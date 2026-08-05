import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ShowKitError } from "../core/errors.js";
import { contentHash, replaceDirectoryAtomic, sha256, writeJsonAtomic } from "../core/json.js";
import {
  ArtifactManifestSchema,
  QualityReportSchema,
  SCHEMA_VERSION,
  type ArtifactManifest,
  type CaptureSource,
  type StorySpec
} from "../core/schemas.js";
import { pathExists, showkitPath } from "../core/project.js";
import { validateStory } from "../core/validate.js";
import { createPlayerFiles } from "../player/assets.js";

const BUILDER_VERSION = (
  JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

function buildMetadata(): { createdAt: string; sourceDateEpoch?: string } {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)) {
    const date = new Date(Number(sourceDateEpoch) * 1_000);
    if (!Number.isNaN(date.getTime())) {
      return {
        createdAt: date.toISOString(),
        sourceDateEpoch
      };
    }
  }
  return { createdAt: new Date().toISOString() };
}

function mediaTypeForPath(filePath: string, capture: CaptureSource): string {
  const asset = capture.assets.find((candidate) => candidate.path === filePath);
  if (asset) return asset.mimeType;
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".md": "text/markdown; charset=utf-8"
    }[extension] ?? "application/octet-stream"
  );
}

function createMarkdown(story: StorySpec): string {
  const lines = [
    `# ${story.title}`,
    "",
    story.goal,
    "",
    ...story.steps.flatMap((step, index) => [
      `## ${index + 1}. ${step.tooltip.title}`,
      "",
      step.tooltip.body,
      ""
    ])
  ];
  return `${lines.join("\n").trim()}\n`;
}

export async function buildDemo(
  capture: CaptureSource,
  story: StorySpec,
  captureRunDirectory: string
): Promise<{ manifest: ArtifactManifest; directory: string; reused: boolean }> {
  const { verification, quality: validationQuality } = validateStory(capture, story);
  const sourceCaptureHash = contentHash(capture);
  const storyHash = contentHash(story);
  const playerFiles = createPlayerFiles(capture, story);
  const playerGzipBytes = gzipSync(Buffer.from(playerFiles["player.js"])).byteLength;
  const quality = {
    ...validationQuality,
    checks: [
      ...validationQuality.checks,
      {
        name: "stale-step-check",
        passed: verification.passed,
        detail: "Every selected step, hotspot anchor, and evidence reference matches the captured product flow."
      },
      {
        name: "player-accessibility-contract",
        passed:
          story.steps.every((step) => step.tooltip.title.length > 0) &&
          capture.steps.every(
            (step) => Boolean(step.scene.target?.role && step.scene.target.name)
          ),
        detail: "Player controls and captured hotspot targets have accessible names."
      },
      {
        name: "player-javascript-budget",
        passed: playerGzipBytes <= 80 * 1024,
        detail: `Player JavaScript is ${playerGzipBytes} gzip bytes; the limit is ${80 * 1024}.`
      },
      {
        name: "single-asset-budget",
        passed: capture.assets.every((asset) => asset.byteLength <= 1_048_576),
        detail: "Every local captured asset is at most 1 MB."
      }
    ]
  };
  quality.passed = quality.checks.every((check) => check.passed);
  const parsedQuality = QualityReportSchema.parse(quality);
  if (!parsedQuality.passed) {
    throw new ShowKitError({
      code: "ArtifactBuildFailed",
      message: "The local demo did not meet its build quality budget. The previous demo has not changed.",
      recovery: "Review the failed quality check, reduce the demo payload, and build again."
    });
  }
  const fileContents: Record<string, string | Uint8Array> = {
    ...playerFiles,
    "release-notes.md": createMarkdown(story),
    "verification.json": `${JSON.stringify(verification, null, 2)}\n`,
    "quality.json": `${JSON.stringify(parsedQuality, null, 2)}\n`
  };
  for (const asset of capture.assets) {
    const bytes = new Uint8Array(await readFile(path.join(captureRunDirectory, asset.path)));
    if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
      throw new ShowKitError({
        code: "ArtifactBuildFailed",
        message: "A local demo asset failed its integrity check. The previous demo has not changed.",
        recovery: "Capture the source flow again, then rebuild."
      });
    }
    fileContents[asset.path] = bytes;
  }
  const files = Object.entries(fileContents)
    .map(([filePath, contents]) => ({
      path: filePath,
      sha256: sha256(contents),
      bytes: Buffer.byteLength(contents),
      mediaType: mediaTypeForPath(filePath, capture)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const version = contentHash({
    sourceCaptureHash,
    storyHash,
    builderVersion: BUILDER_VERSION,
    files
  });
  const directory = showkitPath("artifacts", version);
  const manifestPath = path.join(directory, "artifact.json");
  if (await pathExists(manifestPath)) {
    return {
      manifest: ArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))),
      directory,
      reused: true
    };
  }
  const manifest = ArtifactManifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    state: "BUILT",
    version,
    sourceCaptureHash,
    storyHash,
    builderVersion: BUILDER_VERSION,
    source: capture.source,
    replayLevel: capture.source.replayLevel,
    dependencies: {
      node: { supported: ">=22.12 <25" },
      playwright: {
        ...(capture.source.kind === "playwright-spec"
          ? { capturedWith: capture.source.runtimeVersion }
          : {}),
        supported: ">=1.60.0 <2"
      },
      captureRuntime: {
        kind:
          capture.source.kind === "playwright-spec"
            ? "playwright-test"
            : capture.source.kind === "agent-browser-session"
              ? "agent-browser-adapter"
              : "static-source",
        version:
          capture.source.kind === "playwright-spec"
            ? capture.source.runtimeVersion
            : capture.source.kind === "agent-browser-session"
              ? capture.source.adapterVersion
              : capture.source.generatorVersion
      }
    },
    environment: {
      browser: capture.browser,
      viewport: capture.viewport
    },
    reports: {
      verification: "verification.json",
      quality: "quality.json"
    },
    buildMetadata: buildMetadata(),
    files,
    sanitization: {
      policyChecksPassed: true,
      fullSceneRasterCount: 0,
      remoteRequestCount: 0
    },
    provenance: {
      assets: capture.assets.map((asset) => ({
        path: asset.path,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        origin: "captured-product-flow"
      }))
    },
    publish: null
  });

  try {
    await replaceDirectoryAtomic(directory, async (temporaryPath) => {
      let fileIndex = 0;
      for (const [filePath, contents] of Object.entries(fileContents)) {
        const target = path.join(temporaryPath, filePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
        fileIndex += 1;
        if (
          process.env.SHOWKIT_FAULT_INJECTION === "artifact-write" &&
          fileIndex === 1
        ) {
          throw new Error("Injected artifact write failure.");
        }
      }
      await writeJsonAtomic(path.join(temporaryPath, "artifact.json"), manifest);
    });
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw new ShowKitError({
      code: "ArtifactBuildFailed",
      message: "ShowKit could not build the local demo. The previous demo has not changed.",
      exitCode: 3,
      recovery: "Check available disk space and file permissions, then run the build again."
    });
  }

  return { manifest, directory, reused: false };
}
