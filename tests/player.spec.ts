import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/bin.js");
const cliVersion = (
  JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/cli/package.json"), "utf8")
  ) as { version: string }
).version;
const canary = "SHOWKIT_SECRET_CANARY_7F92D1A4";
const hostilePageCanary = "SHOWKIT_HOSTILE_PAGE_CANARY_71A4";
const sensitiveTitleCanary = "SHOWKIT_SECRET_CANARY_TITLE_93C1";

type CliResponse = {
  ok: boolean;
  status: string;
  error?: {
    code: string;
    message?: string;
    recovery?: string;
    details?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

type CaptureFixtureData = {
  captureId: string;
  fixture: {
    lifecycle: { setup: string; teardown: string };
    auth: { storageState: string; persisted: boolean };
    debug: { screenshot: string; traceBuildInput: boolean; video: string };
    steps: unknown[];
  };
  steps: Array<{
    id: string;
    title: string;
    scene: { anchorId: string };
    evidence: Array<{ id: string; text: string }>;
  }>;
};

function storyForCapture(
  capture: CaptureFixtureData,
  options: { id: string; title: string; goal: string; nextStepIndex?: number }
): Record<string, unknown> {
  return {
    schemaVersion: "0.1",
    id: options.id,
    sourceCaptureId: capture.captureId,
    title: options.title,
    audience: "Release teams",
    goal: options.goal,
    locale: "en-US",
    welcome: {
      title: "Welcome to the product demo",
      body: options.goal,
      actionLabel: "Explore demo",
      backdrop: "heavy"
    },
    steps: capture.steps.map((step, index) => ({
      id: step.id,
      captureStepId: step.id,
      anchorId: step.scene.anchorId,
      tooltip: {
        title: step.title,
        body: step.evidence[0]!.text,
        placement: "auto",
        backdrop: index === 1 ? "medium" : "off"
      },
      evidenceIds: [step.evidence[0]!.id],
      advance: index === options.nextStepIndex ? "next" : "hotspot"
    })),
    theme: {
      accent: "#ff5a36",
      ink: "#17211b",
      paper: "#f3efe6"
    },
    player: {
      chrome: {
        mode: "overlay",
        placements: {
          title: "hidden",
          goal: "hidden",
          stepCount: "tooltip",
          progress: "tooltip",
          back: "tooltip",
          restart: "tooltip",
          cta: "tooltip"
        }
      },
      navigation: "controls"
    },
    completion: {
      title: "Ready to create your demo?",
      body: "Email us to discuss an interactive HTML demo for your product.",
      actions: [
        {
          label: "Email us for a demo",
          href: "mailto:hello@sqncs.com?subject=ShowKit%20demo%20request",
          style: "primary"
        }
      ]
    },
    formats: ["web", "markdown"]
  };
}

function runCli(
  projectDirectory: string,
  args: string[],
  expectedExitCode = 0,
  environment: Record<string, string> = {}
): CliResponse {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SHOWKIT_PROJECT_ROOT: projectDirectory,
      SHOWKIT_TEST_REUSE_FIXTURE_SERVER: "true",
      ...environment
    },
    encoding: "utf8"
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedExitCode);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout.trim()) as CliResponse;
}

