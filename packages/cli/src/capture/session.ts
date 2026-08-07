import type { Locator, Page, Request, TestInfo } from "@playwright/test";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { contentHash, sha256, writeJsonAtomic } from "../core/json.js";
import {
  CaptureEnvelopeSchema,
  CaptureSourceSchema,
  DemoFixtureSchema,
  SCHEMA_VERSION,
  type AssetPayload,
  type CaptureStep,
  type CaptureSource
} from "../core/schemas.js";
import {
  PLAYWRIGHT_CAPTURE_ISOLATION_VERSION,
  captureScene,
  evidenceFromTexts,
  type SemanticCaptureTarget
} from "./browser.js";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import {
  CaptureFailureDiagnosticSchema,
  CaptureStepProgressSchema,
  type CaptureStepProgress
} from "../core/freshness.js";
import {
  assertCaptureSafeForPersistence,
  containsConfiguredSensitiveText
} from "../core/security.js";
import type { PageAssetConsent } from "./extractor.js";

const DEFAULT_CAPTURE_VIEWPORT = { width: 1280, height: 720 } as const;
type CaptureStepPhase = "setup" | "capture" | "action" | "outcome";

function expectedCaptureViewport(): { width: number; height: number } {
  const raw = process.env.SHOWKIT_EXPECTED_VIEWPORT;
  if (!raw) return { ...DEFAULT_CAPTURE_VIEWPORT };
  const match = /^(\d{1,4})x(\d{1,4})$/i.exec(raw);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !match ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "[SHOWKIT:DemoFixtureSetupFailed] The capture viewport contract is invalid. No captured page was saved. [SHOWKIT-CATEGORY:capture-viewport-contract-invalid]",
      exitCode: EXIT_CODES.environment,
      recovery:
        "Run capture through the ShowKit CLI with a valid `--viewport WIDTHxHEIGHT` value."
    });
  }
  return { width, height };
}

function assertCaptureViewport(page: Page): { width: number; height: number } {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "[SHOWKIT:DemoFixtureSetupFailed] ShowKit requires a fixed Playwright viewport.",
      exitCode: EXIT_CODES.environment,
      recovery: "Set a fixed Playwright viewport, then capture again."
    });
  }
  const expectedViewport = expectedCaptureViewport();
  if (
    viewport.width !== expectedViewport.width ||
    viewport.height !== expectedViewport.height
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        `[SHOWKIT:DemoFixtureSetupFailed] The Playwright viewport ${viewport.width}x${viewport.height} does not match the ${expectedViewport.width}x${expectedViewport.height} capture contract. No captured page was saved. ` +
        `[SHOWKIT-CATEGORY:capture-viewport-mismatch] [SHOWKIT-VIEWPORT:${expectedViewport.width}x${expectedViewport.height}:${viewport.width}x${viewport.height}]`,
      exitCode: EXIT_CODES.environment,
      recovery:
        `Set Playwright to ${expectedViewport.width}x${expectedViewport.height}. Use another \`--viewport WIDTHxHEIGHT\` only for an exact requested size or an existing demo.`
    });
  }
  return viewport;
}

function assetExtension(
  mimeType: AssetPayload["mimeType"]
): string {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "font/woff2": "woff2"
  }[mimeType];
}

function mergeCaptureAssets(
  target: Map<string, AssetPayload>,
  assets: AssetPayload[]
): void {
  for (const asset of assets) target.set(asset.sha256, asset);
  const totalBytes = [...target.values()].reduce(
    (total, asset) => total + asset.byteLength,
    0
  );
  if (target.size > 64 || totalBytes > 20 * 1_048_576) {
    throw new ShowKitError({
      code: "CaptureTooLarge",
      message:
        "[SHOWKIT:CaptureTooLarge] The captured product flow exceeds the page asset limit. No captured page was saved.",
      exitCode: EXIT_CODES.validation,
      recovery:
        "Reduce the number or size of visible page assets, then capture again.",
      details: { category: "asset-total-limit" }
    });
  }
}

