import { contentHash } from "../core/json.js";
import { ShowKitError } from "../core/errors.js";
import { sanitizePageUrl } from "../core/url.js";
import { assertCaptureSafeForPersistence } from "../core/security.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentBrowserCaptureSourceSchema,
  AgentBrowserDemoFixtureSchema,
  BrowserFlowRecipeSchema,
  SCHEMA_VERSION,
  SessionCaptureEnvelopeSchema,
  type AssetPayload,
  type BrowserFlowRecipe,
  type CaptureStep,
  type Scene,
  type SessionCaptureEnvelope
} from "../core/schemas.js";

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

export type AgentBrowserCaptureInput = {
  recipe: BrowserFlowRecipe;
  browser: string;
  steps: CaptureStep[];
  terminalScene: Scene;
  assetPayloads: AssetPayload[];
  excludedSurfaces: string[];
  sensitiveText?: {
    mode: "blocked-by-default" | "text-only";
    redactedTextNodeCount: number;
    redactedAttributeCount: number;
    regionCount: number;
  };
};

export function createAgentBrowserCaptureEnvelope(
  input: AgentBrowserCaptureInput
): SessionCaptureEnvelope {
  const recipe = BrowserFlowRecipeSchema.parse(input.recipe);
  const fixture = AgentBrowserDemoFixtureSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: recipe.id,
    baseURL: recipe.url.origin,
    startPath: recipe.url.path,
    viewport: recipe.viewport,
    locale: recipe.locale,
    timezoneId: recipe.timezoneId,
    lifecycle: {
      setup: "agent-browser-session",
      teardown: "agent-browser-session"
    },
    auth: {
      storageState: "runtime-only-if-configured",
      persisted: false
    },
    debug: {
      screenshot: "off",
      traceBuildInput: false,
      video: "off"
    },
    steps: recipe.steps
  });
  const assetPayloads = [...input.assetPayloads].sort((left, right) =>
    left.sha256.localeCompare(right.sha256)
  );
  const recipeStepIds = recipe.steps.map((step) => step.id);
  if (
    input.steps.length !== recipeStepIds.length ||
    input.steps.some((step, index) => step.id !== recipeStepIds[index])
  ) {
    throw new Error("Safe session steps do not match the browser flow recipe.");
  }
  const sourceWithoutId = {
    schemaVersion: SCHEMA_VERSION,
    source: {
      kind: "agent-browser-session" as const,
      recipeHash: contentHash(recipe),
      host: recipe.host,
      browserSurface: recipe.browserSurface,
      adapterVersion: recipe.adapterVersion,
      sessionPersisted: false as const,
      replayLevel: "session-captured" as const
    },
    fixtureHash: contentHash(fixture),
    browser: input.browser,
    fixture,
    viewport: recipe.viewport,
    steps: input.steps,
    terminalScene: input.terminalScene,
    assets: assetPayloads.map((asset) => ({
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      path: `assets/${asset.sha256}.${assetExtension(asset.mimeType)}`
    })),
    redaction: {
      policyChecksPassed: true as const,
      excludedSurfaces: [...new Set(input.excludedSurfaces)].sort(),
      fullSceneRasterCount: 0 as const,
      sensitiveText: input.sensitiveText ?? {
        mode: "blocked-by-default" as const,
        redactedTextNodeCount: 0,
        redactedAttributeCount: 0,
        regionCount: 0
      },
      ...(recipe.privateContent
        ? {
            privateContent: {
              mode: recipe.privateContent.mode,
              consent: recipe.privateContent.consent,
              localOnly: true as const,
              hiddenValuesExcluded: true as const
            }
          }
        : {}),
      ...(recipe.pageAssets
        ? {
            pageAssets: {
              mode: recipe.pageAssets.mode,
              consent: recipe.pageAssets.consent,
              localOnly: true as const,
              assetCount: assetPayloads.length
            }
          }
        : {})
    }
  };
  const capture = AgentBrowserCaptureSourceSchema.parse({
    ...sourceWithoutId,
    captureId: `capture-${contentHash(sourceWithoutId).slice(0, 24)}`
  });
  assertCaptureSafeForPersistence(capture);
  return validateAgentBrowserCaptureEnvelope({
    recipe,
    capture,
    assetPayloads
  });
}