async function allFileContents(root: string): Promise<Array<{ path: string; contents: string }>> {
  const output: Array<{ path: string; contents: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const filePath = path.join(directory, entry);
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        await visit(filePath);
      } else {
        output.push({ path: filePath, contents: await readFile(filePath, "utf8") });
      }
    }
  };
  await visit(root);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function startPortableStaticServer(
  directory: string
): Promise<{ server: Server; url: string }> {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "artifact.json"), "utf8")
  ) as { files: Array<{ path: string; mediaType: string }> };
  const mediaTypes = new Map(manifest.files.map((file) => [file.path, file.mediaType]));
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const filePath = path.resolve(directory, relativePath);
      if (!filePath.startsWith(`${path.resolve(directory)}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const contents = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": mediaTypes.get(relativePath) ?? "application/octet-stream",
        "Content-Length": contents.byteLength
      });
      response.end(contents);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test.describe("Milestone 1 local workflow", () => {
  let projectDirectory: string;
  let previewProcess: ChildProcessWithoutNullStreams;
  let previewUrl: string;
  let portableServer: Server;
  let portableUrl: string;
  let customOverlayServer: Server;
  let customOverlayUrl: string;
  let frameServer: Server;
  let frameUrl: string;
  let hotspotsOnlyServer: Server;
  let hotspotsOnlyUrl: string;
  let noCoverServer: Server;
  let noCoverUrl: string;
  let artifactDirectory: string;
  let firstVersion: string;
  let baseAssetRevision: string;
  let unchangedDiff: CliResponse;
  let changedDiff: CliResponse;
  let checkedDiff: CliResponse;
  let recoveredVersion: string;
  let freshnessSpecDirectory: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-player-"));
    expect(runCli(projectDirectory, ["init"]).status).toBe("created");
    const localIgnore = await readFile(
      path.join(projectDirectory, ".showkit", ".gitignore"),
      "utf8"
    );
    expect(localIgnore).toContain("credentials/");
    expect(localIgnore).toContain("runs/*/trace.zip");
    const doctorStartedAt = performance.now();
    const doctor = runCli(projectDirectory, ["doctor", "--report"]);
    expect(performance.now() - doctorStartedAt).toBeLessThan(2_000);
    expect(doctor.status).toBe("cli-ready");
    expect(doctor).toEqual(
      expect.objectContaining({
        cliVersion,
        readiness: expect.objectContaining({
          cli: true,
          capture: expect.objectContaining({
            static: true,
            openaiBrowser: false,
            codexBrowser: false,
            claudeBrowser: true
          })
        }),
        supportReport: expect.objectContaining({ redacted: true })
      })
    );
    const reportPath = String(
      (doctor.supportReport as { path: string }).path
    );
    const supportReport = await readFile(reportPath, "utf8");
    expect(supportReport).toContain('"paths": "redacted"');
    expect(supportReport).not.toContain(projectDirectory);
    const openAIBrowserDoctor = runCli(projectDirectory, [
      "doctor",
      "--capability",
      "openai-browser"
    ]);
    expect(openAIBrowserDoctor.status).toBe("host-verification-required");
    const claudeBrowserDoctor = runCli(projectDirectory, [
      "doctor",
      "--capability",
      "claude-browser"
    ]);
    expect(claudeBrowserDoctor).toEqual(
      expect.objectContaining({
        status: "fallback-ready",
        checks: expect.objectContaining({
          claudeBrowser: expect.objectContaining({
            builtInChromeCapture: "blocked-no-isolated-world",
            assessedHostCapability: "javascript_tool-page-context",
            policy: "capability-gated",
            verification: "playwright-isolated-world-ready"
          })
        })
      })
    );
    const capture = runCli(projectDirectory, [
      "capture",
      "fixtures/demo-apps/public/public.demo.ts"
    ]);
    expect(capture.stepCount).toBe(3);
    expect(capture.fullSceneRasterCount).toBe(0);
    expect(capture.playwrightProject).toBe("chromium");
    const repeatedCapture = runCli(projectDirectory, [
      "capture",
      "fixtures/demo-apps/public/public.demo.ts",
      "--project",
      "chromium"
    ]);
    expect(repeatedCapture.runId).not.toBe(capture.runId);
    expect(repeatedCapture.captureId).toBe(capture.captureId);

    const captureSource = JSON.parse(
      await readFile(String(capture.path), "utf8")
    ) as CaptureFixtureData;
    expect(captureSource.fixture).toEqual(
      expect.objectContaining({
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
        }
      })
    );
    expect(captureSource.fixture.steps).toHaveLength(3);
    expect(JSON.stringify(captureSource)).not.toContain("storageStatePath");

    const launchStoryPath = path.join(projectDirectory, "product-insights-story.json");
    const launchStory = storyForCapture(captureSource, {
      id: "product-insights-story",
      title: "Product insights walkthrough",
      goal: "Explore the verified product flow at your own pace.",
      nextStepIndex: 1
    });
    await writeFile(
      launchStoryPath,
      `${JSON.stringify(launchStory, null, 2)}\n`
    );
    const appliedStory = runCli(projectDirectory, ["story", "apply", launchStoryPath]);
    expect(appliedStory).toEqual(
      expect.objectContaining({
        status: "applied",
        runId: expect.stringMatching(/^run-/),
        version: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
    const appliedRun = JSON.parse(
      await readFile(
        path.join(
          projectDirectory,
          ".showkit",
          "runs",
          String(appliedStory.runId),
          "run.json"
        ),
        "utf8"
      )
    );
    expect(appliedRun).toEqual(
      expect.objectContaining({
        state: "VALIDATED",
        command: "story-apply",
        storyVersion: appliedStory.version
      })
    );
    expect(String(appliedStory.path)).toContain(
      path.join(
        ".showkit",
        "stories",
        "product-insights-story",
        String(appliedStory.version),
        "story.json"
      )
    );
    const repeatedStory = runCli(projectDirectory, ["story", "apply", launchStoryPath]);
    expect(repeatedStory.version).toBe(appliedStory.version);
    expect(repeatedStory.runId).not.toBe(appliedStory.runId);
    expect(repeatedStory.reused).toBe(true);
    const invalidStoryPath = path.join(projectDirectory, "invalid-story.json");
    await writeFile(
      invalidStoryPath,
      `${JSON.stringify({ ...launchStory, title: "" }, null, 2)}\n`
    );
    const invalidStory = runCli(
      projectDirectory,
      ["story", "apply", invalidStoryPath],
      2
    );
    expect(invalidStory.error).toEqual(
      expect.objectContaining({
        code: "StorySpecInvalid",
        details: {
          issues: [
            expect.objectContaining({
              pointer: "/title"
            })
          ]
        }
      })
    );
    expect(
      JSON.parse(
        await readFile(path.join(projectDirectory, ".showkit", "project.json"), "utf8")
      )
    ).toEqual(
      expect.objectContaining({
        latestStoryId: "product-insights-story",
        latestStoryVersion: appliedStory.version
      })
    );

    const firstBuild = runCli(projectDirectory, ["build", "web,markdown"]);
    expect(firstBuild.status).toBe("built");
    const firstBuildRun = JSON.parse(
      await readFile(
        path.join(
          projectDirectory,
          ".showkit",
          "runs",
          String(firstBuild.runId),
          "run.json"
        ),
        "utf8"
      )
    );
    expect(firstBuildRun).toEqual(
      expect.objectContaining({
        state: "BUILT",
        command: "build",
        storyVersion: appliedStory.version,
        artifactVersion: firstBuild.version
      })
    );
    firstVersion = String(firstBuild.version);
    artifactDirectory = String(firstBuild.path);
    const playerStyles = await readFile(
      path.join(artifactDirectory, "styles.css"),
      "utf8"
    );
    const playerIndex = await readFile(
      path.join(artifactDirectory, "index.html"),
      "utf8"
    );
    const assetRevisions = Array.from(
      playerIndex.matchAll(
        /(?:styles\.css|story\.js|player\.js)\?v=([a-f0-9]{16})/g
      ),
      (match) => match[1]
    );
    expect(assetRevisions).toHaveLength(3);
    expect(new Set(assetRevisions).size).toBe(1);
    baseAssetRevision = assetRevisions[0]!;
    expect(playerStyles).toMatch(
      /\.scene-viewport \*\s*\{[^}]*margin:\s*0;[^}]*padding:\s*0;/s
    );
    expect(playerStyles).not.toMatch(
      /\.welcome-layer\[data-backdrop="(?:light|medium|heavy)"\]\s*\{[^}]*backdrop-filter/s
    );
    const repeatedBuild = runCli(projectDirectory, ["build", "web,markdown"]);
    expect(repeatedBuild.status).toBe("unchanged");
    expect(repeatedBuild.version).toBe(firstVersion);
    expect(repeatedBuild.runId).not.toBe(firstBuild.runId);
    const portable = await startPortableStaticServer(artifactDirectory);
    portableServer = portable.server;
    portableUrl = portable.url;

    const faultStoryPath = path.join(projectDirectory, "fault-story.json");
    await writeFile(
      faultStoryPath,
      `${JSON.stringify(
        storyForCapture(captureSource, {
          id: "fault-story",
          title: "A build that must not replace the previous demo",
          goal: "Prove atomic build recovery."
        }),
        null,
        2
      )}\n`
    );
    expect(runCli(projectDirectory, ["story", "apply", faultStoryPath]).status).toBe("applied");
    const failedBuild = runCli(
      projectDirectory,
      ["build", "web,markdown"],
      3,
      { SHOWKIT_FAULT_INJECTION: "artifact-write" }
    );
    expect(failedBuild.error?.code).toBe("ArtifactBuildFailed");
    const projectAfterFailure = JSON.parse(
      await readFile(path.join(projectDirectory, ".showkit/project.json"), "utf8")
    ) as { latestArtifactVersion: string };
    expect(projectAfterFailure.latestArtifactVersion).toBe(firstVersion);
    expect(
      (await readdir(path.join(projectDirectory, ".showkit/artifacts"))).some((name) =>
        name.includes(".tmp-")
      )
    ).toBe(false);
    const lifecycleRuns = await Promise.all(
      (await readdir(path.join(projectDirectory, ".showkit", "runs"))).map(
        async (runName) =>
          JSON.parse(
            await readFile(
              path.join(projectDirectory, ".showkit", "runs", runName, "run.json"),
              "utf8"
            )
          )
      )
    );
    expect(lifecycleRuns).toContainEqual(
      expect.objectContaining({
        state: "BLOCKED_DIAGNOSTIC",
        command: "build",
        failure: { code: "ArtifactBuildFailed" }
      })
    );
    const operations = await readFile(
      path.join(projectDirectory, ".showkit", "logs", "operations.ndjson"),
      "utf8"
    );
    expect(operations).toContain('"code":"StorySpecInvalid"');
    expect(operations).toContain('"code":"ArtifactBuildFailed"');

    previewProcess = spawn(process.execPath, [cliPath, "preview", "--port", "4395", "--json"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SHOWKIT_PROJECT_ROOT: projectDirectory
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error("Preview did not start.")), 5_000);
      previewProcess.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timeout);
          resolve(buffer.slice(0, newline));
        }
      });
      previewProcess.once("error", reject);
    });
    const preview = JSON.parse(output) as CliResponse;
    previewUrl = String(preview.url);
    expect(preview.visibility).toBe("local");
    expect(preview.published).toBe(false);

    const baseManifest = path.join(artifactDirectory, "artifact.json");
    const showkitFilesBeforeFreshness = await allFileContents(
      path.join(projectDirectory, ".showkit")
    );
    const captureRunsBeforeFreshness = await readdir(
      path.join(projectDirectory, ".showkit", "runs")
    );
    await mkdir(path.join(repositoryRoot, "test-results"), {
      recursive: true
    });
    freshnessSpecDirectory = await mkdtemp(
      path.join(repositoryRoot, "test-results", ".freshness-report-")
    );
    const invalidManifestPath = path.join(
      freshnessSpecDirectory,
      "invalid-artifact.json"
    );
    await writeFile(invalidManifestPath, "{not-json}\n");
    expect(
      runCli(
        projectDirectory,
        ["diff", "--base", "--source", "fixtures/demo-apps/public/public.demo.ts"],
        2
      ).error?.code
    ).toBe("ArtifactBaseMissing");
    expect(
      runCli(
        projectDirectory,
        [
          "diff",
          "--base",
          "missing-artifact.json",
          "--source",
          "fixtures/demo-apps/public/public.demo.ts"
        ],
        2
      ).error?.code
    ).toBe("ArtifactBaseMissing");
    expect(
      runCli(
        projectDirectory,
        [
          "diff",
          "--base",
          invalidManifestPath,
          "--source",
          "fixtures/demo-apps/public/public.demo.ts"
        ],
        2
      ).error?.code
    ).toBe("ArtifactBaseInvalid");

    const baseManifestContents = JSON.parse(
      await readFile(baseManifest, "utf8")
    ) as Record<string, unknown>;
    const legacyManifestPath = path.join(
      freshnessSpecDirectory,
      "legacy-artifact.json"
    );
    const legacyManifest = structuredClone(baseManifestContents);
    delete legacyManifest.freshness;
    await writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest)}\n`);
    expect(
      runCli(
        projectDirectory,
        [
          "diff",
          "--base",
          legacyManifestPath,
          "--source",
          "fixtures/demo-apps/public/public.demo.ts"
        ],
        2
      ).error?.code
    ).toBe("FreshnessBaselineMissing");

    const unsupportedManifestPath = path.join(
      freshnessSpecDirectory,
      "unsupported-artifact.json"
    );
    const unsupportedManifest = {
      ...structuredClone(baseManifestContents),
      replayLevel: "session-captured"
    };
    await writeFile(
      unsupportedManifestPath,
      `${JSON.stringify(unsupportedManifest)}\n`
    );
    expect(
      runCli(
        projectDirectory,
        [
          "diff",
          "--base",
          unsupportedManifestPath,
          "--source",
          "fixtures/demo-apps/public/public.demo.ts"
        ],
        2
      ).error?.code
    ).toBe("FreshnessSourceUnsupported");
    expect(
      runCli(
        projectDirectory,
        [
          "diff",
          "--base",
          baseManifest,
          "--source",
          "missing-source.demo.ts"
        ],
        2
      ).error?.code
    ).toBe("CaptureSourceMissing");
    expect(
      runCli(
        projectDirectory,
        [
          "diff",
          "--base",
          baseManifest,
          "--source",
          "fixtures/demo-apps/public/public.demo.ts",
          "--viewport",
          "invalid"
        ],
        2
      ).error?.code
    ).toBe("DemoFixtureSetupFailed");

    const sourceFreshness = runCli(projectDirectory, [
      "diff",
      "--base",
      baseManifest,
      "--source",
      "fixtures/demo-apps/public/public.demo.ts",
      "--check"
    ]);
    expect(sourceFreshness).toEqual(
      expect.objectContaining({
        status: "fresh",
        sourceMode: "playwright-spec",
        playwrightProject: "chromium",
        expectedViewport: { width: 1440, height: 900 },
        freshness: expect.objectContaining({
          status: "fresh",
          previousDemoChanged: false,
          steps: expect.arrayContaining([
            expect.objectContaining({ state: "fresh" })
          ]),
          completion: expect.objectContaining({ state: "fresh" })
        })
      })
    );
    expect(
      await readdir(path.join(projectDirectory, ".showkit", "runs"))
    ).toEqual(captureRunsBeforeFreshness);

    const renamedProjectManifestPath = path.join(
      freshnessSpecDirectory,
      "renamed-project-artifact.json"
    );
    const renamedProjectManifest = structuredClone(baseManifestContents) as {
      source: { projectName?: string };
    };
    renamedProjectManifest.source.projectName = "renamed-project";
    await writeFile(
      renamedProjectManifestPath,
      `${JSON.stringify(renamedProjectManifest)}\n`
    );
    expect(
      runCli(projectDirectory, [
        "diff",
        "--base",
        renamedProjectManifestPath,
        "--source",
        "fixtures/demo-apps/public/public.demo.ts",
        "--project",
        "chromium",
        "--check"
      ])
    ).toEqual(
      expect.objectContaining({
        status: "fresh",
        playwrightProject: "chromium"
      })
    );

    const stoppedSourcePath = path.join(
      freshnessSpecDirectory,
      "stopped-source.demo.ts"
    );
    const changedSourcePath = path.join(
      freshnessSpecDirectory,
      "changed-source.demo.ts"
    );
    const diagnosticTitleCanary =
      "SHOWKIT_SECRET_CANARY_STEP_DIAGNOSTIC";
    await writeFile(
      changedSourcePath,
      `import { expect, test } from "@showkit/cli/playwright";

test("reports a changed product state", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");
  await page.getByRole("heading", { name: "Know what changed before conversion moves." }).evaluate((heading) => {
    heading.textContent = "Know what changed before the launch moves.";
  });

  const steps = [
    ["open-session-filters", "Open session filters", "Add filter"],
    ["focus-engaged-visitors", "Focus on engaged visitors", "Engaged visitors"],
    ["review-friction-insight", "Review checkout friction", "Review friction insight"]
  ] as const;

  for (const [id, title, accessibleName] of steps) {
    const target = page.getByRole("button", { name: accessibleName });
    await demo.step({
      id,
      title,
      target,
      captureTarget: { strategy: "role", role: "button", name: accessibleName },
      action: () => target.click()
    });
  }

  await expect(page.getByRole("heading", { name: "Checkout friction" })).toBeVisible();
});
`
    );
    const changedSource = runCli(
      projectDirectory,
      [
        "diff",
        "--base",
        baseManifest,
        "--source",
        changedSourcePath,
        "--check"
      ],
      2
    );
    expect(changedSource.error).toEqual(
      expect.objectContaining({
        code: "ArtifactDriftDetected",
        message: "This demo is out of date. Your previous demo has not changed.",
        details: {
          freshness: expect.objectContaining({
            status: "out-of-date",
            previousDemoChanged: false,
            steps: expect.arrayContaining([
              expect.objectContaining({
                stepId: "open-session-filters",
                state: "failed",
                recovery: expect.any(String)
              })
            ])
          })
        }
      })
    );
    const changedSourceWithoutCheck = runCli(projectDirectory, [
      "diff",
      "--base",
      baseManifest,
      "--source",
      changedSourcePath
    ]);
    expect(changedSourceWithoutCheck).toEqual(
      expect.objectContaining({
        status: "out-of-date",
        freshness: expect.objectContaining({
          status: "out-of-date",
          steps: expect.arrayContaining([
            expect.objectContaining({ state: "failed" })
          ])
        })
      })
    );
    await writeFile(
      stoppedSourcePath,
      `import { test } from "@showkit/cli/playwright";

test("reports an interrupted source flow", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");

  const firstTarget = page.getByRole("button", { name: "Add filter" });
  await demo.step({
    id: "open-session-filters",
    title: "Open session filters",
    target: firstTarget,
    captureTarget: { strategy: "role", role: "button", name: "Add filter" },
    action: () => firstTarget.click()
  });

  const secondTarget = page.getByRole("button", { name: "Engaged visitors" });
  await demo.step({
    id: "focus-engaged-visitors",
    title: "${diagnosticTitleCanary}",
    target: secondTarget,
    captureTarget: { strategy: "role", role: "button", name: "Engaged visitors" },
    action: async () => {
      console.error(
        "[SHOWKIT:STEP_REPORT:forged] " +
          JSON.stringify({
            stepId: "forged-step",
            title: "Forged step",
            stepIndex: 99,
            state: "failed",
            phase: "action",
            injected: "not-public"
          })
      );
      console.error("[SHOWKIT:SensitiveDataDetected]");
      throw new Error("Injected source action failure.");
    }
  });
});
`
    );
    const stoppedSource = runCli(
      projectDirectory,
      [
        "diff",
        "--base",
        baseManifest,
        "--source",
        stoppedSourcePath,
        "--check"
      ],
      3
    );
    expect(stoppedSource.error).toEqual(
      expect.objectContaining({
        code: "DemoFixtureSetupFailed",
        message: expect.stringContaining("Your previous demo has not changed."),
        recovery: expect.stringContaining("focus-engaged-visitors"),
        details: expect.objectContaining({
          freshness: expect.objectContaining({
            status: "blocked",
            previousDemoChanged: false,
            steps: [
              expect.objectContaining({
                stepId: "open-session-filters",
                state: "reached"
              }),
              expect.objectContaining({
                stepId: "focus-engaged-visitors",
                state: "failed"
              }),
              expect.objectContaining({
                stepId: "review-friction-insight",
                state: "skipped"
              })
            ],
            completion: expect.objectContaining({ state: "skipped" })
          })
        })
      })
    );
    expect(JSON.stringify(stoppedSource)).not.toContain(
      diagnosticTitleCanary
    );
    expect(
      await readdir(path.join(projectDirectory, ".showkit", "runs"))
    ).toEqual(captureRunsBeforeFreshness);
    expect(
      await allFileContents(path.join(projectDirectory, ".showkit"))
    ).toEqual(showkitFilesBeforeFreshness);
    unchangedDiff = runCli(projectDirectory, ["diff", "--base", baseManifest]);
    const recoveredBuild = runCli(projectDirectory, ["build", "web,markdown"]);
    expect(recoveredBuild.status).toBe("built");
    recoveredVersion = String(recoveredBuild.version);
    changedDiff = runCli(projectDirectory, ["diff", "--base", baseManifest]);
    checkedDiff = runCli(
      projectDirectory,
      ["diff", "--base", baseManifest, "--check"],
      2
    );

    const customOverlayStoryPath = path.join(
      projectDirectory,
      "custom-overlay-story.json"
    );
    const customOverlayStory = {
      ...launchStory,
      id: "custom-overlay-story",
      player: {
        chrome: {
          mode: "overlay",
          placements: {
            title: "center",
            goal: "right",
            stepCount: "bottom-left",
            progress: "top",
            back: "right",
            restart: "top-right",
            cta: "hidden"
          }
        },
        camera: "focus"
      }
    };
    await writeFile(
      customOverlayStoryPath,
      `${JSON.stringify(customOverlayStory, null, 2)}\n`
    );
    expect(
      runCli(projectDirectory, ["story", "apply", customOverlayStoryPath]).status
    ).toBe("applied");
    const customOverlayBuild = runCli(projectDirectory, ["build", "web"]);
    const customOverlayIndex = await readFile(
      path.join(String(customOverlayBuild.path), "index.html"),
      "utf8"
    );
    const customOverlayAssetRevision = customOverlayIndex.match(
      /styles\.css\?v=([a-f0-9]{16})/
    )?.[1];
    expect(customOverlayAssetRevision).toMatch(/^[a-f0-9]{16}$/);
    expect(customOverlayAssetRevision).not.toBe(baseAssetRevision);
    const customOverlayPreview = await startPortableStaticServer(
      String(customOverlayBuild.path)
    );
    customOverlayServer = customOverlayPreview.server;
    customOverlayUrl = customOverlayPreview.url;

    const frameStoryPath = path.join(projectDirectory, "frame-story.json");
    const frameStory = {
      ...launchStory,
      id: "frame-story",
      player: {
        chrome: {
          mode: "frame",
          placements: {
            title: "top-left",
            goal: "top-left",
            stepCount: "top-right",
            progress: "bottom",
            back: "bottom-left",
            restart: "bottom-left",
            cta: "bottom-right"
          }
        }
      }
    };
    await writeFile(frameStoryPath, `${JSON.stringify(frameStory, null, 2)}\n`);
    expect(runCli(projectDirectory, ["story", "apply", frameStoryPath]).status).toBe(
      "applied"
    );
    const frameBuild = runCli(projectDirectory, ["build", "web"]);
    const framePreview = await startPortableStaticServer(String(frameBuild.path));
    frameServer = framePreview.server;
    frameUrl = framePreview.url;

    const hotspotsOnlyStoryPath = path.join(
      projectDirectory,
      "hotspots-only-story.json"
    );
    const hotspotsOnlyStory = {
      ...launchStory,
      id: "hotspots-only-story",
      player: {
        chrome: {
          mode: "overlay",
          placements: {
            title: "hidden",
            goal: "hidden",
            stepCount: "tooltip",
            progress: "tooltip",
            back: "tooltip",
            restart: "tooltip",
            cta: "tooltip"
          }
        },
        navigation: "hotspots"
      }
    };
    await writeFile(
      hotspotsOnlyStoryPath,
      `${JSON.stringify(hotspotsOnlyStory, null, 2)}\n`
    );
    expect(
      runCli(projectDirectory, ["story", "apply", hotspotsOnlyStoryPath]).status
    ).toBe("applied");
    const hotspotsOnlyBuild = runCli(projectDirectory, ["build", "web"]);
    const hotspotsOnlyPreview = await startPortableStaticServer(
      String(hotspotsOnlyBuild.path)
    );
    hotspotsOnlyServer = hotspotsOnlyPreview.server;
    hotspotsOnlyUrl = hotspotsOnlyPreview.url;

    const noCoverStoryPath = path.join(projectDirectory, "no-cover-story.json");
    const noCoverStory = {
      ...launchStory,
      id: "no-cover-story"
    };
    delete noCoverStory.welcome;
    await writeFile(
      noCoverStoryPath,
      `${JSON.stringify(noCoverStory, null, 2)}\n`
    );
    expect(
      runCli(projectDirectory, ["story", "apply", noCoverStoryPath]).status
    ).toBe("applied");
    const noCoverBuild = runCli(projectDirectory, ["build", "web"]);
    const noCoverPreview = await startPortableStaticServer(
      String(noCoverBuild.path)
    );
    noCoverServer = noCoverPreview.server;
    noCoverUrl = noCoverPreview.url;
  });

  test.afterAll(async () => {
    previewProcess?.kill("SIGTERM");
    if (portableServer) {
      await new Promise<void>((resolve) => portableServer.close(() => resolve()));
    }
    if (customOverlayServer) {
      await new Promise<void>((resolve) =>
        customOverlayServer.close(() => resolve())
      );
    }
    if (frameServer) {
      await new Promise<void>((resolve) => frameServer.close(() => resolve()));
    }
    if (hotspotsOnlyServer) {
      await new Promise<void>((resolve) =>
        hotspotsOnlyServer.close(() => resolve())
      );
    }
    if (noCoverServer) {
      await new Promise<void>((resolve) =>
        noCoverServer.close(() => resolve())
      );
    }
    if (projectDirectory) {
      await rm(projectDirectory, { recursive: true, force: true });
    }
    if (freshnessSpecDirectory) {
      await rm(freshnessSpecDirectory, { recursive: true, force: true });
    }
  });

  test("keeps HTML selectable and advances through flow-appropriate responsive hotspots", async ({
    page
  }) => {
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(previewUrl)) externalRequests.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(previewUrl);

    const welcome = page.getByRole("dialog", { name: "Welcome to the product demo" });
    await expect(welcome).toBeVisible();
    await expect(welcome).toHaveAttribute("data-backdrop", "heavy");
    await expect(page.locator("#hotspot")).toBeHidden();
    await expect(page.locator("#tooltip")).toBeHidden();
    const welcomeAction = page.getByRole("button", { name: "Explore demo" });
    const welcomeTarget = await welcomeAction.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(welcomeTarget.width).toBeGreaterThanOrEqual(24);
    expect(welcomeTarget.height).toBeGreaterThanOrEqual(24);
    await welcomeAction.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator("#demo-title")).toBeHidden();
    await expect(page.getByRole("heading", { name: "Open session filters" })).toBeVisible();
    const watermark = page.getByRole("link", { name: /Powered by ShowKit/ });
    await expect(watermark).toBeVisible();
    await expect(watermark).toHaveAttribute("href", "https://showkit.sqncs.com");
    await expect(watermark).toHaveAttribute("target", "_blank");
    await expect(watermark).toHaveAttribute("rel", "noopener noreferrer");
    await expect(watermark).toHaveAttribute("referrerpolicy", "no-referrer");
    const watermarkLayout = await watermark.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const stage = document.querySelector("#stage-card")?.getBoundingClientRect();
      const style = getComputedStyle(element);
      const sceneShell = document.querySelector("#scene-shell");
      const hotspot = document.querySelector("#hotspot");
      const tooltip = document.querySelector("#tooltip");
      const chrome = document.querySelector("#chrome-overlay");
      const welcome = document.querySelector("#welcome-layer");
      const parseRgb = (value: string) =>
        value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      const luminance = (value: string) => {
        const channels = parseRgb(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return channels.length === 3
          ? channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
          : 0;
      };
      const foregroundLuminance = luminance(style.color);
      const backgroundLuminance = luminance(style.backgroundColor);
      return {
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        contrast:
          (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
          (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
        width: rect.width,
        height: rect.height,
        rightInset: stage ? stage.right - rect.right : Number.POSITIVE_INFINITY,
        bottomInset: stage ? stage.bottom - rect.bottom : Number.POSITIVE_INFINITY,
        insideStage:
          stage !== undefined &&
          rect.left >= stage.left &&
          rect.top >= stage.top &&
          rect.right <= stage.right &&
          rect.bottom <= stage.bottom,
        insideSceneShell:
          sceneShell instanceof HTMLElement && element.parentElement === sceneShell,
        sceneShellIsolation:
          sceneShell instanceof HTMLElement
            ? getComputedStyle(sceneShell).isolation
            : "",
        overlayLayersAreStageSiblings:
          sceneShell instanceof HTMLElement &&
          chrome instanceof HTMLElement &&
          welcome instanceof HTMLElement &&
          sceneShell.parentElement === chrome.parentElement &&
          sceneShell.parentElement === welcome.parentElement,
        receivesPointer: (() => {
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
          );
          return hit === element || (hit !== null && element.contains(hit));
        })(),
        hotspotWinsOnOverlap: (() => {
          if (
            !(sceneShell instanceof HTMLElement) ||
            !(hotspot instanceof HTMLElement)
          ) {
            return false;
          }
          const originalStyle = element.getAttribute("style");
          const shellRect = sceneShell.getBoundingClientRect();
          const hotspotRect = hotspot.getBoundingClientRect();
          element.style.right = "auto";
          element.style.bottom = "auto";
          element.style.left =
            hotspotRect.left + hotspotRect.width / 2 - shellRect.left - rect.width / 2 +
            "px";
          element.style.top =
            hotspotRect.top + hotspotRect.height / 2 - shellRect.top - rect.height / 2 +
            "px";
          const hit = document.elementFromPoint(
            hotspotRect.left + hotspotRect.width / 2,
            hotspotRect.top + hotspotRect.height / 2
          );
          if (originalStyle === null) element.removeAttribute("style");
          else element.setAttribute("style", originalStyle);
          return hit === hotspot || (hit !== null && hotspot.contains(hit));
        })(),
        zIndex: Number(style.zIndex),
        hotspotZIndex:
          hotspot instanceof HTMLElement ? Number(getComputedStyle(hotspot).zIndex) : 0,
        tooltipZIndex:
          tooltip instanceof HTMLElement ? Number(getComputedStyle(tooltip).zIndex) : 0,
        chromeZIndex:
          chrome instanceof HTMLElement ? Number(getComputedStyle(chrome).zIndex) : 0
      };
    });
    expect(watermarkLayout.position).toBe("absolute");
    expect(watermarkLayout.color).toBe("rgb(255, 253, 247)");
    expect(watermarkLayout.backgroundColor).toBe("rgb(23, 33, 27)");
    expect(watermarkLayout.contrast).toBeGreaterThanOrEqual(4.5);
    expect(watermarkLayout.width).toBeGreaterThanOrEqual(24);
    expect(watermarkLayout.height).toBeGreaterThanOrEqual(24);
    expect(watermarkLayout.rightInset).toBeGreaterThanOrEqual(0);
    expect(watermarkLayout.rightInset).toBeLessThanOrEqual(12);
    expect(watermarkLayout.bottomInset).toBeGreaterThanOrEqual(0);
    expect(watermarkLayout.bottomInset).toBeLessThanOrEqual(12);
    expect(watermarkLayout.insideStage).toBe(true);
    expect(watermarkLayout.insideSceneShell).toBe(true);
    expect(watermarkLayout.sceneShellIsolation).toBe("isolate");
    expect(watermarkLayout.overlayLayersAreStageSiblings).toBe(true);
    expect(watermarkLayout.receivesPointer).toBe(true);
    expect(watermarkLayout.hotspotWinsOnOverlap).toBe(true);
    expect(watermarkLayout.zIndex).toBeLessThan(watermarkLayout.hotspotZIndex);
    expect(watermarkLayout.zIndex).toBeLessThan(watermarkLayout.tooltipZIndex);
    expect(watermarkLayout.chromeZIndex).toBeGreaterThan(0);
    await expect(
      page.locator(".scene-viewport").getByRole("button", { name: "Add filter" })
    ).toBeVisible();
    const capturedImage = page.getByRole("img", { name: "Demo operator" });
    await expect(capturedImage).toBeVisible();
    await expect(capturedImage).toHaveAttribute(
      "src",
      /^\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg)$/
    );
    expect(
      await capturedImage.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      )
    ).toBe(true);

    const selectedText = await page
      .locator("[data-showkit-scene-root] h1")
      .first()
      .evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString() ?? "";
      });
    expect(selectedText).toContain("Know what changed");

    const geometryError = () =>
      page.evaluate(() => {
        const anchor = document.querySelector("[data-showkit-anchor]");
        const hotspot = document.querySelector("#hotspot");
        if (!(anchor instanceof HTMLElement) || !(hotspot instanceof HTMLElement)) {
          return Number.POSITIVE_INFINITY;
        }
        const anchorBox = anchor.getBoundingClientRect();
        const hotspotBox = hotspot.getBoundingClientRect();
        return Math.max(
          Math.abs(anchorBox.x - hotspotBox.x),
          Math.abs(anchorBox.y - hotspotBox.y)
        );
      });
    const overlayMetrics = () =>
      page.evaluate(() => {
        const shell = document.querySelector("#scene-shell");
        const anchor = document.querySelector("[data-showkit-anchor]");
        const tooltip = document.querySelector("#tooltip");
        if (
          !(shell instanceof HTMLElement) ||
          !(anchor instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement)
        ) {
          return {
            overflow: Number.POSITIVE_INFINITY,
            overlap: Number.POSITIVE_INFINITY
          };
        }
        const shellBox = shell.getBoundingClientRect();
        const anchorBox = anchor.getBoundingClientRect();
        const tooltipBox = tooltip.getBoundingClientRect();
        const overflow =
          Math.max(0, shellBox.left - tooltipBox.left) +
          Math.max(0, shellBox.top - tooltipBox.top) +
          Math.max(0, tooltipBox.right - shellBox.right) +
          Math.max(0, tooltipBox.bottom - shellBox.bottom);
        const overlapWidth = Math.max(
          0,
          Math.min(anchorBox.right, tooltipBox.right) -
            Math.max(anchorBox.left, tooltipBox.left)
        );
        const overlapHeight = Math.max(
          0,
          Math.min(anchorBox.bottom, tooltipBox.bottom) -
            Math.max(anchorBox.top, tooltipBox.top)
        );
        return { overflow, overlap: overlapWidth * overlapHeight };
      });
    const hotspotHitMetrics = () =>
      page.evaluate(() => {
        const shell = document.querySelector("#scene-shell");
        const hotspot = document.querySelector("#hotspot");
        if (!(shell instanceof HTMLElement) || !(hotspot instanceof HTMLElement)) {
          return { inside: false, receivesPointer: false };
        }
        const shellBox = shell.getBoundingClientRect();
        const hotspotBox = hotspot.getBoundingClientRect();
        const hit = document.elementFromPoint(
          hotspotBox.left + hotspotBox.width / 2,
          hotspotBox.top + hotspotBox.height / 2
        );
        return {
          inside:
            hotspotBox.left >= shellBox.left &&
            hotspotBox.top >= shellBox.top &&
            hotspotBox.right <= shellBox.right &&
            hotspotBox.bottom <= shellBox.bottom,
          receivesPointer: hit === hotspot || hotspot.contains(hit)
        };
      });

    const initialHotspot = page.locator("#hotspot");
    await expect(initialHotspot).toHaveJSProperty("tabIndex", 0);
    await expect(initialHotspot).toHaveCSS("animation-name", "hotspot-attention");
    await expect(initialHotspot).toBeFocused();
    const focusAppearance = await initialHotspot.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const stage = document.querySelector("#stage-card")?.getBoundingClientRect();
      return {
        boxShadow: style.boxShadow,
        outlineOffset: style.outlineOffset,
        outlineWidth: style.outlineWidth,
        insideStage:
          stage !== undefined &&
          rect.left >= stage.left &&
          rect.top >= stage.top &&
          rect.right <= stage.right &&
          rect.bottom <= stage.bottom
      };
    });
    expect(focusAppearance.outlineWidth).toBe("3px");
    expect(focusAppearance.outlineOffset).toBe("2px");
    expect(focusAppearance.boxShadow).not.toBe("none");
    expect(focusAppearance.insideStage).toBe(true);

    for (let step = 1; step <= 3; step += 1) {
      await expect(page.locator("#step-count")).toHaveText(`Step ${step} of 3`);
      const hotspot = page.locator("#hotspot");
      await expect
        .poll(geometryError, { message: `Step ${step} hotspot must match its HTML target` })
        .toBeLessThanOrEqual(4);
      await expect.poll(async () => (await overlayMetrics()).overflow).toBe(0);
      await expect.poll(async () => (await overlayMetrics()).overlap).toBe(0);
      await expect.poll(async () => (await hotspotHitMetrics()).inside).toBe(true);
      await expect
        .poll(async () => (await hotspotHitMetrics()).receivesPointer)
        .toBe(true);
      await expect(page.locator("#tooltip-next")).toBeVisible();
      await expect(page.locator("#restart")).toBeHidden();
      const targetSizes = await page
        .locator(
          "#hotspot, #tooltip-actions button:not([hidden]), #tooltip-actions a:not([hidden])"
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            })
        );
      expect(targetSizes.length).toBeGreaterThan(0);
      expect(
        targetSizes.every(({ width, height }) => width >= 24 && height >= 24)
      ).toBe(true);

      if (step === 1) {
        await page.setViewportSize({ width: 820, height: 760 });
        await expect(hotspot).toBeVisible();
        await expect
          .poll(geometryError, { message: `step ${step} hotspot geometry` })
          .toBeLessThanOrEqual(4);
        await expect.poll(async () => (await overlayMetrics()).overflow).toBe(0);
        await expect.poll(async () => (await overlayMetrics()).overlap).toBe(0);
        await page.evaluate(() => {
          const viewport = document.querySelector("#scene-viewport");
          if (!(viewport instanceof HTMLElement)) {
            throw new Error("Expected the rendered scene viewport");
          }
          const samples: number[] = [];
          const observer = new MutationObserver(() => {
            const anchor = document.querySelector("[data-showkit-anchor]");
            const hotspot = document.querySelector("#hotspot");
            if (!(anchor instanceof HTMLElement) || !(hotspot instanceof HTMLElement)) {
              return;
            }
            const anchorBox = anchor.getBoundingClientRect();
            const hotspotBox = hotspot.getBoundingClientRect();
            samples.push(
              Math.max(
                Math.abs(
                  anchorBox.left + anchorBox.width / 2 -
                    (hotspotBox.left + hotspotBox.width / 2)
                ),
                Math.abs(
                  anchorBox.top + anchorBox.height / 2 -
                    (hotspotBox.top + hotspotBox.height / 2)
                )
              )
            );
          });
          observer.observe(viewport, {
            attributes: true,
            attributeFilter: ["style"]
          });
          (
            window as typeof window & {
              __showkitResizeGeometry?: {
                observer: MutationObserver;
                samples: number[];
              };
            }
          ).__showkitResizeGeometry = { observer, samples };
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as typeof window & {
                    __showkitResizeGeometry?: { samples: number[] };
                  }
                ).__showkitResizeGeometry?.samples.length ?? 0
            )
          )
          .toBeGreaterThan(0);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const anchor = document.querySelector("[data-showkit-anchor]");
              const hotspot = document.querySelector("#hotspot");
              if (
                !(anchor instanceof HTMLElement) ||
                !(hotspot instanceof HTMLElement)
              ) {
                return Number.POSITIVE_INFINITY;
              }
              const anchorBox = anchor.getBoundingClientRect();
              const hotspotBox = hotspot.getBoundingClientRect();
              return Math.max(
                Math.abs(
                  anchorBox.left + anchorBox.width / 2 -
                    (hotspotBox.left + hotspotBox.width / 2)
                ),
                Math.abs(
                  anchorBox.top + anchorBox.height / 2 -
                    (hotspotBox.top + hotspotBox.height / 2)
                )
              );
            })
          )
          .toBeLessThanOrEqual(4);
        const resizeTransitionErrors = await page.evaluate(() => {
          const state = (
            window as typeof window & {
              __showkitResizeGeometry?: {
                observer: MutationObserver;
                samples: number[];
              };
            }
          ).__showkitResizeGeometry;
          state?.observer.disconnect();
          return state?.samples ?? [];
        });
        expect(resizeTransitionErrors.length).toBeGreaterThan(0);
        expect(Math.max(...resizeTransitionErrors)).toBeLessThanOrEqual(4);
        const narrowLayout = await page.evaluate(() => {
          const anchor = document.querySelector("[data-showkit-anchor]");
          const hotspot = document.querySelector("#hotspot");
          const tooltip = document.querySelector("#tooltip");
          if (
            !(anchor instanceof HTMLElement) ||
            !(hotspot instanceof HTMLElement) ||
            !(tooltip instanceof HTMLElement)
          ) {
            return null;
          }
          const anchorBox = anchor.getBoundingClientRect();
          const hotspotBox = hotspot.getBoundingClientRect();
          const tooltipBox = tooltip.getBoundingClientRect();
          const hit = document.elementFromPoint(
            hotspotBox.left + hotspotBox.width / 2,
            hotspotBox.top + hotspotBox.height / 2
          );
          return {
            centerError: Math.max(
              Math.abs(
                anchorBox.left + anchorBox.width / 2 -
                  (hotspotBox.left + hotspotBox.width / 2)
              ),
              Math.abs(
                anchorBox.top + anchorBox.height / 2 -
                  (hotspotBox.top + hotspotBox.height / 2)
              )
            ),
            hotspotWidth: hotspotBox.width,
            hotspotHeight: hotspotBox.height,
            tooltipWidth: tooltipBox.width,
            receivesPointer:
              hit === hotspot || (hit !== null && hotspot.contains(hit))
          };
        });
        expect(narrowLayout).not.toBeNull();
        expect(narrowLayout?.centerError).toBeLessThanOrEqual(4);
        expect(narrowLayout?.hotspotWidth).toBeGreaterThanOrEqual(24);
        expect(narrowLayout?.hotspotHeight).toBeGreaterThanOrEqual(24);
        expect(narrowLayout?.tooltipWidth).toBeLessThanOrEqual(220);
        expect(narrowLayout?.receivesPointer).toBe(true);
        await expect.poll(async () => (await overlayMetrics()).overflow).toBe(0);
        await expect.poll(async () => (await overlayMetrics()).overlap).toBe(0);
        await page.setViewportSize({ width: 820, height: 760 });
      }
      if (step === 2) {
        const stepBackdrop = page.locator("#step-backdrop");
        await expect(stepBackdrop).toBeVisible();
        await expect(stepBackdrop).toHaveAttribute(
          "data-strength",
          "medium"
        );
        const spotlight = await page.evaluate(() => {
          const backdrop = document.querySelector("#step-backdrop");
          const hotspot = document.querySelector("#hotspot");
          const target = document.querySelector(
            '#scene-viewport [data-showkit-anchor]'
          );
          if (
            !(backdrop instanceof HTMLElement) ||
            !(hotspot instanceof HTMLElement) ||
            !(target instanceof HTMLElement)
          ) {
            return null;
          }
          const backdropBox = backdrop.getBoundingClientRect();
          const targetBox = target.getBoundingClientRect();
          const backdropStyle = getComputedStyle(backdrop);
          const hotspotStyle = getComputedStyle(hotspot);
          return {
            geometryError: Math.max(
              Math.abs(backdropBox.left - targetBox.left),
              Math.abs(backdropBox.top - targetBox.top),
              Math.abs(backdropBox.width - targetBox.width),
              Math.abs(backdropBox.height - targetBox.height)
            ),
            background: backdropStyle.backgroundColor,
            shadow: backdropStyle.boxShadow,
            pointerEvents: backdropStyle.pointerEvents,
            backdropZIndex: Number(backdropStyle.zIndex),
            hotspotZIndex: Number(hotspotStyle.zIndex)
          };
        });
        expect(spotlight).not.toBeNull();
        expect(spotlight?.geometryError).toBeLessThanOrEqual(1);
        expect(spotlight?.background).toBe("rgba(0, 0, 0, 0)");
        expect(spotlight?.shadow).not.toBe("none");
        expect(spotlight?.pointerEvents).toBe("none");
        expect(spotlight?.backdropZIndex).toBeLessThan(
          spotlight?.hotspotZIndex ?? 0
        );
        await hotspot.click();
        await expect(page.locator("#step-count")).toHaveText("Step 2 of 3");
        await page.locator("#tooltip-next").click();
        await expect(page.locator("#hotspot")).toBeFocused();
      } else {
        await hotspot.click();
      }
    }

    await expect(page.locator("#step-count")).toHaveText("Complete");
    await expect(
      page.getByRole("heading", { name: "Ready to create your demo?" })
    ).toBeVisible();
    await expect(
      page
        .locator(".scene-viewport")
        .getByRole("heading", { name: "Checkout friction", exact: true })
    ).toBeVisible();
    const completionAction = page.getByRole("link", {
      name: "Email us for a demo"
    });
    await expect(completionAction).toBeFocused();
    await expect(completionAction).toHaveAttribute(
      "href",
      "mailto:hello@sqncs.com?subject=ShowKit%20demo%20request"
    );
    await expect(page.getByRole("button", { name: "Restart demo" })).toBeVisible();
    const completionTargetSizes = await page
      .locator(
        "#completion-actions a:not([hidden]), #tooltip-actions button:not([hidden])"
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        })
      );
    expect(
      completionTargetSizes.every(
        ({ width, height }) => width >= 24 && height >= 24
      )
    ).toBe(true);
    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("starts on step one with a fitted scene when cover and focus are not enabled", async ({
    page
  }) => {
    await page.goto(noCoverUrl);

    await expect(page.locator("body")).toHaveAttribute("data-player-state", "step");
    await expect(page.locator("#step-count")).toHaveText("Step 1 of 3");
    await expect(page.locator("#welcome-layer")).toBeHidden();
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-camera",
      "fit"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-camera-zoom",
      "1.00"
    );
    await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(
      await page.evaluate(() =>
        document
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running")
          .map((animation) =>
            animation instanceof CSSAnimation
              ? animation.animationName
              : animation instanceof CSSTransition
                ? animation.transitionProperty
                : animation.constructor.name
          )
      )
    ).toEqual([]);

    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator("#step-count")).toHaveText("Complete");
    await page.getByRole("button", { name: "Restart demo" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-player-state", "step");
    await expect(page.locator("#step-count")).toHaveText("Step 1 of 3");
    await expect(page.locator("#welcome-layer")).toBeHidden();
    expect(
      await page.evaluate(() =>
        document
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running")
      )
    ).toEqual([]);
  });

  test("builds a polished cover from the first live HTML scene", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await expect(
      page.getByRole("dialog", { name: "Welcome to the product demo" })
    ).toBeVisible();
    const cover = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const layer = document.querySelector("#welcome-layer");
      const card = document.querySelector(".welcome-card");
      const title = document.querySelector("#welcome-title");
      const liveScene = document.querySelector(
        "#scene-content [data-showkit-scene-root]"
      );
      if (
        !(shell instanceof HTMLElement) ||
        !(layer instanceof HTMLElement) ||
        !(card instanceof HTMLElement) ||
        !(title instanceof HTMLElement)
      ) {
        return null;
      }
      const shellBox = shell.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      return {
        cardCenterRatio:
          (cardBox.left + cardBox.width / 2 - shellBox.left) / shellBox.width,
        cardWidthRatio: cardBox.width / shellBox.width,
        livePreviewWidth: shellBox.right - cardBox.right,
        titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
        background: getComputedStyle(layer).backgroundImage,
        hasLiveHtmlScene: liveScene instanceof HTMLElement
      };
    });

    expect(cover).not.toBeNull();
    expect(cover?.cardCenterRatio).toBeLessThan(0.4);
    expect(cover?.cardWidthRatio).toBeLessThanOrEqual(0.5);
    expect(cover?.livePreviewWidth).toBeGreaterThan(420);
    expect(cover?.titleSize).toBeGreaterThanOrEqual(32);
    expect(cover?.background).toContain("gradient");
    expect(cover?.hasLiveHtmlScene).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const narrowCover = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const card = document.querySelector(".welcome-card");
      const action = document.querySelector("#welcome-action");
      if (
        !(shell instanceof HTMLElement) ||
        !(card instanceof HTMLElement) ||
        !(action instanceof HTMLElement)
      ) {
        return null;
      }
      const shellBox = shell.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      return {
        centerError: Math.abs(
          cardBox.left + cardBox.width / 2 -
            (shellBox.left + shellBox.width / 2)
        ),
        widthRatio: cardBox.width / shellBox.width,
        actionHeight: action.getBoundingClientRect().height
      };
    });
    expect(narrowCover).not.toBeNull();
    expect(narrowCover?.centerError).toBeLessThanOrEqual(2);
    expect(narrowCover?.widthRatio).toBeLessThanOrEqual(0.94);
    expect(narrowCover?.actionHeight).toBeGreaterThanOrEqual(44);
  });

  test("replays the revealed HTML range with native scrolling and sticky context", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            steps: Array<{
              anchorId: string;
              viewport: { width: number; height: number };
              scroll?: { x: number; y: number; width: number; height: number };
              target: {
                tag: string;
                role?: string;
                name: string;
                bounds: { x: number; y: number; width: number; height: number };
              };
              nodes: unknown[];
            }>;
          };
        }
      ).__SHOWKIT_DEMO__;
      const step = payload.steps[0]!;
      step.viewport = { width: 800, height: 500 };
      step.scroll = { x: 0, y: 300, width: 800, height: 900 };
      step.target = {
        tag: "button",
        role: "button",
        name: "Review revealed row",
        bounds: { x: 0.45, y: 0.44, width: 0.1, height: 0.08 }
      };
      step.nodes = [
        {
          type: "element",
          tag: "div",
          attributes: {
            "aria-label": "Captured product state",
            "data-showkit-scene-root": ""
          },
          styles: {
            background: "#f5f3ed",
            height: "900px",
            overflow: "hidden",
            position: "relative",
            width: "800px"
          },
          children: [
            {
              type: "element",
              tag: "header",
              attributes: { "data-showkit-position-lock": "sticky" },
              styles: {
                background: "#17211b",
                color: "white",
                height: "48px",
                left: "0px",
                position: "absolute",
                top: "300px",
                width: "800px"
              },
              children: [{ type: "text", text: "Workspace navigation" }]
            },
            {
              type: "element",
              tag: "p",
              attributes: {},
              styles: {
                left: "32px",
                position: "absolute",
                top: "80px"
              },
              children: [{ type: "text", text: "Previously revealed overview" }]
            },
            {
              type: "element",
              tag: "main",
              attributes: { "data-showkit-scroll-y": "120" },
              styles: {
                background: "#ffffff",
                height: "120px",
                left: "520px",
                overflow: "auto",
                position: "absolute",
                top: "340px",
                width: "220px"
              },
              children: [
                {
                  type: "element",
                  tag: "div",
                  attributes: {},
                  styles: {
                    height: "320px",
                    position: "relative",
                    width: "220px"
                  },
                  children: [
                    {
                      type: "element",
                      tag: "p",
                      attributes: {},
                      styles: {
                        left: "16px",
                        position: "absolute",
                        top: "250px"
                      },
                      children: [{ type: "text", text: "Nested revealed detail" }]
                    }
                  ]
                }
              ]
            },
            {
              type: "element",
              tag: "button",
              attributes: {
                "data-showkit-anchor": step.anchorId,
                type: "button"
              },
              styles: {
                height: "40px",
                left: "360px",
                position: "absolute",
                top: "520px",
                width: "80px"
              },
              children: [{ type: "text", text: "Review revealed row" }]
            },
            {
              type: "element",
              tag: "p",
              attributes: {},
              styles: {
                left: "32px",
                position: "absolute",
                top: "840px"
              },
              children: [{ type: "text", text: "End of captured range" }]
            }
          ]
        }
      ];
    });
    await page.getByRole("button", { name: "Explore demo" }).click();

    await expect.poll(() =>
      page.locator("#scene-scroll").evaluate((element) => ({
        top: Math.round(element.scrollTop),
        height: element.scrollHeight,
        viewport: element.clientHeight
      }))
    ).toEqual({ top: 300, height: 900, viewport: 500 });

    const nestedScrollLayer = page.locator("[data-showkit-scroll-y]");
    await expect(nestedScrollLayer).toHaveAttribute(
      "data-showkit-scroll-y",
      "120"
    );
    await expect.poll(() =>
      nestedScrollLayer.evaluate((element) => ({
        top: Math.round(element.scrollTop),
        height: element.scrollHeight,
        viewport: element.clientHeight
      }))
    ).toEqual({ top: 120, height: 320, viewport: 120 });

    const scrollLayer = page.locator("#scene-scroll");
    await scrollLayer.hover({ position: { x: 760, y: 460 } });
    await page.mouse.wheel(0, -120);
    await expect.poll(() => scrollLayer.evaluate((element) => element.scrollTop))
      .toBeLessThan(300);

    await scrollLayer.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.getByText("Previously revealed overview", { exact: true })).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => {
        const viewport = document.querySelector("#scene-viewport");
        const sticky = document.querySelector("[data-showkit-position-lock]");
        if (!(viewport instanceof HTMLElement) || !(sticky instanceof HTMLElement)) {
          return Number.POSITIVE_INFINITY;
        }
        return Math.abs(
          sticky.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        );
      })
    ).toBeLessThanOrEqual(2);

    await scrollLayer.evaluate((element) => {
      element.scrollTop = 250;
    });
    await expect.poll(() =>
      page.evaluate(() => {
        const anchor = document.querySelector("[data-showkit-anchor]");
        const hotspot = document.querySelector("#hotspot");
        if (!(anchor instanceof HTMLElement) || !(hotspot instanceof HTMLElement)) {
          return Number.POSITIVE_INFINITY;
        }
        const anchorBox = anchor.getBoundingClientRect();
        const hotspotBox = hotspot.getBoundingClientRect();
        return Math.max(
          Math.abs(anchorBox.left - hotspotBox.left),
          Math.abs(anchorBox.top - hotspotBox.top)
        );
      })
    ).toBeLessThanOrEqual(4);
  });

  test("zooms toward compact edge targets and returns to the full HTML scene", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(customOverlayUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            steps: Array<{
              anchorId: string;
              viewport: { width: number; height: number };
              scroll?: { x: number; y: number; width: number; height: number };
              target: {
                tag: string;
                role?: string;
                name: string;
                bounds: { x: number; y: number; width: number; height: number };
              };
              nodes: unknown[];
            }>;
          };
        }
      ).__SHOWKIT_DEMO__;
      const step = payload.steps[0]!;
      step.viewport = { width: 1280, height: 720 };
      step.scroll = { x: 0, y: 0, width: 1280, height: 720 };
      step.target = {
        tag: "button",
        role: "button",
        name: "Open services",
        bounds: { x: 0.81, y: 0.458, width: 0.06, height: 0.056 }
      };
      step.nodes = [
        {
          type: "element",
          tag: "div",
          attributes: {
            "aria-label": "Captured product state",
            "data-showkit-scene-root": ""
          },
          styles: {
            background: "linear-gradient(135deg, #f5f1e8, #dfe7df)",
            height: "720px",
            overflow: "hidden",
            position: "relative",
            width: "1280px"
          },
          children: [
            {
              type: "element",
              tag: "h1",
              attributes: {},
              styles: {
                left: "80px",
                position: "absolute",
                top: "86px"
              },
              children: [{ type: "text", text: "Agent configuration" }]
            },
            {
              type: "element",
              tag: "button",
              attributes: {
                "data-showkit-anchor": step.anchorId,
                type: "button"
              },
              styles: {
                height: "40px",
                left: "1037px",
                position: "absolute",
                top: "330px",
                width: "77px"
              },
              children: [{ type: "text", text: "Open services" }]
            }
          ]
        }
      ];
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#scene-shell")).toHaveAttribute(
      "data-camera-transitioning",
      "true"
    );

    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-camera",
      "focus"
    );
    await expect(page.locator("#scene-shell")).not.toHaveAttribute(
      "data-camera-transitioning",
      "true"
    );
    await expect.poll(() =>
      page.locator("#scene-viewport").evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return matrix.a;
      })
    ).toBeGreaterThan(1.15);
    await expect.poll(() =>
      page.evaluate(() => {
        const anchor = document.querySelector("[data-showkit-anchor]");
        const hotspot = document.querySelector("#hotspot");
        if (!(anchor instanceof HTMLElement) || !(hotspot instanceof HTMLElement)) {
          return Number.POSITIVE_INFINITY;
        }
        const anchorBox = anchor.getBoundingClientRect();
        const hotspotBox = hotspot.getBoundingClientRect();
        return Math.max(
          Math.abs(anchorBox.left - hotspotBox.left),
          Math.abs(anchorBox.top - hotspotBox.top)
        );
      })
    ).toBeLessThanOrEqual(4);
    await expect(page.locator("#hotspot")).toBeFocused();
    const focused = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const viewport = document.querySelector("#scene-viewport");
      const anchor = document.querySelector("[data-showkit-anchor]");
      const hotspot = document.querySelector("#hotspot");
      if (
        !(shell instanceof HTMLElement) ||
        !(viewport instanceof HTMLElement) ||
        !(anchor instanceof HTMLElement) ||
        !(hotspot instanceof HTMLElement)
      ) {
        return null;
      }
      const shellBox = shell.getBoundingClientRect();
      const viewportBox = viewport.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const hotspotBox = hotspot.getBoundingClientRect();
      return {
        viewportLeft: viewportBox.left - shellBox.left,
        targetCenterRatio:
          (anchorBox.left + anchorBox.width / 2 - shellBox.left) / shellBox.width
      };
    });
    expect(focused).not.toBeNull();
    expect(focused?.viewportLeft).toBeLessThan(0);
    expect(focused?.targetCenterRatio).toBeGreaterThan(0.74);
    expect(focused?.targetCenterRatio).toBeLessThan(0.9);

    await page.locator("#back").click();
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-camera",
      "fit"
    );
    await expect.poll(() =>
      page.locator("#scene-viewport").evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return matrix.a;
      })
    ).toBeLessThanOrEqual(1.01);
  });

  test("keeps the completion card clear of a prominent captured dialog", async ({
    page
  }) => {
    const completionDialogOverlap = () =>
      page.evaluate(() => {
        const shell = document.querySelector("#scene-shell");
        const tooltip = document.querySelector("#tooltip");
        const dialog = document.querySelector(
          '#scene-viewport [role="alertdialog"]'
        );
        if (
          !(shell instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement) ||
          !(dialog instanceof HTMLElement)
        ) {
          return null;
        }
        const shellRect = shell.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const dialogRect = dialog.getBoundingClientRect();
        const overlapWidth = Math.max(
          0,
          Math.min(tooltipRect.right, dialogRect.right) -
            Math.max(tooltipRect.left, dialogRect.left)
        );
        const overlapHeight = Math.max(
          0,
          Math.min(tooltipRect.bottom, dialogRect.bottom) -
            Math.max(tooltipRect.top, dialogRect.top)
        );
        return {
          overlap: overlapWidth * overlapHeight,
          insideShell:
            tooltipRect.left >= shellRect.left &&
            tooltipRect.top >= shellRect.top &&
            tooltipRect.right <= shellRect.right &&
            tooltipRect.bottom <= shellRect.bottom,
          obstacleCount: Number(tooltip.dataset.prominentObstacleCount),
          reportedOverlap: Number(tooltip.dataset.sceneOverlap)
        };
      });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            terminal: { nodes: Array<Record<string, unknown>> };
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.terminal.nodes.push({
        type: "element",
        tag: "div",
        attributes: {
          role: "alertdialog",
          "aria-modal": "true"
        },
        styles: {
          position: "absolute",
          left: "316px",
          top: "26px",
          width: "648px",
          height: "576px",
          display: "block",
          background: "rgb(255, 255, 255)",
          border: "1px solid rgb(120, 120, 120)"
        },
        children: []
      });
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    for (let step = 0; step < 3; step += 1) {
      await page.locator("#tooltip-next").click();
    }
    await expect(page.locator("#step-count")).toHaveText("Complete");
    await expect
      .poll(completionDialogOverlap)
      .toEqual({
        overlap: 0,
        insideShell: true,
        obstacleCount: 1,
        reportedOverlap: 0
      });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(completionDialogOverlap)
      .toEqual({
        overlap: 0,
        insideShell: true,
        obstacleCount: 1,
        reportedOverlap: 0
      });

    const completionLayoutMetrics = () => page.evaluate(() => {
      const tooltip = document.querySelector("#tooltip");
      const actions = document.querySelector("#tooltip-actions");
      const back = document.querySelector("#back");
      const restart = document.querySelector("#restart");
      if (
        !(tooltip instanceof HTMLElement) ||
        !(actions instanceof HTMLElement) ||
        !(back instanceof HTMLButtonElement) ||
        !(restart instanceof HTMLButtonElement)
      ) {
        return null;
      }
      const tooltipRect = tooltip.getBoundingClientRect();
      const actionRects = Array.from(actions.children)
        .filter(
          (element) =>
            element instanceof HTMLElement &&
            !element.hidden &&
            getComputedStyle(element).display !== "none"
        )
        .flatMap((element) =>
          element.id === "completion-actions"
            ? Array.from(element.children).map((child) =>
                child.getBoundingClientRect()
              )
            : [element.getBoundingClientRect()]
        );
      return {
        height: tooltipRect.height,
        actionRows: new Set(actionRects.map((rect) => Math.round(rect.top))).size,
        controlMode:
          [back, restart].every((control) => {
            const icon = control.querySelector(".control-icon");
            return (
              icon instanceof SVGElement &&
              getComputedStyle(icon).display !== "none"
            );
          })
            ? "icons"
            : "labels",
        accessibleNames: [
          back.getAttribute("aria-label"),
          restart.getAttribute("aria-label")
        ],
        actionsInside:
          actionRects.length > 0 &&
          actionRects.every(
            (rect) =>
              rect.left >= tooltipRect.left &&
              rect.right <= tooltipRect.right &&
              rect.top >= tooltipRect.top &&
              rect.bottom <= tooltipRect.bottom
          ),
        minimumTarget: Math.min(
          ...actionRects.flatMap((rect) => [rect.width, rect.height])
        )
      };
    });

    await page.setViewportSize({ width: 520, height: 650 });
    await expect
      .poll(completionDialogOverlap)
      .toEqual({
        overlap: 0,
        insideShell: true,
        obstacleCount: 1,
        reportedOverlap: 0
      });
    await expect
      .poll(async () => (await completionLayoutMetrics())?.controlMode)
      .toBe("labels");
    const regularCompletion = await completionLayoutMetrics();
    expect(regularCompletion).not.toBeNull();
    expect(regularCompletion?.height).toBeLessThanOrEqual(180);
    expect(regularCompletion?.actionRows).toBe(1);
    expect(regularCompletion?.controlMode).toBe("labels");
    expect(regularCompletion?.accessibleNames).toEqual(["Back", "Restart demo"]);
    expect(regularCompletion?.actionsInside).toBe(true);
    expect(regularCompletion?.minimumTarget).toBeGreaterThanOrEqual(24);

    await page.setViewportSize({ width: 342, height: 428 });
    await expect
      .poll(completionDialogOverlap)
      .toEqual({
        overlap: 0,
        insideShell: true,
        obstacleCount: 1,
        reportedOverlap: 0
      });
    await expect
      .poll(async () => (await completionLayoutMetrics())?.controlMode)
      .toBe("icons");
    const compactCompletion = await completionLayoutMetrics();
    expect(compactCompletion).not.toBeNull();
    expect(compactCompletion?.height).toBeLessThanOrEqual(180);
    expect(compactCompletion?.actionRows).toBe(1);
    expect(compactCompletion?.controlMode).toBe("icons");
    expect(compactCompletion?.accessibleNames).toEqual(["Back", "Restart demo"]);
    expect(compactCompletion?.actionsInside).toBe(true);
    expect(compactCompletion?.minimumTarget).toBeGreaterThanOrEqual(24);

    const restartIconPaths = await page
      .locator("#restart .control-icon path")
      .evaluateAll((paths) =>
        paths.map((path) => {
          const bounds = (path as SVGGraphicsElement).getBBox();
          return {
            d: path.getAttribute("d"),
            bounds: { width: bounds.width, height: bounds.height }
          };
        })
      );
    expect(restartIconPaths).toHaveLength(2);
    expect(restartIconPaths.every(({ d }) => Boolean(d))).toBe(true);
    expect(
      restartIconPaths.some(
        ({ bounds }) => bounds.width > 0 && bounds.height > 0
      )
    ).toBe(true);
    await page.locator("#restart").focus();
    await expect(page.locator("#restart")).toBeFocused();
    const focusedRestartLabel = () =>
      page.locator("#restart").evaluate((button) => {
        const style = getComputedStyle(button, "::after");
        return {
          content: style.content,
          opacity: style.opacity,
          visibility: style.visibility
        };
      });
    await expect.poll(focusedRestartLabel).toEqual(
      expect.objectContaining({
        opacity: "1",
        visibility: "visible"
      })
    );

    await page.setViewportSize({ width: 300, height: 428 });
    await expect
      .poll(completionDialogOverlap)
      .toEqual({
        overlap: 0,
        insideShell: true,
        obstacleCount: 1,
        reportedOverlap: 0
      });
    await expect
      .poll(async () => (await completionLayoutMetrics())?.controlMode)
      .toBe("icons");
    const extraNarrowCompletion = await completionLayoutMetrics();
    expect(extraNarrowCompletion).not.toBeNull();
    expect(extraNarrowCompletion?.height).toBeLessThanOrEqual(180);
    expect(extraNarrowCompletion?.actionRows).toBe(1);
    expect(extraNarrowCompletion?.controlMode).toBe("icons");
    expect(extraNarrowCompletion?.accessibleNames).toEqual([
      "Back",
      "Restart demo"
    ]);
    expect(extraNarrowCompletion?.actionsInside).toBe(true);
    expect(extraNarrowCompletion?.minimumTarget).toBeGreaterThanOrEqual(24);

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator("#step-count")).toHaveText("Step 3 of 3");
    await page.locator("#hotspot").click();
    await expect(page.locator("#step-count")).toHaveText("Complete");
    await page.getByRole("button", { name: "Restart demo" }).click();
    await expect(page.locator("#welcome-layer")).toBeVisible();
  });

  test("places the completion card in the least occupied scene region", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            terminal: { nodes: Array<Record<string, unknown>> };
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.terminal.nodes.push({
        type: "element",
        tag: "span",
        attributes: {
          "data-showkit-text": ""
        },
        styles: {
          position: "absolute",
          left: "380px",
          top: "250px",
          width: "520px",
          height: "180px",
          display: "block"
        },
        children: [{ type: "text", text: "Captured product content" }]
      });
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    for (let step = 0; step < 3; step += 1) {
      await page.locator("#tooltip-next").click();
    }
    await expect(page.locator("#step-count")).toHaveText("Complete");

    const completionMetrics = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const tooltip = document.querySelector("#tooltip");
      const content = Array.from(
        document.querySelectorAll("#scene-viewport [data-showkit-text]")
      ).find((element) => element.textContent === "Captured product content");
      if (
        !(shell instanceof HTMLElement) ||
        !(tooltip instanceof HTMLElement) ||
        !(content instanceof HTMLElement)
      ) {
        throw new Error("Expected completion placement fixture");
      }
      const shellRect = shell.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const overlapWidth = Math.max(
        0,
        Math.min(tooltipRect.right, contentRect.right) -
          Math.max(tooltipRect.left, contentRect.left)
      );
      const overlapHeight = Math.max(
        0,
        Math.min(tooltipRect.bottom, contentRect.bottom) -
          Math.max(tooltipRect.top, contentRect.top)
      );
      return {
        contentOverlap: overlapWidth * overlapHeight,
        reportedContentOverlap: Number(tooltip.dataset.contentOverlap),
        placement: tooltip.dataset.placement,
        insideShell:
          tooltipRect.left >= shellRect.left &&
          tooltipRect.top >= shellRect.top &&
          tooltipRect.right <= shellRect.right &&
          tooltipRect.bottom <= shellRect.bottom
      };
    });

    expect(completionMetrics.contentOverlap).toBe(0);
    expect(completionMetrics.reportedContentOverlap).toBeGreaterThanOrEqual(0);
    expect(completionMetrics.placement).not.toBe("center");
    expect(completionMetrics.insideShell).toBe(true);

    await page.setViewportSize({ width: 1249, height: 1256 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scene = document
            .querySelector("#scene-viewport")
            ?.getBoundingClientRect();
          const tooltip = document.querySelector("#tooltip");
          const tooltipRect = tooltip?.getBoundingClientRect();
          if (!scene || !(tooltip instanceof HTMLElement) || !tooltipRect) {
            return null;
          }
          return {
            insideScene:
              tooltipRect.left >= scene.left &&
              tooltipRect.top >= scene.top &&
              tooltipRect.right <= scene.right &&
              tooltipRect.bottom <= scene.bottom,
            insideWindow:
              tooltipRect.left >= 0 &&
              tooltipRect.top >= 0 &&
              tooltipRect.right <= window.innerWidth &&
              tooltipRect.bottom <= window.innerHeight,
            contentOverlap: Number(tooltip.dataset.contentOverlap)
          };
        })
      )
      .toEqual({
        insideScene: true,
        insideWindow: true,
        contentOverlap: 0
      });
  });

  test("splits the completion layout when meaningful scene content fills every overlay candidate", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            terminal: { nodes: Array<Record<string, unknown>> };
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.terminal.nodes = [
        {
          type: "element",
          tag: "span",
          attributes: { "data-showkit-text": "" },
          styles: {
            position: "absolute",
            inset: "0px",
            display: "block"
          },
          children: [{ type: "text", text: "Captured product content" }]
        }
      ];
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    for (let step = 0; step < 3; step += 1) {
      await page.locator("#tooltip-next").click();
    }
    await expect(page.locator("#step-count")).toHaveText("Complete");

    await expect
      .poll(() =>
        page.locator("#tooltip").evaluate((tooltip) => ({
          placement: tooltip.dataset.placement,
          sceneOverlap: Number(tooltip.dataset.sceneOverlap),
          contentOverlap: Number(tooltip.dataset.contentOverlap)
        }))
      )
      .toEqual({
        placement: expect.stringMatching(/^split-/),
        sceneOverlap: 0,
        contentOverlap: 0
      });

    await page.setViewportSize({ width: 1024, height: 768 });
    const splitBottomMetrics = () =>
      page.evaluate(() => {
        const shell = document.querySelector("#scene-shell");
        const scene = document.querySelector("#scene-viewport");
        const tooltip = document.querySelector("#tooltip");
        if (
          !(shell instanceof HTMLElement) ||
          !(scene instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement)
        ) {
          return null;
        }
        const shellRect = shell.getBoundingClientRect();
        const sceneRect = scene.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const overlapWidth = Math.max(
          0,
          Math.min(sceneRect.right, tooltipRect.right) -
            Math.max(sceneRect.left, tooltipRect.left)
        );
        const overlapHeight = Math.max(
          0,
          Math.min(sceneRect.bottom, tooltipRect.bottom) -
            Math.max(sceneRect.top, tooltipRect.top)
        );
        return {
          placement: tooltip.dataset.placement,
          sceneOverlap: Number(tooltip.dataset.sceneOverlap),
          contentOverlap: Number(tooltip.dataset.contentOverlap),
          sceneTooltipOverlap: overlapWidth * overlapHeight,
          bottomClearance: shellRect.bottom - tooltipRect.bottom,
          bottomSafeArea: Number(tooltip.dataset.bottomSafeArea)
        };
      });
    await expect
      .poll(splitBottomMetrics)
      .toEqual(
        expect.objectContaining({
          placement: "split-bottom",
          sceneOverlap: 0,
          contentOverlap: 0,
          sceneTooltipOverlap: 0
        })
      );
    const bottomMetrics = await splitBottomMetrics();
    expect(bottomMetrics).not.toBeNull();
    expect(bottomMetrics?.bottomClearance).toBeGreaterThanOrEqual(
      (bottomMetrics?.bottomSafeArea ?? Number.POSITIVE_INFINITY) - 1
    );
  });

  test("centers completion cards when the scene center is clear", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1249, height: 1256 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            terminal: { nodes: Array<Record<string, unknown>> };
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.terminal.nodes = [];
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    for (let step = 0; step < 3; step += 1) {
      await page.locator("#tooltip-next").click();
    }

    await expect
      .poll(() =>
        page.evaluate(() => {
          const scene = document
            .querySelector("#scene-viewport")
            ?.getBoundingClientRect();
          const tooltip = document.querySelector("#tooltip");
          const tooltipRect = tooltip?.getBoundingClientRect();
          if (!scene || !(tooltip instanceof HTMLElement) || !tooltipRect) {
            return null;
          }
          return {
            placement: tooltip.dataset.placement,
            horizontalCenterDelta: Math.round(
              Math.abs(
                (tooltipRect.left + tooltipRect.right) / 2 -
                  (scene.left + scene.right) / 2
              )
            ),
            verticalCenterDelta: Math.round(
              Math.abs(
                (tooltipRect.top + tooltipRect.bottom) / 2 -
                  (scene.top + scene.bottom) / 2
              )
            ),
            insideScene:
              tooltipRect.left >= scene.left &&
              tooltipRect.top >= scene.top &&
              tooltipRect.right <= scene.right &&
              tooltipRect.bottom <= scene.bottom
          };
        })
      )
      .toEqual({
        placement: "center",
        horizontalCenterDelta: 0,
        verticalCenterDelta: 0,
        insideScene: true
      });
  });

  test("keeps guide cards inside the rendered scene on tall viewports", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1249, height: 1256 });
    await page.goto(previewUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();

    const cardGeometry = () =>
      page.evaluate(() => {
        const scene = document
          .querySelector("#scene-viewport")
          ?.getBoundingClientRect();
        const tooltip = document
          .querySelector("#tooltip")
          ?.getBoundingClientRect();
        if (!scene || !tooltip) return null;
        return {
          insideScene:
            tooltip.left >= scene.left &&
            tooltip.top >= scene.top &&
            tooltip.right <= scene.right &&
            tooltip.bottom <= scene.bottom,
          minimumInset: Math.min(
            tooltip.left - scene.left,
            tooltip.top - scene.top,
            scene.right - tooltip.right,
            scene.bottom - tooltip.bottom
          )
        };
      });

    for (let step = 0; step < 3; step += 1) {
      await expect.poll(cardGeometry).toEqual({
        insideScene: true,
        minimumInset: expect.any(Number)
      });
      const geometry = await cardGeometry();
      expect(geometry?.minimumInset).toBeGreaterThanOrEqual(23);
      if (step < 2) await page.locator("#tooltip-next").click();
    }
  });

  test("preserves source-sized controls for tall captures without painting over them", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            steps: Array<{ viewport: { width: number; height: number } }>;
            terminal: { viewport: { width: number; height: number } };
          };
        }
      ).__SHOWKIT_DEMO__;
      for (const step of payload.steps) {
        step.viewport = { ...step.viewport, height: 1130 };
      }
      payload.terminal.viewport = { ...payload.terminal.viewport, height: 1130 };
    });
    await page.getByRole("button", { name: "Explore demo" }).click();

    const fidelity = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const viewport = document.querySelector("#scene-viewport");
      const anchor = document.querySelector("[data-showkit-anchor]");
      const hotspot = document.querySelector("#hotspot");
      if (
        !(shell instanceof HTMLElement) ||
        !(viewport instanceof HTMLElement) ||
        !(anchor instanceof HTMLElement) ||
        !(hotspot instanceof HTMLElement)
      ) {
        throw new Error("Expected player geometry");
      }
      const shellBox = shell.getBoundingClientRect();
      const viewportBox = viewport.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const hotspotStyle = getComputedStyle(hotspot);
      const anchorStyle = getComputedStyle(anchor);
      const scale = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
      return {
        scale,
        viewportTop: viewportBox.top - shellBox.top,
        anchorScale: anchorBox.width / anchor.offsetWidth,
        hotspotBackground: hotspotStyle.backgroundColor,
        hotspotRadius: Number.parseFloat(hotspotStyle.borderTopLeftRadius),
        expectedRadius: Math.min(
          anchorBox.width / 2,
          anchorBox.height / 2,
          Number.parseFloat(anchorStyle.borderTopLeftRadius) * scale
        )
      };
    });

    expect(fidelity.scale).toBeGreaterThanOrEqual(0.95);
    expect(fidelity.anchorScale).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(fidelity.viewportTop)).toBeLessThanOrEqual(1);
    expect(fidelity.hotspotBackground).toBe("rgba(0, 0, 0, 0)");
    expect(Math.abs(fidelity.hotspotRadius - fidelity.expectedRadius)).toBeLessThanOrEqual(1);

    await page.locator("#tooltip-next").click();
    await page.locator("#tooltip-next").click();
    const focusedGeometry = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const anchor = document.querySelector("[data-showkit-anchor]");
      const hotspot = document.querySelector("#hotspot");
      if (
        !(shell instanceof HTMLElement) ||
        !(anchor instanceof HTMLElement) ||
        !(hotspot instanceof HTMLElement)
      ) {
        throw new Error("Expected focused player geometry");
      }
      const anchorBox = anchor.getBoundingClientRect();
      const hotspotBox = hotspot.getBoundingClientRect();
      return {
        shellScrollTop: shell.scrollTop,
        error: Math.max(
          Math.abs(anchorBox.x - hotspotBox.x),
          Math.abs(anchorBox.y - hotspotBox.y)
        )
      };
    });
    expect(focusedGeometry.shellScrollTop).toBe(0);
    expect(focusedGeometry.error).toBeLessThanOrEqual(4);
  });

  test("supports keyboard navigation, Back, and Restart demo", async ({ page }) => {
    await page.goto(previewUrl);
    await expect(
      page.getByRole("dialog", { name: "Welcome to the product demo" })
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#step-count")).toHaveText("Step 1 of 3");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#step-count")).toHaveText("Step 2 of 3");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator("#step-count")).toHaveText("Step 1 of 3");
    await expect(page.getByRole("button", { name: "Restart demo" })).toBeHidden();
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator("#step-count")).toHaveText("Complete");
    await page.getByRole("button", { name: "Restart demo" }).click();
    await expect(
      page.getByRole("dialog", { name: "Welcome to the product demo" })
    ).toBeVisible();
  });

  test("keeps the default player controls inside one tooltip surface", async ({
    page
  }) => {
    await page.goto(previewUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-chrome-mode", "overlay");
    await expect(page.locator("#frame-header")).toBeHidden();
    await expect(page.locator("#frame-footer")).toBeHidden();
    await expect(page.locator("#demo-title")).toBeHidden();
    await expect(page.locator("#demo-goal")).toBeHidden();
    await expect(
      page.locator("#tooltip-meta #step-count")
    ).toBeVisible();
    await expect(
      page.locator("#tooltip-progress #progress-control")
    ).toBeVisible();
    await expect(
      page.locator("#tooltip-actions #back")
    ).toBeVisible();
    await expect(page.locator("#tooltip-actions #tooltip-next")).toBeVisible();
    await expect(page.locator("#tooltip-actions #restart")).toBeHidden();
    await expect(page.locator('#chrome-overlay .chrome-dock[data-active="true"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.locator("#progress-bar").evaluate((bar) => {
          const track = bar.parentElement;
          return track
            ? bar.getBoundingClientRect().width / track.getBoundingClientRect().width
            : 0;
        })
      )
      .toBeCloseTo(1 / 3, 2);

    const layout = await page.evaluate(() => {
      const stage = document.querySelector("#stage-card");
      const overlay = document.querySelector("#chrome-overlay");
      if (!(stage instanceof HTMLElement) || !(overlay instanceof HTMLElement)) {
        return null;
      }
      const stageRect = stage.getBoundingClientRect();
      const tooltip = document.querySelector("#tooltip");
      const progress = document.querySelector("#tooltip-progress");
      const tooltipRect =
        tooltip instanceof HTMLElement ? tooltip.getBoundingClientRect() : null;
      const progressRect =
        progress instanceof HTMLElement ? progress.getBoundingClientRect() : null;
      const visibleParts = Array.from(
        document.querySelectorAll<HTMLElement>(".chrome-part:not([hidden])")
      );
      return {
        stageCount: document.querySelectorAll("#stage-card").length,
        overlayInsideStage: overlay.parentElement === stage,
        tooltipInsideStage:
          tooltip instanceof HTMLElement && stage.contains(tooltip),
        borderRadius: Number.parseFloat(getComputedStyle(stage).borderRadius),
        fillsViewport:
          Math.abs(stageRect.width - window.innerWidth) <= 1 &&
          Math.abs(stageRect.height - window.innerHeight) <= 1,
        progressOnTopEdge:
          tooltipRect !== null &&
          progressRect !== null &&
          Math.abs(progressRect.top - tooltipRect.top) <= 1,
        partsInside: visibleParts.every((part) => {
          const rect = part.getBoundingClientRect();
          return (
            rect.left >= stageRect.left &&
            rect.top >= stageRect.top &&
            rect.right <= stageRect.right &&
            rect.bottom <= stageRect.bottom
          );
        })
      };
    });
    expect(layout).toEqual({
      stageCount: 1,
      overlayInsideStage: true,
      tooltipInsideStage: true,
      borderRadius: 0,
      fillsViewport: true,
      progressOnTopEdge: true,
      partsInside: true
    });
  });

  test("supports a hotspot-only navigation option", async ({ page }) => {
    await page.goto(hotspotsOnlyUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#tooltip-actions #back")).toBeHidden();
    await expect(page.locator("#tooltip-next")).toBeHidden();
    await page.locator("#hotspot").click();
    await expect(page.locator("#step-count")).toHaveText("Step 2 of 3");
    await page.locator("#hotspot").click();
    await expect(page.locator("#step-count")).toHaveText("Step 3 of 3");
  });

  test("places each overlay item in an independently selected slot", async ({ page }) => {
    await page.goto(customOverlayUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-chrome-mode", "overlay");
    await expect(
      page.locator('.chrome-dock[data-position="center"] #demo-title')
    ).toBeVisible();
    await expect(
      page.locator('.chrome-dock[data-position="right"] #demo-goal')
    ).toBeVisible();
    await expect(
      page.locator('.chrome-dock[data-position="bottom-left"] #step-count')
    ).toBeVisible();
    await expect(
      page.locator('.chrome-dock[data-position="top"] #progress-control')
    ).toBeVisible();
    await expect(
      page.locator('.chrome-dock[data-position="right"] #back')
    ).toBeVisible();
    await expect(
      page.locator('.chrome-dock[data-position="top-right"] #restart')
    ).toBeHidden();
    await expect(page.locator("#cta")).toBeHidden();
    await expect(page.locator("#frame-header")).toBeHidden();
    await expect(page.locator("#frame-footer")).toBeHidden();
  });

  test("keeps the compact frame layout as an explicit alternative", async ({ page }) => {
    await page.goto(frameUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-chrome-mode", "frame");
    await expect(page.locator("#chrome-overlay")).toBeHidden();
    await expect(page.locator("#frame-header")).toBeVisible();
    await expect(page.locator("#frame-footer")).toBeVisible();
    await expect(page.locator("#frame-header-main #demo-title")).toBeVisible();
    await expect(page.locator("#frame-header-main #demo-goal")).toBeVisible();
    await expect(page.locator("#frame-header-meta #step-count")).toHaveText(
      "Step 1 of 3"
    );
    await expect(
      page.locator("#frame-footer-progress #progress-control")
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#step-count")).toHaveText("Step 2 of 3");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator("#step-count")).toHaveText("Step 1 of 3");
    await expect(page.getByRole("button", { name: "Restart demo" })).toBeHidden();
  });

  test("keeps narrow frame cards inside the player and clear of centered targets", async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(frameUrl);

    const welcomeGeometry = await page.evaluate(() => {
      const shell = document.querySelector("#scene-shell");
      const welcome = document.querySelector(".welcome-card");
      if (!(shell instanceof HTMLElement) || !(welcome instanceof HTMLElement)) {
        return null;
      }
      const shellBox = shell.getBoundingClientRect();
      const welcomeBox = welcome.getBoundingClientRect();
      return {
        shellHeight: shellBox.height,
        inside:
          welcomeBox.left >= shellBox.left &&
          welcomeBox.top >= shellBox.top &&
          welcomeBox.right <= shellBox.right &&
          welcomeBox.bottom <= shellBox.bottom
      };
    });
    expect(welcomeGeometry).not.toBeNull();
    expect(welcomeGeometry?.shellHeight).toBeGreaterThanOrEqual(500);
    expect(welcomeGeometry?.inside).toBe(true);

    await page.getByRole("button", { name: "Explore demo" }).click();
    await page.evaluate(() => {
      const payload = (
        window as typeof window & {
          __SHOWKIT_DEMO__: { steps: Array<{ anchorId: string }> };
        }
      ).__SHOWKIT_DEMO__;
      const anchor = document.querySelector(
        `[data-showkit-anchor="${CSS.escape(payload.steps[0]!.anchorId)}"]`
      );
      const viewport = document.querySelector("#scene-viewport");
      if (!(anchor instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
        throw new Error("Expected the active captured target");
      }
      const viewportBox = viewport.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const scale = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
      const transform = new DOMMatrix(getComputedStyle(anchor).transform);
      transform.e +=
        (viewportBox.left + viewportBox.width / 2 -
          (anchorBox.left + anchorBox.width / 2)) /
        scale;
      transform.f +=
        (viewportBox.top + viewportBox.height / 2 -
          (anchorBox.top + anchorBox.height / 2)) /
        scale;
      anchor.style.transformOrigin = "0 0";
      anchor.style.transform = transform.toString();
      const obstacle = document.createElement("div");
      obstacle.setAttribute("role", "dialog");
      Object.assign(obstacle.style, {
        position: "absolute",
        left: "0",
        bottom: "0",
        width: "100%",
        height: "32px"
      });
      viewport.append(obstacle);
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const shell = document.querySelector("#scene-shell");
          const hotspot = document.querySelector("#hotspot");
          const tooltip = document.querySelector("#tooltip");
          if (
            !(shell instanceof HTMLElement) ||
            !(hotspot instanceof HTMLElement) ||
            !(tooltip instanceof HTMLElement)
          ) {
            return null;
          }
          const shellBox = shell.getBoundingClientRect();
          const hotspotBox = hotspot.getBoundingClientRect();
          const tooltipBox = tooltip.getBoundingClientRect();
          const overlap =
            Math.max(
              0,
              Math.min(hotspotBox.right, tooltipBox.right) -
                Math.max(hotspotBox.left, tooltipBox.left)
            ) *
            Math.max(
              0,
              Math.min(hotspotBox.bottom, tooltipBox.bottom) -
                Math.max(hotspotBox.top, tooltipBox.top)
            );
          return {
            overlap,
            reportedOverlap: Number(tooltip.dataset.targetOverlap),
            reportedSceneOverlap: Number(tooltip.dataset.sceneOverlap),
            inside:
              tooltipBox.left >= shellBox.left &&
              tooltipBox.top >= shellBox.top &&
              tooltipBox.right <= shellBox.right &&
              tooltipBox.bottom <= shellBox.bottom
          };
        })
      )
      .toEqual({
        overlap: 0,
        reportedOverlap: 0,
        reportedSceneOverlap: 0,
        inside: true
      });
  });

  test("keeps player controls named, referenced, and free of duplicate IDs", async ({
    page
  }) => {
    await page.goto(previewUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    expect(
      await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll("[id]"), (element) => element.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
      })
    ).toEqual([]);
    expect(
      await page.locator("button:not([hidden])").evaluateAll((buttons) =>
        buttons
          .filter((button) => !(button as HTMLButtonElement).disabled)
          .map(
            (button) =>
              button.getAttribute("aria-label")?.trim() ??
              button.textContent?.trim() ??
              ""
          )
          .filter((name) => name.length === 0)
      )
    ).toEqual([]);
    await expect(page.locator("#hotspot")).toHaveAttribute(
      "aria-describedby",
      "tooltip-body"
    );
    await expect(page.locator("#tooltip-body")).toBeVisible();
  });

  test("fits bounded fallback font drift to the captured text rectangle", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const renderedWidth = (text: string, fontFamily: string) => {
        const probe = document.createElement("span");
        probe.textContent = text;
        Object.assign(probe.style, {
          fontFamily,
          fontSize: "20px",
          lineHeight: "24px",
          position: "absolute",
          visibility: "hidden",
          whiteSpace: "pre"
        });
        document.body.append(probe);
        const range = document.createRange();
        range.selectNodeContents(probe);
        const width = range.getBoundingClientRect().width;
        probe.remove();
        return width;
      };
      const capturedWidth = renderedWidth("Fallback metric", "Georgia, serif") * 1.4;
      const capturedGlyphWidth = renderedWidth("⌁", "sans-serif") * 1.8;
      const nearWrapWidth =
        renderedWidth("ShowKit Agent Demo", "Arial, sans-serif") - 4;
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            steps: Array<{ nodes: Array<Record<string, unknown>> }>;
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "", id: "fallback-metric" },
        styles: {
          display: "block",
          position: "absolute",
          left: "40px",
          top: "40px",
          width: capturedWidth + "px",
          height: "24px",
          "font-family": "Georgia, serif",
          "font-size": "20px",
          "line-height": "24px",
          "white-space": "pre"
        },
        children: [{ type: "text", text: "Fallback metric" }]
      });
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "", id: "fallback-glyph" },
        styles: {
          display: "block",
          position: "absolute",
          left: "40px",
          top: "80px",
          width: capturedGlyphWidth + "px",
          height: "24px",
          "font-family": "sans-serif",
          "font-size": "20px",
          "line-height": "24px",
          "white-space": "pre"
        },
        children: [{ type: "text", text: "⌁" }]
      });
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "", id: "near-wrap-fallback" },
        styles: {
          display: "block",
          position: "absolute",
          left: "200px",
          top: "80px",
          width: nearWrapWidth + "px",
          height: "24px",
          "font-family": "Arial, sans-serif",
          "font-size": "20px",
          "line-height": "24px",
          "white-space": "pre-wrap"
        },
        children: [{ type: "text", text: "ShowKit Agent Demo" }]
      });
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-layout",
      "checked"
    );
    expect(
      Number(
        await page
          .locator("#scene-viewport")
          .getAttribute("data-text-metric-fit-count")
      )
    ).toBeGreaterThan(0);
    await expect(page.locator("#fallback-metric > [data-showkit-text-fit]")).toBeAttached();
    await expect(page.locator("#fallback-glyph > [data-showkit-text-fit]")).toBeAttached();
    await expect(
      page.locator("#near-wrap-fallback > [data-showkit-text-fit]")
    ).toBeAttached();
  });

  test("fails closed when near-wrap recovery exceeds the scale budget", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.textContent = "ShowKit Agent Demo";
      Object.assign(probe.style, {
        fontFamily: "Arial, sans-serif",
        fontSize: "20px",
        lineHeight: "24px",
        position: "absolute",
        visibility: "hidden",
        whiteSpace: "pre"
      });
      document.body.append(probe);
      const range = document.createRange();
      range.selectNodeContents(probe);
      const unsafeWidth = range.getBoundingClientRect().width * 0.75;
      probe.remove();
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            steps: Array<{ nodes: Array<Record<string, unknown>> }>;
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "", id: "unsafe-near-wrap" },
        styles: {
          display: "block",
          position: "absolute",
          left: "200px",
          top: "80px",
          width: unsafeWidth + "px",
          height: "24px",
          "font-family": "Arial, sans-serif",
          "font-size": "20px",
          "line-height": "24px",
          "white-space": "pre-wrap"
        },
        children: [{ type: "text", text: "ShowKit Agent Demo" }]
      });
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-layout",
      "failed"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-metric-drift-count",
      "1"
    );
  });

  test("groups same-line rectangles and bounds multi-line redaction masks", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await page.evaluate(() => {
      const measureText = (text: string, whiteSpace: string) => {
        const probe = document.createElement("span");
        probe.textContent = text;
        Object.assign(probe.style, {
          display: "block",
          fontFamily: "Arial, sans-serif",
          fontSize: "16px",
          lineHeight: "20px",
          position: "absolute",
          visibility: "hidden",
          whiteSpace
        });
        document.body.append(probe);
        const range = document.createRange();
        range.selectNodeContents(probe);
        const rectangle = range.getBoundingClientRect();
        probe.remove();
        return rectangle;
      };
      const sameLine = measureText(" in ", "pre");
      const redacted = measureText("••••••••••\n••••••••••", "pre");
      const wrappedProbe = document.createElement("span");
      wrappedProbe.textContent = "Bounded visible copy wraps safely";
      Object.assign(wrappedProbe.style, {
        display: "block",
        fontFamily: "Arial, sans-serif",
        fontSize: "16px",
        lineHeight: "20px",
        position: "absolute",
        visibility: "hidden",
        whiteSpace: "normal",
        width: "132px"
      });
      document.body.append(wrappedProbe);
      const wrappedRange = document.createRange();
      wrappedRange.selectNodeContents(wrappedProbe);
      const wrapped = wrappedRange.getBoundingClientRect();
      wrappedProbe.remove();
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            textRedactionActive?: boolean;
            steps: Array<{ nodes: Array<Record<string, unknown>> }>;
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.textRedactionActive = true;
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "", id: "same-line-rectangles" },
        styles: {
          display: "block",
          position: "absolute",
          left: "40px",
          top: "40px",
          width: sameLine.width + "px",
          height: sameLine.height + "px",
          "font-family": "Arial, sans-serif",
          "font-size": "16px",
          "line-height": "20px",
          "white-space": "pre"
        },
        children: [
          {
            type: "element",
            tag: "span",
            attributes: {},
            styles: { display: "inline" },
            children: [{ type: "text", text: " " }]
          },
          {
            type: "element",
            tag: "span",
            attributes: {},
            styles: { display: "inline" },
            children: [{ type: "text", text: "in " }]
          }
        ]
      });
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: {
          "data-showkit-text": "",
          id: "bounded-redacted-lines"
        },
        styles: {
          display: "block",
          position: "absolute",
          left: "40px",
          top: "80px",
          width: redacted.width + "px",
          height: redacted.height + "px",
          "font-family": "Arial, sans-serif",
          "font-size": "16px",
          "line-height": "20px",
          "white-space": "pre"
        },
        children: [
          { type: "text", text: "••••••••••\n••••••••••" }
        ]
      });
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: {
          "data-showkit-text": "",
          id: "bounded-visible-lines"
        },
        styles: {
          display: "block",
          position: "absolute",
          left: "240px",
          top: "80px",
          width: wrapped.width + "px",
          height: wrapped.height + "px",
          "font-family": "Arial, sans-serif",
          "font-size": "16px",
          "line-height": "20px",
          "white-space": "normal"
        },
        children: [
          { type: "text", text: "Bounded visible copy wraps safely" }
        ]
      });
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-layout",
      "checked"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-multi-line-fragment-count",
      "0"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-redacted-multi-line-fragment-count",
      "1"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-bounded-multi-line-fragment-count",
      "1"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-metric-drift-count",
      "0"
    );
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-collision-count",
      "0"
    );
  });

  test("reports generated HTML text drift and collisions before fidelity is claimed", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(previewUrl);
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-layout",
      "checked"
    );
    await page.evaluate(() => {
      const payload = (
        window as unknown as {
          __SHOWKIT_DEMO__: {
            steps: Array<{ nodes: Array<Record<string, unknown>> }>;
          };
        }
      ).__SHOWKIT_DEMO__;
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "" },
        styles: {
          display: "block",
          position: "absolute",
          left: "40px",
          top: "40px",
          width: "20px",
          height: "20px",
          "line-height": "20px",
          "white-space": "pre"
        },
        children: [
          {
            type: "text",
            text: "This captured line cannot fit its recorded rectangle"
          }
        ]
      });
      payload.steps[0]!.nodes.push({
        type: "element",
        tag: "span",
        attributes: { "data-showkit-text": "" },
        styles: {
          display: "block",
          position: "absolute",
          left: "80px",
          top: "80px",
          width: "100px",
          height: "40px",
          "font-family": "Arial, sans-serif",
          "font-size": "16px",
          "line-height": "20px",
          "white-space": "pre"
        },
        children: [{ type: "text", text: "Line one\nLine two" }]
      });
    });
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#scene-viewport")).toHaveAttribute(
      "data-text-layout",
      "failed"
    );
    expect(
      Number(
        await page
          .locator("#scene-viewport")
          .getAttribute("data-text-metric-drift-count")
      )
    ).toBeGreaterThan(0);
    expect(
      Number(
        await page
          .locator("#scene-viewport")
          .getAttribute("data-text-multi-line-fragment-count")
      )
    ).toBeGreaterThan(0);
    expect(
      Number(
        await page
          .locator("#scene-viewport")
          .getAttribute("data-text-collision-count")
      )
    ).toBeGreaterThan(0);
  });

  test("reports artifact drift and fails the opt-in CI check", () => {
    expect(unchangedDiff.status).toBe("unchanged");
    expect(changedDiff).toEqual(
      expect.objectContaining({
        status: "changed",
        currentVersion: recoveredVersion,
        storyChanged: true,
        sourceChanged: false
      })
    );
    expect(checkedDiff.error?.code).toBe("ArtifactDriftDetected");
  });

  test("blocks failed reports before the hosted publish boundary", async () => {
    const qualityPath = path.join(artifactDirectory, "quality.json");
    const originalQuality = await readFile(qualityPath, "utf8");
    const failedQuality = JSON.parse(originalQuality) as {
      passed: boolean;
      checks: Array<{ passed: boolean }>;
    };
    failedQuality.passed = false;
    failedQuality.checks[0]!.passed = false;
    try {
      await writeFile(qualityPath, `${JSON.stringify(failedQuality, null, 2)}\n`);
      const blocked = runCli(
        projectDirectory,
        ["publish", "--version", firstVersion],
        2
      );
      expect(blocked.error?.code).toBe("ArtifactPublishBlocked");
    } finally {
      await writeFile(qualityPath, originalQuality);
    }

    const manifest = JSON.parse(
      await readFile(path.join(artifactDirectory, "artifact.json"), "utf8")
    ) as { state: string; publish: unknown };
    expect(manifest).toEqual(expect.objectContaining({ state: "BUILT", publish: null }));
  });

  test("plays from a generic static server without the ShowKit CLI", async ({ page }) => {
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(portableUrl)) externalRequests.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(portableUrl);
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(
      page.getByRole("heading", { name: "Open session filters" })
    ).toBeVisible();
    await expect(page.locator("#hotspot")).toBeVisible();
    await expect(page.getByRole("img", { name: "Demo operator" })).toBeVisible();
    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("creates a portable bundle with deterministic hashes and no raster scenes", async () => {
    const files = await allFileContents(artifactDirectory);
    expect(files.map((file) => path.basename(file.path))).toEqual(
      expect.arrayContaining([
        "artifact.json",
        "index.html",
        "player.js",
        "quality.json",
        "release-notes.md",
        "story.js",
        "styles.css",
        "verification.json"
      ])
    );
    const assetFiles = files.filter((file) =>
      /[/\\]assets[/\\][a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg)$/.test(file.path)
    );
    expect(assetFiles).toHaveLength(1);
    expect(files.some((file) => file.contents.includes(canary))).toBe(false);
    const manifest = JSON.parse(
      await readFile(path.join(artifactDirectory, "artifact.json"), "utf8")
    ) as {
      state: string;
      version: string;
      files: Array<{ path: string; sha256: string; mediaType: string }>;
      reports: { verification: string; quality: string };
      provenance: { assets: Array<{ path: string; origin: string }> };
      sanitization: { fullSceneRasterCount: number };
    };
    expect(manifest.version).toBe(firstVersion);
    expect(manifest.state).toBe("BUILT");
    expect(manifest.reports).toEqual({
      verification: "verification.json",
      quality: "quality.json"
    });
    expect(manifest.sanitization.fullSceneRasterCount).toBe(0);
    const assetEntry = manifest.files.find((file) => file.path.startsWith("assets/"));
    expect(assetEntry?.mediaType).toBe("image/png");
    expect(manifest.provenance.assets).toEqual([
      expect.objectContaining({
        path: assetEntry!.path,
        origin: "captured-product-flow"
      })
    ]);
    const assetBytes = await readFile(path.join(artifactDirectory, assetEntry!.path));
    expect(createHash("sha256").update(assetBytes).digest("hex")).toBe(assetEntry!.sha256);
    const cachedAsset = await readFile(
      path.join(projectDirectory, ".showkit", assetEntry!.path)
    );
    expect(createHash("sha256").update(cachedAsset).digest("hex")).toBe(assetEntry!.sha256);
    const storyContents = await readFile(path.join(artifactDirectory, "story.js"), "utf8");
    expect(storyContents).not.toContain('"html":');
    const playerContents = await readFile(path.join(artifactDirectory, "player.js"));
    expect(gzipSync(playerContents).byteLength).toBeLessThanOrEqual(80 * 1024);
  });
});

