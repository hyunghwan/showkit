import type { Locator, Page, Request, TestInfo } from "@playwright/test";
import { open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { contentHash, sha256, writeJsonAtomic } from "../core/json.js";
import {
  CaptureEnvelopeSchema,
  CaptureSourceSchema,
  DemoFixtureSchema,
  SCHEMA_VERSION,
  type AssetPayload,
  type CaptureStep,
  type CaptureSource
} from "../core/schemas.js";
import {
  PLAYWRIGHT_CAPTURE_ISOLATION_VERSION,
  captureScene,
  evidenceFromTexts,
  type SemanticCaptureTarget
} from "./browser.js";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import {
  CaptureFailureDiagnosticSchema,
  CaptureStepProgressSchema,
  type CaptureStepProgress
} from "../core/freshness.js";
import {
  assertCaptureSafeForPersistence,
  containsConfiguredSensitiveText
} from "../core/security.js";
import type { PageAssetConsent } from "./extractor.js";

const DEFAULT_CAPTURE_VIEWPORT = { width: 1280, height: 720 } as const;
type CaptureStepPhase = "setup" | "capture" | "action" | "outcome";

function expectedCaptureViewport(): { width: number; height: number } {
  const raw = process.env.SHOWKIT_EXPECTED_VIEWPORT;
  if (!raw) return { ...DEFAULT_CAPTURE_VIEWPORT };
  const match = /^(\d{1,4})x(\d{1,4})$/i.exec(raw);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !match ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "[SHOWKIT:DemoFixtureSetupFailed] The capture viewport contract is invalid. No captured page was saved. [SHOWKIT-CATEGORY:capture-viewport-contract-invalid]",
      exitCode: EXIT_CODES.environment,
      recovery:
        "Run capture through the ShowKit CLI with a valid `--viewport WIDTHxHEIGHT` value."
    });
  }
  return { width, height };
}

function assertCaptureViewport(page: Page): { width: number; height: number } {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "[SHOWKIT:DemoFixtureSetupFailed] ShowKit requires a fixed Playwright viewport.",
      exitCode: EXIT_CODES.environment,
      recovery: "Set a fixed Playwright viewport, then capture again."
    });
  }
  const expectedViewport = expectedCaptureViewport();
  if (
    viewport.width !== expectedViewport.width ||
    viewport.height !== expectedViewport.height
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        `[SHOWKIT:DemoFixtureSetupFailed] The Playwright viewport ${viewport.width}x${viewport.height} does not match the ${expectedViewport.width}x${expectedViewport.height} capture contract. No captured page was saved. ` +
        `[SHOWKIT-CATEGORY:capture-viewport-mismatch] [SHOWKIT-VIEWPORT:${expectedViewport.width}x${expectedViewport.height}:${viewport.width}x${viewport.height}]`,
      exitCode: EXIT_CODES.environment,
      recovery:
        `Set Playwright to ${expectedViewport.width}x${expectedViewport.height}. Use another \`--viewport WIDTHxHEIGHT\` only for an exact requested size or an existing demo.`
    });
  }
  return viewport;
}

function assetExtension(
  mimeType: AssetPayload["mimeType"]
): string {
  return {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "font/woff2": "woff2"
  }[mimeType];
}

function mergeCaptureAssets(
  target: Map<string, AssetPayload>,
  assets: AssetPayload[]
): void {
  for (const asset of assets) target.set(asset.sha256, asset);
  const totalBytes = [...target.values()].reduce(
    (total, asset) => total + asset.byteLength,
    0
  );
  if (target.size > 64 || totalBytes > 20 * 1_048_576) {
    throw new ShowKitError({
      code: "CaptureTooLarge",
      message:
        "[SHOWKIT:CaptureTooLarge] The captured product flow exceeds the page asset limit. No captured page was saved.",
      exitCode: EXIT_CODES.validation,
      recovery:
        "Reduce the number or size of visible page assets, then capture again.",
      details: { category: "asset-total-limit" }
    });
  }
}

export type DemoStepOptions = {
  id: string;
  title: string;
  target: Locator;
  captureTarget: OptionalTargetName<SemanticCaptureTarget>;
  pageAssetConsent?: PageAssetConsent;
  remoteAssetPolicy?: "strict" | "decorative-remove";
  action: () => Promise<unknown>;
};

type OptionalTargetName<T> = T extends { name: string }
  ? Omit<T, "name"> & { name?: string }
  : T;

export type DemoController = {
  step(options: DemoStepOptions): Promise<void>;
};

