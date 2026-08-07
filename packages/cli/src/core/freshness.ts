import { z } from "zod";
import { ShowKitError } from "./errors.js";
import { contentHash } from "./json.js";
import {
  FreshnessBaselineSchema,
  FreshnessReportSchema,
  SCHEMA_VERSION,
  type CaptureSource,
  type FreshnessBaseline,
  type FreshnessReport,
  type StorySpec
} from "./schemas.js";

export const CaptureStepProgressSchema = z
  .object({
    stepId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1).max(120),
    stepIndex: z.number().int().nonnegative().max(999),
    state: z.enum(["reached", "failed"]),
    phase: z.enum(["setup", "capture", "action", "outcome"])
  })
  .strict();

export type CaptureStepProgress = z.infer<typeof CaptureStepProgressSchema>;

export const CaptureFailureDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    code: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/),
    exitCode: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(70)]),
    phase: z.enum(["setup", "capture", "action", "outcome", "finalize"]),
    category: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    expectedViewport: z
      .object({
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096)
      })
      .strict()
      .optional(),
    actualViewport: z
      .object({
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096)
      })
      .strict()
      .optional(),
    stepProgress: z.array(CaptureStepProgressSchema).max(1000)
  })
  .strict();

export type CaptureFailureDiagnostic = z.infer<
  typeof CaptureFailureDiagnosticSchema
>;
type BlockedFreshnessReport = Extract<
  FreshnessReport,
  { status: "blocked" }
>;
type FailedFreshnessStep = Extract<
  FreshnessReport["steps"][number],
  { state: "failed" }
>;

export function validateCaptureStepProgress(
  progress: CaptureStepProgress[],
  baseline: FreshnessBaseline
): CaptureStepProgress[] {
  if (progress.length === 0) return [];
  const baselineBySourceIndex = new Map(
    baseline.steps.map((step) => [step.sourceIndex, step.captureStepId])
  );
  const seenIds = new Set<string>();
  let failed = false;
  for (const [position, step] of progress.entries()) {
    if (
      step.stepIndex !== position ||
      seenIds.has(step.stepId) ||
      failed ||
      (step.state === "failed" && position !== progress.length - 1) ||
      (baselineBySourceIndex.has(position) &&
        baselineBySourceIndex.get(position) !== step.stepId)
    ) {
      return [];
    }
    seenIds.add(step.stepId);
    failed = step.state === "failed";
  }
  return progress;
}

function evidenceForStep(
  capture: CaptureSource,
  captureStepId: string,
  evidenceIds: string[]
): Array<{ id: string; text: string }> {
  const captureStep = capture.steps.find((step) => step.id === captureStepId);
  if (!captureStep) return [];
  const evidence = new Map(captureStep.evidence.map((item) => [item.id, item]));
  return evidenceIds.flatMap((id) => {
    const item = evidence.get(id);
    return item ? [item] : [];
  });
}

export function createFreshnessBaseline(
  capture: CaptureSource,
  story: StorySpec
): FreshnessBaseline {
  const captureSteps = new Map(
    capture.steps.map((step, sourceIndex) => [step.id, { step, sourceIndex }])
  );
  return FreshnessBaselineSchema.parse({
    steps: story.steps.map((storyStep) => {
      const source = captureSteps.get(storyStep.captureStepId);
      if (!source) {
        throw new ShowKitError({
          code: "ArtifactBuildFailed",
          message:
            "Demo could not be built because a selected step is missing. The previous demo has not changed.",
          recovery: "Capture the flow again or remove the missing step from the demo content."
        });
      }
      const selectedEvidence = evidenceForStep(
        capture,
        storyStep.captureStepId,
        storyStep.evidenceIds
      );
      if (selectedEvidence.length !== storyStep.evidenceIds.length) {
        throw new ShowKitError({
          code: "ArtifactBuildFailed",
          message:
            "Demo could not be built because captured product text changed. The previous demo has not changed.",
          recovery: "Update the affected tooltip or capture the flow again."
        });
      }
      return {
        stepId: storyStep.id,
        captureStepId: storyStep.captureStepId,
        sourceIndex: source.sourceIndex,
        title: storyStep.tooltip.title,
        sceneHash: contentHash(source.step.scene),
        targetHash: contentHash(source.step.scene.target ?? null),
        evidenceIds: storyStep.evidenceIds,
        evidenceHash: contentHash(selectedEvidence),
        actionOutcomeHash: contentHash(source.step.actionOutcome)
      };
    }),
    terminalSceneHash: contentHash(capture.terminalScene)
  });
}

function stepFailure(options: {
  stepId: string;
  title: string;
  code: string;
  detail: string;
  recovery: string;
}): FailedFreshnessStep {
  return {
    stepId: options.stepId,
    title: options.title,
    state: "failed",
    code: options.code,
    detail: options.detail,
    recovery: options.recovery
  };
}