test.describe("capture safety", () => {
  test("keeps the tooltip clear of a visible label for a visually hidden form target", async ({
    page
  }) => {
    test.setTimeout(120_000);
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-visible-target-")
    );
    const fixtureDirectory = await mkdtemp(
      path.join(
        repositoryRoot,
        "fixtures",
        "demo-apps",
        "assurance",
        ".visible-target-"
      )
    );
    const fixturePath = path.join(fixtureDirectory, "index.html");
    const specPath = path.join(fixtureDirectory, "visible-target.demo.ts");
    const fixtureUrl = `http://127.0.0.1:4173/${path
      .relative(path.join(repositoryRoot, "fixtures", "demo-apps"), fixturePath)
      .split(path.sep)
      .join("/")}`;
    let previewServer: Server | undefined;

    await writeFile(
      fixturePath,
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      html, body, main { width: 100%; height: 100%; margin: 0; }
      main { position: relative; background: #f5f5f2; }
      label {
        position: absolute;
        left: -40px;
        top: 300px;
        box-sizing: border-box;
        display: flex;
        width: 200px;
        height: 48px;
        align-items: center;
        justify-content: center;
        border: 1px solid #222;
        border-radius: 24px;
        background: #fff;
        font: 600 18px/1.2 system-ui, sans-serif;
      }
      [role="dialog"] {
        position: absolute;
        left: 0;
        top: 260px;
        width: 240px;
        height: 150px;
        border: 1px solid #bbb;
        border-radius: 12px;
        background: #fff;
      }
      input {
        position: absolute;
        left: 0;
        top: 24px;
        width: 1px;
        height: 1px;
        overflow: clip;
        clip-path: inset(100%);
      }
    </style>
  </head>
  <body>
    <main>
      <div role="dialog" aria-label="Trip length options"></div>
      <input id="trip-length-weekend" type="radio" name="trip-length" value="weekend" aria-label="Weekend">
      <label for="trip-length-weekend"><span>Weekend</span></label>
    </main>
  </body>
</html>`
    );
    await writeFile(
      specPath,
      `import { test } from "@showkit/cli/playwright";

test.use({ viewport: { width: 1280, height: 720 } });

test("captures a labelled radio target", async ({ page, demo }) => {
  await page.goto(${JSON.stringify(fixtureUrl)});
  const target = page.getByRole("radio", { name: "Weekend", exact: true });
  await demo.step({
    id: "choose-weekend",
    title: "Choose a weekend",
    target,
    captureTarget: {
      strategy: "role",
      role: "radio",
      name: "Weekend"
    },
    action: () =>
      page.locator('label[for="trip-length-weekend"]').dispatchEvent("click")
  });
});
`
    );

    try {
      runCli(projectDirectory, ["init"]);
      const capture = runCli(projectDirectory, [
        "capture",
        specPath,
        "--viewport",
        "1280x720"
      ]);
      const captureSource = JSON.parse(
        await readFile(String(capture.path), "utf8")
      ) as CaptureFixtureData & {
        steps: Array<{
          id: string;
          title: string;
          scene: {
            anchorId: string;
            target: {
              bounds: { x: number; y: number; width: number; height: number };
            };
          };
          evidence: Array<{ id: string; text: string }>;
        }>;
      };
      expect(captureSource.steps[0]!.scene.target.bounds).toEqual(
        expect.objectContaining({
          x: 0,
          width: expect.closeTo(160 / 1280, 5),
          height: expect.closeTo(48 / 720, 5)
        })
      );
      expect(JSON.stringify(captureSource.steps[0]!.scene)).toContain(
        '"data-showkit-interaction-box":"sk-choose-weekend"'
      );

      const storyPath = path.join(projectDirectory, "visible-target-story.json");
      await writeFile(
        storyPath,
        `${JSON.stringify(
          storyForCapture(captureSource, {
            id: "visible-target-story",
            title: "Visible target placement",
            goal: "Keep the guide clear of the highlighted control."
          }),
          null,
          2
        )}\n`
      );
      runCli(projectDirectory, ["story", "apply", storyPath]);
      runCli(projectDirectory, ["validate"]);
      const build = runCli(projectDirectory, ["build", "web"]);
      const preview = await startPortableStaticServer(String(build.path));
      previewServer = preview.server;

      await page.goto(preview.url);
      await page.getByRole("button", { name: "Explore demo" }).click();
      const geometry = await page.evaluate(() => {
        const label = document.querySelector("[data-showkit-scene-root] label");
        const hotspot = document.querySelector("#hotspot");
        const tooltip = document.querySelector("#tooltip");
        const dialog = document.querySelector(
          '[data-showkit-scene-root] [role="dialog"]'
        );
        const viewport = document.querySelector("#scene-viewport");
        const shell = document.querySelector("#scene-shell");
        if (
          !(label instanceof HTMLElement) ||
          !(hotspot instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement) ||
          !(dialog instanceof HTMLElement) ||
          !(viewport instanceof HTMLElement) ||
          !(shell instanceof HTMLElement)
        ) {
          throw new Error("Expected visible target geometry");
        }
        const rawLabelBox = label.getBoundingClientRect();
        const viewportBox = viewport.getBoundingClientRect();
        const shellBox = shell.getBoundingClientRect();
        const labelLeft = Math.max(
          rawLabelBox.left,
          viewportBox.left,
          shellBox.left
        );
        const labelTop = Math.max(
          rawLabelBox.top,
          viewportBox.top,
          shellBox.top
        );
        const labelRight = Math.min(
          rawLabelBox.right,
          viewportBox.right,
          shellBox.right
        );
        const labelBottom = Math.min(
          rawLabelBox.bottom,
          viewportBox.bottom,
          shellBox.bottom
        );
        const labelBox = {
          left: labelLeft,
          top: labelTop,
          right: labelRight,
          bottom: labelBottom,
          width: Math.max(0, labelRight - labelLeft),
          height: Math.max(0, labelBottom - labelTop)
        };
        const hotspotBox = hotspot.getBoundingClientRect();
        const hotspotStyle = getComputedStyle(hotspot);
        const tooltipBox = tooltip.getBoundingClientRect();
        const dialogBox = dialog.getBoundingClientRect();
        const overlapWidth = Math.max(
          0,
          Math.min(labelBox.right, tooltipBox.right) -
            Math.max(labelBox.left, tooltipBox.left)
        );
        const overlapHeight = Math.max(
          0,
          Math.min(labelBox.bottom, tooltipBox.bottom) -
            Math.max(labelBox.top, tooltipBox.top)
        );
        return {
          anchorId: document
            .querySelector("[data-showkit-anchor]")
            ?.getAttribute("data-showkit-anchor"),
          interactionBoxId: label.getAttribute(
            "data-showkit-interaction-box"
          ),
          interactionBoxCount: document.querySelectorAll(
            "[data-showkit-interaction-box]"
          ).length,
          labelBox: {
            left: labelBox.left,
            top: labelBox.top,
            width: labelBox.width,
            height: labelBox.height
          },
          hotspotBox: {
            left: hotspotBox.left,
            top: hotspotBox.top,
            width: hotspotBox.width,
            height: hotspotBox.height
          },
          hotspotStyle: {
            backgroundColor: hotspotStyle.backgroundColor,
            outlineOffset: hotspotStyle.outlineOffset,
            outlineStyle: hotspotStyle.outlineStyle
          },
          hotspotError: Math.max(
            Math.abs(labelBox.left - hotspotBox.left),
            Math.abs(labelBox.top - hotspotBox.top),
            Math.abs(labelBox.width - hotspotBox.width),
            Math.abs(labelBox.height - hotspotBox.height)
          ),
          tooltipOverlap: overlapWidth * overlapHeight,
          dialogTooltipOverlap:
            Math.max(
              0,
              Math.min(dialogBox.right, tooltipBox.right) -
                Math.max(dialogBox.left, tooltipBox.left)
            ) *
            Math.max(
              0,
              Math.min(dialogBox.bottom, tooltipBox.bottom) -
                Math.max(dialogBox.top, tooltipBox.top)
            )
        };
      });
      expect(
        geometry.hotspotError,
        JSON.stringify(geometry)
      ).toBeLessThanOrEqual(4);
      expect(geometry.hotspotStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(geometry.hotspotStyle.outlineStyle).toBe("solid");
      expect(Number.parseFloat(geometry.hotspotStyle.outlineOffset)).toBeGreaterThan(0);
      expect(geometry.tooltipOverlap).toBe(0);
      expect(geometry.dialogTooltipOverlap).toBe(0);

      await page.setViewportSize({ width: 1280, height: 708 });
      await page.evaluate(() => {
        const label = document.querySelector(
          '[data-showkit-interaction-box="sk-choose-weekend"]'
        );
        const viewport = document.querySelector("#scene-viewport");
        if (!(label instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
          throw new Error("Expected lower-edge target geometry");
        }
        const scale = new DOMMatrixReadOnly(
          getComputedStyle(viewport).transform
        ).a;
        const bounds = label.getBoundingClientRect();
        const transform = new DOMMatrix(getComputedStyle(label).transform);
        transform.f += (635 - bounds.top) / scale;
        label.style.transformOrigin = "0 0";
        label.style.transform = transform.toString();
      });
      await page.waitForTimeout(250);
      const lowerEdgePlacement = await page.evaluate(() => {
        const shell = document.querySelector("#scene-shell");
        const tooltip = document.querySelector("#tooltip");
        const actions = document.querySelector("#tooltip-actions");
        if (
          !(shell instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement) ||
          !(actions instanceof HTMLElement)
        ) {
          throw new Error("Expected lower-edge tooltip geometry");
        }
        const shellBox = shell.getBoundingClientRect();
        const tooltipBox = tooltip.getBoundingClientRect();
        const actionsBox = actions.getBoundingClientRect();
        return {
          bottomClearance: shellBox.bottom - tooltipBox.bottom,
          reportedBottomSafeArea: Number(tooltip.dataset.bottomSafeArea),
          actionsInside:
            actionsBox.left >= tooltipBox.left &&
            actionsBox.right <= tooltipBox.right &&
            actionsBox.top >= tooltipBox.top &&
            actionsBox.bottom <= tooltipBox.bottom,
          tooltipInside:
            tooltipBox.left >= shellBox.left &&
            tooltipBox.top >= shellBox.top &&
            tooltipBox.right <= shellBox.right &&
            tooltipBox.bottom <= shellBox.bottom
        };
      });
      expect(lowerEdgePlacement.tooltipInside).toBe(true);
      expect(lowerEdgePlacement.actionsInside).toBe(true);
      expect(lowerEdgePlacement.reportedBottomSafeArea).toBeGreaterThanOrEqual(48);
      expect(lowerEdgePlacement.bottomClearance).toBeGreaterThanOrEqual(
        lowerEdgePlacement.reportedBottomSafeArea - 1
      );

      await page.setViewportSize({ width: 300, height: 840 });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const label = document.querySelector(
          '[data-showkit-interaction-box="sk-choose-weekend"]'
        );
        const shell = document.querySelector("#scene-shell");
        const viewport = document.querySelector("#scene-viewport");
        const tooltip = document.querySelector("#tooltip");
        if (
          !(label instanceof HTMLElement) ||
          !(shell instanceof HTMLElement) ||
          !(viewport instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement)
        ) {
          throw new Error("Expected constrained target geometry");
        }
        tooltip.style.boxSizing = "border-box";
        tooltip.style.width = "220px";
        tooltip.style.height = "800px";
        tooltip.style.minHeight = "800px";
        tooltip.style.maxHeight = "800px";
        const scale = new DOMMatrixReadOnly(
          getComputedStyle(viewport).transform
        ).a;
        const bounds = label.getBoundingClientRect();
        const transform = new DOMMatrix(getComputedStyle(label).transform);
        transform.e += (0 - bounds.left) / scale;
        transform.f += (817.5 - bounds.top) / scale;
        label.style.transformOrigin = "0 0";
        label.style.transform = transform.toString();
        shell.style.width = "299px";
      });
      await page.waitForTimeout(250);
      const constrained = await page.evaluate(() => {
        const label = document.querySelector(
          '[data-showkit-interaction-box="sk-choose-weekend"]'
        );
        const hotspot = document.querySelector("#hotspot");
        const tooltip = document.querySelector("#tooltip");
        if (
          !(label instanceof HTMLElement) ||
          !(hotspot instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement)
        ) {
          throw new Error("Expected constrained placement geometry");
        }
        const overlap = (left: DOMRect, right: DOMRect): number =>
          Math.max(
            0,
            Math.min(left.right, right.right) - Math.max(left.left, right.left)
          ) *
          Math.max(
            0,
            Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
          );
        const tooltipBox = tooltip.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect();
        const hotspotBox = hotspot.getBoundingClientRect();
        return {
          labelOverlap: overlap(labelBox, tooltipBox),
          hotspotOverlap: overlap(hotspotBox, tooltipBox),
          reportedTargetOverlap: Number(tooltip.dataset.targetOverlap),
          labelBox: {
            left: labelBox.left,
            top: labelBox.top,
            width: labelBox.width,
            height: labelBox.height
          },
          hotspotBox: {
            left: hotspotBox.left,
            top: hotspotBox.top,
            width: hotspotBox.width,
            height: hotspotBox.height
          },
          tooltipBox: {
            left: tooltipBox.left,
            top: tooltipBox.top,
            width: tooltipBox.width,
            height: tooltipBox.height
          }
        };
      });
      expect(
        {
          labelOverlap: constrained.labelOverlap,
          hotspotOverlap: constrained.hotspotOverlap,
          reportedTargetOverlap: constrained.reportedTargetOverlap
        },
        JSON.stringify(constrained)
      ).toEqual({ labelOverlap: 0, hotspotOverlap: 0, reportedTargetOverlap: 0 });
    } finally {
      previewServer?.closeAllConnections();
      await new Promise<void>((resolve) => previewServer?.close(() => resolve()) ?? resolve());
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("fails closed when Playwright silently changes the capture viewport", async () => {
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-viewport-contract-")
    );
    const stepDriftProjectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-viewport-step-drift-")
    );
    const terminalDriftProjectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-viewport-terminal-drift-")
    );
    const specDirectory = await mkdtemp(
      path.join(
        repositoryRoot,
        "fixtures",
        "demo-apps",
        "assurance",
        ".viewport-contract-"
      )
    );
    const specPath = path.join(specDirectory, "viewport-contract.demo.ts");
    const stepDriftSpecPath = path.join(
      specDirectory,
      "viewport-step-drift.demo.ts"
    );
    const terminalDriftSpecPath = path.join(
      specDirectory,
      "viewport-terminal-drift.demo.ts"
    );
    await writeFile(
      specPath,
      `import { test } from "@showkit/cli/playwright";

test.use({ viewport: { width: 900, height: 720 } });

test("captures one viewport-bound step", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");
  const target = page.getByRole("button", { name: "Add filter" });
  await demo.step({
    id: "open-filter",
    title: "Open filter",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Add filter"
    },
    action: () => target.click()
  });
});
`
    );
    await writeFile(
      stepDriftSpecPath,
      `import { test } from "@showkit/cli/playwright";

test.use({ viewport: { width: 1440, height: 900 } });

test("blocks viewport drift before a later step", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");
  const target = page.getByRole("button", { name: "Add filter" });
  await demo.step({
    id: "first-filter",
    title: "Open the first filter",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Add filter"
    },
    action: () => page.setViewportSize({ width: 900, height: 720 })
  });
  await demo.step({
    id: "second-filter",
    title: "Open the second filter",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Add filter"
    },
    action: () => target.click()
  });
});
`
    );
    await writeFile(
      terminalDriftSpecPath,
      `import { test } from "@showkit/cli/playwright";