export function parseCaptureTarget(value: unknown): SemanticCaptureTarget {
  const parsed =
    DemoFixtureSchema.shape.steps.element.shape.target.safeParse(value);
  if (parsed.success) return parsed.data;

  const missingName = parsed.error.issues.some(
    (issue) => issue.path.at(-1) === "name"
  );
  const category = missingName
    ? "capture-target-name-required"
    : "capture-target-invalid";
  throw new ShowKitError({
    code: "DemoFixtureSetupFailed",
    message: missingName
      ? "[SHOWKIT:DemoFixtureSetupFailed] Each `captureTarget` needs an accessible name from 1 through 180 characters. No captured page was saved. [SHOWKIT-CATEGORY:capture-target-name-required]"
      : "[SHOWKIT:DemoFixtureSetupFailed] The `captureTarget` does not match a supported target strategy. No captured page was saved. [SHOWKIT-CATEGORY:capture-target-invalid]",
    exitCode: EXIT_CODES.validation,
    recovery: missingName
      ? "Add the target's exact 1-to-180-character accessible name to `captureTarget.name`, then capture again."
      : "Use a supported `captureTarget` strategy with all required fields, then capture again.",
    details: { category }
  });
}

function boundedAccessibleName(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length >= 1 && normalized.length <= 180 ? normalized : "";
}

