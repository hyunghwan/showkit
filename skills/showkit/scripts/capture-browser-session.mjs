import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OPENAI_BROWSER_ADAPTER_VERSION = "0.4.0";
export const OPENAI_BROWSER_ISOLATION_VERSION = "isolated-readonly-v1";
export const CODEX_BROWSER_ADAPTER_VERSION = OPENAI_BROWSER_ADAPTER_VERSION;
export const CODEX_BROWSER_ISOLATION_VERSION =
  OPENAI_BROWSER_ISOLATION_VERSION;

const CODEX_BROWSER_VALIDATION = Symbol("showkit-codex-browser-validation");
const OPENAI_BROWSER_VERIFIED_BINDINGS = new WeakMap();
const TRUSTED_OPENAI_BROWSER_BUILDS = new Map([
  [
    "browser@26.727.40816",
    "8785b5437d98636c3002d3d7e64b98db79c3b66870b1bd3d18dea953a99b1562"
  ],
  [
    "chrome@26.727.40816",
    "8785b5437d98636c3002d3d7e64b98db79c3b66870b1bd3d18dea953a99b1562"
  ]
]);

const MUTATING_ACTION_PATTERN =
  /\b(?:accept|add|approve|buy|checkout|create|delete|download|invite|order|pay|permission|publish|purchase|remove|save|security|send|share|sign|submit|subscribe|upload|update)\b/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serializeSanitizedNodes(nodes) {
  const escapeText = (value) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const escapeAttribute = (value) =>
    escapeText(value).replace(/"/g, "&quot;");
  const serializeNode = (node) => {
    if (node.type === "text") return escapeText(node.text);
    const attributes = Object.entries(node.attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");
    const styleValue = Object.entries(node.styles)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    const style = styleValue
      ? ` style="${escapeAttribute(styleValue)}"`
      : "";
    if (["hr", "img", "input"].includes(node.tag)) {
      return `<${node.tag}${attributes}${style}>`;
    }
    return `<${node.tag}${attributes}${style}>${node.children
      .map(serializeNode)
      .join("")}</${node.tag}>`;
  };
  return nodes.map(serializeNode).join("");
}

function decodeSceneTransfer(value, compressedLength, nodesJsonLength) {
  const compressed = new Uint8Array(compressedLength);
  let packedBuffer = 0;
  let packedBits = 0;
  let compressedOffset = 0;
  for (const character of value) {
    const packed = character.charCodeAt(0) - 0x100;
    if (packed < 0 || packed > 0x7fff) {
      throw new Error("The compressed HTML node transfer has invalid data.");
    }
    packedBuffer = (packedBuffer << 15) | packed;
    packedBits += 15;
    while (packedBits >= 8 && compressedOffset < compressed.length) {
      packedBits -= 8;
      compressed[compressedOffset] =
        (packedBuffer >> packedBits) & 0xff;
      compressedOffset += 1;
      packedBuffer &= (1 << packedBits) - 1;
    }
  }
  if (compressedOffset !== compressed.length) {
    throw new Error("The compressed HTML node transfer is incomplete.");
  }
  const output = [];
  let offset = 0;
  while (offset < compressed.length) {
    const flags = compressed[offset] ?? 0;
    offset += 1;
    for (let bit = 0; bit < 8 && offset < compressed.length; bit += 1) {
      if ((flags & (1 << bit)) === 0) {
        output.push(compressed[offset] ?? 0);
        offset += 1;
        continue;
      }
      if (offset + 2 >= compressed.length) {
        throw new Error("The compressed HTML node transfer is truncated.");
      }
      const distance =
        (((compressed[offset] ?? 0) << 8) |
          (compressed[offset + 1] ?? 0)) +
        1;
      const length = (compressed[offset + 2] ?? 0) + 3;
      offset += 3;
      if (distance <= 0 || distance > output.length) {
        throw new Error("The compressed HTML node transfer is invalid.");
      }
      const matchOffset = output.length - distance;
      for (let index = 0; index < length; index += 1) {
        output.push(output[matchOffset + index] ?? 0);
        if (output.length > 2_000_000) {
          throw new Error("The compressed HTML node transfer is too large.");
        }
      }
    }
  }
  const nodesJson = new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(output)
  );
  if (nodesJson.length !== nodesJsonLength) {
    throw new Error("The compressed HTML node transfer changed length.");
  }
  return nodesJson;
}

async function loadShowKitCli(cli, projectRoot) {
  if (cli) return cli;
  try {
    return await import("@showkit/cli");
  } catch {
    // Resolve from the active project when the skill is installed globally.
  }
  const currentDirectory =
    projectRoot ??
    globalThis.process?.cwd?.() ??
    globalThis.nodeRepl?.cwd;
  if (!currentDirectory) {
    throw new Error(
      "The project root is unavailable. Pass projectRoot when loading the ShowKit browser adapter."
    );
  }
  const requireFromProject = createRequire(
    path.join(currentDirectory, "package.json")
  );
  let entry;
  try {
    const schemaEntry = requireFromProject.resolve(
      "@showkit/cli/schema/story-spec.json"
    );
    entry = pathToFileURL(
      path.resolve(path.dirname(schemaEntry), "..", "index.js")
    ).href;
  } catch {
    throw new Error(
      "@showkit/cli is not installed in this project. Install a compatible project dependency, then run showkit doctor."
    );
  }
  return import(entry);
}

function errorOptions(code) {
  const definitions = {
    PageUrlInvalid: {
      exitCode: 2,
      message:
        "ShowKit could not use this page URL. Your previous captured product flow has not changed.",
      recovery: "Use an HTTP or HTTPS URL without credentials."
    },
    BrowserSessionUnavailable: {
      exitCode: 3,
      message:
        "ShowKit could not find the requested browser session. Your previous captured product flow has not changed.",
      recovery: "Connect Browser or Chrome, then select the page again."
    },
    BrowserDomAccessRequired: {
      exitCode: 3,
      message:
        "ShowKit needs read-only DOM access to capture this page. Your previous captured product flow has not changed.",
      recovery: "Use Browser or Chrome with DOM access, then try again."
    },
    BrowserAuthenticationRequired: {
      exitCode: 3,
      message:
        "Sign in is required in the selected browser. Your previous captured product flow has not changed.",
      recovery: "Sign in in the selected browser, then start a new capture."
    },
    BrowserSessionInterrupted: {
      exitCode: 3,
      message:
        "The selected browser tab changed or closed before capture finished. Your previous captured product flow has not changed.",
      recovery: "Select the tab again and start a new capture."
    },
    BrowserTargetAmbiguous: {
      exitCode: 2,
      message:
        "ShowKit could not find one exact hotspot target. Your previous captured product flow has not changed.",
      recovery: "Refresh the page state and narrow the target to one visible page element."
    },
    BrowserActionConfirmationRequired: {
      exitCode: 2,
      message:
        "This page action can change external data. ShowKit has not selected it, and your previous captured product flow has not changed.",
      recovery: "Approve the exact action or choose a read-only flow."
    },
    SensitiveDataDetected: {
      exitCode: 2,
      message:
        "Sensitive data was found. ShowKit did not save the captured page. Your previous captured product flow has not changed.",
      recovery:
        "Ask whether to replace sensitive text in the captured HTML scene. Continue only after the person says yes."
    },
    UnsupportedSurface: {
      exitCode: 2,
      message:
        "ShowKit cannot capture this part of the page yet. No captured page was saved. Your previous captured product flow has not changed.",
      recovery: "Use supported HTML elements or remove this step."
    },
    CaptureTooLarge: {
      exitCode: 2,
      message:
        "The captured product flow exceeds a safety size limit. Your previous captured product flow has not changed.",
      recovery: "Reduce the number or size of captured states and assets, then capture again."
    }
  };
  return definitions[code] ?? definitions.BrowserSessionInterrupted;
}

function browserError(cli, code, details) {
  const definition =
    code === "UnsupportedSurface" &&
    details?.category === "browser-isolation-unverified"
      ? {
          exitCode: 3,
          message:
            "ShowKit could not verify an isolated read-only browser execution world. No captured page was saved. Your previous captured product flow has not changed.",
          recovery:
            "Use a supported OpenAI Browser or Chrome host whose installed client documents read-only evaluation and creates a separate isolated world, then verify that host again."
        }
      : code === "UnsupportedSurface" && details?.category === "remote-asset"
      ? {
          exitCode: 2,
          message:
            "A visible control depends on an image the browser could not bundle. No captured page was saved. Your previous captured product flow has not changed.",
          recovery:
            "Use a page state where pageAssets exposes the original image bytes, or remove that control from the captured range. Do not substitute the icon."
        }
      : code === "UnsupportedSurface" &&
          details?.category === "font-asset-required"
        ? {
            exitCode: 2,
            message:
              "Visible text depends on a font the browser could not bundle. No captured page was saved. Your previous captured product flow has not changed.",
            recovery:
              "Keep the page open until its fonts finish loading, confirm visible-session page assets, then capture again from the same tab."
          }
      : code === "BrowserSessionInterrupted" &&
          details?.category === "viewport-mismatch"
        ? {
            exitCode: 3,
            message:
              "The capture tab no longer matches the selected browser viewport. No captured page was saved. Your previous captured product flow has not changed.",
            recovery:
              "Return to the originally selected tab at the recorded viewport, then start a new capture from that exact tab."
          }
      : errorOptions(code);
  return new cli.ShowKitError({
    code,
    exitCode: definition.exitCode,
    message: `[SHOWKIT:${code}] ${definition.message}`,
    recovery: definition.recovery,
    ...(details ? { details } : {})
  });
}

function cssAttributeValue(value) {
  return JSON.stringify(value).replaceAll("\u2028", "\\2028 ").replaceAll("\u2029", "\\2029 ");
}

function locatorFor(tab, target) {
  switch (target.strategy) {
    case "role":
      return tab.playwright.getByRole(target.role, {
        name: target.name,
        exact: true
      });
    case "test-id":
      return tab.playwright.getByTestId(target.testId);
    case "href":
      return tab.playwright.locator(`a[href=${cssAttributeValue(target.path)}]`);
    case "label":
      return tab.playwright.getByLabel(target.name, { exact: true });
    case "title":
      return tab.playwright.locator(
        `[title=${cssAttributeValue(target.name)}]`
      );
    case "visible-text":
      return tab.playwright.getByText(target.name, { exact: true });
    default:
      throw new TypeError("Unsupported browser target strategy.");
  }
}

async function viewportLocatorFor(tab, target) {
  const locator = locatorFor(tab, target);
  const matchedCount = await locator.count();
  if (matchedCount === 0) {
    return { count: 0, matchedCount: 0, locator };
  }
  if (matchedCount > 1 && typeof locator.nth !== "function") {
    return { count: matchedCount, matchedCount, locator };
  }
  const viewportLocators = [];
  for (let index = 0; index < matchedCount; index += 1) {
    const candidate =
      matchedCount === 1 ? locator : locator.nth(index);
    if (
      typeof candidate.isVisible === "function" &&
      (await candidate.isVisible())
    ) {
      viewportLocators.push(candidate);
    }
  }
  return {
    count: viewportLocators.length,
    matchedCount,
    locator: viewportLocators[0] ?? locator
  };
}

async function visibleStateSignature(tab) {
  return tab.playwright.evaluate(() => {
    let hash = 2166136261;
    let itemCount = 0;
    const add = (value) => {
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    };
    const allElements = Array.from(document.querySelectorAll("*"));
    const boundedElements =
      allElements.length <= 2_000
        ? allElements
        : [...allElements.slice(0, 1_000), ...allElements.slice(-1_000)];
    const stateElements = Array.from(
      document.querySelectorAll(
        [
          "[role='dialog']",
          "[role='listbox']",
          "[role='menu']",
          "[aria-expanded]",
          "[aria-selected]",
          "[aria-checked]",
          "input[type='checkbox']",
          "input[type='radio']",
          "[open]"
        ].join(",")
      )
    ).slice(-500);
    for (const element of [...new Set([...boundedElements, ...stateElements])]) {
      const rectangle = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rectangle.width <= 0 ||
        rectangle.height <= 0 ||
        rectangle.bottom <= 0 ||
        rectangle.right <= 0 ||
        rectangle.top >= window.innerHeight ||
        rectangle.left >= window.innerWidth ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity || "1") === 0
      ) {
        continue;
      }
      itemCount += 1;
      add(
        [
          element.tagName,
          element.getAttribute("role") ?? "",
          element.getAttribute("aria-expanded") ?? "",
          element.getAttribute("aria-selected") ?? "",
          element.getAttribute("aria-checked") ?? "",
          element.tagName.toLowerCase() === "input" &&
          ["checkbox", "radio"].includes(
            (element.getAttribute("type") ?? "").toLowerCase()
          )
            ? `${Boolean(element.checked)}:${Boolean(element.indeterminate)}`
            : "",
          element.getAttribute("open") ?? "",
          Math.round(rectangle.x),
          Math.round(rectangle.y),
          Math.round(rectangle.width),
          Math.round(rectangle.height),
          (element.innerText ?? "").slice(0, 240)
        ].join("|")
      );
    }
    return `${itemCount}:${hash.toString(16)}`;
  });
}

