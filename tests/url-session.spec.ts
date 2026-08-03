import { expect, test } from "@playwright/test";
import {
  createAgentBrowserCaptureEnvelope,
  writeSessionEnvelopeTemporary,
  type BrowserFlowRecipe,
  type CaptureStep,
  type Scene
} from "@showkit/cli";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "packages", "cli", "dist", "bin.js");
const queryCanary = "URL_QUERY_SECRET_CANARY_9D31";
const sessionCanary = "SHOWKIT_SECRET_CANARY_SESSION_IMPORT_4B21";

type CliResponse = {
  ok: boolean;
  status: string;
  error?: { code: string };
  [key: string]: unknown;
};

function runCli(
  projectDirectory: string,
  args: string[],
  expectedExitCode = 0
): CliResponse {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SHOWKIT_PROJECT_ROOT: projectDirectory
    },
    encoding: "utf8"
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedExitCode);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.stdout).not.toContain(queryCanary);
  expect(result.stderr).not.toContain(queryCanary);
  expect(result.stdout).not.toContain(sessionCanary);
  expect(result.stderr).not.toContain(sessionCanary);
  return JSON.parse(result.stdout.trim()) as CliResponse;
}

function scene(index: number, terminal = false): Scene {
  const id = `session-step-${index}`;
  const label = terminal ? "Session report ready" : `View ${index}`;
  return {
    html: terminal
      ? `<main data-showkit-scene-root=""><h1>${label}</h1></main>`
      : `<main data-showkit-scene-root=""><button role="button" data-showkit-anchor="sk-${id}">${label}</button></main>`,
    nodes: [
      {
        type: "element",
        tag: "main",
        attributes: { "data-showkit-scene-root": "" },
        styles: {},
        children: [
          {
            type: "element",
            tag: terminal ? "h1" : "button",
            attributes: terminal
              ? {}
              : {
                  role: "button",
                  "data-showkit-anchor": `sk-${id}`
                },
            styles: {},
            children: [{ type: "text", text: label }]
          }
        ]
      }
    ],
    viewport: { width: 1280, height: 720 },
    ...(terminal
      ? {}
      : {
          anchorId: `sk-${id}`,
          target: {
            tag: "button",
            role: "button",
            name: label,
            bounds: {
              x: 0.1,
              y: Number((0.08 + index * 0.09).toFixed(2)),
              width: 0.18,
              height: 0.07
            }
          }
        })
  };
}

function sessionEnvelope() {
  const recipe: BrowserFlowRecipe = {
    schemaVersion: "0.1",
    id: "signed-in-session",
    host: "codex",
    browserSurface: "iab",
    adapterVersion: "0.1.0",
    url: {
      origin: "https://app.example.test",
      path: "/dashboard"
    },
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    steps: Array.from({ length: 5 }, (_, index) => ({
      id: `session-step-${index + 1}`,
      title: `Review state ${index + 1}`,
      target: {
        strategy: "role" as const,
        role: "button",
        name: `View ${index + 1}`
      },
      actionKind: index === 1 ? ("filter" as const) : ("navigate" as const)
    }))
  };
  const steps: CaptureStep[] = recipe.steps.map((step, index) => ({
    id: step.id,
    title: step.title,
    scene: scene(index + 1),
    evidence: [
      {
        id: `ev-session-${index + 1}`,
        text: `View ${index + 1}`
      }
    ],
    actionOutcome: {
      url: `https://app.example.test/dashboard/state-${index + 1}`,
      title: `State ${index + 1}`
    }
  }));
  return createAgentBrowserCaptureEnvelope({
    recipe,
    browser: "chromium",
    steps,
    terminalScene: scene(6, true),
    assetPayloads: [],
    excludedSurfaces: [
      "scripts",
      "forms",
      "browser-storage",
      "network-data",
      "remote-decorative-assets"
    ]
  });
}

async function generatedText(root: string): Promise<string> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else output.push(await readFile(filePath, "utf8"));
    }
  };
  await visit(root);
  return output.join("\n");
}

