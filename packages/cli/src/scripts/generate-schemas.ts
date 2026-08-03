import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ArtifactManifestSchema,
  BrowserFlowRecipeSchema,
  CaptureEnvelopeSchema,
  CaptureSourceSchema,
  DemoFixtureSchema,
  QualityReportSchema,
  RunEnvelopeSchema,
  SessionCaptureEnvelopeSchema,
  SkillCompatibilitySchema,
  StorySpecSchema,
  VerificationReportSchema
} from "../core/schemas.js";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema");
await mkdir(directory, { recursive: true });

const schemas = {
  "demo-fixture.json": z.toJSONSchema(DemoFixtureSchema),
  "capture-source.json": z.toJSONSchema(CaptureSourceSchema),
  "capture-envelope.json": z.toJSONSchema(CaptureEnvelopeSchema),
  "browser-flow-recipe.json": z.toJSONSchema(BrowserFlowRecipeSchema),
  "session-capture-envelope.json": z.toJSONSchema(SessionCaptureEnvelopeSchema),
  "run-envelope.json": z.toJSONSchema(RunEnvelopeSchema),
  "skill-compatibility.json": z.toJSONSchema(SkillCompatibilitySchema),
  "story-spec.json": z.toJSONSchema(StorySpecSchema),
  "artifact-manifest.json": z.toJSONSchema(ArtifactManifestSchema),
  "verification-report.json": z.toJSONSchema(VerificationReportSchema),
  "quality-report.json": z.toJSONSchema(QualityReportSchema)
};

await Promise.all(
  Object.entries(schemas).map(([name, schema]) =>
    writeFile(path.join(directory, name), `${JSON.stringify(schema, null, 2)}\n`)
  )
);