async function semanticStateSignature(tab) {
  if (typeof tab?.playwright?.domSnapshot !== "function") return undefined;
  try {
    const snapshot = await tab.playwright.domSnapshot();
    if (typeof snapshot !== "string") return undefined;
    let hash = 2166136261;
    for (let index = 0; index < snapshot.length; index += 1) {
      hash ^= snapshot.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${snapshot.length}:${hash.toString(16)}`;
  } catch {
    return undefined;
  }
}

async function waitForCapturedPageVisuals(tab) {
  if (typeof tab.playwright.evaluate !== "function") return;
  await tab.playwright.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) => {
      let attempts = 0;
      let stableSamples = 0;
      let previousSignature;
      const sample = () => {
        attempts += 1;
        const visibleImages = Array.from(document.images).filter((image) => {
          const rectangle = image.getBoundingClientRect();
          const style = getComputedStyle(image);
          return (
            rectangle.width > 0 &&
            rectangle.height > 0 &&
            rectangle.bottom > 0 &&
            rectangle.right > 0 &&
            rectangle.top < window.innerHeight &&
            rectangle.left < window.innerWidth &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            Number.parseFloat(style.opacity || "1") > 0
          );
        });
        const readyImages = visibleImages.filter(
          (image) =>
            image.complete &&
            image.naturalWidth > 0 &&
            image.naturalHeight > 0
        ).length;
        const signature = [
          visibleImages.length,
          readyImages,
          document.body?.childElementCount ?? 0,
          document.body?.scrollHeight ?? 0
        ].join(":");
        stableSamples =
          signature === previousSignature ? stableSamples + 1 : 0;
        previousSignature = signature;
        if (
          attempts >= 5 &&
          stableSamples >= 3 &&
          readyImages === visibleImages.length
        ) {
          resolve(true);
          return;
        }
        if (attempts >= 50) {
          resolve(false);
          return;
        }
        setTimeout(sample, 100);
      };
      sample();
    });
    return true;
  });
}

function sceneFromKernel(result, anchorId) {
  return {
    html: result.html,
    nodes: result.nodes,
    ...(result.fontFaces?.length > 0
      ? { fontFaces: result.fontFaces }
      : {}),
    viewport: result.viewport,
    ...(anchorId
      ? {
          anchorId,
          target: result.target
        }
      : {})
  };
}

function evidenceFromTexts(texts) {
  return [...new Set(texts.map((text) => text.trim()).filter(Boolean))].map((text) => ({
    id: `ev-${sha256(text).slice(0, 12)}`,
    text
  }));
}

function isKernelSceneResult(result, { targetRequired }) {
  return Boolean(
    result &&
      result.ok === true &&
      typeof result.scanOnly === "boolean" &&
      typeof result.html === "string" &&
      Array.isArray(result.nodes) &&
      Number.isInteger(result.viewport?.width) &&
      Number.isInteger(result.viewport?.height) &&
      result.viewport.width > 0 &&
      result.viewport.height > 0 &&
      Array.isArray(result.evidenceTexts) &&
      result.evidenceTexts.every((text) => typeof text === "string") &&
      Array.isArray(result.assetPayloads) &&
      Array.isArray(result.fontFaces) &&
      Array.isArray(result.excludedSurfaces) &&
      (!targetRequired ||
        (result.target && typeof result.target === "object"))
  );
}

function fontFacesFromReplacements(replacements) {
  const unique = new Map();
  for (const replacement of replacements) {
    if (!replacement.fontFace) continue;
    const key = [
      replacement.fontFace.family,
      replacement.fontFace.style,
      replacement.fontFace.weight,
      replacement.fontFace.stretch,
      replacement.fontFace.src
    ].join("|");
    unique.set(key, replacement.fontFace);
  }
  return [...unique.values()].slice(0, 32);
}

function policyErrorFromKernel(cli, blocker) {
  return browserError(cli, blocker.code, {
    category: blocker.category,
    stepIndex: blocker.stepIndex,
    sourceFingerprint: blocker.sourceFingerprint
  });
}

function kernelOptions(cli, options) {
  return {
    anchorId: options.anchorId,
    targetPresent: options.targetPresent,
    scanOnly: options.scanOnly,
    stepIndex: options.stepIndex,
    secretPatternSources: [...cli.DEFAULT_SECRET_PATTERN_SOURCES],
    sensitiveSelectors: [...options.sensitiveSelectors],
    remoteAssetPolicy: options.remoteAssetPolicy,
    targetErrorCode: "BrowserTargetAmbiguous",
    nodeMode: "json",
    transferEncoding: "lzss-json",
    ...(options.sensitiveTextRedaction
      ? { sensitiveTextRedaction: options.sensitiveTextRedaction }
      : {}),
    ...(options.privateContentConsent
      ? { privateContentConsent: options.privateContentConsent }
      : {}),
    ...(options.fontFaces?.length > 0
      ? { fontFaces: options.fontFaces }
      : {}),
    remoteAssetReplacements: (options.remoteAssetReplacements ?? []).map(
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
  };
}

function confirmedSensitiveTextRedaction(cli, request) {
  if (request === undefined) return undefined;
  if (
    request?.mode !== "text-only" ||
    request?.consent !== "confirmed" ||
    !Array.isArray(request?.selectors) ||
    request.selectors.length > 20 ||
    request.selectors.some(
      (selector) =>
        typeof selector !== "string" ||
        selector.trim() === "" ||
        selector.length > 500
    )
  ) {
    throw browserError(cli, "SensitiveDataDetected", {
      category: "redaction-consent-required"
    });
  }
  return {
    mode: "text-only",
    consent: "confirmed",
    selectors: [...new Set(request.selectors)]
  };
}

function confirmedPageAssetConsent(cli, request) {
  if (request === undefined) return undefined;
  if (
    request?.mode !== "visible-session" ||
    request?.consent !== "confirmed"
  ) {
    throw browserError(cli, "UnsupportedSurface", {
      category: "page-asset-consent-required"
    });
  }
  return {
    mode: "visible-session",
    consent: "confirmed"
  };
}

function confirmedPrivateContentConsent(cli, request) {
  if (request === undefined) return undefined;
  if (
    request?.mode !== "visible-session" ||
    request?.consent !== "confirmed"
  ) {
    throw browserError(cli, "SensitiveDataDetected", {
      category: "private-content-consent-required"
    });
  }
  return {
    mode: "visible-session",
    consent: "confirmed"
  };
}

function assertAdapterShape(cli, adapter) {
  if (
    !adapter ||
    !["iab", "chrome"].includes(adapter.browserSurface) ||
    typeof adapter.browserName !== "string" ||
    !adapter.viewport ||
    typeof adapter.viewport.width !== "number" ||
    typeof adapter.viewport.height !== "number" ||
    typeof adapter.locale !== "string" ||
    typeof adapter.timezoneId !== "string"
  ) {
    throw browserError(cli, "BrowserSessionUnavailable");
  }
  for (const method of [
    "currentUrl",
    "domSnapshot",
    "targetCount",
    "targetVisible",
    "evaluateTarget",
    "performAction",
    "evaluateTerminal",
    "isAlive",
    "cleanup"
  ]) {
    if (typeof adapter[method] !== "function") {
      throw browserError(cli, "BrowserDomAccessRequired");
    }
  }
}

function assertSelectedViewport(cli, expectedViewport, actualViewport) {
  if (
    !expectedViewport ||
    !Number.isInteger(expectedViewport.width) ||
    !Number.isInteger(expectedViewport.height) ||
    expectedViewport.width <= 0 ||
    expectedViewport.height <= 0
  ) {
    throw new cli.ShowKitError({
      code: "DemoFixtureSetupFailed",
      exitCode: 2,
      message:
        "The browser flow is missing the originally selected viewport. Your previous captured product flow has not changed.",
      recovery:
        "Read the selected tab environment before capture and pass its exact viewport."
    });
  }
  if (
    actualViewport.width !== expectedViewport.width ||
    actualViewport.height !== expectedViewport.height
  ) {
    throw browserError(cli, "BrowserSessionInterrupted", {
      category: "viewport-mismatch",
      expectedViewport,
      actualViewport
    });
  }
}

export function browserSelectionPlan({ url, explicitSurface, existingBinding = false }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      error: "PageUrlInvalid"
    };
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return {
      ok: false,
      error: "PageUrlInvalid"
    };
  }
  parsed.search = "";
  parsed.hash = "";
  if (explicitSurface === "iab") {
    return {
      ok: true,
      surface: "iab",
      reuse: existingBinding,
      binding: "iab",
      method: "get",
      argument: "iab",
      url: parsed.toString()
    };
  }
  if (explicitSurface === "chrome") {
    return {
      ok: true,
      surface: "chrome",
      reuse: existingBinding,
      binding: "chrome",
      method: "get",
      argument: "extension",
      url: parsed.toString()
    };
  }
  return {
    ok: true,
    surface: "auto",
    reuse: existingBinding,
    binding: "browser",
    method: "getForUrl",
    argument: parsed.toString(),
    url: parsed.toString()
  };
}

export function collectRenderedIconCandidatesInPage(input = []) {
  const configuration = Array.isArray(input)
    ? { knownSources: input, knownCandidateKeys: [] }
    : input;
  const known = new Set(configuration.knownSources ?? []);
  const knownCandidateKeys = new Set(
    configuration.knownCandidateKeys ?? []
  );
  const candidates = [];
  const seenCandidateKeys = new Set();
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='checkbox']",
    "[role='combobox']",
    "[role='link']",
    "[role='menuitem']",
    "[role='radio']",
    "[role='switch']",
    "[role='tab']"
  ].join(",");
  const directBackgroundSource = (value) => {
    const trimmed = value.trim();
    const match =
      /^url\(\s*["']?([^"')]+)["']?\s*\)$/i.exec(trimmed);
    if (!match) return undefined;
    try {
      const url = new URL(match[1], document.baseURI);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        return undefined;
      }
      return url.href;
    } catch {
      return undefined;
    }
  };
  const transparent = (value) =>
    value === "transparent" ||
    value === "rgba(0, 0, 0, 0)" ||
    value === "rgba(0,0,0,0)";
  const transparentBackgroundImage = (value) =>
    value === "none" ||
    /^-(?:webkit-)?linear-gradient\(top, rgba\(0, 0, 0, 0\), rgba\(0, 0, 0, 0\)\)$/i.test(
      value
    );
  const noVisibleText = (element) =>
    (element.textContent ?? "").replaceAll("\u00a0", "").trim() === "";
  const emptyVisualContent = (value) => {
    const trimmed = value.trim();
    if (['""', "''"].includes(trimmed)) return true;
    const pattern = /url\s*\(\s*["']?([^"')]*)["']?\s*\)/gi;
    let match;
    let matched = false;
    while ((match = pattern.exec(trimmed)) !== null) {
      matched = true;
      if ((match[1] ?? "").trim() !== "") return false;
    }
    return matched;
  };
  const effectiveBackdropColor = (element, includeSelf = false) => {
    let current = includeSelf ? element : element.parentElement;
    while (current) {
      const style = window.getComputedStyle(current);
      if (!transparentBackgroundImage(style.backgroundImage)) {
        return undefined;
      }
      if (!transparent(style.backgroundColor)) {
        return style.backgroundColor;
      }
      current = current.parentElement;
    }
    return "rgba(0, 0, 0, 0)";
  };
  const ancestorsHaveFullOpacity = (element, stopAtInteractive = true) => {
    let current = element.parentElement;
    while (current) {
      if (
        Number.parseFloat(
          window.getComputedStyle(current).opacity || "1"
        ) !== 1
      ) {
        return false;
      }
      if (stopAtInteractive && current.matches(interactiveSelector)) {
        break;
      }
      current = current.parentElement;
    }
    return true;
  };
  const isBoundedTwoDimensionalTransform = (value) => {
    const match = /^matrix\(\s*([^)]+)\s*\)$/.exec(value);
    if (!match?.[1]) return false;
    const values = match[1]
      .split(",")
      .map((part) => Number.parseFloat(part.trim()));
    if (
      values.length !== 6 ||
      values.some((number) => !Number.isFinite(number))
    ) {
      return false;
    }
    const [scaleX, skewY, skewX, scaleY, translateX, translateY] =
      values;
    const firstAxisLength = Math.hypot(scaleX, skewY);
    const secondAxisLength = Math.hypot(skewX, scaleY);
    return (
      firstAxisLength >= 0.25 &&
      secondAxisLength >= 0.25 &&
      firstAxisLength <= 4 &&
      secondAxisLength <= 4 &&
      Math.abs(translateX) <= 512 &&
      Math.abs(translateY) <= 512
    );
  };
  const intersects = (first, second) =>
    first.width > 0 &&
    first.height > 0 &&
    second.width > 0 &&
    second.height > 0 &&
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top;
  const hasRenderedTextInside = (rectangle) => {
    return Array.from(document.querySelectorAll("*")).some((element) => {
      const hasOwnText = Array.from(element.childNodes ?? []).some(
        (node) =>
          node.nodeType === 3 &&
          (node.textContent ?? "").trim() !== ""
      );
      if (!hasOwnText) return false;
      const computed = window.getComputedStyle(element);
      return (
        computed.display !== "none" &&
        computed.visibility === "visible" &&
        Number.parseFloat(computed.opacity || "1") > 0 &&
        intersects(rectangle, element.getBoundingClientRect())
      );
    });
  };

  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (candidates.length >= 64) break;
    if (!element.closest(interactiveSelector) || !noVisibleText(element)) {
      continue;
    }
    if (element.querySelector("canvas,img,picture,svg,video")) continue;
    const computed = window.getComputedStyle(element);
    const source = directBackgroundSource(computed.backgroundImage);
    if (!source || known.has(source)) continue;
    const rectangle = element.getBoundingClientRect();
    const backdropColor = effectiveBackdropColor(element);
    if (
      rectangle.width < 4 ||
      rectangle.height < 4 ||
      rectangle.width > 64 ||
      rectangle.height > 64 ||
      rectangle.width * rectangle.height > 4_096 ||
      rectangle.top < 0 ||
      rectangle.left < 0 ||
      rectangle.bottom > window.innerHeight ||
      rectangle.right > window.innerWidth ||
      computed.display === "none" ||
      computed.visibility !== "visible" ||
      Number.parseFloat(computed.opacity || "1") <= 0 ||
      !ancestorsHaveFullOpacity(element) ||
      backdropColor === undefined ||
      computed.transform !== "none" ||
      computed.filter !== "none" ||
      computed.boxShadow !== "none" ||
      !transparent(computed.backgroundColor) ||
      [
        computed.borderTopWidth,
        computed.borderRightWidth,
        computed.borderBottomWidth,
        computed.borderLeftWidth
      ].some((width) => Number.parseFloat(width || "0") !== 0)
    ) {
      continue;
    }
    const x = Math.min(
      window.innerWidth - 1,
      Math.max(0, rectangle.left + rectangle.width / 2)
    );
    const y = Math.min(
      window.innerHeight - 1,
      Math.max(0, rectangle.top + rectangle.height / 2)
    );
    const match = {
      dimensions: {
        width: rectangle.width,
        height: rectangle.height
      },
      backgroundPosition: computed.backgroundPosition,
      backgroundRepeat: computed.backgroundRepeat,
      backgroundSize: computed.backgroundSize,
      opacity: computed.opacity,
      backdropColor
    };
    const candidateKey = [
      source,
      ...Object.values(match.dimensions).map((value) => value.toFixed(2)),
      match.backgroundPosition,
      match.backgroundRepeat,
      match.backgroundSize,
      match.opacity,
      match.backdropColor
    ].join("|");
    if (
      knownCandidateKeys.has(candidateKey) ||
      seenCandidateKeys.has(candidateKey)
    ) {
      continue;
    }
    candidates.push({
      candidateKey,
      deviceScaleFactor: window.devicePixelRatio || 1,
      source,
      left: rectangle.left,
      top: rectangle.top,
      x,
      y,
      width: rectangle.width,
      height: rectangle.height,
      match
    });
    seenCandidateKeys.add(candidateKey);
  }

  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (candidates.length >= 64) break;
    if (!element.closest(interactiveSelector)) continue;
    const computed = window.getComputedStyle(element);
    const pseudo = window.getComputedStyle(element, "::before");
    const source = directBackgroundSource(pseudo.backgroundImage);
    if (!source || known.has(source)) continue;
    const rectangle = element.getBoundingClientRect();
    const pseudoWidth = Number.parseFloat(pseudo.width || "0");
    const pseudoHeight = Number.parseFloat(pseudo.height || "0");
    const borderLeft = Number.parseFloat(computed.borderLeftWidth || "0");
    const borderRight = Number.parseFloat(computed.borderRightWidth || "0");
    const borderTop = Number.parseFloat(computed.borderTopWidth || "0");
    const borderBottom = Number.parseFloat(
      computed.borderBottomWidth || "0"
    );
    const paddingLeft = Number.parseFloat(computed.paddingLeft || "0");
    const paddingRight = Number.parseFloat(computed.paddingRight || "0");
    const paddingTop = Number.parseFloat(computed.paddingTop || "0");
    const paddingBottom = Number.parseFloat(computed.paddingBottom || "0");
    const pseudoMarginTop = Number.parseFloat(pseudo.marginTop || "0");
    const pseudoMarginRight = Number.parseFloat(
      pseudo.marginRight || "0"
    );
    const pseudoMarginBottom = Number.parseFloat(
      pseudo.marginBottom || "0"
    );
    const pseudoMarginLeft = Number.parseFloat(pseudo.marginLeft || "0");
    const contentHeight =
      rectangle.height -
      borderTop -
      borderBottom -
      paddingTop -
      paddingBottom;
    const contentWidth =
      rectangle.width -
      borderLeft -
      borderRight -
      paddingLeft -
      paddingRight;
    const pseudoOuterHeight =
      pseudoMarginTop + pseudoHeight + pseudoMarginBottom;
    const pseudoOuterWidth =
      pseudoMarginLeft + pseudoWidth + pseudoMarginRight;
    const left =
      rectangle.left +
      borderLeft +
      paddingLeft +
      (computed.justifyContent === "center"
        ? (contentWidth - pseudoOuterWidth) / 2
        : 0) +
      pseudoMarginLeft;
    const top =
      rectangle.top +
      borderTop +
      paddingTop +
      (contentHeight - pseudoOuterHeight) / 2 +
      pseudoMarginTop;
    const backdropColor = effectiveBackdropColor(element, true);
    const zeroLengths = [
      pseudo.borderTopWidth,
      pseudo.borderRightWidth,
      pseudo.borderBottomWidth,
      pseudo.borderLeftWidth,
      pseudo.paddingTop,
      pseudo.paddingRight,
      pseudo.paddingBottom,
      pseudo.paddingLeft
    ].every((value) => Number.parseFloat(value || "0") === 0);
    if (
      !["flex", "inline-flex"].includes(computed.display) ||
      !["row", "row-reverse"].includes(computed.flexDirection) ||
      computed.flexDirection !== "row" ||
      !["normal", "flex-start", "center"].includes(
        computed.justifyContent
      ) ||
      computed.alignItems !== "center" ||
      computed.flexWrap !== "nowrap" ||
      computed.visibility !== "visible" ||
      Number.parseFloat(computed.opacity || "1") !== 1 ||
      computed.transform !== "none" ||
      computed.filter !== "none" ||
      !ancestorsHaveFullOpacity(element, false) ||
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      pseudo.display === "none" ||
      pseudo.position !== "static" ||
      !emptyVisualContent(pseudo.content) ||
      pseudoWidth < 4 ||
      pseudoHeight < 4 ||
      pseudoWidth > 64 ||
      pseudoHeight > 64 ||
      pseudoWidth * pseudoHeight > 4_096 ||
      left < 0 ||
      top < 0 ||
      left + pseudoWidth > window.innerWidth ||
      top + pseudoHeight > window.innerHeight ||
      Number.parseFloat(pseudo.opacity || "1") <= 0 ||
      pseudo.transform !== "none" ||
      pseudo.filter !== "none" ||
      pseudo.boxShadow !== "none" ||
      !transparent(pseudo.backgroundColor) ||
      backdropColor === undefined ||
      !zeroLengths
    ) {
      continue;
    }
    const match = {
      pseudo: "before",
      dimensions: {
        width: pseudoWidth,
        height: pseudoHeight
      },
      backgroundPosition: pseudo.backgroundPosition,
      backgroundRepeat: pseudo.backgroundRepeat,
      backgroundSize: pseudo.backgroundSize,
      opacity: pseudo.opacity,
      backdropColor
    };
    const candidateKey = [
      source,
      match.pseudo,
      pseudoWidth.toFixed(2),
      pseudoHeight.toFixed(2),
      match.backgroundPosition,
      match.backgroundRepeat,
      match.backgroundSize,
      match.opacity,
      match.backdropColor
    ].join("|");
    if (
      knownCandidateKeys.has(candidateKey) ||
      seenCandidateKeys.has(candidateKey)
    ) {
      continue;
    }
    candidates.push({
      candidateKey,
      deviceScaleFactor: window.devicePixelRatio || 1,
      source,
      left,
      top,
      x: left + pseudoWidth / 2,
      y: top + pseudoHeight / 2,
      width: pseudoWidth,
      height: pseudoHeight,
      match
    });
    seenCandidateKeys.add(candidateKey);
  }

  for (const element of Array.from(
    document.querySelectorAll("canvas")
  )) {
    if (candidates.length >= 64) break;
    const computed = window.getComputedStyle(element);
    const rectangle = element.getBoundingClientRect();
    const interactive = element.closest(interactiveSelector);
    const backdropColor = effectiveBackdropColor(element);
    if (
      rectangle.width < 4 ||
      rectangle.height < 4 ||
      rectangle.width > 64 ||
      rectangle.height > 64 ||
      rectangle.width * rectangle.height > 4_096 ||
      rectangle.top < 0 ||
      rectangle.left < 0 ||
      rectangle.bottom > window.innerHeight ||
      rectangle.right > window.innerWidth ||
      computed.display === "none" ||
      computed.visibility !== "visible" ||
      Number.parseFloat(computed.opacity || "1") <= 0 ||
      computed.transform !== "none" ||
      computed.filter !== "none" ||
      computed.boxShadow !== "none" ||
      !ancestorsHaveFullOpacity(element, false) ||
      interactive === null ||
      !noVisibleText(interactive) ||
      hasRenderedTextInside(rectangle) ||
      backdropColor === undefined
    ) {
      continue;
    }
    const source = [
      "showkit:rendered-canvas",
      rectangle.left.toFixed(2),
      rectangle.top.toFixed(2),
      rectangle.width.toFixed(2),
      rectangle.height.toFixed(2),
      String(element.width),
      String(element.height)
    ].join(":");
    if (known.has(source)) continue;
    const match = {
      canvasElement: true,
      dimensions: {
        width: rectangle.width,
        height: rectangle.height
      },
      intrinsicDimensions: {
        width: element.width,
        height: element.height
      },
      opacity: computed.opacity,
      backdropColor
    };
    const candidateKey = [
      source,
      match.opacity,
      match.backdropColor
    ].join("|");
    if (
      knownCandidateKeys.has(candidateKey) ||
      seenCandidateKeys.has(candidateKey)
    ) {
      continue;
    }
    candidates.push({
      candidateKey,
      deviceScaleFactor: window.devicePixelRatio || 1,
      source,
      left: rectangle.left,
      top: rectangle.top,
      x: rectangle.left + rectangle.width / 2,
      y: rectangle.top + rectangle.height / 2,
      width: rectangle.width,
      height: rectangle.height,
      match
    });
    seenCandidateKeys.add(candidateKey);
  }
  return candidates;
}

function renderedImageMetadata(bytes) {
  const buffer = Buffer.from(bytes);
  if (
    buffer.byteLength < 24 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (
      buffer.byteLength < 12 ||
      buffer[0] !== 0xff ||
      buffer[1] !== 0xd8
    ) {
      return undefined;
    }
    let offset = 2;
    const startOfFrameMarkers = new Set([
      0xc0,
      0xc1,
      0xc2,
      0xc3,
      0xc5,
      0xc6,
      0xc7,
      0xc9,
      0xca,
      0xcb,
      0xcd,
      0xce,
      0xcf
    ]);
    while (offset + 8 < buffer.byteLength) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.byteLength && buffer[offset] === 0xff) {
        offset += 1;
      }
      const marker = buffer[offset];
      offset += 1;
      if (
        marker === undefined ||
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        continue;
      }
      if (offset + 1 >= buffer.byteLength) return undefined;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.byteLength) {
        return undefined;
      }
      if (startOfFrameMarkers.has(marker)) {
        if (segmentLength < 7) return undefined;
        return {
          mimeType: "image/jpeg",
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3)
        };
      }
      offset += segmentLength;
    }
    return undefined;
  }
  return {
    mimeType: "image/png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

export function createCodexBrowserAdapter({
  tab,
  browserSurface,
  browserName,
  viewport,
  locale = "en-US",
  timezoneId = "UTC",
  authenticated = true,
  ownedTab = false,
  pageAssetProvider,
  hostValidation
}) {
  const hasDomAccess =
    tab?.playwright &&
    typeof tab.playwright.domSnapshot === "function" &&
    typeof tab.playwright.locator === "function" &&
    typeof tab.playwright.getByRole === "function" &&
    typeof tab.playwright.evaluate === "function";
  const hostVerified =
    hostValidation?.[CODEX_BROWSER_VALIDATION] === true &&
    OPENAI_BROWSER_VERIFIED_BINDINGS.get(hostValidation) === tab;
  const renderedIconReplacements = new Map();
  const renderedIconAttemptedKeys = new Set();
  const captureRenderedIcon = async (candidate) => {
    if (typeof tab.playwright.elementScreenshot !== "function") {
      throw new Error("The selected browser cannot capture an isolated icon.");
    }
    return tab.playwright.elementScreenshot({
      x: candidate.x,
      y: candidate.y,
      includeNonInteractable: true
    });
  };
  const prepareRenderedIconAssets = async (context, replacements) => {
    const visibleSession =
      context?.assetConsent?.mode === "visible-session" &&
      context?.assetConsent?.consent === "confirmed";
    if (
      !visibleSession ||
      typeof tab.playwright.evaluate !== "function" ||
      typeof tab.playwright.elementScreenshot !== "function"
    ) {
      return [];
    }
    for (const [candidateKey, replacement] of renderedIconReplacements) {
      if (
        ![
          "isolated-rendered-image",
          "isolated-rendered-canvas"
        ].includes(replacement.captureKind)
      ) {
        continue;
      }
      renderedIconReplacements.delete(candidateKey);
      renderedIconAttemptedKeys.delete(candidateKey);
    }
    const knownSources = new Set(
      replacements.map((replacement) => replacement.source)
    );
    const knownCandidateKeys = new Set([
      ...renderedIconReplacements.keys(),
      ...renderedIconAttemptedKeys
    ]);
    let candidates;
    try {
      candidates = await tab.playwright.evaluate(
        collectRenderedIconCandidatesInPage,
        {
          knownSources: [...knownSources],
          knownCandidateKeys: [...knownCandidateKeys]
        }
      );
    } catch {
      return [...renderedIconReplacements.values()];
    }
    if (!Array.isArray(candidates)) {
      return [...renderedIconReplacements.values()];
    }
    for (const candidate of candidates.slice(0, 64)) {
      if (
        !candidate ||
        typeof candidate.candidateKey !== "string" ||
        typeof candidate.source !== "string" ||
        typeof candidate.deviceScaleFactor !== "number" ||
        candidate.deviceScaleFactor < 1 ||
        candidate.deviceScaleFactor > 4 ||
        typeof candidate.left !== "number" ||
        typeof candidate.top !== "number" ||
        typeof candidate.x !== "number" ||
        typeof candidate.y !== "number" ||
        typeof candidate.width !== "number" ||
        typeof candidate.height !== "number" ||
        !candidate.match ||
        typeof candidate.match !== "object" ||
        candidate.width < 4 ||
        candidate.height < 4 ||
        candidate.width > 64 ||
        candidate.height > 64 ||
        candidate.width * candidate.height > 4_096 ||
        candidate.match?.imageElement === true ||
        knownSources.has(candidate.source) ||
        knownCandidateKeys.has(candidate.candidateKey)
      ) {
        continue;
      }
      renderedIconAttemptedKeys.add(candidate.candidateKey);
      knownCandidateKeys.add(candidate.candidateKey);
      try {
        const bytes = Buffer.from(await captureRenderedIcon(candidate));
        const image = renderedImageMetadata(bytes);
        if (
          !image ||
          bytes.byteLength === 0 ||
          bytes.byteLength > 262_144 ||
          image.width > 256 ||
          image.height > 256
        ) {
          continue;
        }
        const scaleX = image.width / candidate.width;
        const scaleY = image.height / candidate.height;
        if (
          scaleX < 0.9 ||
          scaleY < 0.9 ||
          scaleX > 4.1 ||
          scaleY > 4.1 ||
          Math.abs(scaleX - scaleY) > 0.15
        ) {
          continue;
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        renderedIconReplacements.set(candidate.candidateKey, {
          source: candidate.source,
          kind: "image",
          captureKind: candidate.match.canvasElement
            ? "isolated-rendered-canvas"
            : "isolated-rendered-icon",
          match: candidate.match,
          payload: {
            sha256,
            mimeType: image.mimeType,
            byteLength: bytes.byteLength,
            base64: bytes.toString("base64")
          }
        });
      } catch {
        // The extractor will fail closed when an interactive icon remains remote.
      }
    }
    return [...renderedIconReplacements.values()];
  };
  const decodeTransferredNodes = async (
    evaluatePage,
    pageFunction,
    options,
    initialResult
  ) => {
    const result = initialResult;
    if (
      !result?.ok ||
      result.scanOnly ||
      typeof result.nodesJson !== "string"
    ) {
      return result;
    }
    let html = result.html;
    let nodesJson = result.nodesJson;
    if (result.transfer?.mode === "lzss-json") {
      if (
        result.transfer.encoding !== "lzss-15bit" ||
        !Number.isInteger(result.transfer.compressedLength) ||
        result.transfer.compressedLength <= 0 ||
        result.transfer.compressedLength > 90_000 ||
        !Number.isInteger(result.transfer.nodesJsonLength) ||
        result.transfer.nodesJsonLength <= 0 ||
        result.transfer.nodesJsonLength > 2_000_000 ||
        nodesJson.length === 0 ||
        nodesJson.length > 48_000
      ) {
        throw new Error("The compressed HTML node transfer is invalid.");
      }
      nodesJson = decodeSceneTransfer(
        nodesJson,
        result.transfer.compressedLength,
        result.transfer.nodesJsonLength
      );
    } else if (result.transfer?.mode === "chunked-json") {
      const { chunkSize, htmlLength, nodesJsonLength } = result.transfer;
      const totalLength = Math.max(htmlLength, nodesJsonLength);
      for (let offset = chunkSize; offset < totalLength; offset += chunkSize) {
        const segment = await evaluatePage(pageFunction, {
          ...options,
          transferEncoding: "chunked-json",
          transferOffset: offset,
          transferChunkSize: chunkSize
        });
        if (
          !segment?.ok ||
          segment.scanOnly ||
          segment.transfer?.mode !== "chunked-json" ||
          segment.transfer.offset !== offset ||
          typeof segment.html !== "string" ||
          typeof segment.nodesJson !== "string"
        ) {
          throw new Error("The captured HTML node transfer was interrupted.");
        }
        html += segment.html;
        nodesJson += segment.nodesJson;
      }
      // A live app can reflow between chunk requests. Preserve the first
      // snapshot's deterministic lengths when later chunks report a small
      // drift, while still failing closed if data is actually missing.
      if (html.length < htmlLength || nodesJson.length < nodesJsonLength) {
        throw new Error("The captured HTML node transfer is incomplete.");
      }
      html = html.slice(0, htmlLength);
      nodesJson = nodesJson.slice(0, nodesJsonLength);
    }
    let nodes;
    try {
      nodes = JSON.parse(nodesJson);
    } catch {
      throw new Error("The captured HTML node transfer is invalid.");
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error("The captured HTML node transfer is empty.");
    }
    if (result.transfer?.mode === "lzss-json") {
      html = serializeSanitizedNodes(nodes);
    }
    return {
      ...result,
      html,
      nodes
    };
  };

  return {
    browserSurface,
    browserName,
    viewport,
    locale,
    timezoneId,
    authenticated,
    hasDomAccess,
    captureSecurity:
      hostVerified
        ? {
            provider: "openai-browser",
            verified: true,
            executionWorld: OPENAI_BROWSER_ISOLATION_VERSION,
            pluginVersion: hostValidation.pluginVersion,
            pluginName: hostValidation.pluginName,
            implementationHash: hostValidation.implementationHash
          }
        : {
            provider: "openai-browser",
            verified: false,
            executionWorld: "unverified"
          },
    async currentUrl() {
      return tab?.url?.();
    },
    async isAlive() {
      try {
        return typeof (await tab?.url?.()) === "string";
      } catch {
        return false;
      }
    },
    async domSnapshot() {
      return tab.playwright.domSnapshot();
    },
    async targetCount(target) {
      return (await viewportLocatorFor(tab, target)).count;
    },
    async targetStatus(target) {
      const status = await viewportLocatorFor(tab, target);
      return {
        matchedCount: status.matchedCount,
        visibleCount: status.count
      };
    },
    async targetVisible(target) {
      const targetLocator = await viewportLocatorFor(tab, target);
      return (
        targetLocator.count === 1 &&
        (typeof targetLocator.locator.isVisible !== "function" ||
          (await targetLocator.locator.isVisible()))
      );
    },
    async evaluateTarget(target, pageFunction, options) {
      if (typeof tab?.playwright?.evaluate !== "function") {
        throw new Error(
          "The selected browser cannot provide isolated page evaluation."
        );
      }
      await viewportLocatorFor(tab, target);
      const pageOptions = {
        ...options,
        scopeTarget: target
      };
      const evaluatePage = (nextPageFunction, nextOptions) =>
        tab.playwright.evaluate(nextPageFunction, nextOptions);
      return decodeTransferredNodes(
        evaluatePage,
        pageFunction,
        pageOptions,
        await evaluatePage(pageFunction, pageOptions)
      );
    },
    async preparePublicAssets(context) {
      const pageAssets = pageAssetProvider
        ? await pageAssetProvider(context)
        : [];
      const renderedIcons = await prepareRenderedIconAssets(
        context,
        pageAssets
      );
      return [...pageAssets, ...renderedIcons];
    },
    async performAction(target, actionKind) {
      if (actionKind === "navigate" && typeof tab.goto === "function") {
        const currentUrl = await tab.url();
        if (typeof currentUrl !== "string") {
          throw new Error("The selected browser page is unavailable.");
        }
        const navigationTarget = await viewportLocatorFor(tab, target);
        if (navigationTarget.count !== 1) {
          throw new Error("The selected navigation target is unavailable.");
        }
        const href =
          target.strategy === "href"
            ? target.path
            : typeof navigationTarget.locator.getAttribute === "function"
              ? await navigationTarget.locator.getAttribute("href")
              : null;
        if (typeof href === "string" && href.trim() !== "") {
          const destination = new URL(href, currentUrl);
          if (
            !["http:", "https:"].includes(destination.protocol) ||
            destination.username ||
            destination.password
          ) {
            throw new Error("The selected navigation target is unavailable.");
          }
          await tab.goto(destination.href);
          if (typeof tab.playwright.waitForLoadState === "function") {
            await tab.playwright.waitForLoadState({
              state: "domcontentloaded",
              timeoutMs: 20_000
            });
          }
          await waitForCapturedPageVisuals(tab);
          return;
        }
      }
      if (
        actionKind === "navigate" &&
        typeof tab.playwright.expectNavigation === "function"
      ) {
        const navigationTarget = await viewportLocatorFor(tab, target);
        if (navigationTarget.count !== 1) {
          throw new Error("The selected navigation target is unavailable.");
        }
        await tab.playwright.expectNavigation(
          () => navigationTarget.locator.click({}),
          {
            timeoutMs: 20_000,
            waitUntil: "domcontentloaded"
          }
        );
        await waitForCapturedPageVisuals(tab);
        return;
      }
      const beforeUrl = await tab.url();
      const beforeSignature = await visibleStateSignature(tab);
      const beforeSemanticSignature = await semanticStateSignature(tab);
      let clickError;
      try {
        const actionTarget = await viewportLocatorFor(tab, target);
        if (actionTarget.count !== 1) {
          throw new Error("The selected page control is unavailable.");
        }
        await actionTarget.locator.click({});
      } catch (error) {
        clickError = error;
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const afterUrl = await tab.url();
        const afterSignature = await visibleStateSignature(tab);
        const afterSemanticSignature = await semanticStateSignature(tab);
        if (
          afterUrl !== beforeUrl ||
          afterSignature !== beforeSignature ||
          (beforeSemanticSignature !== undefined &&
            afterSemanticSignature !== undefined &&
            afterSemanticSignature !== beforeSemanticSignature)
        ) {
          await waitForCapturedPageVisuals(tab);
          return;
        }
        if (typeof tab.playwright.waitForTimeout !== "function") break;
        await tab.playwright.waitForTimeout(100);
      }
      if (clickError) throw clickError;
      throw new Error("The selected page control did not change the visible state.");
    },
    async evaluateTerminal(pageFunction, options) {
      if (typeof tab?.playwright?.evaluate !== "function") {
        throw new Error(
          "The selected browser cannot provide isolated page evaluation."
        );
      }
      const body = tab.playwright.locator("body");
      if ((await body.count()) !== 1) {
        throw new Error("Browser body is unavailable.");
      }
      const pageOptions = {
        ...options,
        scopeSelector: "body"
      };
      const evaluatePage = (nextPageFunction, nextOptions) =>
        tab.playwright.evaluate(nextPageFunction, nextOptions);
      return decodeTransferredNodes(
        evaluatePage,
        pageFunction,
        pageOptions,
        await evaluatePage(pageFunction, pageOptions)
      );
    },
    async cleanup() {
      if (ownedTab) await tab.close();
    }
  };
}

export const createOpenAIBrowserAdapter = createCodexBrowserAdapter;

export function createCodexPageAssetProvider({ tab, approvals = [] }) {
  const approved = new Map();
  const visibleSessionReplacements = new Map();
  const visibleSessionAttemptedUrls = new Set();
  for (const approval of approvals) {
    if (
      !approval ||
      typeof approval.id !== "string" ||
      !["public", "fixture"].includes(approval.classification)
    ) {
      throw new TypeError("Each page asset needs an id and public or fixture classification.");
    }
    const origin = new URL(approval.origin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.origin !== approval.origin
    ) {
      throw new TypeError("Each approved page asset needs an exact HTTP or HTTPS origin.");
    }
    approved.set(approval.id, {
      origin: origin.origin,
      classification: approval.classification
    });
  }

  return async function preparePageAssets(context = {}) {
    const visibleSession =
      context.assetConsent?.mode === "visible-session" &&
      context.assetConsent?.consent === "confirmed";
    if (context.assetConsent !== undefined && !visibleSession) {
      throw new Error("Visible session assets need explicit confirmation.");
    }
    if (!visibleSession && approved.size === 0) return [];
    const capabilityIds = await tab.capabilities.list();
    if (!capabilityIds.some((capability) => capability.id === "pageAssets")) {
      throw new Error("The selected browser does not provide pageAssets.");
    }
    const capability = await tab.capabilities.get("pageAssets");
    const inventory = await capability.list();
    const currentUrl = await tab.url();
    if (typeof currentUrl !== "string" || typeof inventory.pageUrl !== "string") {
      throw new Error("The page asset inventory is not bound to the current page.");
    }
    const current = new URL(currentUrl);
    const inventoryPage = new URL(inventory.pageUrl);
    current.search = "";
    current.hash = "";
    inventoryPage.search = "";
    inventoryPage.hash = "";
    if (current.toString() !== inventoryPage.toString()) {
      throw new Error("The page asset inventory is stale.");
    }

    const renderedAssetSources =
      visibleSession &&
      typeof tab.playwright?.evaluate === "function"
        ? new Set(
            await tab.playwright.evaluate(() => {
              const sources = new Set();
              const addSource = (raw) => {
                if (typeof raw !== "string" || raw.trim() === "") return;
                try {
                  const source = new URL(raw, document.baseURI);
                  if (["http:", "https:", "blob:"].includes(source.protocol)) {
                    sources.add(source.href);
                  }
                } catch {
                  // The extractor will reject unresolved sources separately.
                }
              };
              const addStyleSources = (value) => {
                if (typeof value !== "string" || !/url\s*\(/i.test(value)) {
                  return;
                }
                for (const match of value.matchAll(
                  /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi
                )) {
                  addSource(match[1]);
                }
              };
              const isRendered = (element, computed) => {
                const rectangle = element.getBoundingClientRect();
                return (
                  rectangle.width > 0 &&
                  rectangle.height > 0 &&
                  rectangle.bottom > 0 &&
                  rectangle.right > 0 &&
                  rectangle.top < window.innerHeight &&
                  rectangle.left < window.innerWidth &&
                  computed.display !== "none" &&
                  computed.visibility !== "hidden" &&
                  computed.visibility !== "collapse" &&
                  Number.parseFloat(computed.opacity || "1") > 0
                );
              };
              const styleProperties = [
                "background-image",
                "border-image-source",
                "content",
                "cursor",
                "list-style-image",
                "mask-image",
                "-webkit-mask-image"
              ];
              for (const element of Array.from(
                document.querySelectorAll("*")
              )) {
                const computed = getComputedStyle(element);
                if (!isRendered(element, computed)) continue;
                if (element.tagName.toLowerCase() === "img") {
                  addSource(element.currentSrc || element.src);
                } else if (
                  element.namespaceURI === "http://www.w3.org/2000/svg" &&
                  element.tagName.toLowerCase() === "image"
                ) {
                  addSource(
                    element.getAttribute("href") ??
                      element.getAttribute("src") ??
                      ""
                  );
                }
                for (const property of styleProperties) {
                  addStyleSources(computed.getPropertyValue(property));
                }
                for (const pseudo of ["::before", "::after"]) {
                  const pseudoComputed = getComputedStyle(element, pseudo);
                  for (const property of styleProperties) {
                    addStyleSources(
                      pseudoComputed.getPropertyValue(property)
                    );
                  }
                }
              }
              return [...sources].slice(0, 512);
            })
          )
        : undefined;
    const visibleSessionAliasesByAssetId = new Map();
    const visibleSessionImageAssetsByPath = new Map();
    const renderedImageSourcesByPath = new Map();
    const imagePathKey = (url) =>
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
        ? `${url.origin}${url.pathname}`
        : undefined;
    if (visibleSession && renderedAssetSources !== undefined) {
      for (const asset of inventory.assets) {
        if (asset.kind !== "image") continue;
        try {
          const assetUrl = new URL(asset.url);
          const key = imagePathKey(assetUrl);
          if (!key) continue;
          const assets = visibleSessionImageAssetsByPath.get(key) ?? [];
          assets.push(asset);
          visibleSessionImageAssetsByPath.set(key, assets);
        } catch {
          // Invalid inventory URLs remain excluded below.
        }
      }
      for (const rawSource of renderedAssetSources) {
        try {
          const source = new URL(rawSource);
          const key = imagePathKey(source);
          if (!key) continue;
          const sources = renderedImageSourcesByPath.get(key) ?? [];
          sources.push(source.href);
          renderedImageSourcesByPath.set(key, sources);
        } catch {
          // The rendered source collector already excludes unresolved URLs.
        }
      }
    }

    const selected = [];
    for (const asset of inventory.assets) {
      if (visibleSession) {
        if (!["image", "font"].includes(asset.kind)) continue;
        let assetUrl;
        try {
          assetUrl = new URL(asset.url);
        } catch {
          continue;
        }
        const exactRenderedSource =
          asset.kind === "image" &&
          renderedAssetSources?.has(assetUrl.href);
        const pathKey =
          asset.kind === "image" ? imagePathKey(assetUrl) : undefined;
        const pathAliases =
          pathKey &&
          visibleSessionImageAssetsByPath.get(pathKey)?.length === 1 &&
          renderedImageSourcesByPath.get(pathKey)?.length === 1
            ? renderedImageSourcesByPath.get(pathKey)
            : undefined;
        if (
          !["http:", "https:", "blob:"].includes(assetUrl.protocol) ||
          assetUrl.username ||
          assetUrl.password ||
          visibleSessionAttemptedUrls.has(asset.url) ||
          (asset.kind === "image" &&
            renderedAssetSources !== undefined &&
            !exactRenderedSource &&
            !pathAliases)
        ) {
          continue;
        }
        if (asset.kind === "image") {
          visibleSessionAliasesByAssetId.set(
            asset.id,
            new Set([
              assetUrl.href,
              ...(exactRenderedSource ? [assetUrl.href] : []),
              ...(pathAliases ?? [])
            ])
          );
        }
        selected.push(asset);
        continue;
      }
      const approval = approved.get(asset.id);
      if (!approval) continue;
      const assetUrl = new URL(asset.url);
      const metadata = `${asset.name} ${asset.url}`;
      const safeTransformQuery = Array.from(assetUrl.searchParams).every(
        ([name, value]) => {
          if (name === "w" || name === "h") {
            return (
              /^\d{1,4}$/.test(value) &&
              Number(value) >= 1 &&
              Number(value) <= 8192
            );
          }
          if (name === "q") {
            return (
              /^\d{1,3}$/.test(value) &&
              Number(value) >= 1 &&
              Number(value) <= 100
            );
          }
          if (name === "dpr") {
            return (
              /^(?:\d|\d\.\d{1,2})$/.test(value) &&
              Number(value) >= 0.5 &&
              Number(value) <= 4
            );
          }
          if (name === "auto") {
            return /^(?:format|compress)(?:,(?:format|compress))*$/.test(
              value
            );
          }
          if (name === "fit") {
            return /^(?:clip|crop|fill|max|scale)$/.test(value);
          }
          if (name === "fm") {
            return /^(?:avif|jpeg|jpg|png|webp)$/.test(value);
          }
          return false;
        }
      );
      if (
        asset.kind !== "image" ||
        !["http:", "https:"].includes(assetUrl.protocol) ||
        assetUrl.username ||
        assetUrl.password ||
        assetUrl.hash ||
        !safeTransformQuery ||
        assetUrl.origin !== approval.origin ||
        /\b(?:avatar|profile|private|document|thumbnail|account|user)\b/i.test(
          metadata
        ) ||
        /SHOWKIT_SECRET_CANARY|(?:api|access|auth|secret)[_-]?(?:key|token)|@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
          metadata
        )
      ) {
        throw new Error("An approved page asset did not pass the public asset policy.");
      }
      selected.push(asset);
    }
    if (selected.length === 0) {
      return visibleSession
        ? [...visibleSessionReplacements.values()]
        : [];
    }
    if (visibleSession) {
      for (const asset of selected) {
        visibleSessionAttemptedUrls.add(asset.url);
      }
    }

    const selectedFontUrls = selected
      .filter((asset) => asset.kind === "font")
      .map((asset) => asset.url);
    const fontFaceDescriptors =
      selectedFontUrls.length > 0 &&
      typeof tab.playwright?.evaluate === "function"
        ? await tab.playwright.evaluate((fontUrls) => {
            const selectedUrls = new Set(
              fontUrls.flatMap((raw) => {
                try {
                  return [new URL(raw, document.baseURI).href];
                } catch {
                  return [];
                }
              })
            );
            const descriptors = [];
            const visited = new Set();
            const visitSheet = (sheet) => {
              if (!sheet || visited.has(sheet)) return;
              visited.add(sheet);
              let rules;
              try {
                rules = Array.from(sheet.cssRules ?? []);
              } catch {
                return;
              }
              for (const rule of rules) {
                if (rule.styleSheet) visitSheet(rule.styleSheet);
                const visitRule = (candidate) => {
                  if (
                    candidate.type !== CSSRule.FONT_FACE_RULE ||
                    !candidate.style
                  ) {
                    for (const nested of Array.from(
                      candidate.cssRules ?? []
                    )) {
                      if (nested.styleSheet) visitSheet(nested.styleSheet);
                      visitRule(nested);
                    }
                    return;
                  }
                  const sources = [
                    ...candidate.style
                      .getPropertyValue("src")
                      .matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)
                  ];
                  for (const sourceMatch of sources) {
                    let source;
                    try {
                      source = new URL(
                        sourceMatch[1],
                        document.baseURI
                      ).href;
                    } catch {
                      continue;
                    }
                    if (!selectedUrls.has(source)) continue;
                    const family = candidate.style
                      .getPropertyValue("font-family")
                      .trim()
                      .replace(/^(["'])(.*)\1$/, "$2");
                    const style = candidate.style
                      .getPropertyValue("font-style")
                      .trim()
                      .toLowerCase();
                    const weight = candidate.style
                      .getPropertyValue("font-weight")
                      .trim()
                      .toLowerCase();
                    const stretch = candidate.style
                      .getPropertyValue("font-stretch")
                      .trim()
                      .toLowerCase();
                    const display = candidate.style
                      .getPropertyValue("font-display")
                      .trim()
                      .toLowerCase();
                    const unicodeRange = candidate.style
                      .getPropertyValue("unicode-range")
                      .trim();
                    if (
                      !family ||
                      !/^[^{};@<>"'\\\r\n]{1,120}$/.test(family)
                    ) {
                      continue;
                    }
                    descriptors.push({
                      source,
                      family,
                      style: ["normal", "italic", "oblique"].includes(style)
                        ? style
                        : "normal",
                      weight:
                        /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(weight)
                          ? weight
                          : "normal",
                      stretch:
                        /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/.test(
                          stretch
                        )
                          ? stretch
                          : "normal",
                      display: [
                        "auto",
                        "block",
                        "swap",
                        "fallback",
                        "optional"
                      ].includes(display)
                        ? display
                        : "block",
                      ...(unicodeRange &&
                      /^U\+[0-9A-F?*-]+(?:\s*-\s*[0-9A-F?*-]+)?(?:\s*,\s*U\+[0-9A-F?*-]+(?:\s*-\s*[0-9A-F?*-]+)?)*$/i.test(
                        unicodeRange
                      )
                        ? { unicodeRange }
                        : {})
                    });
                  }
                };
                if (rule.type !== CSSRule.FONT_FACE_RULE && !rule.cssRules) {
                  continue;
                }
                visitRule(rule);
              }
            };
            const visitRoot = (root) => {
              for (const sheet of Array.from(root.styleSheets ?? [])) {
                visitSheet(sheet);
              }
              for (const sheet of Array.from(root.adoptedStyleSheets ?? [])) {
                visitSheet(sheet);
              }
              for (const element of Array.from(
                root.querySelectorAll?.("*") ?? []
              )) {
                if (element.sheet) visitSheet(element.sheet);
                if (element.shadowRoot) visitRoot(element.shadowRoot);
              }
            };
            visitRoot(document);
            return descriptors.slice(0, 32);
          }, selectedFontUrls)
        : [];
    const fontFaceBySource = new Map(
      fontFaceDescriptors.map((descriptor) => [
        descriptor.source,
        descriptor
      ])
    );

    const bundle = await capability.bundle({
      assetIds: selected.map((asset) => asset.id),
      inventoryId: inventory.id
    });
    try {
      if (
        !visibleSession &&
        (bundle.failures.length > 0 ||
          bundle.assets.length !== selected.length)
      ) {
        throw new Error("The browser could not bundle every approved page asset.");
      }
      const selectedById = new Map(selected.map((asset) => [asset.id, asset]));
      const directory = path.resolve(bundle.directoryPath);
      const replacements = [];
      for (const asset of bundle.assets) {
        try {
          const source = selectedById.get(asset.id);
          const filePath = path.resolve(asset.path);
          if (
            !source ||
            asset.kind !== source.kind ||
            !["image", "font"].includes(asset.kind) ||
            !filePath.startsWith(`${directory}${path.sep}`)
          ) {
            throw new Error("A bundled page asset did not match its inventory.");
          }
          const contentType = asset.contentType
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          const fontLooksLikeWoff2 =
            source.kind === "font" &&
            /\.woff2(?:$|[?#])/i.test(`${source.name ?? ""} ${source.url}`);
          const mimeType =
            source.kind === "font" &&
            [
              "font/woff2",
              "application/font-woff2",
              "application/x-font-woff2"
            ].includes(contentType) ||
            (source.kind === "font" &&
              contentType === "application/octet-stream" &&
              fontLooksLikeWoff2)
              ? "font/woff2"
              : [
                  "image/png",
                  "image/jpeg",
                  "image/webp",
                  "image/avif",
                  "image/gif",
                  "image/svg+xml"
                ].includes(contentType)
                ? contentType
                : undefined;
          if (!mimeType) {
            throw new Error("A bundled page asset has an unsupported type.");
          }
          const bytes = await readFile(filePath);
          if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) {
            throw new Error("A bundled page asset exceeds the 1 MB limit.");
          }
          const isPng =
            mimeType === "image/png" &&
            bytes.subarray(0, 8).equals(
              Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            );
          const isJpeg =
            mimeType === "image/jpeg" &&
            bytes[0] === 0xff &&
            bytes[1] === 0xd8 &&
            bytes[2] === 0xff;
          const isWebp =
            mimeType === "image/webp" &&
            bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP";
          const isAvif =
            mimeType === "image/avif" &&
            bytes.byteLength >= 16 &&
            bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
            /^(?:avif|avis)$/.test(
              bytes.subarray(8, 12).toString("ascii")
            );
          const gifHeader = bytes.subarray(0, 6).toString("ascii");
          const isGif =
            mimeType === "image/gif" &&
            (gifHeader === "GIF87a" || gifHeader === "GIF89a");
          const svgText =
            mimeType === "image/svg+xml"
              ? bytes.toString("utf8").trim()
              : "";
          const svgWithoutDeclaration = svgText
            .replace(/^<\?xml\s+[^?]*\?>\s*/i, "")
            .replace(
              /\s+xmlns(?::[A-Za-z][\w.-]*)?\s*=\s*["'][^"']*["']/gi,
              ""
            );
          const svgTags = [
            ...svgWithoutDeclaration.matchAll(
              /<\/?([A-Za-z][\w:-]*)\b/g
            )
          ].map((match) => match[1].toLowerCase());
          const safeSvgTags = new Set([
            "circle",
            "defs",
            "desc",
            "ellipse",
            "g",
            "line",
            "lineargradient",
            "path",
            "polygon",
            "polyline",
            "radialgradient",
            "rect",
            "stop",
            "svg",
            "title"
          ]);
          const isSvg =
            mimeType === "image/svg+xml" &&
            /^<svg\b/i.test(svgWithoutDeclaration) &&
            /<\/svg>\s*$/i.test(svgWithoutDeclaration) &&
            svgTags.every((tag) => safeSvgTags.has(tag)) &&
            !/<(?:script|style|foreignObject|iframe|object|embed|image|use)\b/i.test(
              svgWithoutDeclaration
            ) &&
            !/\son[a-z]+\s*=|(?:href|xlink:href)\s*=|javascript:|data:|url\s*\(|@import|expression\s*\(|(?:https?:)?\/\//i.test(
              svgWithoutDeclaration
            );
          const isWoff2 =
            mimeType === "font/woff2" &&
            bytes.subarray(0, 4).toString("ascii") === "wOF2";
          if (
            !isPng &&
            !isJpeg &&
            !isWebp &&
            !isAvif &&
            !isGif &&
            !isSvg &&
            !isWoff2
          ) {
            throw new Error("A bundled page asset does not match its declared type.");
          }
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const fontFace = fontFaceBySource.get(source.url);
          replacements.push({
            source: source.url,
            kind: source.kind,
            payload: {
              sha256,
              mimeType,
              byteLength: bytes.byteLength,
              base64: Buffer.from(bytes).toString("base64")
            },
            ...(fontFace
              ? {
                  fontFace: {
                    family: fontFace.family,
                    style: fontFace.style,
                    weight: fontFace.weight,
                    stretch: fontFace.stretch,
                    display: fontFace.display,
                    ...(fontFace.unicodeRange
                      ? { unicodeRange: fontFace.unicodeRange }
                      : {}),
                    src: `./assets/${sha256}.woff2`
                  }
                }
              : {})
          });
        } catch (error) {
          if (!visibleSession) throw error;
        }
      }
      if (visibleSession) {
        for (const replacement of replacements) {
          visibleSessionReplacements.set(replacement.source, replacement);
          for (const alias of visibleSessionAliasesByAssetId.get(
            selected.find(
              (asset) => asset.url === replacement.source
            )?.id
          ) ?? []) {
            visibleSessionReplacements.set(alias, {
              ...replacement,
              source: alias
            });
          }
        }
        return [...visibleSessionReplacements.values()];
      }
      return replacements;
    } finally {
      await rm(bundle.directoryPath, { recursive: true, force: true });
    }
  };
}

export const createOpenAIPageAssetProvider = createCodexPageAssetProvider;

export async function verifyCodexBrowserHostIsolation({
  pluginRoot,
  tab
}) {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)) {
    throw new TypeError(
      "OpenAI Browser isolation verification needs an absolute installed plugin path."
    );
  }
  if (typeof tab?.playwright?.evaluate !== "function") {
    throw new TypeError(
      "OpenAI Browser isolation verification needs the exact selected tab with read-only evaluate access."
    );
  }
  const resolvedRoot = await realpath(pluginRoot);
  const manifestPath = path.join(
    resolvedRoot,
    ".codex-plugin",
    "plugin.json"
  );
  const apiPath = path.join(resolvedRoot, "docs", "api.json");
  const clientPath = path.join(
    resolvedRoot,
    "scripts",
    "browser-client.mjs"
  );
  let manifest;
  let api;
  let client;
  try {
    [manifest, api, client] = await Promise.all([
      readFile(manifestPath, "utf8").then((value) => JSON.parse(value)),
      readFile(apiPath, "utf8"),
      readFile(clientPath, "utf8")
    ]);
  } catch {
    throw new Error(
      "The installed OpenAI Browser host could not be inspected."
    );
  }
  const requiredApiSignals = [
    "Evaluate JavaScript in a read-only page scope",
    "Maximum time to spend setting up the read-only DOM scope"
  ];
  const requiredImplementationSignals = [
    "Page.createIsolatedWorld",
    "browser-use-readonly-js",
    "grantUniveralAccess:!1",
    "readonly_live_dom"
  ];
  const implementationHash = sha256(client);
  const trustedImplementationHash = TRUSTED_OPENAI_BROWSER_BUILDS.get(
    `${manifest?.name}@${manifest?.version}`
  );
  if (
    !["browser", "chrome"].includes(manifest?.name) ||
    typeof manifest.version !== "string" ||
    manifest.version.trim() === "" ||
    trustedImplementationHash === undefined ||
    implementationHash !== trustedImplementationHash ||
    !requiredApiSignals.every((signal) => api.includes(signal)) ||
    !requiredImplementationSignals.every((signal) =>
      client.includes(signal)
    )
  ) {
    throw new Error(
      "The installed OpenAI Browser host does not satisfy ShowKit's isolated read-only execution contract."
    );
  }
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new Error(
            "The selected OpenAI Browser tab did not answer the isolated-world probe."
          )
        ),
      5_000
    );
  });
  let probe;
  try {
    probe = await Promise.race([
      tab.playwright.evaluate(() => ({
        ok: true,
        documentNodeType: document.nodeType,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      })),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  if (
    probe?.ok !== true ||
    probe.documentNodeType !== 9 ||
    !Number.isInteger(probe.viewport?.width) ||
    !Number.isInteger(probe.viewport?.height) ||
    probe.viewport.width <= 0 ||
    probe.viewport.height <= 0
  ) {
    throw new Error(
      "The selected OpenAI Browser tab failed the isolated read-only runtime probe."
    );
  }
  const validation = Object.freeze({
    [CODEX_BROWSER_VALIDATION]: true,
    provider: "openai-browser",
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    executionWorld: OPENAI_BROWSER_ISOLATION_VERSION,
    implementationHash
  });
  OPENAI_BROWSER_VERIFIED_BINDINGS.set(validation, tab);
  return validation;
}

export const verifyOpenAIBrowserHostIsolation =
  verifyCodexBrowserHostIsolation;

export async function readCodexBrowserEnvironment(tab, hostValidation) {
  if (
    hostValidation?.[CODEX_BROWSER_VALIDATION] !== true ||
    OPENAI_BROWSER_VERIFIED_BINDINGS.get(hostValidation) !== tab
  ) {
    throw new Error(
      "Verify the installed OpenAI Browser isolated world for this exact selected tab before reading the page environment."
    );
  }
  if (typeof tab?.playwright?.evaluate !== "function") {
    throw new Error("Read-only browser DOM access is unavailable.");
  }
  const environment = await tab.playwright.evaluate(() => ({
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    locale:
      document.documentElement.getAttribute("lang") ||
      window.navigator.language ||
      "en-US",
    timezoneId:
      (typeof Intl === "object" &&
      typeof Intl.DateTimeFormat === "function"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined) ||
      "UTC"
  }));
  const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
  const timezonePattern =
    /^(?:UTC|GMT|Etc\/[A-Za-z0-9_+.-]{1,32}|[A-Za-z][A-Za-z0-9_+.-]{0,31}(?:\/[A-Za-z0-9_+.-]{1,32}){1,2})$/;
  if (
    !environment ||
    !Number.isInteger(environment.viewport?.width) ||
    !Number.isInteger(environment.viewport?.height) ||
    environment.viewport.width <= 0 ||
    environment.viewport.height <= 0 ||
    typeof environment.locale !== "string" ||
    environment.locale.trim() === "" ||
    environment.locale.length > 100 ||
    !localePattern.test(environment.locale) ||
    typeof environment.timezoneId !== "string" ||
    environment.timezoneId.trim() === "" ||
    environment.timezoneId.length > 100 ||
    !timezonePattern.test(environment.timezoneId)
  ) {
    const error = new Error(
      "The browser returned an invalid environment result. No captured page was saved. Your previous captured product flow has not changed."
    );
    error.code = "BrowserSessionInterrupted";
    error.exitCode = 3;
    error.recovery =
      "Verify the selected OpenAI Browser or Chrome host again, then reselect the page.";
    error.details = { category: "environment-result-malformed" };
    throw error;
  }
  return environment;
}

export const readOpenAIBrowserEnvironment = readCodexBrowserEnvironment;

export async function captureBrowserSession({
  adapter,
  sourceHost,
  expectedViewport,
  url,
  id,
  steps,
  confirmedActionIds = [],
  sensitiveSelectors = [],
  sensitiveTextRedaction,
  privateContentConsent,
  pageAssetConsent,
  remoteAssetPolicy = "decorative-remove",
  projectRoot,
  cli: providedCli
}) {
  const cli = await loadShowKitCli(providedCli, projectRoot);
  assertAdapterShape(cli, adapter);
  let envelopePath;
  let phase = "setup";
  let activeStepIndex = -1;

  try {
    if (
      adapter.captureSecurity?.provider !== "openai-browser" ||
      adapter.captureSecurity?.verified !== true ||
      adapter.captureSecurity?.executionWorld !==
        OPENAI_BROWSER_ISOLATION_VERSION
    ) {
      throw browserError(cli, "UnsupportedSurface", {
        category: "browser-isolation-unverified"
      });
    }
    if (adapter.hasDomAccess === false) {
      throw browserError(cli, "BrowserDomAccessRequired");
    }
    if (adapter.authenticated === false) {
      throw browserError(cli, "BrowserAuthenticationRequired");
    }
    phase = "viewport-check";
    assertSelectedViewport(cli, expectedViewport, adapter.viewport);
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 7) {
      throw new cli.ShowKitError({
        code: "DemoFixtureSetupFailed",
        exitCode: 2,
        message:
          "A browser session demo needs 3 to 7 ordered steps. Your previous captured product flow has not changed.",
        recovery: "Provide 3 to 7 evidence-grounded browser steps."
      });
    }
    let safeUrl;
    try {
      safeUrl = cli.sanitizePageUrl(url);
    } catch (error) {
      if (error?.code) throw error;
      throw browserError(cli, "PageUrlInvalid");
    }
    const confirmed = new Set(confirmedActionIds);
    const confirmedRedaction = confirmedSensitiveTextRedaction(
      cli,
      sensitiveTextRedaction
    );
    const confirmedAssets = confirmedPageAssetConsent(cli, pageAssetConsent);
    const confirmedPrivateContent = confirmedPrivateContentConsent(
      cli,
      privateContentConsent
    );
    const assetPayloads = new Map();
    const excludedSurfaces = new Set();
    const captureSteps = [];
    const sensitiveText = {
      mode: confirmedRedaction ? "text-only" : "blocked-by-default",
      redactedTextNodeCount: 0,
      redactedAttributeCount: 0,
      regionCount: confirmedRedaction?.selectors.length ?? 0
    };

    phase = "session-check";
    if (!(await adapter.isAlive())) {
      throw browserError(cli, "BrowserSessionUnavailable");
    }
    const currentUrl = await adapter.currentUrl();
    if (typeof currentUrl !== "string") {
      throw browserError(cli, "BrowserSessionUnavailable");
    }
    const currentSafeUrl = cli.sanitizePageUrl(currentUrl);
    if (
      currentSafeUrl.origin !== safeUrl.origin ||
      currentSafeUrl.path !== safeUrl.path
    ) {
      throw browserError(cli, "BrowserSessionUnavailable");
    }

    let recipe;
    phase = "recipe-validation";
    try {
      recipe = cli.BrowserFlowRecipeSchema.parse({
        schemaVersion: cli.SCHEMA_VERSION,
        id,
        host: sourceHost,
        browserSurface: adapter.browserSurface,
        adapterVersion: OPENAI_BROWSER_ADAPTER_VERSION,
        url: {
          origin: safeUrl.origin,
          path: safeUrl.path
        },
        viewport: adapter.viewport,
        locale: adapter.locale,
        timezoneId: adapter.timezoneId,
        ...(confirmedRedaction
          ? {
              sensitiveTextRedaction: {
                mode: "text-only",
                consent: "confirmed",
                regionCount: confirmedRedaction.selectors.length
              }
            }
          : {}),
        ...(confirmedPrivateContent
          ? {
              privateContent: confirmedPrivateContent
            }
          : {}),
        ...(confirmedAssets
          ? {
              pageAssets: confirmedAssets
            }
          : {}),
        steps
      });
    } catch {
      throw new cli.ShowKitError({
        code: "DemoFixtureSetupFailed",
        exitCode: 2,
        message:
          "The browser flow recipe is invalid. Your previous captured product flow has not changed.",
        recovery: "Create the browser steps again from the latest page state."
      });
    }

    for (const [stepIndex, step] of recipe.steps.entries()) {
      activeStepIndex = stepIndex;
      phase = "session-check";
      if (!(await adapter.isAlive())) {
        throw browserError(cli, "BrowserSessionInterrupted", { stepIndex });
      }
      phase = "target-check";
      const targetStatus =
        typeof adapter.targetStatus === "function"
          ? await adapter.targetStatus(step.target)
          : {
              matchedCount: await adapter.targetCount(step.target),
              visibleCount: await adapter.targetCount(step.target)
            };
      const count = targetStatus.visibleCount;
      const visible =
        count === 1 ? await adapter.targetVisible(step.target) : false;
      if (count !== 1 || !visible) {
        const category =
          targetStatus.matchedCount === 0
            ? "target-missing"
            : count === 0
              ? "target-hidden"
              : "target-duplicate";
        throw browserError(cli, "BrowserTargetAmbiguous", {
          category,
          stepIndex,
          targetCount: targetStatus.matchedCount,
          visibleTargetCount: count
        });
      }

      const anchorId = `sk-${step.id}`;
      phase = "asset-preparation";
      let remoteAssetReplacements = [];
      try {
        remoteAssetReplacements =
          typeof adapter.preparePublicAssets === "function"
            ? await adapter.preparePublicAssets({
                stepIndex,
                target: step.target,
                assetConsent: confirmedAssets
              })
            : [];
      } catch {
        throw browserError(cli, "UnsupportedSurface", {
          category: "page-asset-policy",
          stepIndex
        });
      }
      for (const replacement of remoteAssetReplacements) {
        if (replacement.captureKind?.startsWith("isolated-rendered-")) {
          excludedSurfaces.add("isolated-rendered-assets");
        }
        assetPayloads.set(
          replacement.payload.sha256,
          replacement.payload
        );
      }
      const fontFaces =
        fontFacesFromReplacements(remoteAssetReplacements);
      phase = "scene-extraction";
      const result = await adapter.evaluateTarget(
        step.target,
        cli.extractSceneKernel,
        kernelOptions(cli, {
          anchorId,
          targetPresent: true,
          scanOnly: false,
          stepIndex,
          sensitiveSelectors,
          sensitiveTextRedaction: confirmedRedaction,
          privateContentConsent: confirmedPrivateContent,
          remoteAssetPolicy,
          fontFaces,
          remoteAssetReplacements
        })
      );
      if (!result?.ok) {
        if (result?.blocker) throw policyErrorFromKernel(cli, result.blocker);
        throw browserError(cli, "BrowserSessionInterrupted", { stepIndex });
      }
      if (!isKernelSceneResult(result, { targetRequired: true })) {
        throw browserError(cli, "BrowserSessionInterrupted", {
          category: "scene-result-malformed",
          stepIndex
        });
      }
      if (result.scanOnly || !result.target || result.evidenceTexts.length === 0) {
        throw browserError(cli, "BrowserTargetAmbiguous", {
          category: "semantic-target-required",
          stepIndex
        });
      }

      const actionNeedsConfirmation =
        step.actionKind === "mutation-confirmed" ||
        (step.actionKind === "select" &&
          MUTATING_ACTION_PATTERN.test(
            `${step.title} ${step.target.name}`
          ));
      if (actionNeedsConfirmation && !confirmed.has(step.id)) {
        throw browserError(cli, "BrowserActionConfirmationRequired", {
          stepId: step.id,
          stepIndex
        });
      }

      for (const asset of result.assetPayloads) {
        assetPayloads.set(asset.sha256, asset);
      }
      for (const surface of result.excludedSurfaces) {
        excludedSurfaces.add(surface);
      }
      sensitiveText.redactedTextNodeCount +=
        result.sensitiveText?.redactedTextNodeCount ?? 0;
      sensitiveText.redactedAttributeCount +=
        result.sensitiveText?.redactedAttributeCount ?? 0;

      phase = "page-action";
      await adapter.performAction(step.target, step.actionKind);
      if (!(await adapter.isAlive())) {
        throw browserError(cli, "BrowserSessionInterrupted", { stepIndex });
      }
      phase = "action-outcome";
      const outcomeUrl = await adapter.currentUrl();
      if (typeof outcomeUrl !== "string") {
        throw browserError(cli, "BrowserSessionInterrupted", { stepIndex });
      }
      captureSteps.push({
        id: step.id,
        title: step.title,
        scene: sceneFromKernel(result, anchorId),
        evidence: evidenceFromTexts(result.evidenceTexts),
        actionOutcome: {
          url: cli.sanitizePageUrl(outcomeUrl).value,
          title: step.title
        }
      });
    }

    activeStepIndex = recipe.steps.length;
    phase = "terminal-session-check";
    if (!(await adapter.isAlive())) {
      throw browserError(cli, "BrowserSessionInterrupted", {
        stepIndex: recipe.steps.length
      });
    }
    phase = "terminal-asset-preparation";
    let terminalRemoteAssetReplacements = [];
    try {
      terminalRemoteAssetReplacements =
          typeof adapter.preparePublicAssets === "function"
            ? await adapter.preparePublicAssets({
              stepIndex: recipe.steps.length,
              target: null,
              assetConsent: confirmedAssets
            })
          : [];
    } catch {
      throw browserError(cli, "UnsupportedSurface", {
        category: "page-asset-policy",
        stepIndex: recipe.steps.length
      });
    }
    for (const replacement of terminalRemoteAssetReplacements) {
      if (replacement.captureKind?.startsWith("isolated-rendered-")) {
        excludedSurfaces.add("isolated-rendered-assets");
      }
      assetPayloads.set(
        replacement.payload.sha256,
        replacement.payload
      );
    }
    const terminalFontFaces =
      fontFacesFromReplacements(terminalRemoteAssetReplacements);
    phase = "terminal-extraction";
    const terminalResult = await adapter.evaluateTerminal(
      cli.extractSceneKernel,
      kernelOptions(cli, {
        targetPresent: false,
        scanOnly: false,
        stepIndex: recipe.steps.length,
        sensitiveSelectors,
        sensitiveTextRedaction: confirmedRedaction,
        privateContentConsent: confirmedPrivateContent,
        remoteAssetPolicy,
        fontFaces: terminalFontFaces,
        remoteAssetReplacements: terminalRemoteAssetReplacements
      })
    );
    if (!terminalResult?.ok) {
      if (terminalResult?.blocker) {
        throw policyErrorFromKernel(cli, terminalResult.blocker);
      }
      throw browserError(cli, "BrowserSessionInterrupted", {
        stepIndex: recipe.steps.length
      });
    }
    if (
      !isKernelSceneResult(terminalResult, { targetRequired: false })
    ) {
      throw browserError(cli, "BrowserSessionInterrupted", {
        category: "terminal-result-malformed",
        stepIndex: recipe.steps.length
      });
    }
    if (terminalResult.scanOnly) {
      throw browserError(cli, "BrowserSessionInterrupted", {
        stepIndex: recipe.steps.length
      });
    }
    for (const asset of terminalResult.assetPayloads) {
      assetPayloads.set(asset.sha256, asset);
    }
    for (const surface of terminalResult.excludedSurfaces) {
      excludedSurfaces.add(surface);
    }
    sensitiveText.redactedTextNodeCount +=
      terminalResult.sensitiveText?.redactedTextNodeCount ?? 0;
    sensitiveText.redactedAttributeCount +=
      terminalResult.sensitiveText?.redactedAttributeCount ?? 0;

    phase = "envelope-validation";
    const envelope = cli.createAgentBrowserCaptureEnvelope({
      recipe,
      browser: adapter.browserName,
      steps: captureSteps,
      terminalScene: sceneFromKernel(terminalResult),
      assetPayloads: [...assetPayloads.values()],
      excludedSurfaces: [...excludedSurfaces],
      sensitiveText
    });
    phase = "temporary-handoff";
    envelopePath = await cli.writeSessionEnvelopeTemporary(envelope);
    return {
      status: "captured",
      sourceMode: "agent-browser-session",
      replayLevel: "session-captured",
      captureId: envelope.capture.captureId,
      stepCount: captureSteps.length,
      envelopePath,
      importCommand: [
        "showkit",
        "capture",
        "session",
        envelopePath,
        "--json"
      ]
    };
  } catch (error) {
    if (envelopePath) await rm(envelopePath, { force: true });
    if (error?.code) throw error;
    const validationPaths = Array.isArray(error?.issues)
      ? error.issues
          .map((issue) =>
            Array.isArray(issue?.path) ? `/${issue.path.join("/")}` : undefined
          )
          .filter(Boolean)
          .slice(0, 20)
      : undefined;
    throw browserError(cli, "BrowserSessionInterrupted", {
      phase,
      stepIndex: activeStepIndex,
      ...(validationPaths?.length ? { validationPaths } : {})
    });
  } finally {
    await adapter.cleanup().catch(() => {});
  }
}

export async function removeBrowserSessionEnvelope(envelopePath) {
  await rm(envelopePath, { force: true });
}
