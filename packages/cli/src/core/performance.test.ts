import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDemo } from "../build/build.js";
import {
  CaptureSourceSchema,
  SCHEMA_VERSION,
  StorySpecSchema,
  type CaptureSource,
  type StorySpec
} from "./schemas.js";
import { validateStory } from "./validate.js";

const temporaryRoots: string[] = [];

function fiftyStepProject(): { capture: CaptureSource; story: StorySpec } {
  const stepIds = Array.from({ length: 50 }, (_, index) => `step-${index + 1}`);
  const capture = CaptureSourceSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    captureId: "capture-performance",
    source: {
      kind: "playwright-spec",
      specHash: "a".repeat(64),
      runtime: "playwright-test",
      runtimeVersion: "1.62.0",
      replayLevel: "ci-replayable"
    },
    fixtureHash: "b".repeat(64),
    browser: "chromium",
    fixture: {
      schemaVersion: SCHEMA_VERSION,
      id: "performance-flow",
      baseURL: "http://127.0.0.1:4173",
      startPath: "/performance",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      timezoneId: "UTC",
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
      },
      steps: stepIds.map((id, index) => ({
        id,
        title: `Review state ${index + 1}`,
        target: {
          strategy: "role",
          role: "button",
          name: `Continue ${index + 1}`
        }
      }))
    },
    viewport: { width: 1280, height: 720 },
    steps: stepIds.map((id, index) => ({
      id,
      title: `Review state ${index + 1}`,
      scene: {
        html: `<main data-showkit-scene-root=""><button role="button" data-showkit-anchor="sk-${id}">Continue ${index + 1}</button></main>`,
        nodes: [
          {
            type: "element",
            tag: "main",
            attributes: { "data-showkit-scene-root": "" },
            styles: {},
            children: [
              {
                type: "element",
                tag: "button",
                attributes: {
                  role: "button",
                  "data-showkit-anchor": `sk-${id}`
                },
                styles: {},
                children: [{ type: "text", text: `Continue ${index + 1}` }]
              }
            ]
          }
        ],
        viewport: { width: 1280, height: 720 },
        anchorId: `sk-${id}`,
        target: {
          tag: "button",
          role: "button",
          name: `Continue ${index + 1}`,
          bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 }
        }
      },
      evidence: [{ id: `ev-${index + 1}`, text: `Continue ${index + 1}` }],
      actionOutcome: {
        url: `http://127.0.0.1:4173/performance/${index + 1}`,
        title: `State ${index + 1}`
      }
    })),
    terminalScene: {
      html: '<main data-showkit-scene-root=""><h1>Complete</h1></main>',
      nodes: [
        {
          type: "element",
          tag: "main",
          attributes: { "data-showkit-scene-root": "" },
          styles: {},
          children: [
            {
              type: "element",
              tag: "h1",
              attributes: {},
              styles: {},
              children: [{ type: "text", text: "Complete" }]
            }
          ]
        }
      ],
      viewport: { width: 1280, height: 720 }
    },
    assets: [],
    redaction: {
      policyChecksPassed: true,
      excludedSurfaces: ["scripts"],
      fullSceneRasterCount: 0
    }
  });
  const story = StorySpecSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: "performance-story",
    sourceCaptureId: capture.captureId,
    title: "Fifty-step performance proof",
    audience: "Release teams",
    goal: "Verify the documented local performance budgets.",
    locale: "en-US",
    steps: capture.steps.map((step, index) => ({
      id: step.id,
      captureStepId: step.id,
      anchorId: step.scene.anchorId,
      tooltip: {
        title: step.title,
        body: step.evidence[0]!.text,
        placement: "auto"
      },
      evidenceIds: [step.evidence[0]!.id],
      advance: "hotspot"
    })),
    theme: {
      accent: "#ff5a36",
      ink: "#17211b",
      paper: "#f3efe6"
    },
    formats: ["web", "markdown"]
  });
  return { capture, story };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Milestone 1 performance budgets", () => {
  it("validates 50 steps under 3 seconds and builds them under 10 seconds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "showkit-performance-"));
    temporaryRoots.push(root);
    const runDirectory = path.join(root, ".showkit", "runs", "capture");
    await mkdir(runDirectory, { recursive: true });
    const { capture, story } = fiftyStepProject();

    const validateStartedAt = performance.now();
    expect(validateStory(capture, story).verification.passed).toBe(true);
    expect(performance.now() - validateStartedAt).toBeLessThan(3_000);

    const previousRoot = process.env.SHOWKIT_PROJECT_ROOT;
    const previousEpoch = process.env.SOURCE_DATE_EPOCH;
    process.env.SHOWKIT_PROJECT_ROOT = root;
    process.env.SOURCE_DATE_EPOCH = "0";
    try {
      const buildStartedAt = performance.now();
      const result = await buildDemo(capture, story, runDirectory);
      expect(performance.now() - buildStartedAt).toBeLessThan(10_000);
      expect(result.manifest.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "index.html" }),
          expect.objectContaining({ path: "story.js" })
        ])
      );
    } finally {
      if (previousRoot === undefined) delete process.env.SHOWKIT_PROJECT_ROOT;
      else process.env.SHOWKIT_PROJECT_ROOT = previousRoot;
      if (previousEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = previousEpoch;
    }
  });
});
