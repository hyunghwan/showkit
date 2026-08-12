import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page
} from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import {
  compareCapturedImages,
  cropCapturedImage,
  type CapturedImageComparison
} from "../packages/cli/src/capture/image.js";
import { captureScene } from "../packages/cli/src/capture/browser.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "packages/cli/dist/bin.js");
const viewport = { width: 1280, height: 720 };
// Linux Chromium rasterizes replayed positioned text with more edge variance,
// while the geometry assertion below still rejects layout drift on every platform.
const channelFidelityLimits =
  process.platform === "linux"
    ? { scene: 0.02, focus: 0.08 }
    : { scene: 0.002, focus: 0.005 };
// Pixelmatch removes antialiasing-only edges, but Linux Chromium still produces
// a small amount of font-raster variance across otherwise aligned text runs.
// Keep critical product regions on the cross-platform budget below.
const perceptualFidelityLimits =
  process.platform === "linux"
    ? { scene: 0.005, focus: 0.04 }
    : { scene: 0.002, focus: 0.005 };
const criticalPerceptualFidelityLimit = 0.005;
const geometryTolerance = 0.75;

type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function expectRectanglesAligned(actual: Rectangle, expected: Rectangle): void {
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[coordinate] - expected[coordinate])).toBeLessThan(
      geometryTolerance
    );
  }
}

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
  let previous: Buffer | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      clip: { x: 0, y: 0, ...viewport },
      scale: "css",
      type: "png"
    });
    if (previous) {
      const stability = await comparePerceptualImages(current, previous);
      if (stability.changedPixelCount === 0) return current;
    }
    previous = current;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
  }
  throw new Error("The browser render did not stabilize for visual comparison.");
}

