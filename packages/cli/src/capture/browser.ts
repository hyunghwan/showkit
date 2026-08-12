import type { Locator, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import { sha256 } from "../core/json.js";
import type {
  AssetPayload,
  Scene,
  SceneFontFace
} from "../core/schemas.js";
import { DEFAULT_SECRET_PATTERN_SOURCES } from "../core/security.js";
import {
  extractSceneKernel,
  readFrozenSceneTransferKernel,
  type FrozenSceneTransferResult,
  type PageAssetConsent,
  type SceneKernelBlocker,
  type SceneKernelOptions,
  type SceneKernelResult
} from "./extractor.js";
import {
  collectVisiblePageAssetInventory,
  preparePlaywrightPageAssets,
  type VisiblePageAssetInventory
} from "./page-assets.js";
import { decodeSceneKernelResult } from "./scene-transfer.js";

export const PLAYWRIGHT_CAPTURE_ISOLATION_VERSION =
  "chromium-cdp-isolated-readonly-v1";

export type SemanticCaptureTarget = NonNullable<
  SceneKernelOptions["scopeTarget"]
>;

type CdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  detach(): Promise<void>;
};

type CachedIsolatedWorld = {
  session: CdpSession;
  executionContextId: number | undefined;
};

const isolatedWorlds = new WeakMap<Page, Promise<CachedIsolatedWorld>>();

function cachedIsolatedWorld(page: Page): Promise<CachedIsolatedWorld> {
  const existing = isolatedWorlds.get(page);
  if (existing) return existing;
  const created = (async (): Promise<CachedIsolatedWorld> => {
    const world: CachedIsolatedWorld = {
      session: (await page.context().newCDPSession(page)) as CdpSession,
      executionContextId: undefined
    };
    const invalidate = (): void => {
      world.executionContextId = undefined;
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) invalidate();
    });
    page.once("close", () => {
      isolatedWorlds.delete(page);
      void world.session.detach().catch(() => undefined);
    });
    return world;
  })();
  isolatedWorlds.set(page, created);
  void created.catch(() => {
    if (isolatedWorlds.get(page) === created) {
      isolatedWorlds.delete(page);
    }
  });
  return created;
}

async function ensureExecutionContext(
  page: Page,
  world: CachedIsolatedWorld
): Promise<number> {
  if (Number.isInteger(world.executionContextId)) {
    return world.executionContextId!;
  }
  const frameTree = (await world.session.send("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const frameId = frameTree.frameTree?.frame?.id;
  if (!frameId) throw new Error("The main browser frame is unavailable.");
  const isolatedWorld = (await world.session.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "showkit-capture-readonly",
    grantUniveralAccess: false
  })) as { executionContextId?: number };
  if (!Number.isInteger(isolatedWorld.executionContextId)) {
    throw new Error("The isolated browser execution context is unavailable.");
  }
  const executionContextId = isolatedWorld.executionContextId!;
  const installation = (await world.session.send("Runtime.evaluate", {
    expression: `(() => {
      Object.defineProperty(globalThis, "__showkitExtractHtmlSceneV1", {
        value: ${extractSceneKernel.toString()},
        configurable: true
      });
      Object.defineProperty(globalThis, "__showkitReadFrozenHtmlSceneV1", {
        value: ${readFrozenSceneTransferKernel.toString()},
        configurable: true
      });
      Object.defineProperty(globalThis, "__showkitCollectVisiblePageAssetsV1", {
        value: ${collectVisiblePageAssetInventory.toString()},
        configurable: true
      });
      return true;
    })()`,
    contextId: executionContextId,
    awaitPromise: true,
    returnByValue: true
  })) as { exceptionDetails?: { text?: string } };
  if (installation.exceptionDetails) {
    throw new Error(
      installation.exceptionDetails.text ??
        "The isolated browser capture functions could not be installed."
    );
  }
  world.executionContextId = executionContextId;
  return executionContextId;
}

async function locatorMatchesSemanticTarget(
  page: Page,
  locator: Locator,
  target: { role?: string; name: string },
  captureTarget: SemanticCaptureTarget
): Promise<boolean> {
  try {
    if (captureTarget.strategy === "role") {
      return (
        (await page
          .getByRole(
            captureTarget.role as Parameters<Page["getByRole"]>[0],
            { name: captureTarget.name, exact: true }
          )
          .and(locator)
          .count()) === 1
      );
    }
    if (captureTarget.strategy === "test-id") {
      return (
        (await page
          .getByTestId(captureTarget.testId)
          .and(locator)
          .count()) === 1
      );
    }
    if (captureTarget.strategy === "label") {
      return (
        (await page
          .getByLabel(captureTarget.name, { exact: true })
          .and(locator)
          .count()) === 1
      );
    }
    if (captureTarget.strategy === "title") {
      return (
        (await page
          .getByTitle(captureTarget.name, { exact: true })
          .and(locator)
          .count()) === 1
      );
    }
    if (captureTarget.strategy === "visible-text") {
      const textLocator = page.getByText(captureTarget.name, { exact: true });
      if ((await textLocator.and(locator).count()) === 1) return true;
      return (await locator.filter({ has: textLocator }).count()) === 1;
    }
    if (captureTarget.strategy !== "href") return false;
    if (!target.name) return false;
    return await locator.evaluate(
      (element, expected) => {
        const href = element.getAttribute("href");
        if (!href || href.length > 2_048) return false;
        try {
          const path =
            href === expected.path
              ? href
              : new URL(href, expected.baseUrl).pathname;
          return path === expected.path;
        } catch {
          return false;
        }
      },
      { path: captureTarget.path, baseUrl: page.url() }
    );
  } catch {
    return false;
  }
}

type InteractionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function clipBoundsToViewport(
  bounds: InteractionBounds,
  viewport: { width: number; height: number } | null
): InteractionBounds | null {
  if (!viewport) return bounds;
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const right = Math.min(viewport.width, bounds.x + bounds.width);
  const bottom = Math.min(viewport.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

async function visibleInteractionBounds(
  page: Page,
  target: Locator
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const bounds = await target.boundingBox();
  if (!bounds) return null;
  return clipBoundsToViewport(bounds, page.viewportSize());
}

async function syntheticBoundsMatchAssociatedLabel(
  target: Locator,
  targetBounds: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }
): Promise<boolean> {
  try {
    return await target.evaluate(
      (element, expected) => {
        if (!(element instanceof HTMLInputElement)) return false;
        const labels = new Set(Array.from(element.labels ?? []));
        const containingLabel = element.closest("label");
        if (containingLabel) labels.add(containingLabel);
        const horizontalTolerance = Math.max(0.003, 3 / expected.viewport.width);
        const verticalTolerance = Math.max(0.003, 3 / expected.viewport.height);
        return [...labels].some((label) => {
          const style = getComputedStyle(label);
          const rectangle = label.getBoundingClientRect();
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number.parseFloat(style.opacity || "1") <= 0
          ) {
            return false;
          }
          const left = Math.max(0, rectangle.left);
          const top = Math.max(0, rectangle.top);
          const right = Math.min(expected.viewport.width, rectangle.right);
          const bottom = Math.min(expected.viewport.height, rectangle.bottom);
          if (right <= left || bottom <= top) return false;
          const normalized = {
            x: left / expected.viewport.width,
            y: top / expected.viewport.height,
            width: (right - left) / expected.viewport.width,
            height: (bottom - top) / expected.viewport.height
          };
          return (
            Math.abs(normalized.x - expected.targetBounds.x) <=
              horizontalTolerance &&
            Math.abs(normalized.y - expected.targetBounds.y) <=
              verticalTolerance &&
            Math.abs(normalized.width - expected.targetBounds.width) <=
              horizontalTolerance &&
            Math.abs(normalized.height - expected.targetBounds.height) <=
              verticalTolerance
          );
        });
      },
      { targetBounds, viewport }
    );
  } catch {
    return false;
  }
}