async function inferLocatorAccessibleName(
  target: Locator,
  expectedRole?: string,
  strategy?: SemanticCaptureTarget["strategy"]
): Promise<string> {
  const deadline = performance.now() + 5_000;
  const remainingTimeout = (): number =>
    Math.max(1, Math.ceil(deadline - performance.now()));
  const boundedTargetAttribute = async (
    name: string,
    maxLength = 180
  ): Promise<string | null> =>
    target
      .evaluate(
        (element, options) => {
          const value = element.getAttribute(options.name);
          return value !== null && value.length <= options.maxLength
            ? value
            : null;
        },
        { name, maxLength },
        { timeout: remainingTimeout() }
      )
      .catch(() => null);
  const hasOversizedNameSource = await target
    .evaluate(
      (root) => {
        const limits: Array<[string, number]> = [
          ["alt", 180],
          ["aria-label", 180],
          ["aria-labelledby", 512],
          ["id", 256],
          ["title", 180],
          ["value", 180]
        ];
        const pending: Element[] = [root];
        let visited = 0;
        while (pending.length > 0 && visited < 512) {
          const element = pending.shift()!;
          visited += 1;
          if (
            limits.some(([name, limit]) => {
              const value = element.getAttribute(name);
              return value !== null && value.length > limit;
            })
          ) {
            return true;
          }
          for (const child of element.children) {
            if (pending.length + visited >= 512) break;
            pending.push(child);
          }
        }
        return false;
      },
      undefined,
      { timeout: remainingTimeout() }
    )
    .catch(() => true);
  if (hasOversizedNameSource) return "";
  const exactAccessibleName = async (
    value: string | null | undefined
  ): Promise<string> => {
    const name = boundedAccessibleName(value);
    if (!name || !expectedRole) return name;
    try {
      return (await target
        .page()
        .getByRole(expectedRole as Parameters<Page["getByRole"]>[0], {
          name,
          exact: true
        })
        .and(target)
        .count()) === 1
        ? name
        : "";
    } catch {
      return "";
    }
  };
  const visibleLocatorText = async (locator: Locator): Promise<string> => {
    if ((await locator.count().catch(() => 0)) === 0) return "";
    return locator
      .first()
      .evaluate(
        (root) => {
          const visited = new Set<Element>();
          let visitedNodes = 0;
          let capturedCharacters = 0;
          const parts: string[] = [];
          const append = (value: string | null): void => {
            if (!value || capturedCharacters > 180) return;
            const remaining = 181 - capturedCharacters;
            parts.push(value.slice(0, remaining));
            capturedCharacters += Math.min(value.length, remaining);
          };
          const visit = (
            node: Node,
            allowHiddenRoot = false,
            allowLabelledBy = true
          ): void => {
            if (visitedNodes >= 512 || capturedCharacters > 180) return;
            visitedNodes += 1;
            if (node.nodeType === Node.TEXT_NODE) {
              append(node.textContent);
              return;
            }
            if (!(node instanceof Element) || visited.has(node)) return;
            visited.add(node);
            const tag = node.tagName.toLowerCase();
            if (["script", "style", "template", "noscript"].includes(tag)) {
              return;
            }
            const style = getComputedStyle(node);
            if (
              !allowHiddenRoot &&
              (node.getAttribute("aria-hidden") === "true" ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                Number.parseFloat(style.opacity || "1") === 0)
            ) {
              return;
            }
            if (allowLabelledBy) {
              const labelledBy = node.getAttribute("aria-labelledby");
              if (labelledBy) {
                for (const id of labelledBy.split(/\s+/).filter(Boolean).slice(0, 8)) {
                  const label = document.getElementById(id);
                  if (label) visit(label, true, false);
                }
                return;
              }
            }
            const ariaLabel = node.getAttribute("aria-label");
            if (ariaLabel) {
              append(ariaLabel);
              return;
            }
            if (tag === "img") {
              append(node.getAttribute("alt") || node.getAttribute("title"));
              return;
            }
            if (["input", "select", "textarea"].includes(tag)) return;
            for (const child of Array.from(node.childNodes)) visit(child);
          };
          visit(root);
          return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 181);
        },
        undefined,
        { timeout: remainingTimeout() }
      )
      .catch(() => "");
  };
  const matchesSelector = async (selector: string): Promise<boolean> =>
    (await target
      .page()
      .locator(selector)
      .and(target)
      .count()
      .catch(() => 0)) === 1;
  const safeContentNames = async (): Promise<string[]> =>
    target
      .evaluate(
        (root) => {
          const parts: string[] = [];
          let visitedNodes = 0;
          let capturedCharacters = 0;
          const append = (value: string | null): void => {
            if (!value || capturedCharacters > 180) return;
            const remaining = 181 - capturedCharacters;
            parts.push(value.slice(0, remaining));
            capturedCharacters += Math.min(value.length, remaining);
          };
          const visit = (node: Node): void => {
            if (visitedNodes >= 512 || capturedCharacters > 180) return;
            visitedNodes += 1;
            if (node.nodeType === Node.TEXT_NODE) {
              append(node.textContent);
              return;
            }
            if (!(node instanceof Element)) return;
            const tag = node.tagName.toLowerCase();
            if (["script", "style", "template", "noscript"].includes(tag)) {
              return;
            }
            const style = getComputedStyle(node);
            if (
              node.getAttribute("aria-hidden") === "true" ||
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              Number.parseFloat(style.opacity || "1") === 0
            ) {
              return;
            }
            if (tag === "img") {
              const labelledBy = node.getAttribute("aria-labelledby");
              let appendedReferencedName = false;
              if (labelledBy) {
                for (const id of labelledBy.split(/\s+/).filter(Boolean).slice(0, 8)) {
                  const label = document.getElementById(id);
                  const value = label?.getAttribute("aria-label") || label?.textContent;
                  if (value) {
                    append(value);
                    appendedReferencedName = true;
                  }
                }
              }
              if (appendedReferencedName) return;
              append(
                node.getAttribute("aria-label") ||
                  node.getAttribute("alt") ||
                  node.getAttribute("title")
              );
              return;
            }
            if (["input", "select", "textarea"].includes(tag)) {
              return;
            }
            const ariaLabel = node.getAttribute("aria-label");
            if (ariaLabel) {
              append(ariaLabel);
              return;
            }
            for (const child of Array.from(node.childNodes)) visit(child);
          };
          for (const child of Array.from(root.childNodes)) visit(child);
          return [...new Set([
            parts.join("").replace(/\s+/g, " ").trim(),
            parts.join(" ").replace(/\s+/g, " ").trim()
          ])].filter(Boolean);
        },
        undefined,
        { timeout: remainingTimeout() }
      )
      .catch(() => []);
  const visibleTextName = async (): Promise<string> =>
    target
      .evaluate(
        (root) => {
          let visitedNodes = 0;
          let value = "";
          const visit = (node: Node): void => {
            if (visitedNodes >= 512 || value.length > 180) return;
            visitedNodes += 1;
            if (node.nodeType === Node.TEXT_NODE) {
              value += node.textContent ?? "";
              return;
            }
            if (!(node instanceof Element)) return;
            const style = getComputedStyle(node);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              Number.parseFloat(style.opacity || "1") === 0
            ) {
              return;
            }
            for (const child of Array.from(node.childNodes)) visit(child);
          };
          for (const child of Array.from(root.childNodes)) visit(child);
          return value.slice(0, 181);
        },
        undefined,
        { timeout: remainingTimeout() }
      )
      .catch(() => "");
  if (strategy === "title") {
    return boundedAccessibleName(
      await boundedTargetAttribute("title")
    );
  }
  if (strategy === "visible-text") {
    return boundedAccessibleName(await visibleTextName());
  }
  const labelledBy = await boundedTargetAttribute("aria-labelledby", 512);
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/).filter(Boolean).slice(0, 8)) {
      const text = await visibleLocatorText(
        target.page().locator(`[id=${JSON.stringify(id)}]`)
      );
      if (text) parts.push(text);
    }
    const labelledName = await exactAccessibleName(parts.join(" "));
    if (labelledName) return labelledName;
  }

  const ariaLabel = await exactAccessibleName(
    await boundedTargetAttribute("aria-label")
  );
  if (ariaLabel) return ariaLabel;

  if (await matchesSelector("table")) {
    const caption = await exactAccessibleName(
      await visibleLocatorText(target.locator(":scope > caption"))
    );
    if (caption) return caption;
  }

  const id = await boundedTargetAttribute("id", 256);
  if (id) {
    const associatedLabel = await exactAccessibleName(
      await visibleLocatorText(
        target.page().locator(`label[for=${JSON.stringify(id)}]`)
      )
    );
    if (associatedLabel) return associatedLabel;
  }

  const ancestorLabel = await exactAccessibleName(
    await visibleLocatorText(target.locator("xpath=ancestor::label[1]"))
  );
  if (ancestorLabel) return ancestorLabel;
  if (strategy === "label") return "";

  const inputImage = await matchesSelector('input[type="image" i]');
  if (inputImage) {
    const alt = await exactAccessibleName(
      await boundedTargetAttribute("alt")
    );
    if (alt) return alt;
  }
  if (
    await matchesSelector(
      'input[type="button" i], input[type="reset" i], input[type="submit" i]'
    )
  ) {
    const value = await exactAccessibleName(
      await boundedTargetAttribute("value")
    );
    if (value) return value;
    if (await matchesSelector('input[type="submit" i]')) {
      const defaultName = await exactAccessibleName("Submit");
      if (defaultName) return defaultName;
    }
    if (await matchesSelector('input[type="reset" i]')) {
      const defaultName = await exactAccessibleName("Reset");
      if (defaultName) return defaultName;
    }
  }
  if (await matchesSelector("img")) {
    const alt = await exactAccessibleName(
      await boundedTargetAttribute("alt")
    );
    if (alt) return alt;
  }
  for (const candidate of await safeContentNames()) {
    const contentName = await exactAccessibleName(candidate);
    if (contentName) return contentName;
  }
  const title = await exactAccessibleName(
    await boundedTargetAttribute("title")
  );
  if (title) return title;
  if (inputImage) {
    const defaultName = await exactAccessibleName("Submit");
    if (defaultName) return defaultName;
  }
  const emptyFileInput =
    (await matchesSelector('input[type="file" i]')) &&
    (await target
      .evaluate(
        (element) =>
          element instanceof HTMLInputElement &&
          element.type.toLowerCase() === "file" &&
          (element.files?.length ?? 0) === 0,
        undefined,
        { timeout: remainingTimeout() }
      )
      .catch(() => false));
  const unsafeRoot =
    (await matchesSelector(
      "textarea,select,[contenteditable]:not([contenteditable='false']),input:not([type='button' i]):not([type='checkbox' i]):not([type='file' i]):not([type='image' i]):not([type='radio' i]):not([type='reset' i]):not([type='submit' i]),a[href],area[href]"
    )) ||
    ((await matchesSelector('input[type="file" i]')) && !emptyFileInput);
  const unsafeDescendantCount = await target
    .locator(
      "input,select,textarea,[contenteditable]:not([contenteditable='false']),a[href],area[href]"
    )
    .count()
    .catch(() => 0);
  const descendantCount = await target.locator("*").count().catch(() => 513);
  const snapshotSourcesBounded = await target
    .evaluate(
      (root) => {
        let sourceCharacters = 0;
        let visitedNodes = 0;
        const visit = (node: Node): boolean => {
          visitedNodes += 1;
          if (visitedNodes > 512) return false;
          if (node.nodeType === Node.TEXT_NODE) {
            sourceCharacters += node.textContent?.length ?? 0;
            return sourceCharacters <= 4_096;
          }
          if (!(node instanceof Element)) return true;
          for (const name of [
            "alt",
            "aria-label",
            "aria-labelledby",
            "title"
          ]) {
            const value = node.getAttribute(name);
            if (value && value.length > 512) return false;
            sourceCharacters += value?.length ?? 0;
            if (sourceCharacters > 4_096) return false;
          }
          for (const pseudo of ["::before", "::after"] as const) {
            const content = getComputedStyle(node, pseudo).content;
            if (content.length > 512) return false;
            sourceCharacters += content.length;
            if (sourceCharacters > 4_096) return false;
          }
          return Array.from(node.childNodes).every(visit);
        };
        return visit(root);
      },
      undefined,
      { timeout: remainingTimeout() }
    )
    .catch(() => false);
  if (
    !unsafeRoot &&
    unsafeDescendantCount === 0 &&
    descendantCount <= 128 &&
    snapshotSourcesBounded
  ) {
    const snapshot = await target
      .ariaSnapshot({ timeout: remainingTimeout() })
      .then((value) => (value.length <= 2_048 ? value : ""))
      .catch(() => "");
    const rootLine = snapshot.split("\n", 1)[0]?.trim() ?? "";
    const quotedName = /^-\s+[^\s:]+\s+"((?:\\.|[^"\\])*)"/.exec(
      rootLine
    )?.[1];
    if (quotedName !== undefined) {
      try {
        const snapshotName = await exactAccessibleName(
          JSON.parse(`"${quotedName}"`) as string
        );
        if (snapshotName) return snapshotName;
      } catch {
        // Invalid snapshot quoting is treated as a missing inferred name.
      }
    }
  }
  return "";
}