test.use({ viewport: { width: 1440, height: 900 } });

test("blocks viewport drift before the terminal scene", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");
  const target = page.getByRole("button", { name: "Add filter" });
  await demo.step({
    id: "open-filter",
    title: "Open the filter",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Add filter"
    },
    action: () => page.setViewportSize({ width: 900, height: 720 })
  });
});
`
    );

    try {
      runCli(projectDirectory, ["init"]);
      const preflight = runCli(projectDirectory, [
        "capture",
        specPath,
        "--preflight"
      ]);
      expect(preflight.expectedViewport).toEqual({ width: 1440, height: 900 });

      const missingValue = runCli(
        projectDirectory,
        ["capture", specPath, "--viewport"],
        2
      );
      expect(missingValue.error).toEqual(
        expect.objectContaining({ code: "DemoFixtureSetupFailed" })
      );

      const blocked = runCli(projectDirectory, ["capture", specPath], 3);
      expect(blocked.error).toEqual(
        expect.objectContaining({
          code: "DemoFixtureSetupFailed",
          details: expect.objectContaining({
            category: "capture-viewport-mismatch",
            expectedViewport: { width: 1440, height: 900 },
            actualViewport: { width: 900, height: 720 }
          })
        })
      );
      const blockedFiles = await allFileContents(
        path.join(projectDirectory, ".showkit")
      );
      expect(
        blockedFiles.some((file) => file.path.endsWith("capture.json"))
      ).toBe(false);

      const explicitlySized = runCli(projectDirectory, [
        "capture",
        specPath,
        "--viewport",
        "900x720"
      ]);
      expect(explicitlySized.viewport).toEqual({ width: 900, height: 720 });

      for (const [driftProjectDirectory, driftSpecPath] of [
        [stepDriftProjectDirectory, stepDriftSpecPath],
        [terminalDriftProjectDirectory, terminalDriftSpecPath]
      ] as const) {
        runCli(driftProjectDirectory, ["init"]);
        const drift = runCli(
          driftProjectDirectory,
          ["capture", driftSpecPath],
          3
        );
        expect(drift.error).toEqual(
          expect.objectContaining({
            code: "DemoFixtureSetupFailed",
            details: expect.objectContaining({
              category: "capture-viewport-mismatch",
              expectedViewport: { width: 1440, height: 900 },
              actualViewport: { width: 900, height: 720 }
            })
          })
        );
        const driftFiles = await allFileContents(
          path.join(driftProjectDirectory, ".showkit")
        );
        expect(
          driftFiles.some((file) => file.path.endsWith("capture.json"))
        ).toBe(false);
      }
    } finally {
      await rm(specDirectory, { recursive: true, force: true });
      await rm(projectDirectory, { recursive: true, force: true });
      await rm(stepDriftProjectDirectory, { recursive: true, force: true });
      await rm(terminalDriftProjectDirectory, {
        recursive: true,
        force: true
      });
    }
  });

  test("uses an isolated Chromium world when the page overrides browser prototypes", async () => {
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-browser-realm-")
    );
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(projectDirectory, [
        "capture",
        "fixtures/demo-apps/assurance/browser-realm-attack.demo.ts"
      ]);
      const capture = JSON.parse(
        await readFile(String(response.path), "utf8")
      ) as {
        source: {
          captureSecurity?: {
            provider: string;
            browserEngine: string;
            executionWorld: string;
          };
        };
      };
      expect(capture.source.captureSecurity).toEqual({
        provider: "playwright-cdp",
        browserEngine: "chromium",
        executionWorld: "chromium-cdp-isolated-readonly-v1"
      });
      const files = await allFileContents(
        path.join(projectDirectory, ".showkit")
      );
      expect(
        files.some((file) => file.contents.includes(hostilePageCanary))
      ).toBe(false);
      expect(
        files.some((file) => /\.(?:png|jpe?g|webp)$/i.test(file.path))
      ).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("fails closed when Playwright cannot provide a Chromium isolated world", async () => {
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-browser-isolation-unavailable-")
    );
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        [
          "capture",
          "fixtures/demo-apps/assurance/nonisolated-browser.demo.ts"
        ],
        3
      );
      expect(response.error?.code).toBe("UnsupportedSurface");
      expect(response.error?.details).toEqual(expect.objectContaining({
        category: "browser-isolation-unavailable"
      }));
      const files = await allFileContents(
        path.join(projectDirectory, ".showkit")
      );
      expect(
        files.some((file) => file.path.endsWith("capture.json"))
      ).toBe(false);
      expect(
        files.some((file) => /[/\\]assets[/\\]/.test(file.path))
      ).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("uses structured capture diagnostics for action, duplicate-ID, and multi-flow recovery", async () => {
    test.setTimeout(120_000);
    const actionProjectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-action-diagnostic-")
    );
    const duplicateProjectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-duplicate-diagnostic-")
    );
    const multiFlowProjectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-multi-flow-diagnostic-")
    );
    await mkdir(path.join(repositoryRoot, "test-results"), { recursive: true });
    const specDirectory = await mkdtemp(
      path.join(repositoryRoot, "test-results", ".freshness-report-diagnostic-")
    );
    const actionSpecPath = path.join(specDirectory, "action.demo.ts");
    const duplicateSpecPath = path.join(specDirectory, "duplicate.demo.ts");
    const multiFlowSpecPath = path.join(specDirectory, "multi-flow.demo.ts");
    try {
      await writeFile(
        actionSpecPath,
        `import { test } from "@showkit/cli/playwright";

