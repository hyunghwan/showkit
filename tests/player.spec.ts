import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  error?: { code: string; details?: Record<string, unknown> };
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
  return output;
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
  let artifactDirectory: string;
  let firstVersion: string;
  let baseAssetRevision: string;
  let unchangedDiff: CliResponse;
  let changedDiff: CliResponse;
  let checkedDiff: CliResponse;
  let recoveredVersion: string;

  test.beforeAll(async () => {
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
    const repeatedCapture = runCli(projectDirectory, [
      "capture",
      "fixtures/demo-apps/public/public.demo.ts"
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
        }
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
    if (projectDirectory) {
      await rm(projectDirectory, { recursive: true, force: true });
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

  test("preserves source-sized controls for tall captures without painting over them", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
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

  test("blocks failed reports before the local-only Cloud boundary", async () => {
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

    const localOnly = runCli(
      projectDirectory,
      ["publish", "--version", firstVersion],
      4
    );
    expect(localOnly.error?.code).toBe("CloudFeatureUnavailable");
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
        left: 400px;
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
    action: () => page.locator('label[for="trip-length-weekend"]').click()
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
          width: expect.closeTo(200 / 1280, 5),
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
        if (
          !(label instanceof HTMLElement) ||
          !(hotspot instanceof HTMLElement) ||
          !(tooltip instanceof HTMLElement)
        ) {
          throw new Error("Expected visible target geometry");
        }
        const labelBox = label.getBoundingClientRect();
        const hotspotBox = hotspot.getBoundingClientRect();
        const tooltipBox = tooltip.getBoundingClientRect();
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
          hotspotError: Math.max(
            Math.abs(labelBox.left - hotspotBox.left),
            Math.abs(labelBox.top - hotspotBox.top),
            Math.abs(labelBox.width - hotspotBox.width),
            Math.abs(labelBox.height - hotspotBox.height)
          ),
          tooltipOverlap: overlapWidth * overlapHeight
        };
      });
      expect(
        geometry.hotspotError,
        JSON.stringify(geometry)
      ).toBeLessThanOrEqual(4);
      expect(geometry.tooltipOverlap).toBe(0);

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
      await new Promise<void>((resolve) => previewServer?.close(() => resolve()) ?? resolve());
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });

  test("fails closed when Playwright silently changes the capture viewport", async () => {
    const projectDirectory = await mkdtemp(
      path.join(os.tmpdir(), "showkit-viewport-contract-")
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

    try {
      runCli(projectDirectory, ["init"]);
      const preflight = runCli(projectDirectory, [
        "capture",
        specPath,
        "--preflight"
      ]);
      expect(preflight.expectedViewport).toEqual({ width: 1280, height: 720 });

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
          details: {
            category: "capture-viewport-mismatch",
            expectedViewport: { width: 1280, height: 720 },
            actualViewport: { width: 900, height: 720 }
          }
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
    } finally {
      await rm(specDirectory, { recursive: true, force: true });
      await rm(projectDirectory, { recursive: true, force: true });
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
        2
      );
      expect(response.error?.code).toBe("UnsupportedSurface");
      expect(response.error?.details).toEqual({
        category: "browser-isolation-unavailable"
      });
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
      expect(response.error?.details).toEqual({
        category: "target-locator-mismatch"
      });
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