async function comparePerceptualImages(
  actualBytes: Uint8Array,
  expectedBytes: Uint8Array
): Promise<{
  width: number;
  height: number;
  changedPixelCount: number;
  changedPixelRatio: number;
}> {
  const decode = (bytes: Uint8Array) =>
    sharp(Buffer.from(bytes), {
      failOn: "error",
      limitInputPixels: 4096 * 4096
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const [actual, expected] = await Promise.all([
    decode(actualBytes),
    decode(expectedBytes)
  ]);
  expect(actual.info).toEqual(
    expect.objectContaining({
      width: expected.info.width,
      height: expected.info.height,
      channels: 4
    })
  );
  const changedPixelCount = pixelmatch(
    actual.data,
    expected.data,
    null,
    actual.info.width,
    actual.info.height,
    { includeAA: false, threshold: 0.1 }
  );
  return {
    width: actual.info.width,
    height: actual.info.height,
    changedPixelCount,
    changedPixelRatio:
      changedPixelCount / (actual.info.width * actual.info.height)
  };
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

type OneStepFidelityRegion = {
  name: string;
  source: Locator;
  replaySelector: string;
};

type OneStepFidelityComparison = Awaited<
  ReturnType<typeof comparePerceptualImages>
> & {
  geometryDelta: number;
  changedStyleProperties: string[];
};

async function compareOneCapturedStep(options: {
  context: BrowserContext;
  sourcePage: Page;
  captured: Awaited<ReturnType<typeof captureScene>>;
  target: Locator;
  regions?: OneStepFidelityRegion[];
  replayHtml?: string;
}): Promise<{
  fullScene: Awaited<ReturnType<typeof comparePerceptualImages>>;
  target: OneStepFidelityComparison;
  regions: Record<string, OneStepFidelityComparison>;
}> {
  const replay = await options.context.newPage();
  const styleSnapshot = async (locator: Locator): Promise<Record<string, string>> =>
    locator.evaluate((element) => {
      const snapshot: Record<string, string> = {};
      const diagnosticProperties = [
        "-webkit-backdrop-filter",
        "-webkit-text-fill-color",
        "align-content",
        "align-items",
        "backdrop-filter",
        "background-clip",
        "background-color",
        "background-image",
        "background-position",
        "background-size",
        "border-bottom",
        "border-collapse",
        "border-left",
        "border-radius",
        "border-right",
        "border-spacing",
        "border-top",
        "box-shadow",
        "box-sizing",
        "color",
        "display",
        "filter",
        "flex",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "gap",
        "grid-template-columns",
        "grid-template-rows",
        "height",
        "justify-content",
        "letter-spacing",
        "line-height",
        "margin-bottom",
        "margin-left",
        "margin-right",
        "margin-top",
        "mask-image",
        "max-height",
        "max-width",
        "min-height",
        "min-width",
        "object-fit",
        "object-position",
        "opacity",
        "overflow",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "padding-top",
        "place-items",
        "position",
        "text-align",
        "text-shadow",
        "transform"
      ];
      const elements = [
        element,
        ...Array.from(element.querySelectorAll("*")).slice(0, 127)
      ];
      for (const [index, current] of elements.entries()) {
        const computed = getComputedStyle(current);
        for (const property of diagnosticProperties) {
          snapshot[`${index}:${property}`] = computed
            .getPropertyValue(property)
            .slice(0, 512);
        }
      }
      return snapshot;
    });
  const compareRegion = async (
    source: Locator,
    replayRegion: Locator,
    sourceScreenshot: Buffer,
    replayScreenshot: Buffer
  ): Promise<OneStepFidelityComparison> => {
    await expect(source).toHaveCount(1);
    await expect(replayRegion).toHaveCount(1);
    const [sourceBox, replayBox] = await Promise.all([
      source.boundingBox(),
      replayRegion.boundingBox()
    ]);
    expect(sourceBox).not.toBeNull();
    expect(replayBox).not.toBeNull();
    const geometryDelta = Math.max(
      ...(["x", "y", "width", "height"] as const).map((coordinate) =>
        Math.abs(sourceBox![coordinate] - replayBox![coordinate])
      )
    );
    const padding = 4;
    const width = Math.min(512, Math.ceil(sourceBox!.width + padding * 2));
    const height = Math.min(512, Math.ceil(sourceBox!.height + padding * 2));
    const left = Math.min(
      viewport.width - width,
      Math.max(
        0,
        Math.floor(sourceBox!.x + sourceBox!.width / 2 - width / 2)
      )
    );
    const top = Math.min(
      viewport.height - height,
      Math.max(
        0,
        Math.floor(sourceBox!.y + sourceBox!.height / 2 - height / 2)
      )
    );
    const rectangle = {
      left,
      top,
      width,
      height
    };
    const [sourceCrop, replayCrop, sourceStyles, replayStyles] =
      await Promise.all([
        cropCapturedImage({
          bytes: sourceScreenshot,
          ...rectangle,
          viewport
        }),
        cropCapturedImage({
          bytes: replayScreenshot,
          ...rectangle,
          viewport
        }),
        styleSnapshot(source),
        styleSnapshot(replayRegion)
      ]);
    const comparison = await comparePerceptualImages(
      replayCrop.bytes,
      sourceCrop.bytes
    );
    const normalizedReplayProperties = new Set([
      "-webkit-locale",
      "bottom",
      "inset-block-end",
      "inset-block-start",
      "inset-inline-end",
      "inset-inline-start",
      "left",
      "min-block-size",
      "min-height",
      "min-inline-size",
      "min-width",
      "position",
      "right",
      "top"
    ]);
    const changedStyleProperties =
      comparison.changedPixelCount === 0
        ? []
        : [...new Set([...Object.keys(sourceStyles), ...Object.keys(replayStyles)])]
            .filter((key) => sourceStyles[key] !== replayStyles[key])
            .map((key) => key.slice(key.indexOf(":") + 1))
            .filter((property) => !normalizedReplayProperties.has(property))
            .sort()
            .slice(0, 32);
    return { ...comparison, geometryDelta, changedStyleProperties };
  };

  try {
    await replay.setContent(options.replayHtml ?? options.captured.scene.html);
    await replay.addStyleTag({
      content: "html,body{width:1280px;height:720px;margin:0;overflow:hidden;}"
    });
    const [sourceScreenshot, replayScreenshot] = await Promise.all([
      screenshotViewport(options.sourcePage),
      screenshotViewport(replay)
    ]);
    const fullScene = await comparePerceptualImages(
      replayScreenshot,
      sourceScreenshot
    );
    const target = await compareRegion(
      options.target,
      replay.locator(
        `[data-showkit-anchor="${options.captured.scene.anchorId}"]`
      ),
      sourceScreenshot,
      replayScreenshot
    );
    const regions: Record<string, OneStepFidelityComparison> = {};
    for (const region of options.regions ?? []) {
      regions[region.name] = await compareRegion(
        region.source,
        replay.locator(region.replaySelector),
        sourceScreenshot,
        replayScreenshot
      );
    }
    return { fullScene, target, regions };
  } finally {
    await replay.close();
  }
}

test("detects a small missing visual asset without writing a diff image", async () => {
  const background = {
    create: {
      width: 64,
      height: 64,
      channels: 4 as const,
      background: "#fffdf8"
    }
  };
  const actual = await sharp(background).png().toBuffer();
  const expected = await sharp(background)
    .composite([
      {
        input: {
          create: {
            width: 16,
            height: 16,
            channels: 4,
            background: "#7d4be2"
          }
        },
        left: 24,
        top: 24
      }
    ])
    .png()
    .toBuffer();

  const comparison = await comparePerceptualImages(actual, expected);
  expect(comparison.changedPixelCount).toBe(256);
  expect(comparison.changedPixelRatio).toBe(0.0625);
});

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
    const perceptualComparisons: Awaited<
      ReturnType<typeof comparePerceptualImages>
    >[] = [];
    const perceptualFocusComparisons: Awaited<
      ReturnType<typeof comparePerceptualImages>
    >[] = [];
    const criticalRegionComparisons: Array<{
      key: string;
      comparison: Awaited<ReturnType<typeof comparePerceptualImages>>;
    }> = [];
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
      perceptualComparisons.push(
        await comparePerceptualImages(replayScreenshot, sourceScreenshot)
      );

      const box = await sourceTarget.boundingBox();
      expect(box).not.toBeNull();
      const replayBox = await replay
        .locator(
          `[data-showkit-anchor="${capture.steps[index]!.scene.anchorId}"]`
        )
        .boundingBox();
      expect(replayBox).not.toBeNull();
      expectRectanglesAligned(replayBox!, box!);
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
      perceptualFocusComparisons.push(
        await comparePerceptualImages(
          replayFocus.bytes,
          sourceFocus.bytes
        )
      );

      for (const criticalRegion of [
        {
          key: "brand-mark",
          selector: '[role="img"][aria-label="Northstar mark"]'
        },
        {
          key: "preview-image",
          selector: 'img[alt="Four abstract customer segments"]'
        },
        {
          key: "accent-checkbox",
          selector: 'input[type="checkbox"]'
        }
      ]) {
        const sourceRegionBox = await page
          .locator(criticalRegion.selector)
          .boundingBox();
        const replayRegionBox = await replay
          .locator(criticalRegion.selector)
          .boundingBox();
        expect(sourceRegionBox).not.toBeNull();
        expect(replayRegionBox).not.toBeNull();
        expectRectanglesAligned(replayRegionBox!, sourceRegionBox!);
        const padding = 4;
        const width = Math.min(512, sourceRegionBox!.width + padding * 2);
        const height = Math.min(512, sourceRegionBox!.height + padding * 2);
        const left = Math.min(
          viewport.width - width,
          Math.max(
            0,
            sourceRegionBox!.x + sourceRegionBox!.width / 2 - width / 2
          )
        );
        const top = Math.min(
          viewport.height - height,
          Math.max(
            0,
            sourceRegionBox!.y + sourceRegionBox!.height / 2 - height / 2
          )
        );
        const [sourceCriticalRegion, replayCriticalRegion] = await Promise.all([
          cropCapturedImage({
            bytes: sourceScreenshot,
            left,
            top,
            width,
            height,
            viewport
          }),
          cropCapturedImage({
            bytes: replayScreenshot,
            left,
            top,
            width,
            height,
            viewport
          })
        ]);
        criticalRegionComparisons.push({
          key: `${index + 1}:${criticalRegion.key}`,
          comparison: await comparePerceptualImages(
            replayCriticalRegion.bytes,
            sourceCriticalRegion.bytes
          )
        });
      }

      if (index < stepTargets.length - 1) {
        await sourceTarget.click();
        await replay.keyboard.press("ArrowRight");
      }
    }

    const ratios = comparisons.map((comparison) => comparison.changedPixelRatio);
    const focusRatios = focusComparisons.map(
      (comparison) => comparison.changedPixelRatio
    );
    const perceptualRatios = perceptualComparisons.map(
      (comparison) => comparison.changedPixelRatio
    );
    const perceptualFocusRatios = perceptualFocusComparisons.map(
      (comparison) => comparison.changedPixelRatio
    );
    const criticalRegionRatios = criticalRegionComparisons.map(
      ({ comparison }) => comparison.changedPixelRatio
    );
    console.log(
      `SHOWKIT_VISUAL_FIDELITY ${JSON.stringify({
        platform: process.platform,
        ratios,
        focusRatios,
        perceptualRatios,
        perceptualFocusRatios,
        criticalRegionComparisons,
        comparisons,
        focusComparisons
      })}`
    );
    expect(Math.max(...ratios)).toBeLessThan(channelFidelityLimits.scene);
    expect(Math.max(...focusRatios)).toBeLessThan(channelFidelityLimits.focus);
    expect(Math.max(...perceptualRatios)).toBeLessThan(
      perceptualFidelityLimits.scene
    );
    expect(Math.max(...perceptualFocusRatios)).toBeLessThan(
      perceptualFidelityLimits.focus
    );
    expect(Math.max(...criticalRegionRatios)).toBeLessThan(
      criticalPerceptualFidelityLimit
    );

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

test("compares high-impact CSS capability regions with the native source", async ({
  context,
  page
}) => {
  await page.goto("http://127.0.0.1:4173/assurance/css-capabilities.html");
  const target = page.getByRole("button", {
    name: "Save capability review",
    exact: true
  });
  const captured = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Save capability review"
    },
    anchorId: "sk-css-capability-review"
  });
  const comparison = await compareOneCapturedStep({
    context,
    sourcePage: page,
    captured,
    target,
    regions: [
      {
        name: "backdrop-filter",
        source: page.locator('[aria-label="Backdrop filter sample"]'),
        replaySelector: '[aria-label="Backdrop filter sample"]'
      },
      {
        name: "background-clip",
        source: page.locator('[aria-label="Background clip sample"]'),
        replaySelector: '[aria-label="Background clip sample"]'
      }
    ]
  });

  console.log(`SHOWKIT_CSS_CAPABILITIES ${JSON.stringify(comparison)}`);
  expect(comparison.fullScene.changedPixelRatio).toBeLessThan(0.002);
  expect(comparison.target.changedPixelRatio).toBeLessThan(0.005);
  for (const region of Object.values(comparison.regions)) {
    expect(region.geometryDelta).toBeLessThan(geometryTolerance);
    expect(region.changedPixelRatio).toBeLessThan(0.005);
  }

  const degradedHtml = captured.scene.html.replace(
    /(?:-webkit-)?backdrop-filter:[^;"]+;?/g,
    (property) =>
      property.startsWith("-webkit-")
        ? "-webkit-backdrop-filter:none;"
        : "backdrop-filter:none;"
  );
  expect(degradedHtml).not.toBe(captured.scene.html);
  const detectedGap = await compareOneCapturedStep({
    context,
    sourcePage: page,
    captured,
    target,
    replayHtml: degradedHtml,
    regions: [
      {
        name: "backdrop-filter",
        source: page.locator('[aria-label="Backdrop filter sample"]'),
        replaySelector: '[aria-label="Backdrop filter sample"]'
      }
    ]
  });
  expect(detectedGap.regions["backdrop-filter"]?.changedPixelRatio).toBeGreaterThan(
    0.005
  );
  expect(
    detectedGap.regions["backdrop-filter"]?.changedStyleProperties
  ).toContain("backdrop-filter");

  const degradedGradientHtml = captured.scene.html.replace(
    /-webkit-text-fill-color:[^;\"]+;?/g,
    "-webkit-text-fill-color:#fffdf8;"
  );
  expect(degradedGradientHtml).not.toBe(captured.scene.html);
  const detectedGradientGap = await compareOneCapturedStep({
    context,
    sourcePage: page,
    captured,
    target,
    replayHtml: degradedGradientHtml,
    regions: [
      {
        name: "background-clip",
        source: page.locator('[aria-label="Background clip sample"]'),
        replaySelector: '[aria-label="Background clip sample"]'
      }
    ]
  });
  expect(
    detectedGradientGap.regions["background-clip"]?.changedPixelRatio
  ).toBeGreaterThan(0.005);
  expect(
    detectedGradientGap.regions["background-clip"]?.changedStyleProperties
  ).toContain("-webkit-text-fill-color");
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

test("leaves no publishable files when render settling times out", async () => {
  test.setTimeout(60_000);
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-render-timeout-"));
  try {
    runCli(projectDirectory, ["init"]);
    const response = runCli(
      projectDirectory,
      ["capture", "fixtures/demo-apps/assurance/render-settle-timeout.demo.ts"],
      2
    );
    expect(response.error?.code).toBe("UnsupportedSurface");
    expect(response.error?.details).toEqual(
      expect.objectContaining({ category: "unstable-render-state" })
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
