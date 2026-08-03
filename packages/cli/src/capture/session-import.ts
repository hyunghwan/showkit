import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ShowKitError } from "../core/errors.js";
import { replaceDirectoryAtomic, sha256, writeJsonAtomic } from "../core/json.js";
import {
  CaptureEnvelopeSchema,
  RunEnvelopeSchema,
  SCHEMA_VERSION,
  type CaptureEnvelope
} from "../core/schemas.js";
import { assertCaptureSafeForPersistence } from "../core/security.js";
import {
  pathExists,
  saveProject,
  showkitPath,
  type Project
} from "../core/project.js";

export async function commitCaptureEnvelope(options: {
  envelope: CaptureEnvelope;
  project: Project;
  runId: string;
  startedAt: string;
}): Promise<{ captureId: string; path: string }> {
  const envelope = CaptureEnvelopeSchema.parse(options.envelope);
  const capture = envelope.capture;
  assertCaptureSafeForPersistence(capture);
  const assetBytes = new Map<string, Buffer>();
  for (const payload of envelope.assetPayloads) {
    const bytes = Buffer.from(payload.base64, "base64");
    if (bytes.byteLength !== payload.byteLength || sha256(bytes) !== payload.sha256) {
      throw new ShowKitError({
        code: "AssetIntegrityFailed",
        message: "A captured asset did not match its content hash. No captured page was saved.",
        recovery: "Capture the source flow again."
      });
    }
    assetBytes.set(payload.sha256, bytes);
  }
  if (capture.assets.some((asset) => !assetBytes.has(asset.sha256))) {
    throw new ShowKitError({
      code: "AssetIntegrityFailed",
      message: "A captured asset is missing. No captured page was saved.",
      recovery: "Capture the source flow again."
    });
  }
  const runDirectory = showkitPath("runs", options.runId);
  await replaceDirectoryAtomic(runDirectory, async (temporaryPath) => {
    await writeJsonAtomic(
      path.join(temporaryPath, "run.json"),
      RunEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: options.runId,
        command: "capture",
        state: "CAPTURED",
        captureId: capture.captureId,
        startedAt: options.startedAt,
        completedAt: new Date().toISOString()
      })
    );
    await writeJsonAtomic(path.join(temporaryPath, "capture.json"), capture);
    await writeJsonAtomic(path.join(temporaryPath, "environment.json"), {
      node: process.version,
      platform: process.platform,
      browser: capture.browser,
      viewport: capture.viewport,
      sourceMode: capture.source.kind
    });
    await writeJsonAtomic(path.join(temporaryPath, "verification.json"), {
      schemaVersion: SCHEMA_VERSION,
      passed: true,
      checks: [
        {
          name: "capture-policy",
          passed: true,
          detail: "The captured product flow passed persistence safety checks."
        },
        {
          name: "asset-integrity",
          passed: true,
          detail: `${capture.assets.length} captured assets match their content hashes.`
        },
        {
          name: "source-provenance",
          passed: true,
          detail: `The captured product flow records ${capture.source.replayLevel} provenance.`
        }
      ]
    });
    if (capture.assets.length > 0) {
      await mkdir(path.join(temporaryPath, "assets"), { recursive: true });
      await Promise.all(
        capture.assets.map(async (asset) => {
          const targetPath = path.join(temporaryPath, asset.path);
          const cachedPath = showkitPath(asset.path);
          if (await pathExists(cachedPath)) {
            const cachedBytes = await readFile(cachedPath);
            if (
              cachedBytes.byteLength !== asset.byteLength ||
              sha256(cachedBytes) !== asset.sha256
            ) {
              throw new ShowKitError({
                code: "AssetIntegrityFailed",
                message:
                  "A cached asset did not match its content hash. No captured page was saved.",
                recovery: "Remove the corrupted local asset, then capture the source flow again."
              });
            }
            await link(cachedPath, targetPath).catch(async () => {
              await writeFile(targetPath, cachedBytes);
            });
            return;
          }
          await writeFile(targetPath, assetBytes.get(asset.sha256)!);
        })
      );
    }
  });
  await Promise.allSettled(
    capture.assets.map(async (asset) => {
      const cachedPath = showkitPath(asset.path);
      if (await pathExists(cachedPath)) return;
      await mkdir(path.dirname(cachedPath), { recursive: true });
      await link(path.join(runDirectory, asset.path), cachedPath);
    })
  );
  await saveProject({
    ...options.project,
    latestCaptureRunId: options.runId
  });
  return {
    captureId: capture.captureId,
    path: path.join(runDirectory, "capture.json")
  };
}