function sensitiveSelectors(): string[] {
  return (process.env.SHOWKIT_SENSITIVE_SELECTORS ?? "")
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function policyError(blocker: SceneKernelBlocker): ShowKitError {
  const definitions: Record<string, { message: string; recovery: string }> = {
    SensitiveDataDetected: {
      message: "Sensitive data was found. ShowKit did not save the captured page.",
      recovery: "Hide the data or update the capture rule, then try again."
    },
    UnsupportedSurface: {
      message: "ShowKit cannot capture this part of the page yet. No captured page was saved.",
      recovery: "Use supported HTML elements or remove this step."
    },
    CaptureTooLarge: {
      message: "The captured product flow exceeds a safety size limit.",
      recovery: "Reduce the number or size of captured states and assets, then capture again."
    },
    BrowserTargetAmbiguous: {
      message: "The browser target is missing, hidden, or ambiguous.",
      recovery: "Refresh the DOM snapshot and select one visible semantic target."
    },
    TargetMissing: {
      message: "ShowKit could not find this hotspot target.",
      recovery: "Use a target that matches one visible semantic element, then capture again."
    }
  };
  const definition =
    blocker.code === "UnsupportedSurface" &&
    blocker.category === "infinite-animation"
      ? {
          message:
            "A visible infinite animation cannot be captured deterministically. No captured page was saved.",
          recovery:
            "Pause or remove the visible infinite animation, then capture the flow again."
        }
      : blocker.code === "UnsupportedSurface" &&
          blocker.category === "remote-asset"
      ? {
          message:
            "A visible control depends on an image the browser could not bundle. No captured page was saved.",
          recovery:
            "Use a page state where the original image bytes can be bundled, or remove that control from the captured range. Do not substitute the icon."
        }
      : definitions[blocker.code] ?? definitions.UnsupportedSurface!;
  const safeCategory = /^[a-z0-9-]{1,80}$/.test(blocker.category)
    ? blocker.category
    : "unsupported-surface";
  return new ShowKitError({
    code: blocker.code,
    message: `[SHOWKIT:${blocker.code}] ${definition.message} [SHOWKIT-CATEGORY:${safeCategory}]`,
    exitCode: EXIT_CODES.validation,
    recovery: definition.recovery,
    details: {
      category: safeCategory,
      stepIndex: blocker.stepIndex,
      sourceFingerprint: blocker.sourceFingerprint
    }
  });
}

function kernelOptions(
  options: Partial<SceneKernelOptions> & Pick<SceneKernelOptions, "targetPresent">
): SceneKernelOptions {
  return {
    targetPresent: options.targetPresent,
    scanOnly: options.scanOnly ?? false,
    stepIndex: options.stepIndex ?? 0,
    secretPatternSources: [...DEFAULT_SECRET_PATTERN_SOURCES],
    sensitiveSelectors: sensitiveSelectors(),
    remoteAssetPolicy: options.remoteAssetPolicy ?? "strict",
    targetErrorCode: options.targetErrorCode ?? "TargetMissing",
    nodeMode: options.scanOnly ? "tree" : "json",
    ...(!options.scanOnly ? { transferEncoding: "lzss-json" as const } : {}),
    ...(options.anchorId ? { anchorId: options.anchorId } : {}),
    ...(options.scopeTarget ? { scopeTarget: options.scopeTarget } : {}),
    ...(options.scrollCapture
      ? { scrollCapture: options.scrollCapture }
      : {}),
    ...(options.pageAssetConsent
      ? { pageAssetConsent: options.pageAssetConsent }
      : {}),
    ...(options.fontFaces?.length
      ? { fontFaces: options.fontFaces }
      : {}),
    ...(options.remoteAssetReplacements?.length
      ? { remoteAssetReplacements: options.remoteAssetReplacements }
      : {}),
    ...(options.transferEncoding
      ? { transferEncoding: options.transferEncoding }
      : {}),
    ...(options.transferOffset !== undefined
      ? { transferOffset: options.transferOffset }
      : {}),
    ...(options.transferChunkSize !== undefined
      ? { transferChunkSize: options.transferChunkSize }
      : {}),
    ...(options.transferId ? { transferId: options.transferId } : {})
  };
}

async function visiblePageAssetInventory(
  page: Page
): Promise<VisiblePageAssetInventory> {
  try {
    const world = await cachedIsolatedWorld(page);
    const executionContextId = await ensureExecutionContext(page, world);
    const response = (await world.session.send("Runtime.callFunctionOn", {
      functionDeclaration:
        "function() { return globalThis.__showkitCollectVisiblePageAssetsV1(); }",
      executionContextId,
      arguments: [],
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
    })) as {
      result?: { value?: VisiblePageAssetInventory };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails || !response.result?.value) {
      throw new Error("The visible page asset inventory is unavailable.");
    }
    const inventory = response.result.value;
    if (
      !Array.isArray(inventory.images) ||
      inventory.images.length > 64 ||
      inventory.images.some(
        (source) => typeof source !== "string" || source.length > 10_000
      ) ||
      !Array.isArray(inventory.fonts) ||
      inventory.fonts.length > 32 ||
      !Array.isArray(inventory.visibleFontFamilies) ||
      inventory.visibleFontFamilies.length > 32 ||
      inventory.visibleFontFamilies.some(
        (family) => typeof family !== "string" || family.length > 120
      ) ||
      !Array.isArray(inventory.visibleFontFaces) ||
      inventory.visibleFontFaces.length > 32 ||
      !Array.isArray(inventory.visibleFontMetrics) ||
      inventory.visibleFontMetrics.length > 32 ||
      inventory.visibleFontMetrics.some(
        (font) =>
          typeof font.family !== "string" ||
          font.family.length === 0 ||
          font.family.length > 120 ||
          !Array.isArray(font.metrics) ||
          font.metrics.length !== 4 ||
          font.metrics.some(
            (row) =>
              !Array.isArray(row) ||
              row.length !== 3 ||
              row.some((value) => !Number.isFinite(value))
          )
      ) ||
      !Array.isArray(inventory.unreadableStyleSheets) ||
      inventory.unreadableStyleSheets.length > 32 ||
      inventory.unreadableStyleSheets.some(
        (source) => typeof source !== "string" || source.length > 10_000
      ) ||
      !Array.isArray(inventory.renderedIcons) ||
      inventory.renderedIcons.length > 32 ||
      inventory.renderedIcons.some(
        (icon) =>
          typeof icon.source !== "string" ||
          icon.source.length > 10_000 ||
          !Number.isInteger(icon.elementIndex) ||
          icon.elementIndex < 0 ||
          ![icon.left, icon.top, icon.width, icon.height].every(Number.isFinite) ||
          icon.width < 4 ||
          icon.height < 4 ||
          icon.width > 96 ||
          icon.height > 96 ||
          icon.width * icon.height > 4_096 ||
          !Number.isFinite(icon.boxWidth) ||
          !Number.isFinite(icon.boxHeight) ||
          icon.boxWidth < 4 ||
          icon.boxHeight < 4 ||
          icon.boxWidth > 96 ||
          icon.boxHeight > 96 ||
          icon.boxWidth * icon.boxHeight > 4_096 ||
          typeof icon.transform !== "string" ||
          icon.transform.length > 240 ||
          typeof icon.directElementSafe !== "boolean"
      )
    ) {
      throw new Error("The visible page asset inventory is malformed.");
    }
    return inventory;
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw browserIsolationError(error);
  }
}

function unstableRenderStateError(): ShowKitError {
  return new ShowKitError({
    code: "UnsupportedSurface",
    message:
      "[SHOWKIT:UnsupportedSurface] The page did not reach a stable HTML state before capture. No captured page was saved. [SHOWKIT-CATEGORY:unstable-render-state]",
    exitCode: EXIT_CODES.validation,
    recovery:
      "Wait for visible animations and page updates to finish, then capture the flow again.",
    details: { category: "unstable-render-state" }
  });
}

async function withRenderStateDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt = performance.now() + 5_500
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(unstableRenderStateError()),
      Math.max(0, deadlineAt - performance.now())
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRenderSettleDeadline<T>(
  page: Page,
  operation: (
    world: CachedIsolatedWorld,
    executionContextId: number
  ) => Promise<T>,
  deadlineAt = performance.now() + 5_500
): Promise<T> {
  let world: CachedIsolatedWorld | undefined;
  let pendingWorld: Promise<CachedIsolatedWorld> | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (!pendingWorld || isolatedWorlds.get(page) === pendingWorld) {
        isolatedWorlds.delete(page);
      }
      if (world) {
        void world.session.detach().catch(() => undefined);
      } else if (pendingWorld) {
        void pendingWorld
          .then((lateWorld) => lateWorld.session.detach())
          .catch(() => undefined);
      }
      reject(unstableRenderStateError());
    }, Math.max(0, deadlineAt - performance.now()));
  });
  const work = (async () => {
    pendingWorld = cachedIsolatedWorld(page);
    world = await pendingWorld;
    if (timedOut) throw unstableRenderStateError();
    const executionContextId = await ensureExecutionContext(page, world);
    if (timedOut) throw unstableRenderStateError();
    return operation(world, executionContextId);
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleVisibleAssetsInIsolatedWorld(
  page: Page,
  minimumSettleMs: 220 | 320 = 320,
  deadlineAt?: number
): Promise<void> {
  try {
    const response = (await withRenderSettleDeadline(
      page,
      (world, executionContextId) => world.session.send("Runtime.callFunctionOn", {
      functionDeclaration: `async function(minimumSettleMs) {
        const timeoutMs = 5000;
        const quietWindowMs = 220;
        const maxElements = 10000;
        const maxVisibleImages = 64;
        const maxAnimations = 2000;
        const startedAt = performance.now();
        const timeoutAt = startedAt + timeoutMs;
        const allElements = document.getElementsByTagName("*");
        if (allElements.length > maxElements) {
          return "element-limit";
        }
        let revision = 0;
        let lastChangeAt = startedAt;
        let stableChecks = 0;
        let previousSignature = "";
        const changed = () => {
          revision += 1;
          lastChangeAt = performance.now();
        };
        const intersectsViewport = (element) => {
          const rectangle = element.getBoundingClientRect();
          return (
            rectangle.width > 0 &&
            rectangle.height > 0 &&
            rectangle.bottom > 0 &&
            rectangle.right > 0 &&
            rectangle.top < innerHeight &&
            rectangle.left < innerWidth
          );
        };
        const isEffectivelyVisible = (element) => {
          let visibilityChecked = false;
          try {
            if (typeof element.checkVisibility === "function") {
              visibilityChecked = true;
              if (!element.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                contentVisibilityAuto: true,
                opacityProperty: true,
                visibilityProperty: true
              })) {
                return false;
              }
            }
          } catch {
            visibilityChecked = false;
          }
          if (!visibilityChecked) {
            let current = element;
            while (current instanceof Element) {
              const computed = getComputedStyle(current);
              if (
                computed.display === "none" ||
                computed.visibility === "hidden" ||
                computed.visibility === "collapse" ||
                Number.parseFloat(computed.opacity || "1") <= 0
              ) {
                return false;
              }
              current = current.parentElement;
            }
          }
          return intersectsViewport(element);
        };
        const animationTargetElement = (animation) => {
          const effect = animation.effect;
          const target = effect?.target;
          return (
            target instanceof Element
              ? target
              : target?.element instanceof Element
                ? target.element
                : undefined
          );
        };
        const animationPseudoElement = (animation) => {
          const effect = animation.effect;
          const pseudo = effect?.pseudoElement ?? effect?.target?.type;
          return ["::before", "::after"].includes(pseudo) ? pseudo : undefined;
        };
        const animationMayAffectCapturedPixels = (
          animation,
          activeElementAnimationTargets
        ) => {
          const targetElement = animationTargetElement(animation);
          if (!targetElement) return true;
          // Current opacity and geometry are animation phases, not proof that
          // future frames cannot paint. Only a static ancestor that removes the
          // whole target subtree from rendering is a safe fast-path exemption.
          let current = animationPseudoElement(animation)
            ? targetElement
            : targetElement.parentElement;
          while (current instanceof Element) {
            const computed = getComputedStyle(current);
            if (
              (computed.display === "none" ||
                Number.parseFloat(computed.opacity || "1") <= 0) &&
              !activeElementAnimationTargets.has(current)
            ) {
              return false;
            }
            current = current.parentElement;
          }
          return true;
        };
        let mutationObserver;
        const observedShadowRoots = new WeakSet();
        let observedShadowRootCount = 0;
        let observedShadowRootLimitExceeded = false;
        const observeShadowRoot = (shadowRoot) => {
          if (!mutationObserver || observedShadowRoots.has(shadowRoot)) return;
          observedShadowRootCount += 1;
          if (observedShadowRootCount > maxElements) {
            observedShadowRootLimitExceeded = true;
            return;
          }
          observedShadowRoots.add(shadowRoot);
          mutationObserver.observe(shadowRoot, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true
          });
          changed();
        };
        const activeAnimations = () => {
          const animations = [];
          const seenAnimations = new Set();
          const seenRoots = new Set();
          const pendingRoots = [{ root: document, depth: 0 }];
          let visitedElements = 0;
          let shadowDepthExceeded = false;
          while (pendingRoots.length > 0) {
            const current = pendingRoots.pop();
            if (!current || seenRoots.has(current.root)) continue;
            seenRoots.add(current.root);
            if (typeof current.root.getAnimations === "function") {
              for (const animation of current.root.getAnimations()) {
                if (seenAnimations.has(animation)) continue;
                seenAnimations.add(animation);
                animations.push(animation);
                if (animations.length > maxAnimations * 10) return animations;
              }
            }
            const walker = document.createTreeWalker(
              current.root,
              NodeFilter.SHOW_ELEMENT
            );
            let element = walker.nextNode();
            while (element) {
              visitedElements += 1;
              if (visitedElements > maxElements) {
                return { limit: "element-limit" };
              }
              if (element.shadowRoot) {
                observeShadowRoot(element.shadowRoot);
                if (current.depth >= 64) shadowDepthExceeded = true;
                else {
                  pendingRoots.push({
                    root: element.shadowRoot,
                    depth: current.depth + 1
                  });
                }
              }
              element = walker.nextNode();
            }
          }
          if (observedShadowRootLimitExceeded) {
            return { limit: "shadow-root-limit" };
          }
          if (shadowDepthExceeded) return { limit: "shadow-depth-limit" };
          return animations;
        };
        const previouslyVisible = new WeakSet();
        for (const element of allElements) {
          if (isEffectivelyVisible(element)) previouslyVisible.add(element);
        }
        const changedVisibility = (element) => {
          const wasVisible = previouslyVisible.has(element);
          const visible = isEffectivelyVisible(element);
          if (visible) previouslyVisible.add(element);
          else previouslyVisible.delete(element);
          return wasVisible || visible;
        };
        const mutationAffectsRender = (record) => {
          const target =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          if (!target) return true;
          if (changedVisibility(target)) return true;
          if (record.type === "childList") {
            return Array.from(record.addedNodes).some((node) => {
              const element =
                node instanceof Element ? node : node.parentElement;
              return element ? changedVisibility(element) : false;
            });
          }
          return false;
        };
        mutationObserver = new MutationObserver((records) => {
          if (records.some(mutationAffectsRender)) changed();
        });
        mutationObserver.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true
        });
        // Shadow-tree mutations do not cross the root boundary. Discover the
        // same bounded roots used by animation settling, then observe each one.
        const initialAnimationScan = activeAnimations();
        if (!Array.isArray(initialAnimationScan)) {
          mutationObserver.disconnect();
          return initialAnimationScan.limit;
        }
        const resizeObserver =
          typeof ResizeObserver === "function"
            ? new ResizeObserver(changed)
            : undefined;
        resizeObserver?.observe(document.documentElement);
        if (document.body) resizeObserver?.observe(document.body);
        const bounded = (promise) =>
          new Promise((resolve) => {
            let complete = false;
            const finish = (value) => {
              if (complete) return;
              complete = true;
              clearTimeout(timer);
              resolve(value);
            };
            const timer = setTimeout(
              () => finish(undefined),
              Math.max(0, timeoutAt - performance.now())
            );
            Promise.resolve(promise).then(finish, () => finish(undefined));
          });
        const visibleImages = () => {
          const images = [];
          for (const image of document.images) {
            if (!isEffectivelyVisible(image)) continue;
            images.push(image);
            if (images.length > maxVisibleImages) break;
          }
          return images;
        };
        const nextFrame = () =>
          typeof requestAnimationFrame === "function"
            ? new Promise((resolve) => {
                let complete = false;
                const finish = (value) => {
                  if (complete) return;
                  complete = true;
                  clearTimeout(timer);
                  if (value === false) cancelAnimationFrame(frame);
                  resolve(value);
                };
                const frame = requestAnimationFrame(() => finish(true));
                const timer = setTimeout(() => finish(false), 100);
              })
            : new Promise((resolve) => setTimeout(() => resolve(false), 16));
        try {
          await bounded(document.fonts?.ready ?? Promise.resolve());
          if (allElements.length > maxElements) return "element-limit";
          const initialImages = visibleImages();
          if (initialImages.length > maxVisibleImages) return "image-limit";
          await bounded(
            Promise.all(
              initialImages.map((image) =>
                typeof image.decode === "function"
                  ? image.decode().catch(() => undefined)
                  : Promise.resolve()
              )
            )
          );
          while (performance.now() < timeoutAt) {
            const preFrameAnimations = activeAnimations();
            if (!Array.isArray(preFrameAnimations)) {
              return preFrameAnimations.limit;
            }
            if (preFrameAnimations.length > maxAnimations * 10) {
              return "animation-scan-limit";
            }
            await nextFrame();
            if (allElements.length > maxElements) return "element-limit";
            const now = performance.now();
            if (now >= timeoutAt) return "unstable";
            const images = visibleImages();
            if (images.length > maxVisibleImages) return "image-limit";
            let sourceSignal = 0;
            let readyCount = 0;
            for (const image of images) {
              const source = image.currentSrc || image.src || "";
              sourceSignal = (sourceSignal + source.length * 31) % 2147483647;
              if (image.complete) readyCount += 1;
            }
            const animations = activeAnimations();
            if (!Array.isArray(animations)) return animations.limit;
            if (animations.length > maxAnimations * 10) {
              return "animation-scan-limit";
            }
            let visibleAnimationCount = 0;
            let visibleInfiniteAnimation = false;
            const activeElementAnimationTargets = new WeakSet();
            for (const animation of animations) {
              if (!["pending", "running"].includes(animation.playState)) continue;
              const targetElement = animationTargetElement(animation);
              if (targetElement && !animationPseudoElement(animation)) {
                activeElementAnimationTargets.add(targetElement);
              }
            }
            const activeFiniteAnimations = animations.filter((animation) => {
              if (!["pending", "running"].includes(animation.playState)) {
                return false;
              }
              const timing = animation.effect?.getComputedTiming?.();
              const endTime = Number(timing?.endTime);
              const visible = animationMayAffectCapturedPixels(
                animation,
                activeElementAnimationTargets
              );
              if (!visible) return false;
              visibleAnimationCount += 1;
              if (visibleAnimationCount > maxAnimations) return false;
              if (!Number.isFinite(endTime)) {
                visibleInfiniteAnimation = true;
                return false;
              }
              return true;
            });
            if (visibleAnimationCount > maxAnimations) {
              return "animation-limit";
            }
            if (visibleInfiniteAnimation) return "infinite-animation";
            const activeFiniteAnimationCount = activeFiniteAnimations.length;
            const signature = [
              revision,
              images.length,
              readyCount,
              sourceSignal,
              activeFiniteAnimationCount,
              document.documentElement.scrollWidth,
              document.documentElement.scrollHeight
            ].join("|");
            stableChecks = signature === previousSignature ? stableChecks + 1 : 0;
            previousSignature = signature;
            const visibleImagesReady = readyCount === images.length;
            if (
              now - startedAt >= minimumSettleMs &&
              now - lastChangeAt >= quietWindowMs &&
              document.readyState === "complete" &&
              visibleImagesReady &&
              activeFiniteAnimationCount === 0 &&
              stableChecks >= 3
            ) {
              // Four matching frame signatures already include more than the
              // two consecutive stable renders required by the QA contract.
              return "stable";
            }
          }
          return "unstable";
        } finally {
          mutationObserver.disconnect();
          resizeObserver?.disconnect();
        }
      }`,
      executionContextId,
      arguments: [{ value: minimumSettleMs }],
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
      }),
      deadlineAt
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.text ??
          "The page render state could not be checked before capture."
      );
    }
    const settleStatus = response.result?.value;
    if (
      [
        "element-limit",
        "image-limit",
        "animation-limit",
        "animation-scan-limit",
        "shadow-depth-limit",
        "shadow-root-limit"
      ].includes(
        String(settleStatus)
      )
    ) {
      throw new ShowKitError({
        code: "CaptureTooLarge",
        message:
          "[SHOWKIT:CaptureTooLarge] The visible page exceeds a bounded capture limit. No captured page was saved.",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Reduce the number of visible elements, images, or animations, then capture the flow again.",
        details: { category: String(settleStatus) }
      });
    }
    if (settleStatus === "infinite-animation") {
      throw new ShowKitError({
        code: "UnsupportedSurface",
        message:
          "[SHOWKIT:UnsupportedSurface] A visible infinite animation cannot be captured deterministically. No captured page was saved. [SHOWKIT-CATEGORY:infinite-animation]",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Pause or remove the visible infinite animation, then capture the flow again.",
        details: { category: "infinite-animation" }
      });
    }
    if (settleStatus !== "stable") {
      throw new ShowKitError({
        code: "UnsupportedSurface",
        message:
          "[SHOWKIT:UnsupportedSurface] The page did not reach a stable HTML state before capture. No captured page was saved. [SHOWKIT-CATEGORY:unstable-render-state]",
        exitCode: EXIT_CODES.validation,
        recovery:
          "Wait for visible animations and page updates to finish, then capture the flow again.",
        details: { category: "unstable-render-state" }
      });
    }
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw browserIsolationError(error);
  }
}

async function preparedAssetsForScene(
  page: Page,
  consent: PageAssetConsent,
  observedPublicFontSources: string[] | (() => string[]) = [],
  initialSettleDeadlineAt?: number
): Promise<Awaited<ReturnType<typeof preparePlaywrightPageAssets>>> {
  const assets = new Map<string, AssetPayload>();
  const fontFaces = new Map<string, SceneFontFace>();
  const replacements = new Map<
    string,
    Awaited<ReturnType<typeof preparePlaywrightPageAssets>>["replacements"][number]
  >();
  const resolvedSources = new Set<string>();
  let previousSignature = "";
  const recentPublicFontSources = async (): Promise<string[]> => {
    const sources = new Set<string>();
    for (const request of await page.requests()) {
      if (request.resourceType() !== "font") continue;
      const raw = request.url();
      if (raw.length > 10_000) continue;
      try {
        const url = new URL(raw);
        if (
          ["http:", "https:"].includes(url.protocol) &&
          url.username === "" &&
          url.password === "" &&
          url.hash === ""
        ) {
          sources.add(url.href);
        }
      } catch {
        // Invalid request URLs are ignored and font capture remains fail-closed.
      }
    }
    return [...sources];
  };

  await settleVisibleAssetsInIsolatedWorld(
    page,
    320,
    initialSettleDeadlineAt
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inventory = await visiblePageAssetInventory(page);
    const signature = JSON.stringify({
      images: inventory.images,
      fonts: inventory.fonts.map((font) => font.source),
      visibleFontFamilies: inventory.visibleFontFamilies,
      visibleFontFaces: inventory.visibleFontFaces,
      visibleFontMetrics: inventory.visibleFontMetrics,
      unreadableStyleSheets: inventory.unreadableStyleSheets,
      icons: inventory.renderedIcons.map((icon) => [
        icon.source,
        icon.elementIndex,
        icon.left,
        icon.top,
        icon.width,
        icon.height,
        icon.boxWidth,
        icon.boxHeight,
        icon.transform,
        icon.directElementSafe,
        icon.match.backgroundPosition,
        icon.match.backgroundSize
      ])
    });
    const pending = {
      images: inventory.images.filter((source) => !resolvedSources.has(source)),
      fonts: inventory.fonts.filter(
        (font) => !resolvedSources.has(font.source)
      ),
      visibleFontFamilies: inventory.visibleFontFamilies,
      visibleFontFaces: inventory.visibleFontFaces,
      visibleFontMetrics: inventory.visibleFontMetrics,
      unreadableStyleSheets: inventory.unreadableStyleSheets,
      renderedIcons: inventory.renderedIcons.filter(
        (icon) => !resolvedSources.has(icon.source)
      )
    };
    if (signature === previousSignature) {
      break;
    }
    const observedSources = [
      ...(typeof observedPublicFontSources === "function"
        ? observedPublicFontSources()
        : observedPublicFontSources),
      ...(await recentPublicFontSources())
    ];
    const prepared = await preparePlaywrightPageAssets(
      page,
      consent,
      pending,
      [...new Set(observedSources)]
    );
    for (const asset of prepared.assets) assets.set(asset.sha256, asset);
    for (const face of prepared.fontFaces) {
      fontFaces.set(
        [face.family, face.style, face.weight, face.stretch, face.src].join("|"),
        face
      );
    }
    for (const replacement of prepared.replacements) {
      const key = [
        replacement.source,
        replacement.captureKind ?? "original",
        replacement.match?.pseudo ?? "element",
        replacement.match?.captureSurface ?? "element",
        replacement.match?.dimensions.width ?? 0,
        replacement.match?.dimensions.height ?? 0,
        replacement.match?.boxDimensions?.width ?? 0,
        replacement.match?.boxDimensions?.height ?? 0,
        replacement.match?.backgroundPosition ?? "",
        replacement.match?.backgroundRepeat ?? "",
        replacement.match?.backgroundSize ?? "",
        replacement.match?.opacity ?? "",
        replacement.match?.backdropColor ?? "",
        replacement.match?.transform ?? ""
      ].join("|");
      replacements.set(key, replacement);
      if (!replacement.captureKind) {
        resolvedSources.add(replacement.source);
      }
    }
    for (const font of prepared.fontFaces) {
      const source = pending.fonts.find(
        (candidate) =>
          candidate.family === font.family &&
          candidate.style === font.style &&
          candidate.weight === font.weight &&
          candidate.stretch === font.stretch
      )?.source;
      if (source) resolvedSources.add(source);
    }
    previousSignature = signature;
    await settleVisibleAssetsInIsolatedWorld(page);
  }

  const assetList = [...assets.values()];
  const totalBytes = assetList.reduce(
    (total, asset) => total + asset.byteLength,
    0
  );
  if (assetList.length > 64 || totalBytes > 20 * 1_048_576) {
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
  return {
    assets: assetList,
    fontFaces: [...fontFaces.values()].slice(0, 32),
    replacements: [...replacements.values()]
  };
}

function browserIsolationError(error?: unknown): ShowKitError {
  return new ShowKitError({
    code: "UnsupportedSurface",
    message:
      "[SHOWKIT:UnsupportedSurface] This browser cannot provide the isolated page world required for safe capture. No captured page was saved. [SHOWKIT-CATEGORY:browser-isolation-unavailable]",
    exitCode: EXIT_CODES.environment,
    recovery:
      "Run this flow in Chromium or Chrome through Playwright 1.60 or newer, or use the static-source route.",
    details: {
      category: "browser-isolation-unavailable",
      isolation: PLAYWRIGHT_CAPTURE_ISOLATION_VERSION,
      ...(error instanceof Error && error.message
        ? { reason: error.message.slice(0, 240) }
        : {})
    }
  });
}

async function evaluateInIsolatedWorld(
  page: Page,
  options: SceneKernelOptions
): Promise<SceneKernelResult> {
  let world: CachedIsolatedWorld | undefined;
  let frozenCaptureId: string | undefined;
  try {
    world = await cachedIsolatedWorld(page);
    const executionContextId = await ensureExecutionContext(page, world);
    const callKernel = async (
      nextOptions: SceneKernelOptions
    ): Promise<SceneKernelResult> => {
      const response = (await world!.session.send("Runtime.callFunctionOn", {
        functionDeclaration:
          "async function(options) { return await globalThis.__showkitExtractHtmlSceneV1(options); }",
        executionContextId,
        arguments: [{ value: nextOptions }],
        awaitPromise: true,
        returnByValue: true,
        userGesture: false
      })) as {
        result?: { value?: SceneKernelResult };
        exceptionDetails?: { text?: string };
      };
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.text ??
            "The isolated browser evaluation failed."
        );
      }
      if (!response.result || response.result.value === undefined) {
        throw new Error("The isolated browser evaluation returned no result.");
      }
      return response.result.value;
    };
    const callFrozenTransfer = async (request: {
      captureId: string;
      offset?: number;
      chunkSize?: number;
      release?: boolean;
    }): Promise<FrozenSceneTransferResult> => {
      const response = (await world!.session.send("Runtime.callFunctionOn", {
        functionDeclaration:
          "function(options) { return globalThis.__showkitReadFrozenHtmlSceneV1(options); }",
        executionContextId,
        arguments: [{ value: request }],
        awaitPromise: true,
        returnByValue: true,
        userGesture: false
      })) as {
        result?: { value?: FrozenSceneTransferResult };
        exceptionDetails?: { text?: string };
      };
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.text ??
            "The frozen HTML scene transfer failed."
        );
      }
      if (!response.result || response.result.value === undefined) {
        throw new Error("The frozen HTML scene transfer returned no result.");
      }
      return response.result.value;
    };
    const initialResult = await callKernel({
      ...options,
      ...(!options.scanOnly ? { transferId: randomUUID() } : {})
    });
    if (
      initialResult.ok &&
      !initialResult.scanOnly &&
      initialResult.transfer?.mode === "chunked-json"
    ) {
      frozenCaptureId = initialResult.transfer.captureId;
    }
    const decoded = await decodeSceneKernelResult(
      initialResult,
      async (offset, chunkSize) => {
        if (!frozenCaptureId) {
          throw new Error("The frozen HTML scene transfer id is unavailable.");
        }
        return callFrozenTransfer({
          captureId: frozenCaptureId,
          offset,
          chunkSize
        });
      }
    );
    if (frozenCaptureId) {
      await callFrozenTransfer({
        captureId: frozenCaptureId,
        release: true
      }).catch(() => undefined);
      frozenCaptureId = undefined;
    }
    return decoded;
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw browserIsolationError(error);
  } finally {
    if (world && frozenCaptureId && Number.isInteger(world.executionContextId)) {
      await world.session
        .send("Runtime.callFunctionOn", {
          functionDeclaration:
            "function(options) { return globalThis.__showkitReadFrozenHtmlSceneV1(options); }",
          executionContextId: world.executionContextId,
          arguments: [
            { value: { captureId: frozenCaptureId, release: true } }
          ],
          awaitPromise: true,
          returnByValue: true,
          userGesture: false
        })
        .catch(() => undefined);
    }
  }
}