test("reports the failing action", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");
  const target = page.getByRole("button", { name: "Add filter" });
  await demo.step({
    id: "action-failure",
    title: "Action failure",
    target,
    captureTarget: { strategy: "role", role: "button", name: "Add filter" },
    action: async () => {
      console.error("[SHOWKIT:SensitiveDataDetected]");
      throw new Error("Source action stopped.");
    }
  });
});
`
      );
      runCli(actionProjectDirectory, ["init"]);
      const actionResponse = runCli(
        actionProjectDirectory,
        ["capture", actionSpecPath],
        3
      );
      expect(actionResponse.error).toEqual(
        expect.objectContaining({
          code: "DemoFixtureSetupFailed",
          recovery: expect.stringContaining("failing action"),
          details: expect.objectContaining({
            failurePhase: "action",
            stepProgress: [
              expect.objectContaining({
                stepId: "action-failure",
                state: "failed",
                phase: "action"
              })
            ]
          })
        })
      );
      expect(actionResponse.error?.recovery).not.toContain("viewport");

      await writeFile(
        duplicateSpecPath,
        `import { test } from "@showkit/cli/playwright";

test("rejects duplicate step IDs", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");
  const target = page.getByRole("button", { name: "Add filter" });
  for (const title of ["First", "Second"]) {
    await demo.step({
      id: "duplicate-step",
      title,
      target,
      captureTarget: { strategy: "role", role: "button", name: "Add filter" },
      action: async () => undefined
    });
  }
});
`
      );
      runCli(duplicateProjectDirectory, ["init"]);
      const duplicateResponse = runCli(
        duplicateProjectDirectory,
        ["capture", duplicateSpecPath],
        2
      );
      expect(duplicateResponse.error).toEqual(
        expect.objectContaining({
          code: "DemoFixtureSetupFailed",
          message: expect.stringContaining("same demo step ID"),
          recovery: expect.stringContaining("different lowercase hyphenated ID"),
          details: expect.objectContaining({
            category: "duplicate-step-id"
          })
        })
      );

      await writeFile(
        multiFlowSpecPath,
        `import { test } from "@showkit/cli/playwright";

