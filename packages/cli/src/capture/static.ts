import { ShowKitError } from "../core/errors.js";
import { contentHash } from "../core/json.js";
import {
  CaptureEnvelopeSchema,
  SCHEMA_VERSION,
  StaticCaptureSourceSchema,
  StaticDemoFixtureSchema,
  type AssetPayload,
  type CaptureEnvelope,
  type CaptureStep,
  type DemoFixture,
  type Scene
} from "../core/schemas.js";
import { assertCaptureSafeForPersistence } from "../core/security.js";
import { sanitizePageUrl } from "../core/url.js";

function assetExtension(mimeType: AssetPayload["mimeType"]): string {
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

type FixtureStep = DemoFixture["steps"][number];

export type StaticCaptureStepInput = FixtureStep & {
  scene: Scene;
  evidence: CaptureStep["evidence"];
  actionOutcome: CaptureStep["actionOutcome"];
};

export type StaticCaptureInput = {
  id: string;
  baseURL: string;
  startPath: string;
  viewport: { width: number; height: number };
  locale?: string;
  timezoneId?: string;
  sourceFiles: Array<{ path: string; sha256: string }>;
  generatorVersion: string;
  steps: StaticCaptureStepInput[];
  terminalScene: Scene;
  assetPayloads?: AssetPayload[];
  excludedSurfaces?: string[];
};

export function createStaticCaptureEnvelope(
  input: StaticCaptureInput
): CaptureEnvelope {
  const parsedOrigin = new URL(input.baseURL);
  if (input.baseURL !== parsedOrigin.origin) {
    throw new TypeError("Static capture baseURL must be an exact HTTP or HTTPS origin.");
  }
  const fixture = StaticDemoFixtureSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    baseURL: input.baseURL,
    startPath: input.startPath,
    viewport: input.viewport,
    locale: input.locale ?? "en-US",
    timezoneId: input.timezoneId ?? "UTC",
    lifecycle: {
      setup: "static-source",
      teardown: "static-source"
    },
    auth: {
      storageState: "not-used",
      persisted: false
    },
    debug: {
      screenshot: "off",
      traceBuildInput: false,
      video: "off"
    },
    steps: input.steps.map(({ scene: _scene, evidence: _evidence, actionOutcome: _outcome, ...step }) => step)
  });
  const steps = input.steps.map(
    ({ id, title, scene, evidence, actionOutcome }) => ({
      id,
      title,
      scene,
      evidence,
      actionOutcome
    })
  );
  const assetPayloads = [...(input.assetPayloads ?? [])].sort((left, right) =>
    left.sha256.localeCompare(right.sha256)
  );
  const sourceFiles = [...input.sourceFiles].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const sourceWithoutId = {
    schemaVersion: SCHEMA_VERSION,
    source: {
      kind: "static-source" as const,
      sourceFiles,
      generator: "showkit-static" as const,
      generatorVersion: input.generatorVersion,
      replayLevel: "source-derived" as const
    },
    fixtureHash: contentHash(fixture),
    browser: "static-source",
    fixture,
    viewport: input.viewport,
    steps,
    terminalScene: input.terminalScene,
    assets: assetPayloads.map((asset) => ({
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      path: `assets/${asset.sha256}.${assetExtension(asset.mimeType)}`
    })),
    redaction: {
      policyChecksPassed: true as const,
      excludedSurfaces: [
        ...new Set([
          "browser-runtime",
          "browser-storage",
          "network-data",
          "remote-assets",
          ...(input.excludedSurfaces ?? [])
        ])
      ].sort(),
      fullSceneRasterCount: 0 as const,
      sensitiveText: {
        mode: "blocked-by-default" as const,
        redactedTextNodeCount: 0,
        redactedAttributeCount: 0,
        regionCount: 0
      }
    }
  };
  const capture = StaticCaptureSourceSchema.parse({
    ...sourceWithoutId,
    captureId: `capture-${contentHash(sourceWithoutId).slice(0, 24)}`
  });
  return validateStaticCaptureEnvelope({
    capture,
    assetPayloads
  });
}

export function validateStaticCaptureEnvelope(
  input: unknown
): CaptureEnvelope {
  let envelope: CaptureEnvelope;
  try {
    envelope = CaptureEnvelopeSchema.parse(input);
    StaticCaptureSourceSchema.parse(envelope.capture);
  } catch {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The static-source envelope is malformed. The previous captured product flow has not changed.",
      recovery:
        "Regenerate the static-source envelope with the current ShowKit CLI."
    });
  }
  const capture = StaticCaptureSourceSchema.parse(envelope.capture);
  assertCaptureSafeForPersistence(capture);
  if (
    capture.fixtureHash !== contentHash(capture.fixture) ||
    capture.fixture.viewport.width !== capture.viewport.width ||
    capture.fixture.viewport.height !== capture.viewport.height ||
    contentHash(
      capture.fixture.steps.map(({ id, title }) => ({ id, title }))
    ) !==
      contentHash(
        capture.steps.map(({ id, title }) => ({ id, title }))
      )
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The static-source envelope does not match its fixture. The previous captured product flow has not changed.",
      recovery:
        "Regenerate the static-source envelope from the current source files."
    });
  }
  for (const step of capture.steps) {
    if (sanitizePageUrl(step.actionOutcome.url).value !== step.actionOutcome.url) {
      throw new ShowKitError({
        code: "PageUrlInvalid",
        message:
          "A static-source result contains a URL query or fragment. Nothing was imported.",
        recovery:
          "Regenerate the static-source envelope with sanitized action URLs."
      });
    }
  }
  const sourceFiles = [...capture.source.sourceFiles].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  if (
    new Set(sourceFiles.map((entry) => entry.path)).size !==
      sourceFiles.length ||
    contentHash(sourceFiles) !== contentHash(capture.source.sourceFiles)
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The static-source file inventory must be unique and sorted. Nothing was imported.",
      recovery:
        "Regenerate the static-source envelope with the current ShowKit CLI."
    });
  }
  const referencedAssets = [...capture.assets]
    .map((asset) => asset.sha256)
    .sort();
  const payloadAssets = [...envelope.assetPayloads]
    .map((asset) => asset.sha256)
    .sort();
  if (
    new Set(referencedAssets).size !== referencedAssets.length ||
    new Set(payloadAssets).size !== payloadAssets.length ||
    contentHash(referencedAssets) !== contentHash(payloadAssets)
  ) {
    throw new ShowKitError({
      code: "AssetIntegrityFailed",
      message:
        "The static-source asset inventory is incomplete. Nothing was imported.",
      recovery:
        "Regenerate the static-source envelope from the current source files."
    });
  }
  const { captureId: _captureId, ...sourceWithoutId } = capture;
  const expectedCaptureId = `capture-${contentHash(sourceWithoutId).slice(0, 24)}`;
  if (capture.captureId !== expectedCaptureId) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The static-source capture ID does not match its safe content. Nothing was imported.",
      recovery:
        "Regenerate the static-source envelope from the current source files."
    });
  }
  return {
    capture,
    assetPayloads: envelope.assetPayloads
  };
}