export async function resolveCaptureTarget(
  value: unknown,
  target: Locator
): Promise<SemanticCaptureTarget> {
  const parsed =
    DemoFixtureSchema.shape.steps.element.shape.target.safeParse(value);
  if (parsed.success) return parsed.data;
  const missingName = parsed.error.issues.some(
    (issue) => issue.path.at(-1) === "name"
  );
  let candidate = value;
  if (missingName && value && typeof value === "object" && !Array.isArray(value)) {
    const strategy = (value as Record<string, unknown>).strategy;
    const expectedRole =
      typeof (value as Record<string, unknown>).role === "string"
        ? ((value as Record<string, unknown>).role as string)
        : strategy === "href"
          ? "link"
          : undefined;
    const name = await inferLocatorAccessibleName(
      target,
      expectedRole,
      typeof strategy === "string"
        ? (strategy as SemanticCaptureTarget["strategy"])
        : undefined
    );
    if (name) {
      candidate = { ...(value as Record<string, unknown>), name };
      const recovered =
        DemoFixtureSchema.shape.steps.element.shape.target.safeParse(candidate);
      if (recovered.success) return recovered.data;
    }
  }
  return parseCaptureTarget(candidate);
}

export class CaptureSession implements DemoController {
  readonly #page: Page;
  readonly #testInfo: TestInfo;
  readonly #outputPath: string | undefined;
  readonly #outputKind: "capture" | "freshness";
  readonly #diagnosticOutputPath: string | undefined;
  readonly #steps: CaptureStep[] = [];
  readonly #stepProgress: CaptureStepProgress[] = [];
  readonly #stepTargets: SemanticCaptureTarget[] = [];
  readonly #assets = new Map<string, AssetPayload>();
  readonly #excludedSurfaces = new Set<string>();
  readonly #startedAt = performance.now();
  #sceneExtractionCount = 0;
  #sceneExtractionMs = 0;
  #actionCount = 0;
  #actionMs = 0;
  #failureRecorded = false;
  #pageAssetConsent: PageAssetConsent | undefined;
  #remoteAssetPolicy: "strict" | "decorative-remove" = "decorative-remove";
  readonly #observedPublicFontSources = new Set<string>();
  readonly #fontRequestListener: (request: Request) => void;
  #fixtureSeed:
    | {
        schemaVersion: typeof SCHEMA_VERSION;
        id: string;
        baseURL: string;
        startPath: string;
        viewport: { width: number; height: number };
        locale: string;
        timezoneId: string;
        lifecycle: {
          setup: "playwright-fixture";
          teardown: "playwright-fixture";
        };
        auth: {
          storageState: "runtime-only-if-configured";
          persisted: false;
        };
        debug: {
          screenshot: "off";
          traceBuildInput: false;
          video: "off";
        };
      }
    | undefined;

