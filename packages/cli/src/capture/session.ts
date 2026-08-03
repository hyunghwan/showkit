import type { Locator, Page, TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
  inspectPagePolicy,
  type SemanticCaptureTarget
} from "./browser.js";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import { assertCaptureSafeForPersistence } from "../core/security.js";

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

export type DemoStepOptions = {
  id: string;
  title: string;
  target: Locator;
  captureTarget: SemanticCaptureTarget;
  action: () => Promise<unknown>;
};

export type DemoController = {
  step(options: DemoStepOptions): Promise<void>;
};

export class CaptureSession implements DemoController {
  readonly #page: Page;
  readonly #testInfo: TestInfo;
  readonly #outputPath: string | undefined;
  readonly #steps: CaptureStep[] = [];
  readonly #stepTargets: SemanticCaptureTarget[] = [];
  readonly #assets = new Map<string, AssetPayload>();
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
  }

  get active(): boolean {
    return Boolean(this.#outputPath);
  }

  async step(options: DemoStepOptions): Promise<void> {
    if (!this.active) {
      await options.action();
      return;
    }

    await inspectPagePolicy(this.#page);
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
      const viewport = this.#page.viewportSize();
      if (!viewport) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] ShowKit requires a fixed Playwright viewport.",
          exitCode: EXIT_CODES.environment,
          recovery: "Set a fixed Playwright viewport, then capture again."
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
    const anchorId = `sk-${options.id}`;
    const { scene, evidenceTexts, assets } = await captureScene(this.#page, {
      target: options.target,
      captureTarget,
      anchorId,
      stepIndex: this.#steps.length
    });
    for (const asset of assets) {
      this.#assets.set(asset.sha256, asset);
    }
    await options.action();
    await inspectPagePolicy(this.#page);
    const safeOutcomeTitle = await this.#page.title();
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

    await inspectPagePolicy(this.#page);
    const { scene: terminalScene, assets } = await captureScene(this.#page);
    for (const asset of assets) {
      this.#assets.set(asset.sha256, asset);
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
    const sourceWithoutId = {
      schemaVersion: SCHEMA_VERSION,
      source: {
        kind: "playwright-spec" as const,
        specHash: sha256(specContents),
        runtime: "playwright-test" as const,
        runtimeVersion: playwrightPackage.version,
        replayLevel: "ci-replayable" as const,
        captureSecurity: {
          provider: "playwright-cdp" as const,
          browserEngine: "chromium" as const,
          executionWorld: PLAYWRIGHT_CAPTURE_ISOLATION_VERSION
        }
      },
      fixtureHash: contentHash(fixture),
      browser: this.#testInfo.project.name || "chromium",
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
        excludedSurfaces: [
          "scripts",
          "inline-handlers",
          "forms",
          "remote-assets",
          "browser-storage",
          "network-data"
        ],
        fullSceneRasterCount: 0 as const,
        sensitiveText: {
          mode: "blocked-by-default" as const,
          redactedTextNodeCount: 0,
          redactedAttributeCount: 0,
          regionCount: 0
        }
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
    const captureBytes = Buffer.byteLength(JSON.stringify(envelope));
    const captureLimitBytes = 25 * 1024 * 1024;
    if (captureBytes > captureLimitBytes) {
      throw new ShowKitError({
        code: "CaptureTooLarge",
        message:
          "[SHOWKIT:CaptureTooLarge] The captured product flow exceeds the 25 MB safety limit.",
        recovery: "Reduce the number or size of captured product states, then capture again."
      });
    }
    await writeJsonAtomic(this.#outputPath, envelope);
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
