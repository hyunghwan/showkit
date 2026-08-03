import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
      SHOWKIT_PROJECT_ROOT: projectDirectory
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
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
