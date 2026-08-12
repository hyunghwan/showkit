import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/bin.js");

function runCli(projectDirectory: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SHOWKIT_PROJECT_ROOT: projectDirectory,
      SHOWKIT_TEST_REUSE_FIXTURE_SERVER: "true"
    },
    encoding: "utf8"
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

test("captures 25 steps under 30 seconds", async () => {
  test.setTimeout(45_000);
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-capture-budget-"));
  try {
    runCli(projectDirectory, ["init"]);
    const startedAt = performance.now();
    const capture = runCli(projectDirectory, [
      "capture",
      "fixtures/demo-apps/performance/performance.demo.ts"
    ]);
    expect(performance.now() - startedAt).toBeLessThan(30_000);
    expect(capture.stepCount).toBe(25);
    expect(capture.fullSceneRasterCount).toBe(0);
    expect(capture.capturePerformance).toEqual(
      expect.objectContaining({
        htmlSceneCount: 26,
        actionCount: 25,
        sceneExtractionMs: expect.any(Number),
        actionMs: expect.any(Number),
        totalMs: expect.any(Number)
      })
    );
    const capturePerformance = capture.capturePerformance as {
      htmlSceneCount: number;
      sceneExtractionMs: number;
    };
    console.log(
      `SHOWKIT_CAPTURE_PERFORMANCE ${JSON.stringify(capture.capturePerformance)}`
    );
    expect(
      capturePerformance.sceneExtractionMs /
        capturePerformance.htmlSceneCount
    ).toBeLessThan(340);
    expect(
      await readFile(String(capture.path), "utf8")
    ).not.toContain("capturePerformance");
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