export function validateAgentBrowserCaptureEnvelope(
  input: unknown
): SessionCaptureEnvelope {
  let envelope: SessionCaptureEnvelope;
  try {
    envelope = SessionCaptureEnvelopeSchema.parse(input);
  } catch {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session envelope is malformed. The previous captured product flow has not changed.",
      recovery: "Capture the browser session again with the current ShowKit skill."
    });
  }
  const { recipe, capture } = envelope;
  assertCaptureSafeForPersistence(capture);
  if (
    capture.source.recipeHash !== contentHash(recipe) ||
    capture.source.host !== recipe.host ||
    capture.source.browserSurface !== recipe.browserSurface ||
    capture.source.adapterVersion !== recipe.adapterVersion ||
    capture.fixtureHash !== contentHash(capture.fixture) ||
    capture.fixture.baseURL !== recipe.url.origin ||
    capture.fixture.startPath !== recipe.url.path ||
    contentHash(capture.fixture.steps) !== contentHash(recipe.steps) ||
    contentHash(capture.viewport) !== contentHash(recipe.viewport)
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session envelope does not match its safe recipe. The previous captured product flow has not changed.",
      recovery: "Capture the browser session again with the current ShowKit skill."
    });
  }
  const recipeRedaction = recipe.sensitiveTextRedaction;
  const captureRedaction = capture.redaction.sensitiveText;
  if (
    (recipeRedaction === undefined &&
      captureRedaction?.mode === "text-only") ||
    (recipeRedaction !== undefined &&
      (captureRedaction?.mode !== "text-only" ||
        captureRedaction.regionCount !== recipeRedaction.regionCount))
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session text-redaction report does not match its confirmed recipe. Nothing was imported.",
      recovery: "Capture the browser session again with the current ShowKit skill."
    });
  }
  const recipePageAssets = recipe.pageAssets;
  const capturePageAssets = capture.redaction.pageAssets;
  if (
    (recipePageAssets === undefined && capturePageAssets !== undefined) ||
    (recipePageAssets !== undefined &&
      (capturePageAssets?.mode !== "visible-session" ||
        capturePageAssets.consent !== "confirmed" ||
        capturePageAssets.localOnly !== true ||
        capturePageAssets.assetCount !== capture.assets.length))
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session asset-consent report does not match its confirmed recipe. Nothing was imported.",
      recovery: "Capture the browser session again with the current ShowKit skill."
    });
  }
  const recipePrivateContent = recipe.privateContent;
  const capturePrivateContent = capture.redaction.privateContent;
  if (
    (recipePrivateContent === undefined &&
      capturePrivateContent !== undefined) ||
    (recipePrivateContent !== undefined &&
      (capturePrivateContent?.mode !== "visible-session" ||
        capturePrivateContent.consent !== "confirmed" ||
        capturePrivateContent.localOnly !== true ||
        capturePrivateContent.hiddenValuesExcluded !== true))
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session private-content report does not match its confirmed recipe. Nothing was imported.",
      recovery: "Capture the browser session again with the current ShowKit skill."
    });
  }
  for (const step of capture.steps) {
    const sanitized = sanitizePageUrl(step.actionOutcome.url);
    if (sanitized.value !== step.actionOutcome.url) {
      throw new ShowKitError({
        code: "PageUrlInvalid",
        message:
          "A browser session result contains a URL query or fragment. Nothing was imported.",
        recovery: "Capture the session again after removing query and fragment data."
      });
    }
  }
  const { captureId: _captureId, ...sourceWithoutId } = capture;
  const expectedCaptureId = `capture-${contentHash(sourceWithoutId).slice(0, 24)}`;
  if (capture.captureId !== expectedCaptureId) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session capture ID does not match its safe content. Nothing was imported.",
      recovery: "Capture the browser session again with the current ShowKit skill."
    });
  }
  return envelope;
}

export async function writeSessionEnvelopeTemporary(
  input: unknown
): Promise<string> {
  const envelope = validateAgentBrowserCaptureEnvelope(input);
  const filePath = path.join(
    os.tmpdir(),
    `showkit-browser-session-${randomUUID()}.json`
  );
  await writeFile(filePath, `${JSON.stringify(envelope)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return filePath;
}