for (const id of ["first-flow", "second-flow"]) {
  test(id, async ({ page, demo }) => {
    await page.goto("http://127.0.0.1:4173/public/index.html");
    const target = page.getByRole("button", { name: "Add filter" });
    await demo.step({
      id,
      title: id,
      target,
      captureTarget: { strategy: "role", role: "button", name: "Add filter" },
      action: async () => undefined
    });
  });
}
`
      );
      runCli(multiFlowProjectDirectory, ["init"]);
      const multiFlowResponse = runCli(
        multiFlowProjectDirectory,
        ["capture", multiFlowSpecPath],
        3
      );
      expect(multiFlowResponse.error).toEqual(
        expect.objectContaining({
          code: "DemoFixtureSetupFailed",
          message: expect.stringContaining("More than one Playwright test or project"),
          recovery: expect.stringContaining("--project <name>"),
          details: expect.objectContaining({
            category: "multiple-playwright-flows"
          })
        })
      );
    } finally {
      await rm(specDirectory, { recursive: true, force: true });
      await rm(actionProjectDirectory, { recursive: true, force: true });
      await rm(duplicateProjectDirectory, { recursive: true, force: true });
      await rm(multiFlowProjectDirectory, { recursive: true, force: true });
    }
  });

  test("fails before persistence when sensitive data is present", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-secret-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        ["capture", "fixtures/demo-apps/secret/secret.demo.ts"],
        2
      );
      expect(response.error?.code).toBe("SensitiveDataDetected");
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.path.endsWith("capture.json"))).toBe(false);
      expect(files.some((file) => file.contents.includes(canary))).toBe(false);
      const blockedRun = files.find((file) => file.path.endsWith("run.json"));
      expect(blockedRun).toBeDefined();
      expect(JSON.parse(blockedRun!.contents)).toEqual(
        expect.objectContaining({
          state: "BLOCKED_DIAGNOSTIC",
          command: "capture",
          failure: { code: "SensitiveDataDetected" }
        })
      );
      expect(
        files.some((file) => /[/\\]runs[/\\].*[/\\]assets[/\\]/.test(file.path))
      ).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("fails before persistence when an action puts sensitive data in the document title", async () => {
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-sensitive-title-")
    );
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        [
          "capture",
          "fixtures/demo-apps/assurance/sensitive-title.demo.ts"
        ],
        2
      );
      expect(response.error?.code).toBe("SensitiveDataDetected");
      const files = await allFileContents(
        path.join(projectDirectory, ".showkit")
      );
      expect(
        files.some((file) => file.path.endsWith("capture.json"))
      ).toBe(false);
      expect(
        files.some((file) => file.contents.includes(sensitiveTitleCanary))
      ).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("fails when the action locator and isolated capture target differ", async () => {
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-target-mismatch-")
    );
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        [
          "capture",
          "fixtures/demo-apps/assurance/target-mismatch.demo.ts"
        ],
        2
      );
      expect(response.error?.code).toBe("TargetMissing");
      expect(response.error?.details).toEqual(expect.objectContaining({
        category: "target-locator-mismatch"
      }));
      const files = await allFileContents(
        path.join(projectDirectory, ".showkit")
      );
      expect(
        files.some((file) => file.path.endsWith("capture.json"))
      ).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("returns a named error without an image fallback for unsupported content", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-unsupported-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        ["capture", "fixtures/demo-apps/unsupported/unsupported.demo.ts"],
        2
      );
      expect(response.error?.code).toBe("UnsupportedSurface");
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.path.endsWith("capture.json"))).toBe(false);
      expect(files.some((file) => /\.(?:png|jpe?g|webp)$/i.test(file.path))).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("rejects a full-scene image without a screenshot fallback", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-screenshot-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        ["capture", "fixtures/demo-apps/screenshot/screenshot.demo.ts"],
        2
      );
      expect(response.error?.code).toBe("UnsupportedSurface");
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.path.endsWith("capture.json"))).toBe(false);
      expect(files.some((file) => /[/\\]assets[/\\]/.test(file.path))).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("rejects a remote image before persistence", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-remote-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        ["capture", "fixtures/demo-apps/remote-asset/remote-asset.demo.ts"],
        2
      );
      expect(response.error?.code).toBe("UnsupportedSurface");
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.path.endsWith("capture.json"))).toBe(false);
      expect(files.some((file) => file.contents.includes("/remote-asset/missing.png"))).toBe(
        false
      );
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("removes scripts, handlers, forms, values, and destinations while keeping empty controls", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-sanitizer-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(projectDirectory, [
        "capture",
        "fixtures/demo-apps/sanitizer/sanitizer.demo.ts"
      ]);
      const capture = await readFile(String(response.path), "utf8");
      expect(capture).not.toMatch(/<script|<form|onclick|unpublished/i);
      expect(capture).toMatch(/<input\b/i);
      expect(capture).not.toMatch(/\bvalue=|"value"\s*:/i);
      expect(capture).not.toContain("https://example.test/private-path");
      expect(capture).not.toContain('"href"');
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("keeps Playwright storage values runtime-only", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-storage-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(projectDirectory, [
        "capture",
        "fixtures/demo-apps/storage/storage.demo.ts"
      ]);
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.contents.includes(canary))).toBe(false);
      const capture = JSON.parse(await readFile(String(response.path), "utf8")) as {
        fixture: { auth: unknown };
      };
      expect(capture.fixture.auth).toEqual({
        storageState: "runtime-only-if-configured",
        persisted: false
      });
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("rejects an oversized asset without persisting it", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-oversized-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        ["capture", "fixtures/demo-apps/oversized/oversized.demo.ts"],
        2
      );
      expect(response.error?.code).toBe("CaptureTooLarge");
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.path.endsWith("capture.json"))).toBe(false);
      expect(files.some((file) => /[/\\]assets[/\\]/.test(file.path))).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("returns CaptureSourceEmpty for a flow without demo steps", async () => {
    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-empty-"));
    try {
      runCli(projectDirectory, ["init"]);
      const response = runCli(
        projectDirectory,
        ["capture", "fixtures/demo-apps/empty/empty.demo.ts"],
        2
      );
      expect(response.error?.code).toBe("CaptureSourceEmpty");
      const files = await allFileContents(path.join(projectDirectory, ".showkit"));
      expect(files.some((file) => file.path.endsWith("capture.json"))).toBe(false);
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });
});