export async function inspectPagePolicy(page: Page): Promise<void> {
  const result = await evaluateInIsolatedWorld(
    page,
    kernelOptions({ targetPresent: false, scanOnly: true })
  );
  if (!result.ok) throw policyError(result.blocker);
}

type CaptureSceneOptions = {
  stepIndex?: number;
  remoteAssetPolicy?: "strict" | "decorative-remove";
  pageAssetConsent?: PageAssetConsent;
  observedPublicFontSources?: string[] | (() => string[]);
  targetErrorCode?: "TargetMissing" | "BrowserTargetAmbiguous";
} &
  (
    | {
        target: Locator;
        captureTarget: SemanticCaptureTarget;
        anchorId: string;
      }
    | {
        target?: never;
        captureTarget?: never;
        anchorId?: never;
      }
  );

export async function captureScene(
  page: Page,
  options?: CaptureSceneOptions
): Promise<{
  scene: Scene;
  evidenceTexts: string[];
  assets: AssetPayload[];
  excludedSurfaces: string[];
}> {
  const initialRenderDeadlineAt = performance.now() + 5_500;
  const targetOptions = options?.target ? options : undefined;
  const targetReadiness = targetOptions
    ? await withRenderStateDeadline(
        async () => {
          const count = await targetOptions.target.count();
          return {
            count,
            visible: count === 1 && (await targetOptions.target.isVisible())
          };
        },
        initialRenderDeadlineAt
      )
    : { count: 0, visible: false };
  if (targetOptions && targetReadiness.count !== 1) {
    throw new ShowKitError({
      code: targetOptions.targetErrorCode ?? "TargetMissing",
      message: `[SHOWKIT:${targetOptions.targetErrorCode ?? "TargetMissing"}] ShowKit requires exactly one visible semantic target.`,
      recovery: "Refresh the page state and narrow the target to one visible semantic element."
    });
  }
  const concreteTargetReady = targetReadiness.visible;
  let preparedAssets = options?.pageAssetConsent
    ? await preparedAssetsForScene(
        page,
        options.pageAssetConsent,
        options.observedPublicFontSources,
        initialRenderDeadlineAt
      )
    : { assets: [], fontFaces: [], replacements: [] };
  await settleVisibleAssetsInIsolatedWorld(
    page,
    concreteTargetReady ? 220 : 320,
    options?.pageAssetConsent ? undefined : initialRenderDeadlineAt
  );
  let locatorBounds:
    | Awaited<ReturnType<typeof visibleInteractionBounds>>
    | undefined = undefined;
  if (targetOptions) {
    locatorBounds = await visibleInteractionBounds(page, targetOptions.target);
    if (!locatorBounds) {
      throw new ShowKitError({
        code: targetOptions.targetErrorCode ?? "TargetMissing",
        message: `[SHOWKIT:${targetOptions.targetErrorCode ?? "TargetMissing"}] ShowKit requires one visible semantic target.`,
        exitCode: EXIT_CODES.validation,
        recovery:
          "Refresh the page state and select one visible semantic element.",
        details: { category: "target-locator-unavailable" }
      });
    }
  }
  const extractPreparedScene = async () =>
    evaluateInIsolatedWorld(
      page,
      kernelOptions({
        targetPresent: Boolean(targetOptions),
        stepIndex: options?.stepIndex ?? 0,
        ...(targetOptions?.anchorId ? { anchorId: targetOptions.anchorId } : {}),
        ...(targetOptions?.captureTarget
          ? { scopeTarget: targetOptions.captureTarget }
          : {}),
        scrollCapture: "revealed",
        ...(options?.remoteAssetPolicy
          ? { remoteAssetPolicy: options.remoteAssetPolicy }
          : {}),
        ...(options?.pageAssetConsent
          ? { pageAssetConsent: options.pageAssetConsent }
          : {}),
        ...(preparedAssets.fontFaces.length > 0
          ? { fontFaces: preparedAssets.fontFaces }
          : {}),
        ...(preparedAssets.replacements.length > 0
          ? {
              remoteAssetReplacements: preparedAssets.replacements.map(
                (replacement) => ({
                  source: replacement.source,
                  ...(replacement.captureKind
                    ? { captureKind: replacement.captureKind }
                    : {}),
                  ...(replacement.match ? { match: replacement.match } : {}),
                  payload: {
                    sha256: replacement.payload.sha256,
                    mimeType: replacement.payload.mimeType,
                    byteLength: replacement.payload.byteLength
                  }
                })
              )
            }
          : {}),
        ...(options?.targetErrorCode
          ? { targetErrorCode: options.targetErrorCode }
          : {})
      })
    );
  let result = await extractPreparedScene();
  let retryCount = 0;
  const retryLimit = (candidate: SceneKernelResult): number =>
    !candidate.ok &&
    candidate.blocker.code === "UnsupportedSurface" &&
    candidate.blocker.category === "canvas"
      ? 2
      : 1;
  const retryable = (candidate: SceneKernelResult): boolean =>
    !candidate.ok &&
    candidate.blocker.code === "UnsupportedSurface" &&
    (candidate.blocker.category === "canvas" ||
      (["remote-asset", "font-asset-required"].includes(
        candidate.blocker.category
      ) &&
        options?.pageAssetConsent !== undefined));
  while (retryable(result) && retryCount < retryLimit(result)) {
    retryCount += 1;
    if (options?.pageAssetConsent) {
      preparedAssets = await preparedAssetsForScene(
        page,
        options.pageAssetConsent,
        options.observedPublicFontSources
      );
    }
    await settleVisibleAssetsInIsolatedWorld(
      page,
      concreteTargetReady ? 220 : 320
    );
    if (targetOptions) {
      locatorBounds = await visibleInteractionBounds(page, targetOptions.target);
      if (!locatorBounds) {
        throw new ShowKitError({
          code: targetOptions.targetErrorCode ?? "TargetMissing",
          message: `[SHOWKIT:${targetOptions.targetErrorCode ?? "TargetMissing"}] ShowKit requires one visible semantic target.`,
          exitCode: EXIT_CODES.validation,
          recovery:
            "Refresh the page state and select one visible semantic element.",
          details: { category: "target-locator-unavailable" }
        });
      }
    }
    result = await extractPreparedScene();
  }
  if (!result.ok) throw policyError(result.blocker);
  if (result.scanOnly) {
    throw new Error("The scene extractor returned a scan-only result during capture.");
  }
  if (targetOptions && (!result.target || result.evidenceTexts.length === 0)) {
    throw new ShowKitError({
      code: targetOptions.targetErrorCode ?? "TargetMissing",
      message: `[SHOWKIT:${targetOptions.targetErrorCode ?? "TargetMissing"}] ShowKit could not derive a semantic hotspot target.`,
      recovery: "Use a visible semantic target, then capture the flow again."
    });
  }
  if (targetOptions && locatorBounds && result.target) {
    const normalizedLocatorBounds = {
      x: locatorBounds.x / result.viewport.width,
      y: locatorBounds.y / result.viewport.height,
      width: locatorBounds.width / result.viewport.width,
      height: locatorBounds.height / result.viewport.height
    };
    const horizontalTolerance = Math.max(
      0.003,
      3 / result.viewport.width
    );
    const verticalTolerance = Math.max(
      0.003,
      3 / result.viewport.height
    );
    const sameBounds =
      Math.abs(normalizedLocatorBounds.x - result.target.bounds.x) <=
        horizontalTolerance &&
      Math.abs(
        normalizedLocatorBounds.width - result.target.bounds.width
      ) <= horizontalTolerance &&
      Math.abs(normalizedLocatorBounds.y - result.target.bounds.y) <=
        verticalTolerance &&
      Math.abs(
        normalizedLocatorBounds.height - result.target.bounds.height
      ) <= verticalTolerance;
    const syntheticBoundsContainLocator =
      result.targetUsesSyntheticBounds === true &&
      result.target.bounds.x <=
        normalizedLocatorBounds.x + horizontalTolerance &&
      result.target.bounds.y <= normalizedLocatorBounds.y + verticalTolerance &&
      result.target.bounds.x + result.target.bounds.width >=
        normalizedLocatorBounds.x +
          normalizedLocatorBounds.width -
          horizontalTolerance &&
      result.target.bounds.y + result.target.bounds.height >=
        normalizedLocatorBounds.y +
          normalizedLocatorBounds.height -
          verticalTolerance;
    const syntheticBoundsMatchLabel =
      result.targetUsesSyntheticBounds === true &&
      !syntheticBoundsContainLocator &&
      (await syntheticBoundsMatchAssociatedLabel(
        targetOptions.target,
        result.target.bounds,
        result.viewport
      ));
    const sameSemanticIdentity = await locatorMatchesSemanticTarget(
      page,
      targetOptions.target,
      result.target,
      targetOptions.captureTarget
    );
    if (
      (!sameBounds &&
        !syntheticBoundsContainLocator &&
        !syntheticBoundsMatchLabel) ||
      !sameSemanticIdentity
    ) {
      throw new ShowKitError({
        code: targetOptions.targetErrorCode ?? "TargetMissing",
        message: `[SHOWKIT:${targetOptions.targetErrorCode ?? "TargetMissing"}] The action target does not match the isolated capture target. [SHOWKIT-CATEGORY:target-locator-mismatch]`,
        exitCode: EXIT_CODES.validation,
        recovery:
          "Use the same visible semantic element for `target` and `captureTarget`, then capture again.",
        details: {
          category: "target-locator-mismatch",
          geometryMatched: sameBounds,
          semanticIdentityMatched: sameSemanticIdentity
        }
      });
    }
  }
  return {
    scene: {
      html: result.html,
      nodes: result.nodes,
      viewport: result.viewport,
      scroll: result.scroll,
      ...(result.fontFaces.length > 0
        ? { fontFaces: result.fontFaces }
        : {}),
      ...(targetOptions
        ? { anchorId: targetOptions.anchorId, target: result.target }
        : {})
    } as Scene,
    evidenceTexts: result.evidenceTexts.map((text) => text.trim()).filter(Boolean),
    assets: [
      ...new Map(
        [...preparedAssets.assets, ...result.assetPayloads].map((asset) => [
          asset.sha256,
          asset
        ])
      ).values()
    ],
    excludedSurfaces: [
      ...new Set([
        ...result.excludedSurfaces,
        ...(preparedAssets.replacements.some((replacement) =>
          replacement.captureKind?.startsWith("isolated-rendered-")
        )
          ? ["isolated-rendered-assets"]
          : [])
      ])
    ]
  };
}

export function evidenceFromTexts(texts: string[]): Array<{ id: string; text: string }> {
  return [...new Set(texts)].map((text) => ({
    id: `ev-${sha256(text).slice(0, 12)}`,
    text
  }));
}