export type DemoStepOptions = {
  id: string;
  title: string;
  target: Locator;
  captureTarget: SemanticCaptureTarget;
  pageAssetConsent?: PageAssetConsent;
  remoteAssetPolicy?: "strict" | "decorative-remove";
  action: () => Promise<unknown>;
};

export type DemoController = {
  step(options: DemoStepOptions): Promise<void>;
};

export class CaptureSession implements DemoController {
  readonly #page: Page;
  readonly #testInfo: TestInfo;
  readonly #outputPath: string | undefined;
  readonly #outputKind: "capture" | "freshness";
  readonly #diagnosticOutputPath: string | undefined;
  readonly #steps: CaptureStep[] = [];
  readonly #stepProgress: CaptureStepProgress[] = [];
  readonly #stepTargets: SemanticCaptureTarget[] = [];
  readonly #assets = new Map<string, AssetPayload>();
  readonly #excludedSurfaces = new Set<string>();
  readonly #startedAt = performance.now();
  #sceneExtractionCount = 0;
  #sceneExtractionMs = 0;
  #actionCount = 0;
  #actionMs = 0;
  #failureRecorded = false;
  #pageAssetConsent: PageAssetConsent | undefined;
  #remoteAssetPolicy: "strict" | "decorative-remove" = "decorative-remove";
  readonly #observedPublicFontSources = new Set<string>();
  readonly #fontRequestListener: (request: Request) => void;
  #fixtureSeed:
    | {
        schemaVersion: typeof SCHEMA_VERSION;
        id: string;
        baseURL: string;
        startPath: string;
        viewport: { width: number; height: number };
        locale: string;
        timezoneId: string;
        lifecycle: {
          setup: "playwright-fixture";
          teardown: "playwright-fixture";
        };
        auth: {
          storageState: "runtime-only-if-configured";
          persisted: false;
        };
        debug: {
          screenshot: "off";
          traceBuildInput: false;
          video: "off";
        };
      }
    | undefined;

