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
  FreshnessReportSchema,
  QualityReportSchema,
  RunEnvelopeSchema,
  SessionCaptureEnvelopeSchema,
  SkillCompatibilitySchema,
  StorySpecSchema,
  VerificationReportSchema
} from "../core/schemas.js";

type JsonSchema = Record<string, unknown>;

function freshnessReportJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(FreshnessReportSchema) as JsonSchema;
  const branches = Array.isArray(schema.anyOf)
    ? (schema.anyOf as JsonSchema[])
    : [];
  const failedResult = {
    type: "object",
    properties: { state: { const: "failed" } },
    required: ["state"]
  };
  const stepFailure = {
    properties: {
      steps: {
        type: "array",
        contains: failedResult,
        minContains: 1
      }
    },
    required: ["steps"]
  };
  const completionFailure = {
    properties: { completion: failedResult },
    required: ["completion"]
  };
  for (const branch of branches) {
    const properties = branch.properties as
      | Record<string, JsonSchema>
      | undefined;
    const status = properties?.status?.const;
    if (status === "out-of-date") {
      branch.allOf = [{ anyOf: [stepFailure, completionFailure] }];
    }
    if (status === "blocked") {
      branch.allOf = [
        {
          anyOf: [
            stepFailure,
            completionFailure,
            { required: ["sourceFailure"] }
          ]
        }
      ];
    }
  }
  return schema;
}

function captureSourceJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(CaptureSourceSchema) as JsonSchema;
  const properties = schema.properties as
    | Record<string, JsonSchema>
    | undefined;
  const steps = properties?.steps;
  if (steps) {
    steps.uniqueItems = true;
    steps["x-showkit-uniqueBy"] = "id";
  }
  return schema;
}

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema");
await mkdir(directory, { recursive: true });

const schemas = {
  "demo-fixture.json": z.toJSONSchema(DemoFixtureSchema),
  "capture-source.json": captureSourceJsonSchema(),
  "capture-envelope.json": z.toJSONSchema(CaptureEnvelopeSchema),
  "browser-flow-recipe.json": z.toJSONSchema(BrowserFlowRecipeSchema),
  "session-capture-envelope.json": z.toJSONSchema(SessionCaptureEnvelopeSchema),
  "run-envelope.json": z.toJSONSchema(RunEnvelopeSchema),
  "skill-compatibility.json": z.toJSONSchema(SkillCompatibilitySchema),
  "story-spec.json": z.toJSONSchema(StorySpecSchema),
  "artifact-manifest.json": z.toJSONSchema(ArtifactManifestSchema),
  "verification-report.json": z.toJSONSchema(VerificationReportSchema),
  "quality-report.json": z.toJSONSchema(QualityReportSchema),
  "freshness-report.json": freshnessReportJsonSchema()
};

await Promise.all(
  Object.entries(schemas).map(([name, schema]) =>
    writeFile(path.join(directory, name), `${JSON.stringify(schema, null, 2)}\n`)
  )
);