test("imports a private 5-step browser session and marks it session-captured", async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-url-session-"));
  try {
    runCli(projectDirectory, ["init"]);
    const envelope = sessionEnvelope();
    const envelopePath = await writeSessionEnvelopeTemporary(envelope);
    const captured = runCli(projectDirectory, ["capture", "session", envelopePath]);
    await expect(access(envelopePath)).rejects.toThrow();
    expect(captured).toEqual(
      expect.objectContaining({
        status: "captured",
        sourceMode: "agent-browser-session",
        replayLevel: "session-captured",
        stepCount: 5,
        fullSceneRasterCount: 0
      })
    );
    const persistedCapture = JSON.parse(
      await readFile(String(captured.path), "utf8")
    );
    expect(persistedCapture.source).toEqual(
      expect.objectContaining({
        kind: "agent-browser-session",
        sessionPersisted: false,
        replayLevel: "session-captured"
      })
    );
    expect(JSON.stringify(persistedCapture)).not.toMatch(/[?#]/);

    const secondPath = await writeSessionEnvelopeTemporary(envelope);
    const repeated = runCli(projectDirectory, ["capture", "session", secondPath]);
    expect(repeated.captureId).toBe(captured.captureId);
    expect(repeated.runId).not.toBe(captured.runId);

    const built = runCli(projectDirectory, ["build", "web,markdown"]);
    const manifest = JSON.parse(
      await readFile(path.join(String(built.path), "artifact.json"), "utf8")
    );
    expect(manifest.replayLevel).toBe("session-captured");
    expect(manifest.source.kind).toBe("agent-browser-session");
    expect(manifest.dependencies.captureRuntime.kind).toBe("agent-browser-adapter");
    expect(manifest.dependencies.playwright).not.toHaveProperty("capturedWith");
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("deletes a rejected envelope and leaves only a content-free diagnostic", async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-url-blocked-"));
  try {
    runCli(projectDirectory, ["init"]);
    const goodPath = await writeSessionEnvelopeTemporary(sessionEnvelope());
    const good = runCli(projectDirectory, ["capture", "session", goodPath]);
    const projectBefore = JSON.parse(
      await readFile(path.join(projectDirectory, ".showkit", "project.json"), "utf8")
    );

    const unsafe = structuredClone(sessionEnvelope());
    unsafe.capture.steps[0]!.actionOutcome.url =
      `https://app.example.test/dashboard?token=${queryCanary}#private`;
    const unsafePath = path.join(
      os.tmpdir(),
      `showkit-unsafe-session-${randomUUID()}.json`
    );
    await writeFile(unsafePath, `${JSON.stringify(unsafe)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    const rejected = runCli(
      projectDirectory,
      ["capture", "session", unsafePath],
      2
    );
    expect(rejected.error?.code).toBe("PageUrlInvalid");
    await expect(access(unsafePath)).rejects.toThrow();

    const projectAfter = JSON.parse(
      await readFile(path.join(projectDirectory, ".showkit", "project.json"), "utf8")
    );
    expect(projectAfter.latestCaptureRunId).toBe(projectBefore.latestCaptureRunId);
    expect(good.captureId).toBeDefined();
    expect(await generatedText(path.join(projectDirectory, ".showkit"))).not.toContain(
      queryCanary
    );

    const sensitive = structuredClone(sessionEnvelope());
    sensitive.capture.steps[0]!.evidence[0]!.text = sessionCanary;
    const sensitivePath = path.join(
      os.tmpdir(),
      `showkit-sensitive-session-${randomUUID()}.json`
    );
    await writeFile(sensitivePath, `${JSON.stringify(sensitive)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    const sensitiveRejected = runCli(
      projectDirectory,
      ["capture", "session", sensitivePath],
      2
    );
    expect(sensitiveRejected.error?.code).toBe("SensitiveDataDetected");
    await expect(access(sensitivePath)).rejects.toThrow();
    expect(await generatedText(path.join(projectDirectory, ".showkit"))).not.toContain(
      sessionCanary
    );
    const projectAfterSensitive = JSON.parse(
      await readFile(path.join(projectDirectory, ".showkit", "project.json"), "utf8")
    );
    expect(projectAfterSensitive.latestCaptureRunId).toBe(
      projectBefore.latestCaptureRunId
    );
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("rejects and deletes a non-private temporary envelope", async () => {
  test.skip(process.platform === "win32", "POSIX file modes are not available on Windows.");
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-url-mode-"));
  const envelopePath = path.join(os.tmpdir(), `showkit-mode-${randomUUID()}.json`);
  try {
    runCli(projectDirectory, ["init"]);
    await writeFile(envelopePath, `${JSON.stringify(sessionEnvelope())}\n`, {
      flag: "wx",
      mode: 0o644
    });
    expect((await stat(envelopePath)).mode & 0o777).toBe(0o644);
    const rejected = runCli(
      projectDirectory,
      ["capture", "session", envelopePath],
      3
    );
    expect(rejected.error?.code).toBe("DemoFixtureSetupFailed");
    await expect(access(envelopePath)).rejects.toThrow();
  } finally {
    await rm(envelopePath, { force: true });
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