  constructor(page: Page, testInfo: TestInfo) {
    this.#page = page;
    this.#testInfo = testInfo;
    this.#outputPath = process.env.SHOWKIT_CAPTURE_OUTPUT;
    this.#outputKind =
      process.env.SHOWKIT_CAPTURE_OUTPUT_KIND === "freshness"
        ? "freshness"
        : "capture";
    this.#diagnosticOutputPath =
      process.env.SHOWKIT_CAPTURE_DIAGNOSTIC_OUTPUT;
    this.#fontRequestListener = (request): void => {
      if (
        !this.active ||
        request.resourceType() !== "font" ||
        this.#observedPublicFontSources.size >= 64
      ) {
        return;
      }
      const raw = request.url();
      if (raw.length > 10_000) return;
      try {
        const url = new URL(raw);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username !== "" ||
          url.password !== "" ||
          url.hash !== ""
        ) {
          return;
        }
        this.#observedPublicFontSources.add(url.href);
      } catch {
        // Malformed font request URLs are ignored and capture remains fail-closed.
      }
    };
    if (this.active) this.#page.on("request", this.#fontRequestListener);
  }

  get active(): boolean {
    return Boolean(this.#outputPath);
  }

  #reportStep(progress: {
    stepId: string;
    title: string;
    stepIndex: number;
    state: "reached" | "failed";
    phase: CaptureStepPhase;
  }): void {
    const parsedStepId =
      CaptureSourceSchema.shape.steps.element.shape.id.safeParse(
        progress.stepId
      );
    const parsedTitle =
      CaptureSourceSchema.shape.steps.element.shape.title.safeParse(
        progress.title
      );
    const stepId =
      parsedStepId.success &&
      !containsConfiguredSensitiveText(parsedStepId.data)
        ? parsedStepId.data
        : `step-${progress.stepIndex + 1}`;
    const title =
      parsedTitle.success &&
      !containsConfiguredSensitiveText(parsedTitle.data)
        ? parsedTitle.data
        : `Step ${progress.stepIndex + 1}`;
    this.#stepProgress.push(
      CaptureStepProgressSchema.parse({
        ...progress,
        stepId,
        title
      })
    );
  }

  async step(options: DemoStepOptions): Promise<void> {
    if (!this.active) {
      await options.action();
      return;
    }

    const stepIndex = this.#steps.length;
    const progress: { phase: CaptureStepPhase } = { phase: "setup" };
    try {
      if (this.#steps.some((step) => step.id === options.id)) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] Each demo step needs a unique ID. No captured page was saved. [SHOWKIT-CATEGORY:duplicate-step-id]",
          exitCode: EXIT_CODES.validation,
          recovery:
            "Give every `demo.step()` a different lowercase hyphenated ID, then capture again."
        });
      }
      await this.#captureStep(options, (nextPhase) => {
        progress.phase = nextPhase;
      });
      this.#reportStep({
        stepId: options.id,
        title: options.title,
        stepIndex,
        state: "reached",
        phase: "outcome"
      });
    } catch (error) {
      this.#reportStep({
        stepId: options.id,
        title: options.title,
        stepIndex,
        state: "failed",
        phase: progress.phase
      });
      await this.recordFailure(
        error,
        progress.phase,
        progress.phase === "action"
          ? "DemoFixtureSetupFailed"
          : "InternalError"
      );
      if (error instanceof ShowKitError) throw error;
      if (progress.phase === "action") {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] The source flow action stopped before capture finished. No captured page was saved.",
          exitCode: EXIT_CODES.environment,
          recovery: "Run the Playwright flow directly and fix the failing action."
        });
      }
      throw new ShowKitError({
        code: "InternalError",
        message:
          "[SHOWKIT:InternalError] ShowKit hit an internal capture error. No captured page was saved.",
        exitCode: EXIT_CODES.internal,
        recovery:
          "Retry once, then report the failure without including private page content."
      });
    }
  }

  async recordFailure(
    error: unknown,
    phase: CaptureStepPhase | "finalize",
    fallbackCode: "DemoFixtureSetupFailed" | "InternalError"
  ): Promise<void> {
    if (
      this.#failureRecorded ||
      !this.#diagnosticOutputPath
    ) {
      return;
    }
    const fallbackInternal = fallbackCode === "InternalError";
    const failure =
      error instanceof ShowKitError
        ? error
        : new ShowKitError({
            code: fallbackCode,
            message: fallbackInternal
              ? "ShowKit hit an internal capture error."
              : "The source flow stopped before capture finished.",
            exitCode: fallbackInternal
              ? EXIT_CODES.internal
              : EXIT_CODES.environment,
            recovery: fallbackInternal
              ? "Retry once, then report the failure without private page content."
              : "Run the Playwright flow directly and fix the failing action."
          });
    const code =
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(failure.code) &&
      !containsConfiguredSensitiveText(failure.code)
        ? failure.code
        : "InternalError";
    const category = [
      ...failure.message.matchAll(
        /\[SHOWKIT-CATEGORY:([a-z0-9-]{1,80})\]/g
      )
    ].at(-1)?.[1];
    const viewport = [
      ...failure.message.matchAll(
        /\[SHOWKIT-VIEWPORT:(\d{1,4})x(\d{1,4}):(\d{1,4})x(\d{1,4})\]/g
      )
    ].at(-1);
    await writeJsonAtomic(
      this.#diagnosticOutputPath,
      CaptureFailureDiagnosticSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        code,
        exitCode:
          code === "InternalError" ? EXIT_CODES.internal : failure.exitCode,
        phase,
        ...(category ? { category } : {}),
        ...(viewport
          ? {
              expectedViewport: {
                width: Number(viewport[1]),
                height: Number(viewport[2])
              },
              actualViewport: {
                width: Number(viewport[3]),
                height: Number(viewport[4])
              }
            }
          : {}),
        stepProgress: this.#stepProgress
      })
    );
    this.#failureRecorded = true;
  }

  async #writeCaptureOutput(value: unknown): Promise<void> {
    if (!this.#outputPath) return;
    const lockPath = `${this.#outputPath}.lock`;
    try {
      const lock = await open(lockPath, "wx");
      await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] More than one Playwright test or project tried to produce this flow. No captured page was saved. [SHOWKIT-CATEGORY:multiple-playwright-flows]",
        exitCode: EXIT_CODES.environment,
        recovery:
          "Keep one test in the source file and pass `--project <name>` when the Playwright config defines multiple projects."
      });
    }
    await writeJsonAtomic(this.#outputPath, value);
  }

  async #captureStep(
    options: DemoStepOptions,
    setPhase: (phase: Exclude<CaptureStepPhase, "setup">) => void
  ): Promise<void> {
    const captureTarget = await resolveCaptureTarget(
      options.captureTarget,
      options.target
    );
    const viewport = assertCaptureViewport(this.#page);
    if (!this.#fixtureSeed) {
      const currentUrl = new URL(this.#page.url());
      if (!["http:", "https:"].includes(currentUrl.protocol)) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] ShowKit requires an HTTP or HTTPS product page.",
          exitCode: EXIT_CODES.environment,
          recovery: "Open the product page before the first `demo.step()`."
        });
      }
      const fixtureId = this.#testInfo.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
      const screenshot = this.#testInfo.project.use.screenshot;
      const video = this.#testInfo.project.use.video;
      if (
        (screenshot !== undefined && screenshot !== "off") ||
        (video !== undefined && video !== "off")
      ) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "[SHOWKIT:DemoFixtureSetupFailed] ShowKit capture requires screenshot and video recording to be off.",
          exitCode: EXIT_CODES.environment,
          recovery: "Set Playwright `screenshot: \"off\"` and `video: \"off\"`, then capture again."
        });
      }
      this.#fixtureSeed = {
        schemaVersion: SCHEMA_VERSION,
        id: fixtureId || "demo-flow",
        baseURL: currentUrl.origin,
        startPath: currentUrl.pathname || "/",
        viewport,
        locale:
          typeof this.#testInfo.project.use.locale === "string"
            ? this.#testInfo.project.use.locale
            : "en-US",
        timezoneId:
          typeof this.#testInfo.project.use.timezoneId === "string"
            ? this.#testInfo.project.use.timezoneId
            : "UTC",
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
      };
    }
    if (
      options.pageAssetConsent &&
      this.#pageAssetConsent &&
      (options.pageAssetConsent.mode !== this.#pageAssetConsent.mode ||
        options.pageAssetConsent.consent !== this.#pageAssetConsent.consent)
    ) {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] A capture flow cannot change page asset consent after it starts. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Set one page asset consent mode on the first `demo.step()` and reuse it for the rest of the flow."
      });
    }
    if (options.pageAssetConsent && this.#steps.length > 0) {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] Page asset consent must be set on the first capture step. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Move `pageAssetConsent` to the first `demo.step()`, then capture again."
      });
    }
    if (options.pageAssetConsent) {
      this.#pageAssetConsent = options.pageAssetConsent;
    }
    if (
      options.remoteAssetPolicy &&
      this.#steps.length > 0 &&
      options.remoteAssetPolicy !== this.#remoteAssetPolicy
    ) {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "[SHOWKIT:DemoFixtureSetupFailed] A capture flow cannot change its remote asset policy after it starts. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Set `remoteAssetPolicy` on the first `demo.step()` and reuse it for the rest of the flow."
      });
    }
    if (options.remoteAssetPolicy) {
      this.#remoteAssetPolicy = options.remoteAssetPolicy;
    }
    const anchorId = `sk-${options.id}`;
    setPhase("capture");
    const extractionStartedAt = performance.now();
    const {
      scene,
      evidenceTexts,
      assets,
      excludedSurfaces
    } = await captureScene(this.#page, {
      target: options.target,
      captureTarget,
      anchorId,
      stepIndex: this.#steps.length,
      ...(this.#pageAssetConsent
        ? {
            pageAssetConsent: this.#pageAssetConsent,
            observedPublicFontSources: () => [
              ...this.#observedPublicFontSources
            ]
          }
        : {}),
      remoteAssetPolicy: this.#remoteAssetPolicy
    });
    this.#sceneExtractionCount += 1;
    this.#sceneExtractionMs += performance.now() - extractionStartedAt;
    mergeCaptureAssets(this.#assets, assets);
    for (const surface of excludedSurfaces) {
      this.#excludedSurfaces.add(surface);
    }
    setPhase("action");
    const actionStartedAt = performance.now();
    await options.action();
    this.#actionCount += 1;
    this.#actionMs += performance.now() - actionStartedAt;
    setPhase("outcome");
    const safeOutcomeTitle = await this.#page.title();
    if (containsConfiguredSensitiveText(safeOutcomeTitle)) {
      throw new ShowKitError({
        code: "SensitiveDataDetected",
        message:
          "[SHOWKIT:SensitiveDataDetected] Sensitive data was found in the page title after the action. No captured page was saved. Your previous demo has not changed.",
        exitCode: EXIT_CODES.validation,
        recovery: "Hide the data from the page title, then capture again."
      });
    }
    this.#stepTargets.push(captureTarget);
    this.#steps.push(
      CaptureSourceSchema.shape.steps.element.parse({
        id: options.id,
        title: options.title,
        scene,
        evidence: evidenceFromTexts(evidenceTexts),
        actionOutcome: {
          url: sanitizePageUrl(this.#page.url()),
          title: safeOutcomeTitle
        }
      })
    );
  }

  async finalize(): Promise<void> {
    if (!this.active || !this.#outputPath) {
      return;
    }
    if (this.#testInfo.status !== "passed") {
      return;
    }
    if (this.#steps.length === 0) {
      throw new ShowKitError({
        code: "CaptureSourceEmpty",
        message:
          "[SHOWKIT:CaptureSourceEmpty] This source flow has no demo steps. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery: "Add at least one `demo.step()`, then capture the flow again."
      });
    }

    assertCaptureViewport(this.#page);
    const terminalExtractionStartedAt = performance.now();
    const {
      scene: terminalScene,
      assets,
      excludedSurfaces
    } = await captureScene(
      this.#page,
      {
        ...(this.#pageAssetConsent
          ? {
              pageAssetConsent: this.#pageAssetConsent,
              observedPublicFontSources: () => [
                ...this.#observedPublicFontSources
              ]
            }
          : {}),
        remoteAssetPolicy: this.#remoteAssetPolicy
      }
    );
    this.#sceneExtractionCount += 1;
    this.#sceneExtractionMs +=
      performance.now() - terminalExtractionStartedAt;
    mergeCaptureAssets(this.#assets, assets);
    for (const surface of excludedSurfaces) {
      this.#excludedSurfaces.add(surface);
    }
    const specContents = await readFile(this.#testInfo.file, "utf8");
    const require = createRequire(import.meta.url);
    const playwrightPackage = JSON.parse(
      await readFile(require.resolve("@playwright/test/package.json"), "utf8")
    ) as { version: string };
    const viewport = this.#steps[0]?.scene.viewport;
    if (!viewport) {
      throw new Error("Capture steps did not include a viewport.");
    }

    if (!this.#fixtureSeed) {
      throw new Error("Capture did not create a DemoFixture.");
    }
    const fixture = DemoFixtureSchema.parse({
      ...this.#fixtureSeed,
      steps: this.#steps.map((step, index) => {
        const target = this.#stepTargets[index];
        if (!target) throw new Error("Capture step target metadata is missing.");
        return {
          id: step.id,
          title: step.title,
          target,
          actionKind: "select"
        };
      })
    });
    const assetPayloads = [...this.#assets.values()].sort((left, right) =>
      left.sha256.localeCompare(right.sha256)
    );
    const projectName = this.#testInfo.project.name.trim();
    if (
      projectName.length > 120 ||
      containsConfiguredSensitiveText(projectName)
    ) {
      throw new ShowKitError({
        code: "SensitiveDataDetected",
        message:
          "[SHOWKIT:SensitiveDataDetected] The Playwright project name is not safe to save. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Use a short project name that does not contain private data, then capture again."
      });
    }
    const sourceWithoutId = {
      schemaVersion: SCHEMA_VERSION,
      source: {
        kind: "playwright-spec" as const,
        specHash: sha256(specContents),
        runtime: "playwright-test" as const,
        runtimeVersion: playwrightPackage.version,
        ...(projectName ? { projectName } : {}),
        replayLevel: "ci-replayable" as const,
        captureSecurity: {
          provider: "playwright-cdp" as const,
          browserEngine: "chromium" as const,
          executionWorld: PLAYWRIGHT_CAPTURE_ISOLATION_VERSION
        }
      },
      fixtureHash: contentHash(fixture),
      browser: projectName || "chromium",
      fixture,
      viewport,
      steps: this.#steps,
      terminalScene,
      assets: assetPayloads.map((asset) => ({
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        path: `assets/${asset.sha256}.${assetExtension(asset.mimeType)}`
      })),
      redaction: {
        policyChecksPassed: true as const,
        excludedSurfaces: [...this.#excludedSurfaces].sort(),
        fullSceneRasterCount: 0 as const,
        sensitiveText: {
          mode: "blocked-by-default" as const,
          redactedTextNodeCount: 0,
          redactedAttributeCount: 0,
          regionCount: 0
        },
        ...(this.#pageAssetConsent
          ? {
              pageAssets: {
                mode: this.#pageAssetConsent.mode,
                consent: this.#pageAssetConsent.consent,
                localOnly: true as const,
                assetCount: assetPayloads.length
              }
            }
          : {})
      }
    };
    const capture: CaptureSource = CaptureSourceSchema.parse({
      ...sourceWithoutId,
      captureId: `capture-${contentHash(sourceWithoutId).slice(0, 24)}`
    });
    const envelope = CaptureEnvelopeSchema.parse({
      capture,
      assetPayloads
    });
    assertCaptureSafeForPersistence(envelope.capture);
    const output = this.#outputKind === "freshness" ? capture : envelope;
    const captureBytes = Buffer.byteLength(JSON.stringify(output));
    const captureLimitBytes = 25 * 1024 * 1024;
    if (captureBytes > captureLimitBytes) {
      throw new ShowKitError({
        code: "CaptureTooLarge",
        message:
          "[SHOWKIT:CaptureTooLarge] The captured product flow exceeds the 25 MB safety limit.",
        recovery: "Reduce the number or size of captured product states, then capture again."
      });
    }
    await this.#writeCaptureOutput(output);
    const rounded = (value: number): number => Number(value.toFixed(3));
    console.error(
      `[SHOWKIT:CAPTURE_PERFORMANCE] ${JSON.stringify({
        htmlSceneCount: this.#sceneExtractionCount,
        sceneExtractionMs: rounded(this.#sceneExtractionMs),
        actionCount: this.#actionCount,
        actionMs: rounded(this.#actionMs),
        totalMs: rounded(performance.now() - this.#startedAt)
      })}`
    );
  }

  dispose(): void {
    this.#page.off("request", this.#fontRequestListener);
    this.#observedPublicFontSources.clear();
  }
}

function sanitizePageUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "about:blank";
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "about:blank";
  }
}
