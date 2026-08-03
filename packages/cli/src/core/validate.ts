import { ShowKitError } from "./errors.js";
import {
  QualityReportSchema,
  SCHEMA_VERSION,
  VerificationReportSchema,
  inspectPlayerThemeContrast,
  type CaptureSource,
  type QualityReport,
  type SanitizedNode,
  type StorySpec,
  type VerificationReport
} from "./schemas.js";
import {
  inspectCaptureContentPolicy,
  visitSanitizedNodes
} from "./security.js";

export function validateStory(
  capture: CaptureSource,
  story: StorySpec
): { verification: VerificationReport; quality: QualityReport } {
  const checks: VerificationReport["checks"] = [];
  const addCheck = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  addCheck(
    "source-capture",
    story.sourceCaptureId === capture.captureId,
    story.sourceCaptureId === capture.captureId
      ? "Demo content matches the captured product flow."
      : "Demo content references another captured product flow."
  );

  const captureSteps = new Map(capture.steps.map((step) => [step.id, step]));
  const uniqueStoryIds = new Set(story.steps.map((step) => step.id));
  const anchorCounts = new Map<string, number>();
  const targetBounds = new Map<
    string,
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const missingEvidence = new Map<string, string[]>();
  addCheck(
    "unique-step-ids",
    uniqueStoryIds.size === story.steps.length,
    uniqueStoryIds.size === story.steps.length
      ? "Every demo step ID is unique."
      : "Demo step IDs must be unique."
  );

  for (const storyStep of story.steps) {
    const captureStep = captureSteps.get(storyStep.captureStepId);
    addCheck(
      `capture-step:${storyStep.id}`,
      Boolean(captureStep),
      captureStep
        ? `The “${storyStep.tooltip.title}” step is present in the captured flow.`
        : `The “${storyStep.tooltip.title}” step is not present in the captured flow.`
    );
    if (!captureStep) continue;

    let anchorCount = 0;
    visitSanitizedNodes(captureStep.scene.nodes, (node) => {
      if (
        node.type === "element" &&
        node.attributes["data-showkit-anchor"] === storyStep.anchorId
      ) {
        anchorCount += 1;
      }
    });
    anchorCounts.set(storyStep.id, anchorCount);
    addCheck(
      `anchor:${storyStep.id}`,
      anchorCount === 1,
      anchorCount === 1
        ? `The “${storyStep.tooltip.title}” hotspot target is present.`
        : `The “${storyStep.tooltip.title}” hotspot target is out of date.`
    );

    const evidenceIds = new Set(captureStep.evidence.map((evidence) => evidence.id));
    const missingEvidenceIds = storyStep.evidenceIds.filter((id) => !evidenceIds.has(id));
    missingEvidence.set(storyStep.id, missingEvidenceIds);
    const evidencePresent = missingEvidenceIds.length === 0;
    addCheck(
      `evidence:${storyStep.id}`,
      evidencePresent,
      evidencePresent
        ? `The “${storyStep.tooltip.title}” tooltip is based on captured text.`
        : `The “${storyStep.tooltip.title}” tooltip is based on product text that changed.`
    );

    const bounds = captureStep.scene.target?.bounds;
    targetBounds.set(storyStep.id, bounds);
    const boundsValid =
      bounds !== undefined &&
      bounds.x + bounds.width <= 1.000001 &&
      bounds.y + bounds.height <= 1.000001;
    addCheck(
      `bounds:${storyStep.id}`,
      boundsValid,
      boundsValid
        ? `The “${storyStep.tooltip.title}” hotspot stays inside the captured viewport.`
        : `The “${storyStep.tooltip.title}” hotspot no longer matches the product.`
    );
  }

  const allScenes = [...capture.steps.map((step) => step.scene), capture.terminalScene];
  const capturePolicy = inspectCaptureContentPolicy(capture);
  const scenesClean =
    capturePolicy.sensitiveTextAbsent &&
    capturePolicy.htmlPolicyPassed &&
    capturePolicy.screenshotPolicyPassed;
  addCheck(
    "html-policy",
    scenesClean,
    scenesClean
      ? "Product scripts, forms, remote requests, and unsupported surfaces are absent."
      : "A demo scene contains content ShowKit cannot export."
  );
  addCheck(
    "screenshot-scene",
    capture.redaction.fullSceneRasterCount === 0,
    capture.redaction.fullSceneRasterCount === 0
      ? "The demo contains 0 full-screen image scenes."
      : "Full-screen image scenes are not supported."
  );

  const passed = checks.every((check) => check.passed);
  const verification = VerificationReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    passed,
    checks
  });
  const qualityChecks: QualityReport["checks"] = [
    {
      name: "selectable-html",
      passed: allScenes.every((scene) => /<[^>]+>/.test(scene.html)),
      detail: "Every product state is stored as HTML."
    },
    {
      name: "semantic-targets",
      passed: capture.steps.every((step) => Boolean(step.scene.target?.role)),
      detail: "Every hotspot target has a semantic role."
    },
    {
      name: "content-security-policy",
      passed: scenesClean,
      detail: "Demo scenes cannot run product scripts or remote requests."
    },
    {
      name: "content-addressed-assets",
      passed: capture.assets.every(
        (asset) => {
          const extension = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
            "image/avif": "avif",
            "image/gif": "gif",
            "image/svg+xml": "svg",
            "font/woff2": "woff2"
          }[asset.mimeType];
          return (
            asset.path === `assets/${asset.sha256}.${extension}` &&
            asset.byteLength <= 1_048_576
          );
        }
      ),
      detail: `${capture.assets.length} local assets use content-addressed paths.`
    },
    {
      name: "wcag-2.2-player-theme",
      passed: inspectPlayerThemeContrast(story.theme).passed,
      detail:
        "Player chrome colors meet ShowKit’s WCAG 2.2 AA contrast thresholds. Captured product content is not assessed by this check."
    }
  ];
  const quality = QualityReportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    passed: qualityChecks.every((check) => check.passed),
    fullSceneRasterCount: 0,
    remoteRequestCount: 0,
    checks: qualityChecks
  });

  if (!passed || !quality.passed) {
    const anchorFailure = checks.find(
      (check) =>
        (check.name.startsWith("anchor:") || check.name.startsWith("bounds:")) &&
        !check.passed
    );
    const evidenceFailure = checks.find(
      (check) => check.name.startsWith("evidence:") && !check.passed
    );
    if (anchorFailure) {
      const stepId = anchorFailure.name.split(":")[1] ?? "unknown";
      const storyStep = story.steps.find((step) => step.id === stepId);
      throw new ShowKitError({
        code: "HotspotAnchorDrift",
        message: "This hotspot no longer matches the product. The previous demo has not changed.",
        recovery: "Capture the flow again or update the hotspot target.",
        details: {
          stepId,
          anchorId: storyStep?.anchorId ?? "unknown",
          expected: {
            anchorCount: 1,
            boundsInsideViewport: true
          },
          actual: {
            anchorCount: anchorCounts.get(stepId) ?? 0,
            bounds: targetBounds.get(stepId) ?? null
          }
        }
      });
    }
    if (evidenceFailure) {
      const stepId = evidenceFailure.name.split(":")[1] ?? "unknown";
      throw new ShowKitError({
        code: "CopyEvidenceDrift",
        message:
          "This tooltip is based on product text that changed. The previous demo has not changed.",
        recovery: "Update the tooltip or capture the flow again.",
        details: {
          stepId,
          missingEvidenceIds: missingEvidence.get(stepId) ?? []
        }
      });
    }
    throw new ShowKitError({
      code: "StorySpecInvalid",
      message: "Demo content could not be checked. The previous demo has not changed.",
      recovery: "Review the failed checks, then apply the demo content again.",
      details: {
        failedChecks: checks
          .filter((check) => !check.passed)
          .map((check) => ({ name: check.name, detail: check.detail })),
        failedQualityChecks: quality.checks
          .filter((check) => !check.passed)
          .map((check) => ({ name: check.name, detail: check.detail }))
      }
    });
  }

  return { verification, quality };
}
