import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareCapturedImages,
  cropCapturedImage,
  type CapturedImageComparison
} from "../packages/cli/src/capture/image.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/bin.js");
const viewport = { width: 1280, height: 720 };

test.use({ viewport });

type CliResponse = {
  ok: boolean;
  status: string;
  path?: string;
  error?: {
    code: string;
    details?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

type CaptureFixtureData = {
  captureId: string;
  steps: Array<{
    id: string;
    title: string;
    scene: { anchorId: string };
    evidence: Array<{ id: string; text: string }>;
  }>;
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
      SHOWKIT_PROJECT_ROOT: projectDirectory,
      SHOWKIT_TEST_REUSE_FIXTURE_SERVER: "true"
    },
    encoding: "utf8"
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedExitCode);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout.trim()) as CliResponse;
}

function storyForCapture(capture: CaptureFixtureData): Record<string, unknown> {
  return {
    schemaVersion: "0.1",
    id: "visual-fidelity-assurance",
    sourceCaptureId: capture.captureId,
    title: "Presentation workspace walkthrough",
    audience: "Product teams",
    goal: "Review the captured presentation settings.",
    locale: "en-US",
    welcome: {
      title: "Presentation workspace",
      body: "Review the captured presentation settings.",
      actionLabel: "Explore demo",
      backdrop: "heavy"
    },
    steps: capture.steps.map((step) => ({
      id: step.id,
      captureStepId: step.id,
      anchorId: step.scene.anchorId,
      tooltip: {
        title: step.title,
        body: step.evidence[0]!.text,
        placement: "auto",
        backdrop: "off"
      },
      evidenceIds: [step.evidence[0]!.id],
      advance: "next"
    })),
    theme: {
      accent: "#7d4be2",
      ink: "#18252b",
      paper: "#f4f1e9"
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
      title: "Review complete",
      body: "The captured presentation flow is ready to share.",
      actions: [
        {
          label: "Email us for a demo",
          href: "mailto:hello@sqncs.com?subject=ShowKit%20demo%20request",
          style: "primary"
        }
      ]
    },
    formats: ["web"]
  };
}

async function startStaticServer(
  directory: string
): Promise<{ server: Server; url: string }> {
  const mediaTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".svg", "image/svg+xml"]
  ]);
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
        "Content-Type": mediaTypes.get(path.extname(filePath)) ?? "application/octet-stream",
        "Content-Length": contents.byteLength,
        "Cache-Control": "no-store"
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

async function settleNativeRender(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function screenshotViewport(page: Page): Promise<Buffer> {
  await settleNativeRender(page);
  return page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip: { x: 0, y: 0, ...viewport },
    scale: "css",
    type: "png"
  });
}

async function allFilePaths(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const filePath = path.join(directory, entry);
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) await visit(filePath);
      else output.push(filePath);
    }
  };
  await visit(root);
  return output.sort();
}

