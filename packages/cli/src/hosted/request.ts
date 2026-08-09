import type { ArtifactManifest } from "../core/schemas.js";
import {
  HOSTED_REQUEST_MAX_BYTES,
  HostedPublishRequestSchema,
  type HostedPublishRequest
} from "./contracts.js";

function titleFromStory(contents: Buffer): string {
  const source = contents.toString("utf8");
  const prefix = "window.__SHOWKIT_DEMO__ = ";
  if (!source.startsWith(prefix) || !source.endsWith(";\n")) {
    throw new Error("The built story does not use the supported inert-data wrapper.");
  }
  const value: unknown = JSON.parse(source.slice(prefix.length, -2));
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { title?: unknown }).title !== "string"
  ) {
    throw new Error("The built story has no demo title.");
  }
  return (value as { title: string }).title;
}

export function createHostedPublishRequest(options: {
  projectId: string;
  manifest: ArtifactManifest;
  contents: ReadonlyMap<string, Buffer>;
}): { request: HostedPublishRequest; json: string; bytes: number } {
  const player = options.manifest.files.find((file) => file.path === "player.js");
  const story = options.contents.get("story.js");
  if (!player || !story) throw new Error("The built demo is missing its approved player or story.");

  const input = {
    schemaVersion: "0.1",
    projectId: options.projectId,
    title: titleFromStory(story),
    visibility: "unlisted",
    artifact: {
      version: options.manifest.version,
      sourceCaptureHash: options.manifest.sourceCaptureHash,
      storyHash: options.manifest.storyHash,
      ...(options.manifest.freshness
        ? { freshness: options.manifest.freshness }
        : {}),
      builderVersion: options.manifest.builderVersion,
      runtimeHash: player.sha256,
      files: options.manifest.files,
      sanitization: options.manifest.sanitization,
      publish: null
    },
    files: options.manifest.files.map((file) => {
      const contents = options.contents.get(file.path);
      if (!contents) throw new Error(`The built demo is missing ${file.path}.`);
      return { ...file, encoding: "base64" as const, content: contents.toString("base64") };
    })
  };
  const unvalidatedJson = JSON.stringify(input);
  if (Buffer.byteLength(unvalidatedJson) > HOSTED_REQUEST_MAX_BYTES) {
    throw new Error("The hosted request is larger than 5 MiB.");
  }
  const request = HostedPublishRequestSchema.parse(input);
  const json = JSON.stringify(request);
  const bytes = Buffer.byteLength(json);
  if (bytes > HOSTED_REQUEST_MAX_BYTES) {
    throw new Error("The hosted request is larger than 5 MiB.");
  }
  return { request, json, bytes };
}