export function compareCaptureFreshness(options: {
  baseline: FreshnessBaseline;
  baseVersion: string;
  baseSourceHash: string;
  currentCapture: CaptureSource;
}): FreshnessReport {
  const currentSteps = new Map(
    options.currentCapture.steps.map((step, sourceIndex) => [
      step.id,
      { step, sourceIndex }
    ])
  );
  const steps = options.baseline.steps.map((baselineStep) => {
    const current = currentSteps.get(baselineStep.captureStepId);
    if (!current) {
      return stepFailure({
        stepId: baselineStep.stepId,
        title: baselineStep.title,
        code: "SourceStepMissing",
        detail: `The source flow no longer includes the “${baselineStep.title}” step.`,
        recovery: "Restore the source step or update the demo content, then check the demo again."
      });
    }
    if (current.sourceIndex !== baselineStep.sourceIndex) {
      return stepFailure({
        stepId: baselineStep.stepId,
        title: baselineStep.title,
        code: "SourceStepOrderChanged",
        detail: `The “${baselineStep.title}” step moved in the source flow.`,
        recovery: "Review the new step order, then capture and approve the updated demo."
      });
    }
    if (contentHash(current.step.scene.target ?? null) !== baselineStep.targetHash) {
      return stepFailure({
        stepId: baselineStep.stepId,
        title: baselineStep.title,
        code: "HotspotAnchorDrift",
        detail: `The hotspot for “${baselineStep.title}” no longer matches the product.`,
        recovery: "Capture the flow again or update the hotspot target."
      });
    }
    if (
      contentHash(
        evidenceForStep(
          options.currentCapture,
          baselineStep.captureStepId,
          baselineStep.evidenceIds
        )
      ) !== baselineStep.evidenceHash
    ) {
      return stepFailure({
        stepId: baselineStep.stepId,
        title: baselineStep.title,
        code: "CopyEvidenceDrift",
        detail: `The tooltip for “${baselineStep.title}” is based on product text that changed.`,
        recovery: "Update the tooltip or capture the flow again."
      });
    }
    if (contentHash(current.step.actionOutcome) !== baselineStep.actionOutcomeHash) {
      return stepFailure({
        stepId: baselineStep.stepId,
        title: baselineStep.title,
        code: "SourceOutcomeChanged",
        detail: `The product result after “${baselineStep.title}” changed.`,
        recovery: "Review the new result, then capture and approve the updated demo."
      });
    }
    if (contentHash(current.step.scene) !== baselineStep.sceneHash) {
      return stepFailure({
        stepId: baselineStep.stepId,
        title: baselineStep.title,
        code: "SourceSceneChanged",
        detail: `The product state for “${baselineStep.title}” changed.`,
        recovery: "Review the changed product state, then capture and approve the updated demo."
      });
    }
    return {
      stepId: baselineStep.stepId,
      title: baselineStep.title,
      state: "fresh" as const,
      detail: `The “${baselineStep.title}” step still matches the product.`
    };
  });
  const completionChanged =
    contentHash(options.currentCapture.terminalScene) !==
    options.baseline.terminalSceneHash;
  const completion: FreshnessReport["completion"] = completionChanged
    ? {
        state: "failed",
        code: "SourceCompletionChanged",
        detail: "The final product state changed.",
        recovery: "Review the final state, then capture and approve the updated demo."
      }
    : {
        state: "fresh",
        detail: "The final product state still matches the product."
      };
  const status =
    steps.some((step) => step.state === "failed") || completionChanged
      ? "out-of-date"
      : "fresh";
  const currentSourceHash = contentHash(options.currentCapture);
  return FreshnessReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    status,
    previousDemoChanged: false,
    baseVersion: options.baseVersion,
    baseSourceHash: options.baseSourceHash,
    currentSourceHash,
    steps,
    completion
  });
}

export function createBlockedFreshnessReport(options: {
  baseline: FreshnessBaseline;
  baseVersion: string;
  baseSourceHash: string;
  progress: CaptureStepProgress[];
  failure: { code: string; message: string; recovery: string };
}): FreshnessReport {
  const reached = new Set(
    options.progress
      .filter((step) => step.state === "reached")
      .map((step) => step.stepId)
  );
  const failed = [...options.progress]
    .reverse()
    .find((step) => step.state === "failed");
  const steps: BlockedFreshnessReport["steps"] = options.baseline.steps.map((step) => {
    if (failed?.stepId === step.captureStepId) {
      return stepFailure({
        stepId: step.stepId,
        title: step.title,
        code: options.failure.code,
        detail: options.failure.message,
        recovery: options.failure.recovery
      });
    }
    if (reached.has(step.captureStepId)) {
      return {
        stepId: step.stepId,
        title: step.title,
        state: "reached",
        detail:
          "The source flow reached this step before it stopped. Its demo content was not compared."
      };
    }
    return {
      stepId: step.stepId,
      title: step.title,
      state: "skipped",
      detail: "This step was not reached because the source flow stopped earlier."
    };
  });
  const failedSelectedStep = failed
    ? options.baseline.steps.some(
        (step) => step.captureStepId === failed.stepId
      )
    : false;
  const everySelectedStepReached = options.baseline.steps.every((step) =>
    reached.has(step.captureStepId)
  );
  const completionFailed = !failed && everySelectedStepReached;
  const sourceFailure =
    failed && !failedSelectedStep
      ? {
          state: "failed" as const,
          code: options.failure.code,
          detail: options.failure.message,
          recovery: options.failure.recovery,
          captureStepId: failed.stepId,
          phase: failed.phase
        }
      : !failed && !completionFailed
        ? {
            state: "failed" as const,
            code: options.failure.code,
            detail: options.failure.message,
            recovery: options.failure.recovery,
            phase: "setup" as const
          }
        : undefined;
  return FreshnessReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    status: "blocked",
    previousDemoChanged: false,
    baseVersion: options.baseVersion,
    baseSourceHash: options.baseSourceHash,
    steps,
    completion: completionFailed
      ? {
          state: "failed",
          code: options.failure.code,
          detail: options.failure.message,
          recovery: options.failure.recovery
        }
      : {
          state: "skipped",
          detail:
            "The final product state was not checked because the source flow stopped earlier."
        },
    ...(sourceFailure ? { sourceFailure } : {})
  });
}