  constructor(page: Page, testInfo: TestInfo) {
    this.#page = page;
    this.#testInfo = testInfo;
    this.#outputPath = process.env.SHOWKIT_CAPTURE_OUTPUT;
    this.#outputKind =
      process.env.SHOWKIT_CAPTURE_OUTPUT_KIND === "freshness"
        ? "freshness"
        : "capture";
    this.#diagnosticOutputPath =
      process.env.SHOWKIT_CAPTURE_DIAGNOSTIC_OUTPUT;
    this.#fontRequestListener = (request): void => {
      if (
        !this.active ||
        request.resourceType() !== "font" ||
        this.#observedPublicFontSources.size >= 64
      ) {
        return;
      }
      const raw = request.url();
      if (raw.length > 10_000) return;
      try {
        const url = new URL(raw);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username !== "" ||
          url.password !== "" ||
          url.hash !== ""
        ) {
          return;
        }
        this.#observedPublicFontSources.add(url.href);
      } catch {
        // Malformed font request URLs are ignored and capture remains fail-closed.
      }
    };
    if (this.active) this.#page.on("request", this.#fontRequestListener);
  }

  get active(): boolean {
    return Boolean(this.#outputPath);
  }

  #reportStep(progress: {
    stepId: string;
    title: string;
    stepIndex: number;
    state: "reached" | "failed";
    phase: CaptureStepPhase;
  }): void {
    const parsedStepId =
      CaptureSourceSchema.shape.steps.element.shape.id.safeParse(
        progress.stepId
      );
    const parsedTitle =
      CaptureSourceSchema.shape.steps.element.shape.title.safeParse(
        progress.title
      );
    const stepId =
      parsedStepId.success &&
      !containsConfiguredSensitiveText(parsedStepId.data)
        ? parsedStepId.data
        : `step-${progress.stepIndex + 1}`;
    const title =
      parsedTitle.success &&
      !containsConfiguredSensitiveText(parsedTitle.data)
        ? parsedTitle.data
        : `Step ${progress.stepIndex + 1}`;
    this.#stepProgress.push(
      CaptureStepProgressSchema.parse({
        ...progress,
        stepId,
        title
      })
    );
  }

  async step(options: DemoStepOptions): Promise<void> {
    if (!this.active) {
      await options.action();
      return;
    }

    const stepIndex = this.#steps.length;
    const progress: { phase: CaptureStepPhase } = { phase: "setup" };
    try {
      if (this.#steps.some((step) => step.id === options.id)) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] Each demo step needs a unique ID. No captured page was saved. [SHOWKIT-CATEGORY:duplicate-step-id]",
          exitCode: EXIT_CODES.validation,
          recovery:
            "Give every `demo.step()` a different lowercase hyphenated ID, then capture again."
        });
      }
      await this.#captureStep(options, (nextPhase) => {
        progress.phase = nextPhase;
      });
      this.#reportStep({
        stepId: options.id,
        title: options.title,
        stepIndex,
        state: "reached",
        phase: "outcome"
      });
    } catch (error) {
      this.#reportStep({
        stepId: options.id,
        title: options.title,
        stepIndex,
        state: "failed",
        phase: progress.phase
      });
      await this.recordFailure(
        error,
        progress.phase,
        progress.phase === "action"
          ? "DemoFixtureSetupFailed"
          : "InternalError"
      );
      if (error instanceof ShowKitError) throw error;
      if (progress.phase === "action") {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] The source flow action stopped before capture finished. No captured page was saved.",
          exitCode: EXIT_CODES.environment,
          recovery: "Run the Playwright flow directly and fix the failing action."
        });
      }
      throw new ShowKitError({
        code: "InternalError",
        message:
          "[SHOWKIT:InternalError] ShowKit hit an internal capture error. No captured page was saved.",
        exitCode: EXIT_CODES.internal,
        recovery:
          "Retry once, then report the failure without including private page content."
      });
    }
  }

  async recordFailure(
    error: unknown,
    phase: CaptureStepPhase | "finalize",
    fallbackCode: "DemoFixtureSetupFailed" | "InternalError"
  ): Promise<void> {
    if (
      this.#failureRecorded ||
      !this.#diagnosticOutputPath
    ) {
      return;
    }
    const fallbackInternal = fallbackCode === "InternalError";
    const failure =
      error instanceof ShowKitError
        ? error
        : new ShowKitError({
            code: fallbackCode,
            message: fallbackInternal
              ? "ShowKit hit an internal capture error."
              : "The source flow stopped before capture finished.",
            exitCode: fallbackInternal
              ? EXIT_CODES.internal
              : EXIT_CODES.environment,
            recovery: fallbackInternal
              ? "Retry once, then report the failure without private page content."
              : "Run the Playwright flow directly and fix the failing action."
          });
    const code =
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(failure.code) &&
      !containsConfiguredSensitiveText(failure.code)
        ? failure.code
        : "InternalError";
    const category = [
      ...failure.message.matchAll(
        /\[SHOWKIT-CATEGORY:([a-z0-9-]{1,80})\]/g
      )
    ].at(-1)?.[1];
    const viewport = [
      ...failure.message.matchAll(
        /\[SHOWKIT-VIEWPORT:(\d{1,4})x(\d{1,4}):(\d{1,4})x(\d{1,4})\]/g
      )
    ].at(-1);
    await writeJsonAtomic(
      this.#diagnosticOutputPath,
      CaptureFailureDiagnosticSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        code,
        exitCode:
          code === "InternalError" ? EXIT_CODES.internal : failure.exitCode,
        phase,
        ...(category ? { category } : {}),
        ...(viewport
          ? {
              expectedViewport: {
                width: Number(viewport[1]),
                height: Number(viewport[2])
              },
              actualViewport: {
                width: Number(viewport[3]),
                height: Number(viewport[4])
              }
            }
          : {}),
        stepProgress: this.#stepProgress
      })
    );
    this.#failureRecorded = true;
  }

  async #writeCaptureOutput(value: unknown): Promise<void> {
    if (!this.#outputPath) return;
    const lockPath = `${this.#outputPath}.lock`;
    try {
      const lock = await open(lockPath, "wx");
      await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] More than one Playwright test or project tried to produce this flow. No captured page was saved. [SHOWKIT-CATEGORY:multiple-playwright-flows]",
        exitCode: EXIT_CODES.environment,
        recovery:
          "Keep one test in the source file and pass `--project <name>` when the Playwright config defines multiple projects."
      });
    }
    await writeJsonAtomic(this.#outputPath, value);
  }

  async #captureStep(
    options: DemoStepOptions,
    setPhase: (phase: Exclude<CaptureStepPhase, "setup">) => void
  ): Promise<void> {
    const viewport = assertCaptureViewport(this.#page);
    if (!this.#fixtureSeed) {
      const currentUrl = new URL(this.#page.url());
      if (!["http:", "https:"].includes(currentUrl.protocol)) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] ShowKit requires an HTTP or HTTPS product page.",
          exitCode: EXIT_CODES.environment,
          recovery: "Open the product page before the first `demo.step()`."
        });
      }
      const fixtureId = this.#testInfo.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
      const screenshot = this.#testInfo.project.use.screenshot;
      const video = this.#testInfo.project.use.video;
      if (
        (screenshot !== undefined && screenshot !== "off") ||
        (video !== undefined && video !== "off")
      ) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] ShowKit capture requires screenshot and video recording to be off.",
          exitCode: EXIT_CODES.environment,
          recovery: "Set Playwright `screenshot: \"off\"` and `video: \"off\"`, then capture again."
        });
      }
      this.#fixtureSeed = {
        schemaVersion: SCHEMA_VERSION,
        id: fixtureId || "demo-flow",
        baseURL: currentUrl.origin,
        startPath: currentUrl.pathname || "/",
        viewport,
        locale:
          typeof this.#testInfo.project.use.locale === "string"
            ? this.#testInfo.project.use.locale
            : "en-US",
        timezoneId:
          typeof this.#testInfo.project.use.timezoneId === "string"
            ? this.#testInfo.project.use.timezoneId
            : "UTC",
        lifecycle: {
          setup: "playwright-fixture",
          teardown: "playwright-fixture"
        },
        auth: {
          storageState: "runtime-only-if-configured",
          persisted: false
        },
        debug: {
          screenshot: "off",
          traceBuildInput: false,
          video: "off"
        }
      };
    }
    const captureTarget =
      DemoFixtureSchema.shape.steps.element.shape.target.parse(
        options.captureTarget
      );
    if (
      options.pageAssetConsent &&
      this.#pageAssetConsent &&
      (options.pageAssetConsent.mode !== this.#pageAssetConsent.mode ||
        options.pageAssetConsent.consent !== this.#pageAssetConsent.consent)
    ) {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] A capture flow cannot change page asset consent after it starts. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Set one page asset consent mode on the first `demo.step()` and reuse it for the rest of the flow."
      });
    }
    if (options.pageAssetConsent && this.#steps.length > 0) {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] Page asset consent must be set on the first capture step. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Move `pageAssetConsent` to the first `demo.step()`, then capture again."
      });
    }
    if (options.pageAssetConsent) {
      this.#pageAssetConsent = options.pageAssetConsent;
    }
    if (
      options.remoteAssetPolicy &&
      this.#steps.length > 0 &&
      options.remoteAssetPolicy !== this.#remoteAssetPolicy
    ) {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] A capture flow cannot change its remote asset policy after it starts. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Set `remoteAssetPolicy` on the first `demo.step()` and reuse it for the rest of the flow."
      });
    }
    if (options.remoteAssetPolicy) {
      this.#remoteAssetPolicy = options.remoteAssetPolicy;
    }
    const anchorId = `sk-${options.id}`;
    setPhase("capture");
    const extractionStartedAt = performance.now();
    const {
      scene,
      evidenceTexts,
      assets,
      excludedSurfaces
    } = await captureScene(this.#page, {
      target: options.target,
      captureTarget,
      anchorId,
      stepIndex: this.#steps.length,
      ...(this.#pageAssetConsent
        ? {
            pageAssetConsent: this.#pageAssetConsent,
            observedPublicFontSources: () => [
              ...this.#observedPublicFontSources
            ]
          }
        : {}),
      remoteAssetPolicy: this.#remoteAssetPolicy
    });
    this.#sceneExtractionCount += 1;
    this.#sceneExtractionMs += performance.now() - extractionStartedAt;
    mergeCaptureAssets(this.#assets, assets);
    for (const surface of excludedSurfaces) {
      this.#excludedSurfaces.add(surface);
    }
    setPhase("action");
    const actionStartedAt = performance.now();
    await options.action();
    this.#actionCount += 1;
    this.#actionMs += performance.now() - actionStartedAt;
    setPhase("outcome");
    const safeOutcomeTitle = await this.#page.title();
    if (containsConfiguredSensitiveText(safeOutcomeTitle)) {
      throw new ShowKitError({
        code: "SensitiveDataDetected",
        message:
          "[SHOWKIT:SensitiveDataDetected] Sensitive data was found in the page title after the action. No captured page was saved. Your previous demo has not changed.",
        exitCode: EXIT_CODES.validation,
        recovery: "Hide the data from the page title, then capture again."
      });
    }
    this.#stepTargets.push(captureTarget);
    this.#steps.push(
      CaptureSourceSchema.shape.steps.element.parse({
        id: options.id,
        title: options.title,
        scene,
        evidence: evidenceFromTexts(evidenceTexts),
        actionOutcome: {
          url: sanitizePageUrl(this.#page.url()),
          title: safeOutcomeTitle
        }
      })
    );
  }

  async finalize(): Promise<void> {
    if (!this.active || !this.#outputPath) {
      return;
    }
    if (this.#testInfo.status !== "passed") {
      return;
    }
    if (this.#steps.length === 0) {
      throw new ShowKitError({
        code: "CaptureSourceEmpty",
        message:
          "[SHOWKIT:CaptureSourceEmpty] This source flow has no demo steps. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery: "Add at least one `demo.step()`, then capture the flow again."
      });
    }

    assertCaptureViewport(this.#page);
    const terminalExtractionStartedAt = performance.now();
    const {
      scene: terminalScene,
      assets,
      excludedSurfaces
    } = await captureScene(
      this.#page,
      {
        ...(this.#pageAssetConsent
          ? {
              pageAssetConsent: this.#pageAssetConsent,
              observedPublicFontSources: () => [
                ...this.#observedPublicFontSources
              ]
            }
          : {}),
        remoteAssetPolicy: this.#remoteAssetPolicy
      }
    );
    this.#sceneExtractionCount += 1;
    this.#sceneExtractionMs +=
      performance.now() - terminalExtractionStartedAt;
    mergeCaptureAssets(this.#assets, assets);
    for (const surface of excludedSurfaces) {
      this.#excludedSurfaces.add(surface);
    }
    const specContents = await readFile(this.#testInfo.file, "utf8");
    const require = createRequire(import.meta.url);
    const playwrightPackage = JSON.parse(
      await readFile(require.resolve("@playwright/test/package.json"), "utf8")
    ) as { version: string };
    const viewport = this.#steps[0]?.scene.viewport;
    if (!viewport) {
      throw new Error("Capture steps did not include a viewport.");
    }

    if (!this.#fixtureSeed) {
      throw new Error("Capture did not create a DemoFixture.");
    }
    const fixture = DemoFixtureSchema.parse({
      ...this.#fixtureSeed,
      steps: this.#steps.map((step, index) => {
        const target = this.#stepTargets[index];
        if (!target) throw new Error("Capture step target metadata is missing.");
        return {
          id: step.id,
          title: step.title,
          target,
          actionKind: "select"
        };
      })
    });
    const assetPayloads = [...this.#assets.values()].sort((left, right) =>
      left.sha256.localeCompare(right.sha256)
    );
    const projectName = this.#testInfo.project.name.trim();
    if (
      projectName.length > 120 ||
      containsConfiguredSensitiveText(projectName)
    ) {
      throw new ShowKitError({
        code: "SensitiveDataDetected",
        message:
          "[SHOWKIT:SensitiveDataDetected] The Playwright project name is not safe to save. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Use a short project name that does not contain private data, then capture again."
      });
    }
    const sourceWithoutId = {
      schemaVersion: SCHEMA_VERSION,
      source: {
        kind: "playwright-spec" as const,
        specHash: sha256(specContents),
        runtime: "playwright-test" as const,
        runtimeVersion: playwrightPackage.version,
        ...(projectName ? { projectName } : {}),
        replayLevel: "ci-replayable" as const,
        captureSecurity: {
          provider: "playwright-cdp" as const,
          browserEngine: "chromium" as const,
          executionWorld: PLAYWRIGHT_CAPTURE_ISOLATION_VERSION
        }
      },
      fixtureHash: contentHash(fixture),
      browser: projectName || "chromium",
      fixture,
      viewport,
      steps: this.#steps,
      terminalScene,
      assets: assetPayloads.map((asset) => ({
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        path: `assets/${asset.sha256}.${assetExtension(asset.mimeType)}`
      })),
      redaction: {
        policyChecksPassed: true as const,
        excludedSurfaces: [...this.#excludedSurfaces].sort(),
        fullSceneRasterCount: 0 as const,
        sensitiveText: {
          mode: "blocked-by-default" as const,
          redactedTextNodeCount: 0,
          redactedAttributeCount: 0,
          regionCount: 0
        },
        ...(this.#pageAssetConsent
          ? {
              pageAssets: {
                mode: this.#pageAssetConsent.mode,
                consent: this.#pageAssetConsent.consent,
                localOnly: true as const,
                assetCount: assetPayloads.length
              }
            }
          : {})
      }
    };
    const capture: CaptureSource = CaptureSourceSchema.parse({
      ...sourceWithoutId,
      captureId: `capture-${contentHash(sourceWithoutId).slice(0, 24)}`
    });
    const envelope = CaptureEnvelopeSchema.parse({
      capture,
      assetPayloads
    });
    assertCaptureSafeForPersistence(envelope.capture);
    const output = this.#outputKind === "freshness" ? capture : envelope;
    const captureBytes = Buffer.byteLength(JSON.stringify(output));
    const captureLimitBytes = 25 * 1024 * 1024;
    if (captureBytes > captureLimitBytes) {
      throw new ShowKitError({
        code: "CaptureTooLarge",
        message:
          "[SHOWKIT:CaptureTooLarge] The captured product flow exceeds the 25 MB safety limit.",
        recovery: "Reduce the number or size of captured product states, then capture again."
      });
    }
    await this.#writeCaptureOutput(output);
    const rounded = (value: number): number => Number(value.toFixed(3));
    console.error(
      `[SHOWKIT:CAPTURE_PERFORMANCE] ${JSON.stringify({
        htmlSceneCount: this.#sceneExtractionCount,
        sceneExtractionMs: rounded(this.#sceneExtractionMs),
        actionCount: this.#actionCount,
        actionMs: rounded(this.#actionMs),
        totalMs: rounded(performance.now() - this.#startedAt)
      })}`
    );
  }

  dispose(): void {
    this.#page.off("request", this.#fontRequestListener);
    this.#observedPublicFontSources.clear();
  }
}

function sanitizePageUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "about:blank";
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "about:blank";
  }
}