test("compares generated demo states with the native source render in memory", async ({
  page,
  context
}) => {
  test.setTimeout(120_000);
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-visual-fidelity-"));
  let artifactServer: Server | undefined;
  const replay = await context.newPage();
  try {
    expect(runCli(projectDirectory, ["init"]).status).toBe("created");
    const captureResponse = runCli(projectDirectory, [
      "capture",
      "fixtures/demo-apps/assurance/visual-fidelity.demo.ts",
      "--viewport",
      "1280x720"
    ]);
    expect(captureResponse.fullSceneRasterCount).toBe(0);
    const capture = JSON.parse(
      await readFile(String(captureResponse.path), "utf8")
    ) as CaptureFixtureData;
    expect(capture.steps).toHaveLength(3);

    const storyPath = path.join(projectDirectory, "visual-fidelity-story.json");
    await writeFile(storyPath, `${JSON.stringify(storyForCapture(capture), null, 2)}\n`);
    expect(runCli(projectDirectory, ["story", "apply", storyPath]).status).toBe("applied");
    const buildResponse = runCli(projectDirectory, ["build", "web"]);
    expect(buildResponse.status).toBe("built");
    const artifactDirectory = String(buildResponse.path);
    const staticServer = await startStaticServer(artifactDirectory);
    artifactServer = staticServer.server;

    await page.goto("http://127.0.0.1:4173/assurance/visual-fidelity.html");
    await replay.goto(staticServer.url);
    await replay.getByRole("button", { name: "Explore demo" }).click();
    await replay.addStyleTag({
      content: `
        #hotspot, #tooltip, #step-backdrop, #chrome-overlay,
        #showkit-watermark, .showkit-watermark { display: none !important; }
      `
    });

    const stepTargets = ["Customize view", "Align preview", "Review summary"] as const;
    const comparisons: CapturedImageComparison[] = [];
    const focusComparisons: CapturedImageComparison[] = [];
    for (let index = 0; index < stepTargets.length; index += 1) {
      const accessibleName = stepTargets[index]!;
      const sourceTarget = page.getByRole("button", { name: accessibleName });
      await sourceTarget.focus();
      await expect(replay.locator("#scene-viewport")).toHaveAttribute(
        "data-text-layout",
        "checked"
      );

      const [sourceScreenshot, replayScreenshot] = await Promise.all([
        screenshotViewport(page),
        screenshotViewport(replay)
      ]);
      comparisons.push(
        await compareCapturedImages({
          actual: replayScreenshot,
          expected: sourceScreenshot,
          channelThreshold: 16
        })
      );

      const box = await sourceTarget.boundingBox();
      expect(box).not.toBeNull();
      const focusRectangle = {
        left: Math.max(0, box!.x - 8),
        top: Math.max(0, box!.y - 8),
        width: Math.min(512, box!.width + 16),
        height: Math.min(512, box!.height + 16)
      };
      const [sourceFocus, replayFocus] = await Promise.all([
        cropCapturedImage({
          bytes: sourceScreenshot,
          ...focusRectangle,
          viewport
        }),
        cropCapturedImage({
          bytes: replayScreenshot,
          ...focusRectangle,
          viewport
        })
      ]);
      focusComparisons.push(
        await compareCapturedImages({
          actual: replayFocus.bytes,
          expected: sourceFocus.bytes,
          channelThreshold: 16
        })
      );

      if (index < stepTargets.length - 1) {
        await sourceTarget.click();
        await replay.keyboard.press("ArrowRight");
      }
    }

    const ratios = comparisons.map((comparison) => comparison.changedPixelRatio);
    const focusRatios = focusComparisons.map(
      (comparison) => comparison.changedPixelRatio
    );
    console.log(
      `SHOWKIT_VISUAL_FIDELITY ${JSON.stringify({ ratios, focusRatios })}`
    );
    expect(Math.max(...ratios)).toBeLessThan(0.002);
    expect(Math.max(...focusRatios)).toBeLessThan(0.005);

    const projectFiles = await allFilePaths(path.join(projectDirectory, ".showkit"));
    expect(
      projectFiles.some((filePath) =>
        /(?:screenshot|baseline|actual|visual-diff).*\.(?:png|jpe?g|webp)$/i.test(filePath)
      )
    ).toBe(false);
    expect(
      projectFiles.some((filePath) => /full[-_]?scene.*\.(?:png|jpe?g|webp)$/i.test(filePath))
    ).toBe(false);
  } finally {
    await replay.close();
    if (artifactServer) {
      await new Promise<void>((resolve, reject) =>
        artifactServer!.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("fails closed for a native dialog instead of flattening its semantics", async () => {
  test.setTimeout(60_000);
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-native-dialog-"));
  try {
    runCli(projectDirectory, ["init"]);
    const response = runCli(
      projectDirectory,
      ["capture", "fixtures/demo-apps/assurance/native-dialog.demo.ts"],
      2
    );
    expect(response.error?.code).toBe("UnsupportedSurface");
    expect(response.error?.details).toEqual(
      expect.objectContaining({ category: "dialog" })
    );
    const projectFiles = await allFilePaths(path.join(projectDirectory, ".showkit"));
    expect(projectFiles.some((filePath) => filePath.endsWith("capture.json"))).toBe(false);
    expect(
      projectFiles.some((filePath) => /\.(?:png|jpe?g|webp)$/i.test(filePath))
    ).toBe(false);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
