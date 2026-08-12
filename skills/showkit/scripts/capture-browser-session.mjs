import { createHash, randomUUID } from "node:crypto";
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
const OPENAI_BROWSER_VERIFIED_RUNTIMES = new WeakMap();
const OPENAI_BROWSER_CDP_METHODS = new Set([
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Runtime.evaluate"
]);
const OPENAI_BROWSER_CDP_RESULT_LIMIT = 2_000_000;
const TRUSTED_OPENAI_BROWSER_BUILDS = new Map([
  [
    "browser@26.803.41515",
    "323bc3e687e17d7e377238d9f4c69111c4d0e6219103b6316d8c52082489533b"
  ],
  [
    "chrome@26.803.41515",
    "323bc3e687e17d7e377238d9f4c69111c4d0e6219103b6316d8c52082489533b"
  ],
  [
    "browser@26.730.61639",
    "091a81603ff202a16ed56557709bf42d97caf8f0dd2e07ae9e26d7c014d71035"
  ],
  [
    "chrome@26.730.61639",
    "091a81603ff202a16ed56557709bf42d97caf8f0dd2e07ae9e26d7c014d71035"
  ],
  [
    "browser@26.730.61309",
    "939555af59361e95b1f064181829c9dfc4ac99599d1b9949596900443ac15787"
  ],
  [
    "chrome@26.730.61309",
    "939555af59361e95b1f064181829c9dfc4ac99599d1b9949596900443ac15787"
  ],
  [
    "browser@26.727.51351",
    "f204d340535055781952b10ed396de20b842f00a19e430852f7e121ad1ce91f6"
  ],
  [
    "chrome@26.727.51351",
    "f204d340535055781952b10ed396de20b842f00a19e430852f7e121ad1ce91f6"
  ],
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

function exactWebOrigin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("The selected browser tab needs an HTTP or HTTPS origin.");
  }
  return url.origin;
}

function isExecutionContextUnavailable(error) {
  return /(?:Cannot find context|context.*(?:destroyed|invalid|not found)|Inspected target navigated or closed)/i.test(
    String(error?.message ?? error)
  );
}

function isApprovedCdpFallbackError(error) {
  return /(?:admin-enforced policy could not be verified|Timed out after \d+ms waiting for CDP command (?:Page\.getFrameTree|Page\.createIsolatedWorld|Runtime\.evaluate)|read-only DOM scope.*timed out)/i.test(
    String(error?.message ?? error)
  );
}

function serializeApprovedPageCall(pageFunction, options) {
  if (typeof pageFunction !== "function") {
    throw new TypeError("Approved browser evaluation needs a page function.");
  }
  const source = Function.prototype.toString.call(pageFunction);
  if (source.length === 0 || source.length > 600_000 || /\[native code\]/.test(source)) {
    throw new Error("The approved browser page function is invalid.");
  }
  let serializedOptions;
  try {
    serializedOptions = JSON.stringify(options);
  } catch {
    throw new Error("The approved browser page options are not JSON-safe.");
  }
  if (serializedOptions === undefined) serializedOptions = "undefined";
  if (serializedOptions.length > 1_000_000) {
    throw new Error("The approved browser page options are too large.");
  }
  serializedOptions = serializedOptions
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `Promise.resolve((${source})(${serializedOptions}))`;
}

// Low-level runtime constructors are exported so the command-contract test can
// exercise the CDP allowlist without pretending that a fixture plugin is an
// attested host. They do not create a host validation token and therefore
// cannot mark an adapter as verified.
export async function createApprovedCdpRuntime(
  tab,
  capability,
  approvedOrigin
) {
  if (typeof capability?.send !== "function") {
    throw new Error("The approved Chrome CDP capability is unavailable.");
  }
  const initialUrl = await tab?.url?.();
  if (typeof initialUrl !== "string") {
    throw new Error("The selected browser page is unavailable.");
  }
  const boundOrigin = exactWebOrigin(initialUrl);
  if (approvedOrigin !== undefined && boundOrigin !== approvedOrigin) {
    throw new Error(
      "The selected browser tab left the origin approved for this capture."
    );
  }
  let context;

  const send = async (method, params = {}) => {
    if (!OPENAI_BROWSER_CDP_METHODS.has(method)) {
      throw new Error("ShowKit blocked a CDP command outside its read-only allowlist.");
    }
    return capability.send(method, params, { timeoutMs: 10_000 });
  };

  const currentFrame = async () => {
    const currentUrl = await tab?.url?.();
    if (
      typeof currentUrl !== "string" ||
      exactWebOrigin(currentUrl) !== boundOrigin
    ) {
      throw new Error(
        "The selected browser tab left the origin approved for this capture."
      );
    }
    const response = await send("Page.getFrameTree");
    const frame = response?.frameTree?.frame;
    if (
      typeof frame?.id !== "string" ||
      frame.id.length === 0 ||
      typeof frame?.loaderId !== "string" ||
      frame.loaderId.length === 0
    ) {
      throw new Error("Chrome returned an invalid main-frame result.");
    }
    let frameOrigin;
    try {
      frameOrigin = exactWebOrigin(frame.url);
    } catch {
      throw new Error("Chrome returned an invalid main-frame origin.");
    }
    if (frameOrigin !== boundOrigin) {
      throw new Error(
        "The selected browser frame left the origin approved for this capture."
      );
    }
    return frame;
  };

  const executionContext = async ({ refresh = false } = {}) => {
    const frame = await currentFrame();
    if (
      refresh ||
      context?.frameId !== frame.id ||
      context?.loaderId !== frame.loaderId
    ) {
      const response = await send("Page.createIsolatedWorld", {
        frameId: frame.id,
        worldName: "showkit-readonly-capture-v1",
        grantUniveralAccess: false
      });
      if (!Number.isInteger(response?.executionContextId)) {
        throw new Error("Chrome did not create an isolated capture world.");
      }
      context = {
        frameId: frame.id,
        loaderId: frame.loaderId,
        executionContextId: response.executionContextId
      };
    }
    return context.executionContextId;
  };

  const evaluateOnce = async (expression, refresh = false) => {
    const contextId = await executionContext({ refresh });
    const response = await send("Runtime.evaluate", {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      silent: true,
      userGesture: false,
      generatePreview: false,
      disableBreaks: true
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "The isolated page function failed.";
      throw new Error(description);
    }
    const remote = response?.result;
    if (!remote || remote.type === "object" && remote.subtype === "error") {
      throw new Error("Chrome returned an invalid isolated evaluation result.");
    }
    if (remote.type === "undefined") return undefined;
    if (!Object.prototype.hasOwnProperty.call(remote, "value")) {
      throw new Error("Chrome did not return the isolated result by value.");
    }
    let serialized;
    try {
      serialized = JSON.stringify(remote.value);
    } catch {
      throw new Error("Chrome returned a non-serializable isolated result.");
    }
    if (
      serialized !== undefined &&
      serialized.length > OPENAI_BROWSER_CDP_RESULT_LIMIT
    ) {
      throw new Error("Chrome returned an isolated result above the safety limit.");
    }
    return remote.value;
  };

  return Object.freeze({
    transport: "approved-cdp-capability",
    async evaluate(pageFunction, options) {
      const expression = serializeApprovedPageCall(pageFunction, options);
      try {
        return await evaluateOnce(expression);
      } catch (error) {
        if (!isExecutionContextUnavailable(error)) throw error;
        context = undefined;
        return evaluateOnce(expression, true);
      }
    }
  });
}

export function createAdaptiveApprovedRuntime(
  tab,
  directRuntime,
  approvedOrigin
) {
  let approvedRuntimePromise;
  const approvedRuntime = async () => {
    approvedRuntimePromise ??= (async () => {
      if (
        typeof tab?.capabilities?.list !== "function" ||
        typeof tab?.capabilities?.get !== "function"
      ) {
        return undefined;
      }
      const capabilities = await tab.capabilities.list();
      if (
        !Array.isArray(capabilities) ||
        !capabilities.some((capability) => capability?.id === "cdp")
      ) {
        return undefined;
      }
      const cdp = await tab.capabilities.get("cdp");
      return createApprovedCdpRuntime(tab, cdp, approvedOrigin);
    })();
    return approvedRuntimePromise;
  };
  return Object.freeze({
    transport: "host-readonly-evaluate+approved-cdp-fallback",
    async evaluate(pageFunction, options) {
      const activeApprovedRuntime = await approvedRuntimePromise;
      if (activeApprovedRuntime) {
        return activeApprovedRuntime.evaluate(pageFunction, options);
      }
      try {
        return await directRuntime.evaluate(pageFunction, options);
      } catch (error) {
        if (!isApprovedCdpFallbackError(error)) throw error;
        const fallback = await approvedRuntime();
        if (!fallback) throw error;
        return fallback.evaluate(pageFunction, options);
      }
    }
  });
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
          details?.category === "infinite-animation"
        ? {
            exitCode: 2,
            message:
              "A visible infinite animation cannot be captured deterministically. No captured page was saved. Your previous captured product flow has not changed.",
            recovery:
              "Pause or remove the visible infinite animation, then capture the flow again."
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

// This function is serialized into the isolated read-only browser world. Keep
// its accessible-name rules aligned with simpleAccessibleNameVariants in the
// CLI extractor so target discovery and capture accept the same exact name.
function targetAccessibleNameIndexes({ strategy, testId, path, name }) {
  const pageDocument = document;
  const normalizedText = (value) => value.replace(/\s+/g, " ").trim();
  const accessibleTextContent = (
    element,
    {
      allowHiddenRoot = false,
      allowHiddenSubtree = false,
      separateChildElements = false
    } = {}
  ) => {
    const tag = element.tagName.toLowerCase();
    if (["noscript", "script", "style", "template"].includes(tag)) return "";
    if (
      !allowHiddenSubtree &&
      !allowHiddenRoot &&
      element.getAttribute("aria-hidden") === "true"
    ) {
      return "";
    }
    const style = pageDocument.defaultView?.getComputedStyle(element);
    if (
      !allowHiddenSubtree &&
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity || "1") === 0)
    ) {
      return "";
    }
    const inputType = (element.getAttribute("type") ?? "").toLowerCase();
    if (tag === "img" || (tag === "input" && inputType === "image")) {
      return element.getAttribute("alt") ?? "";
    }
    const parts = [];
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3) {
        parts.push(child.textContent ?? "");
      } else if (child.nodeType === 1) {
        parts.push(
          accessibleTextContent(child, {
            ...(allowHiddenSubtree ? { allowHiddenSubtree: true } : {}),
            ...(separateChildElements ? { separateChildElements: true } : {})
          })
        );
      }
    }
    return parts.join(separateChildElements ? " " : "");
  };
  const labelledText = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    return labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => {
            const label = pageDocument.getElementById(id);
            return label
              ? accessibleTextContent(label, {
                  allowHiddenRoot: true,
                  allowHiddenSubtree: true,
                  separateChildElements: true
                })
              : "";
          })
          .join(" ")
      : "";
  };
  const labelsByControlId = new Map();
  for (const label of Array.from(pageDocument.querySelectorAll("label"))) {
    const labelFor = label.getAttribute("for");
    if (!labelFor) continue;
    const labels = labelsByControlId.get(labelFor) ?? [];
    labels.push(label);
    labelsByControlId.set(labelFor, labels);
  }
  const associatedLabelText = (element) => {
    const labels = new Set(
      element.id ? (labelsByControlId.get(element.id) ?? []) : []
    );
    let ancestor = element.parentElement;
    while (ancestor) {
      if (ancestor.tagName.toLowerCase() === "label") labels.add(ancestor);
      ancestor = ancestor.parentElement;
    }
    return [...labels].map((label) => accessibleTextContent(label)).join(" ");
  };
  const explicitLabelName = (element) => {
    const candidate = [
      element.getAttribute("aria-label"),
      labelledText(element),
      associatedLabelText(element)
    ].find((value) => normalizedText(value ?? "") !== "");
    return normalizedText(candidate ?? "");
  };
  const simpleAccessibleName = (element) => {
    const tag = element.tagName.toLowerCase();
    const inputType = (element.getAttribute("type") ?? "").toLowerCase();
    const candidate = [
      explicitLabelName(element),
      tag === "input" && ["button", "reset", "submit"].includes(inputType)
        ? element.getAttribute("value")
        : "",
      tag === "img" || (tag === "input" && inputType === "image")
        ? element.getAttribute("alt")
        : "",
      element.getAttribute("title"),
      accessibleTextContent(element)
    ].find((value) => normalizedText(value ?? "") !== "");
    return normalizedText(candidate ?? "");
  };
  const segmentedAccessibleTextContent = (element) => {
    if (element.getAttribute("aria-hidden") === "true") return "";
    const style = pageDocument.defaultView?.getComputedStyle(element);
    if (
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity || "1") === 0)
    ) {
      return "";
    }
    const parts = [];
    for (const child of Array.from(element.childNodes)) {
      const value =
        child.nodeType === 3
          ? child.textContent ?? ""
          : child.nodeType === 1
            ? segmentedAccessibleTextContent(child)
            : "";
      if (normalizedText(value) !== "") parts.push(value);
    }
    return parts.join(" ");
  };
  const simpleAccessibleNameVariants = (element) => {
    const primary = simpleAccessibleName(element);
    const tag = element.tagName.toLowerCase();
    const inputType = (element.getAttribute("type") ?? "").toLowerCase();
    const authoredName = [
      explicitLabelName(element),
      tag === "input" && ["button", "reset", "submit"].includes(inputType)
        ? element.getAttribute("value")
        : "",
      tag === "img" || (tag === "input" && inputType === "image")
        ? element.getAttribute("alt")
        : "",
      element.getAttribute("title")
    ].find((value) => normalizedText(value ?? "") !== "");
    return authoredName
      ? [primary]
      : [
          ...new Set([
            primary,
            normalizedText(segmentedAccessibleTextContent(element))
          ])
        ];
  };
  const expectedName = normalizedText(name);
  const candidates =
    strategy === "href"
      ? Array.from(pageDocument.querySelectorAll("a[href]"))
      : Array.from(pageDocument.querySelectorAll("[data-testid]")).filter(
          (element) => element.getAttribute("data-testid") === testId
        );
  const indexes = [];
  for (const [index, element] of candidates.entries()) {
    const pathMatches = (() => {
      if (strategy !== "href") return true;
      const href = element.getAttribute("href") ?? "";
      if (href === path) return true;
      try {
        return new URL(href, pageDocument.baseURI).pathname === path;
      } catch {
        return false;
      }
    })();
    if (
      pathMatches &&
      simpleAccessibleNameVariants(element).includes(expectedName)
    ) {
      indexes.push(index);
    }
  }
  return indexes;
}

function locatorFor(tab, target) {
  switch (target.strategy) {
    case "role":
      return tab.playwright.getByRole(target.role, {
        name: target.name,
        exact: true
      });
    case "test-id":
      return tab.playwright.locator(
        `[data-testid=${cssAttributeValue(target.testId)}]`
      );
    case "href":
      return tab.playwright.locator("a[href]");
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
  const locatorCount = await locator.count();
  const evaluatedIndexes =
    target.strategy === "test-id" || target.strategy === "href"
      ? await tab.playwright.evaluate(targetAccessibleNameIndexes, {
          strategy: target.strategy,
          ...(target.strategy === "test-id"
            ? { testId: target.testId }
            : { path: target.path }),
          name: target.name
        })
      : Array.from({ length: locatorCount }, (_, index) => index);
  const matchingIndexes = Array.isArray(evaluatedIndexes)
    ? [
        ...new Set(
          evaluatedIndexes.filter(
            (index) =>
              Number.isInteger(index) && index >= 0 && index < locatorCount
          )
        )
      ]
    : [];
  const matchedCount = matchingIndexes.length;
  if (matchedCount === 0) {
    return { count: 0, matchedCount: 0, locator };
  }
  if (locatorCount > 1 && typeof locator.nth !== "function") {
    return { count: matchedCount, matchedCount, locator };
  }
  const viewportLocators = [];
  for (const index of matchingIndexes) {
    const candidate =
      locatorCount === 1 ? locator : locator.nth(index);
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

async function armCapturedPageChange(tab) {
  return tab.playwright.evaluate(() => {
    const world = window;
    if (typeof world.MutationObserver !== "function") return undefined;
    const previous = world.__showkitPageChangeObserverV1;
    previous?.cleanup?.();
    const token =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `change-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const state = {
      token,
      revision: 0,
      waiters: [],
      cleanup: undefined
    };
    const changed = () => {
      state.revision += 1;
      const waiters = state.waiters.splice(0);
      for (const waiter of waiters) waiter(state.revision);
    };
    const mutationObserver = new world.MutationObserver(changed);
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    const resizeObserver =
      typeof world.ResizeObserver === "function"
        ? new world.ResizeObserver(changed)
        : undefined;
    resizeObserver?.observe(document.documentElement);
    if (document.body) resizeObserver?.observe(document.body);
    const events = ["change", "input", "toggle", "hashchange", "popstate"];
    for (const event of events) {
      window.addEventListener(event, changed, true);
    }
    state.cleanup = () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      for (const event of events) {
        window.removeEventListener(event, changed, true);
      }
      for (const waiter of state.waiters.splice(0)) waiter(state.revision);
      if (world.__showkitPageChangeObserverV1 === state) {
        delete world.__showkitPageChangeObserverV1;
      }
    };
    Object.defineProperty(world, "__showkitPageChangeObserverV1", {
      value: state,
      configurable: true,
      writable: true
    });
    return token;
  });
}

async function waitForCapturedPageChange(tab, token, revision, timeoutMs) {
  return tab.playwright.evaluate(
    async ({ expectedToken, seenRevision, boundedTimeoutMs }) => {
      if (typeof expectedToken !== "string") {
        return { available: false, changed: false, revision: seenRevision };
      }
      const state = window.__showkitPageChangeObserverV1;
      if (!state || state.token !== expectedToken) {
        return { available: false, changed: false, revision: seenRevision };
      }
      if (state.revision > seenRevision) {
        return {
          available: true,
          changed: true,
          revision: state.revision
        };
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (nextRevision) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            available: true,
            changed: nextRevision > seenRevision,
            revision: nextRevision
          });
        };
        const timeout = setTimeout(
          () => finish(state.revision),
          boundedTimeoutMs
        );
        state.waiters.push(finish);
      });
    },
    {
      expectedToken: token,
      seenRevision: revision,
      boundedTimeoutMs: timeoutMs
    }
  );
}

async function releaseCapturedPageChange(tab, token) {
  if (
    typeof tab?.playwright?.evaluate !== "function" ||
    typeof token !== "string"
  ) {
    return;
  }
  await tab.playwright
    .evaluate((expectedToken) => {
      const state = window.__showkitPageChangeObserverV1;
      if (state?.token === expectedToken) state.cleanup?.();
    }, token)
    .catch(() => undefined);
}

function unstableBrowserRenderError() {
  const error = new Error(
    "The page did not reach a stable HTML state before capture. No captured page was saved."
  );
  error.code = "UnsupportedSurface";
  error.exitCode = 2;
  error.recovery =
    "Wait for visible animations and page updates to finish, then capture the flow again.";
  error.details = { category: "unstable-render-state" };
  return error;
}

async function waitForCapturedPageVisuals(tab, minimumSettleMs = 320) {
  if (typeof tab.playwright.evaluate !== "function") return;
  let hostTimer;
  const hostTimeout = new Promise((_resolve, reject) => {
    hostTimer = setTimeout(
      () => reject(unstableBrowserRenderError()),
      5_500
    );
  });
  const settleCall = Promise.resolve().then(() => tab.playwright.evaluate(async (settleOptions) => {
    const timeoutMs = 5_000;
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    const boundedMinimumSettleMs =
      settleOptions?.minimumSettleMs === 220 ? 220 : 320;
    const quietWindowMs = 220;
    const maxElements = 10_000;
    const maxVisibleImages = 64;
    const maxAnimations = 2_000;
    const allElements = document.getElementsByTagName("*");
    if (allElements.length > maxElements) {
      return "element-limit";
    }
    let revision = 0;
    let lastChangeAt = startedAt;
    const changed = () => {
      revision += 1;
      lastChangeAt = Date.now();
    };
    const intersectsViewport = (element) => {
      const rectangle = element.getBoundingClientRect();
      return (
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        rectangle.bottom > 0 &&
        rectangle.right > 0 &&
        rectangle.top < window.innerHeight &&
        rectangle.left < window.innerWidth
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
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number.parseFloat(style.opacity || "1") <= 0
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
          const element = node instanceof Element ? node : node.parentElement;
          return element ? changedVisibility(element) : false;
        });
      }
      return false;
    };
    mutationObserver =
      typeof window.MutationObserver === "function"
        ? new window.MutationObserver((records) => {
            if (records.some(mutationAffectsRender)) changed();
          })
        : undefined;
    mutationObserver?.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    const initialAnimationScan = activeAnimations();
    if (!Array.isArray(initialAnimationScan)) {
      mutationObserver?.disconnect();
      return initialAnimationScan.limit;
    }
    const resizeObserver =
      typeof window.ResizeObserver === "function"
        ? new window.ResizeObserver(changed)
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
          Math.max(0, deadline - Date.now())
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
      typeof window.requestAnimationFrame === "function"
        ? new Promise((resolve) => {
            let complete = false;
            const finish = (value) => {
              if (complete) return;
              complete = true;
              clearTimeout(timer);
              if (value === false) window.cancelAnimationFrame(frame);
              resolve(value);
            };
            const frame = window.requestAnimationFrame(() => finish(true));
            const timer = setTimeout(() => finish(false), 100);
          })
        : new Promise((resolve) => setTimeout(() => resolve(false), 16));
    try {
      if (document.fonts?.ready) await bounded(document.fonts.ready);
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
      let previousSignature;
      let stableFrames = 0;
      while (Date.now() < deadline) {
        const preFrameAnimations = activeAnimations();
        if (!Array.isArray(preFrameAnimations)) {
          return preFrameAnimations.limit;
        }
        if (preFrameAnimations.length > maxAnimations * 10) {
          return "animation-scan-limit";
        }
        await nextFrame();
        if (allElements.length > maxElements) return "element-limit";
        const now = Date.now();
        if (now >= deadline) return false;
        const images = visibleImages();
        if (images.length > maxVisibleImages) return "image-limit";
        const readyImages = images.filter(
          (image) => image.complete
        ).length;
        let sourceSignal = 0;
        for (const image of images) {
          const source = image.currentSrc || image.src || "";
          sourceSignal = (sourceSignal + source.length * 31) % 2_147_483_647;
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
        if (visibleAnimationCount > maxAnimations) return "animation-limit";
        if (visibleInfiniteAnimation) return "infinite-animation";
        const activeFiniteAnimationCount = activeFiniteAnimations.length;
        const signature = [
          revision,
          images.length,
          readyImages,
          sourceSignal,
          activeFiniteAnimationCount,
          document.documentElement.scrollWidth,
          document.documentElement.scrollHeight
        ].join(":");
        if (signature === previousSignature) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        previousSignature = signature;
        if (
          stableFrames >= 3 &&
          readyImages === images.length &&
          activeFiniteAnimationCount === 0 &&
          document.readyState === "complete" &&
          now - startedAt >= boundedMinimumSettleMs &&
          now - lastChangeAt >= quietWindowMs
        ) {
          return true;
        }
      }
      return false;
    } finally {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    }
  }, { minimumSettleMs, __showkitVisualSettle: true }));
  let stable;
  try {
    stable = await Promise.race([settleCall, hostTimeout]);
  } finally {
    clearTimeout(hostTimer);
  }
  if ([
    "element-limit",
    "image-limit",
    "animation-limit",
    "animation-scan-limit",
    "shadow-depth-limit",
    "shadow-root-limit"
  ].includes(stable)) {
    const error = new Error(
      "The visible page exceeds a bounded capture limit. No captured page was saved."
    );
    error.code = "CaptureTooLarge";
    error.exitCode = 2;
    error.recovery =
      "Reduce the number of visible elements, images, or animations, then capture the flow again.";
    error.details = { category: stable };
    throw error;
  }
  if (stable === "infinite-animation") {
    const error = new Error(
      "A visible infinite animation cannot be captured deterministically. No captured page was saved."
    );
    error.code = "UnsupportedSurface";
    error.exitCode = 2;
    error.recovery =
      "Pause or remove the visible infinite animation, then capture the flow again.";
    error.details = { category: "infinite-animation" };
    throw error;
  }
  if (stable !== true) {
    throw unstableBrowserRenderError();
  }
}

async function positionCapturedTarget(locatorTab, target) {
  const status = await viewportLocatorFor(locatorTab, target);
  if (status.count !== 1 || typeof status.locator?.evaluate !== "function") {
    return false;
  }
  const moved = await status.locator
    .evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      if (
        rectangle.width <= 0 ||
        rectangle.height <= 0 ||
        rectangle.height >= window.innerHeight * 0.7
      ) {
        return false;
      }
      let current = element;
      while (current instanceof Element) {
        const position = getComputedStyle(current).position;
        if (position === "fixed" || position === "sticky") return false;
        current = current.parentElement;
      }
      const margin = Math.min(
        96,
        Math.max(48, Math.round(window.innerHeight * 0.12))
      );
      const nearTop = rectangle.top < margin && window.scrollY > 1;
      const nearBottom = rectangle.bottom > window.innerHeight - margin;
      if (!nearTop && !nearBottom) return false;
      element.scrollIntoView({
        behavior: "instant",
        block: "center",
        inline: "nearest"
      });
      return true;
    })
    .catch(() => false);
  return moved;
}

function sceneFromKernel(result, anchorId) {
  return {
    html: result.html,
    nodes: result.nodes,
    ...(result.fontFaces?.length > 0
      ? { fontFaces: result.fontFaces }
      : {}),
    viewport: result.viewport,
    scroll: result.scroll,
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
      Number.isInteger(result.scroll?.x) &&
      Number.isInteger(result.scroll?.y) &&
      Number.isInteger(result.scroll?.width) &&
      Number.isInteger(result.scroll?.height) &&
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
    scrollCapture: "revealed",
    transferEncoding: "lzss-json",
    ...(options.sensitiveTextRedaction
      ? { sensitiveTextRedaction: options.sensitiveTextRedaction }
      : {}),
    ...(options.privateContentConsent
      ? { privateContentConsent: options.privateContentConsent }
      : {}),
    ...(options.pageAssetConsent
      ? { pageAssetConsent: options.pageAssetConsent }
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
    if (
      match[1].length <= 10_000 &&
      /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(
        match[1]
      )
    ) {
      return match[1];
    }
    try {
      const url = new URL(
        match[1],
        document.baseURI || document.URL || window.location.href
      );
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
      const computed = window.getComputedStyle(element);
      if (
        computed.display === "none" ||
        computed.visibility !== "visible" ||
        Number.parseFloat(computed.opacity || "1") <= 0
      ) {
        return false;
      }
      return Array.from(element.childNodes ?? []).some((node) => {
        if (node.nodeType !== 3 || (node.textContent ?? "").trim() === "") {
          return false;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects()).some(
          (textRectangle) =>
            textRectangle.bottom > 0 &&
            textRectangle.right > 0 &&
            textRectangle.top < window.innerHeight &&
            textRectangle.left < window.innerWidth &&
            intersects(rectangle, textRectangle)
        );
      });
    });
  };

  const privateUseGlyph = (content) => {
    const match = /^(["'])([\s\S]{1,8}?)\1(?:\s*\/\s*["'][\s\S]*["'])?$/.exec(
      content.trim()
    );
    if (!match?.[2]) return undefined;
    const glyphs = Array.from(match[2]).filter(
      (character) => !/\s/u.test(character)
    );
    if (
      glyphs.length < 1 ||
      glyphs.length > 2 ||
      glyphs.some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return !(
          (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
          (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
          (codePoint >= 0x100000 && codePoint <= 0x10fffd)
        );
      })
    ) {
      return undefined;
    }
    return glyphs.join("");
  };

  for (const element of Array.from(
    document.querySelectorAll(interactiveSelector)
  )) {
    if (candidates.length >= 64) break;
    if (
      !noVisibleText(element) ||
      element.children.length > 0 ||
      element.querySelector("canvas,img,picture,svg,video")
    ) {
      continue;
    }
    const computed = window.getComputedStyle(element);
    const pseudoEntry = ["before", "after"]
      .map((name) => {
        const style = window.getComputedStyle(element, `::${name}`);
        return { name, style, glyph: privateUseGlyph(style.content) };
      })
      .find((entry) => entry.glyph !== undefined);
    if (!pseudoEntry) continue;
    const rectangle = element.getBoundingClientRect();
    const backdropColor = effectiveBackdropColor(element);
    if (
      rectangle.width < 4 ||
      rectangle.height < 4 ||
      rectangle.width > 96 ||
      rectangle.height > 96 ||
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
    const glyphKey = Array.from(pseudoEntry.glyph)
      .map((character) => (character.codePointAt(0) ?? 0).toString(16))
      .join("-");
    const source = [
      "showkit:rendered-font-icon",
      pseudoEntry.name,
      glyphKey,
      pseudoEntry.style.fontFamily,
      pseudoEntry.style.fontSize,
      pseudoEntry.style.fontWeight,
      pseudoEntry.style.color,
      pseudoEntry.style.transform,
      pseudoEntry.style.opacity,
      pseudoEntry.style.filter,
      pseudoEntry.style.boxShadow
    ].join(":");
    if (known.has(source)) continue;
    const match = {
      fontGlyphElement: true,
      fontGlyphPseudo: pseudoEntry.name,
      fontGlyphContent: pseudoEntry.style.content,
      fontGlyphFamily: pseudoEntry.style.fontFamily,
      fontGlyphSize: pseudoEntry.style.fontSize,
      fontGlyphWeight: pseudoEntry.style.fontWeight,
      fontGlyphColor: pseudoEntry.style.color,
      fontGlyphTransform: pseudoEntry.style.transform,
      fontGlyphOpacity: pseudoEntry.style.opacity,
      fontGlyphFilter: pseudoEntry.style.filter,
      fontGlyphBoxShadow: pseudoEntry.style.boxShadow,
      dimensions: {
        width: rectangle.width,
        height: rectangle.height
      },
      opacity: computed.opacity,
      backdropColor
    };
    const candidateKey = [
      source,
      rectangle.width.toFixed(2),
      rectangle.height.toFixed(2),
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

  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (candidates.length >= 64) break;
    if (!element.closest(interactiveSelector) || !noVisibleText(element)) {
      continue;
    }
    if (
      element.children.length > 0 ||
      element.querySelector("canvas,img,picture,svg,video") ||
      ["::before", "::after"].some((pseudo) => {
        const content = window
          .getComputedStyle(element, pseudo)
          .content.trim();
        return !["none", "normal"].includes(content);
      })
    ) {
      continue;
    }
    const computed = window.getComputedStyle(element);
    const source = directBackgroundSource(computed.backgroundImage);
    if (!source || known.has(source)) continue;
    const rectangle = element.getBoundingClientRect();
    const backdropColor = effectiveBackdropColor(element);
    if (
      rectangle.width < 4 ||
      rectangle.height < 4 ||
      rectangle.width > 96 ||
      rectangle.height > 96 ||
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
      pseudoWidth > 96 ||
      pseudoHeight > 96 ||
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
  const hostVerified =
    hostValidation?.[CODEX_BROWSER_VALIDATION] === true &&
    OPENAI_BROWSER_VERIFIED_BINDINGS.get(hostValidation) === tab;
  const verifiedRuntime = hostVerified
    ? OPENAI_BROWSER_VERIFIED_RUNTIMES.get(hostValidation)
    : undefined;
  const evaluatePage =
    typeof verifiedRuntime?.evaluate === "function"
      ? verifiedRuntime.evaluate.bind(verifiedRuntime)
      : typeof tab?.playwright?.evaluate === "function"
        ? tab.playwright.evaluate.bind(tab.playwright)
        : undefined;
  const runtimeTab = {
    url: (...args) => tab.url(...args),
    playwright: {
      evaluate: evaluatePage,
      domSnapshot:
        typeof tab?.playwright?.domSnapshot === "function"
          ? tab.playwright.domSnapshot.bind(tab.playwright)
          : undefined
    }
  };
  let pageVisualsSettled = false;
  const settlePageVisuals = async (minimumSettleMs = 320) => {
    await waitForCapturedPageVisuals(runtimeTab, minimumSettleMs);
    pageVisualsSettled = true;
  };
  const consumeSettledVisuals = async (minimumSettleMs = 320) => {
    if (!pageVisualsSettled) await settlePageVisuals(minimumSettleMs);
    pageVisualsSettled = false;
  };
  const hasDomAccess =
    tab?.playwright &&
    typeof tab.playwright.domSnapshot === "function" &&
    typeof tab.playwright.locator === "function" &&
    typeof tab.playwright.getByRole === "function" &&
    typeof evaluatePage === "function";
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
    const requestedPublicPage =
      context?.assetConsent?.mode === "public-page" &&
      context?.assetConsent?.consent === "requested";
    if (
      (!visibleSession && !requestedPublicPage) ||
      typeof evaluatePage !== "function" ||
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
      candidates = await evaluatePage(
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
        candidate.width > (candidate.match?.canvasElement ? 64 : 96) ||
        candidate.height > (candidate.match?.canvasElement ? 64 : 96) ||
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
    transferReaderFunction,
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
      const {
        chunkSize,
        htmlLength,
        nodesJsonLength,
        captureId,
        payloadSha256
      } = result.transfer;
      const totalLength = Math.max(htmlLength, nodesJsonLength);
      const useFrozenTransfer =
        typeof transferReaderFunction === "function" &&
        typeof captureId === "string" &&
        typeof payloadSha256 === "string";
      try {
        for (let offset = chunkSize; offset < totalLength; offset += chunkSize) {
          const segment = useFrozenTransfer
            ? await evaluatePage(transferReaderFunction, {
                captureId,
                offset,
                chunkSize
              })
            : await evaluatePage(pageFunction, {
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
            segment.transfer.chunkSize !== chunkSize ||
            segment.transfer.htmlLength !== htmlLength ||
            segment.transfer.nodesJsonLength !== nodesJsonLength ||
            (useFrozenTransfer &&
              (segment.transfer.captureId !== captureId ||
                segment.transfer.payloadSha256 !== payloadSha256)) ||
            typeof segment.html !== "string" ||
            typeof segment.nodesJson !== "string"
          ) {
            throw new Error("The captured HTML node transfer was interrupted.");
          }
          html += segment.html;
          nodesJson += segment.nodesJson;
        }
      } finally {
        if (useFrozenTransfer) {
          await evaluatePage(transferReaderFunction, {
            captureId,
            release: true
          }).catch(() => undefined);
        }
      }
      if (html.length < htmlLength || nodesJson.length < nodesJsonLength) {
        throw new Error("The captured HTML node transfer is incomplete.");
      }
      html = html.slice(0, htmlLength);
      nodesJson = nodesJson.slice(0, nodesJsonLength);
      if (
        typeof payloadSha256 === "string" &&
        sha256(`${html}\u0000${nodesJson}`) !== payloadSha256
      ) {
        throw new Error("The captured HTML node transfer changed content.");
      }
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
            implementationHash: hostValidation.implementationHash,
            transport: hostValidation.transport
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
    async waitForTargetStatus(
      target,
      { timeoutMs = 1_500, pollMs = 50 } = {}
    ) {
      const timeout =
        Number.isInteger(timeoutMs) && timeoutMs >= 0
          ? Math.min(timeoutMs, 5_000)
          : 1_500;
      const poll =
        Number.isInteger(pollMs) && pollMs > 0
          ? Math.min(pollMs, 250)
          : 50;
      const deadline = performance.now() + timeout;
      let status;
      do {
        status = await viewportLocatorFor(tab, target);
        if (status.count === 1) break;
        if (performance.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, poll));
      } while (true);
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
    async prepareTargetForCapture(target) {
      const moved = await positionCapturedTarget(tab, target);
      if (moved) pageVisualsSettled = false;
      if (!pageVisualsSettled) await settlePageVisuals(220);
      return moved;
    },
    async evaluateTarget(target, pageFunction, options, transferReaderFunction) {
      if (typeof evaluatePage !== "function") {
        throw new Error(
          "The selected browser cannot provide isolated page evaluation."
        );
      }
      await viewportLocatorFor(tab, target);
      await consumeSettledVisuals(220);
      const pageOptions = {
        ...options,
        scopeTarget: target,
        transferId: randomUUID()
      };
      return decodeTransferredNodes(
        evaluatePage,
        pageFunction,
        transferReaderFunction,
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
      pageVisualsSettled = false;
      return [...pageAssets, ...renderedIcons];
    },
    async performAction(target, actionKind) {
      if (actionKind === "inspect") {
        const inspectTarget = await viewportLocatorFor(tab, target);
        if (inspectTarget.count !== 1) {
          throw new Error("The selected inspection target is unavailable.");
        }
        return;
      }
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
          typeof navigationTarget.locator.getAttribute === "function"
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
          await settlePageVisuals();
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
        await settlePageVisuals();
        return;
      }
      const beforeUrl = await tab.url();
      const beforeSignature = await visibleStateSignature(runtimeTab);
      const beforeSemanticSignature = await semanticStateSignature(runtimeTab);
      const changedFromBaseline = async () => {
        const currentUrl = await tab.url();
        if (currentUrl !== beforeUrl) return true;
        const currentSignature = await visibleStateSignature(runtimeTab);
        const currentSemanticSignature = await semanticStateSignature(runtimeTab);
        return (
          currentSignature !== beforeSignature ||
          (beforeSemanticSignature !== undefined &&
            currentSemanticSignature !== undefined &&
            currentSemanticSignature !== beforeSemanticSignature)
        );
      };
      const changeToken = await armCapturedPageChange(runtimeTab);
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
      let revision = 0;
      const deadline = Date.now() + 3_000;
      try {
        while (Date.now() < deadline) {
          const afterUrl = await tab.url();
          if (afterUrl !== beforeUrl) {
            await settlePageVisuals();
            if (await changedFromBaseline()) return;
          }
          const signal = await waitForCapturedPageChange(
            runtimeTab,
            changeToken,
            revision,
            Math.max(1, deadline - Date.now())
          );
          if (!signal?.available) {
            if (await changedFromBaseline()) {
              await settlePageVisuals();
              if (await changedFromBaseline()) return;
            }
            break;
          }
          revision = signal.revision;
          if (!signal.changed) break;
          if (await changedFromBaseline()) {
            await settlePageVisuals();
            if (await changedFromBaseline()) return;
          }
        }
      } finally {
        await releaseCapturedPageChange(runtimeTab, changeToken);
      }
      if (clickError) throw clickError;
      throw new Error("The selected page control did not change the visible state.");
    },
    async evaluateTerminal(pageFunction, options, transferReaderFunction) {
      if (typeof evaluatePage !== "function") {
        throw new Error(
          "The selected browser cannot provide isolated page evaluation."
        );
      }
      const body = tab.playwright.locator("body");
      if ((await body.count()) !== 1) {
        throw new Error("Browser body is unavailable.");
      }
      await consumeSettledVisuals();
      const pageOptions = {
        ...options,
        scopeSelector: "body",
        transferId: randomUUID()
      };
      return decodeTransferredNodes(
        evaluatePage,
        pageFunction,
        transferReaderFunction,
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

export function collectPageFontFaceDescriptors(fontUrls) {
  const pageBaseUrl =
    document.baseURI || document.URL || window.location.href;
  const selectedUrls = new Set(
    fontUrls.flatMap((raw) => {
      try {
        return [new URL(raw, pageBaseUrl).href];
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
          for (const nested of Array.from(candidate.cssRules ?? [])) {
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
            source = new URL(sourceMatch[1], pageBaseUrl).href;
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
          if (!family || !/^[^{};@<>"'\\\r\n]{1,120}$/.test(family)) {
            continue;
          }
          descriptors.push({
            source,
            family,
            style: ["normal", "italic", "oblique"].includes(style)
              ? style
              : "normal",
            weight: /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(weight)
              ? weight
              : "normal",
            stretch:
              /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/.test(
                stretch
              )
                ? stretch
                : "normal",
            display: ["auto", "block", "swap", "fallback", "optional"].includes(
              display
            )
              ? display
              : "block",
            ...(unicodeRange &&
            /^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i.test(
              unicodeRange
            )
              ? { unicodeRange }
              : {})
          });
        }
      };
      if (rule.type !== CSSRule.FONT_FACE_RULE && !rule.cssRules) continue;
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
    for (const element of Array.from(root.querySelectorAll?.("*") ?? [])) {
      if (element.sheet) visitSheet(element.sheet);
      if (element.shadowRoot) visitRoot(element.shadowRoot);
    }
  };
  visitRoot(document);
  return descriptors.slice(0, 32);
}

export function createCodexPageAssetProvider({
  tab,
  approvals = [],
  hostValidation
}) {
  const hostVerified =
    hostValidation?.[CODEX_BROWSER_VALIDATION] === true &&
    OPENAI_BROWSER_VERIFIED_BINDINGS.get(hostValidation) === tab;
  const verifiedRuntime = hostVerified
    ? OPENAI_BROWSER_VERIFIED_RUNTIMES.get(hostValidation)
    : undefined;
  const evaluatePage =
    typeof verifiedRuntime?.evaluate === "function"
      ? verifiedRuntime.evaluate.bind(verifiedRuntime)
      : typeof tab?.playwright?.evaluate === "function"
        ? tab.playwright.evaluate.bind(tab.playwright)
        : undefined;
  const approved = new Map();
  const visibleSessionReplacements = new Map();
  const visibleSessionAttemptedUrls = new Set();
  let pageAssetCapabilityPromise;
  const pageAssetCapability = async () => {
    pageAssetCapabilityPromise ??= (async () => {
      const capabilityIds = await tab.capabilities.list();
      if (!capabilityIds.some((capability) => capability.id === "pageAssets")) {
        throw new Error("The selected browser does not provide pageAssets.");
      }
      return tab.capabilities.get("pageAssets");
    })();
    return pageAssetCapabilityPromise;
  };
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
    const capability = await pageAssetCapability();
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
      typeof evaluatePage === "function"
        ? new Set(
            await evaluatePage(() => {
              const sources = new Set();
              const addSource = (raw) => {
                if (typeof raw !== "string" || raw.trim() === "") return;
                try {
                  const source = new URL(
                    raw,
                    document.baseURI || document.URL || window.location.href
                  );
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
          if (name === "w" || name === "h" || name === "im_w") {
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
      typeof evaluatePage === "function"
        ? await evaluatePage((fontUrls) => {
            const selectedUrls = new Set(
              fontUrls.flatMap((raw) => {
                try {
                  return [
                    new URL(
                      raw,
                      document.baseURI || document.URL || window.location.href
                    ).href
                  ];
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
                        document.baseURI ||
                          document.URL ||
                          window.location.href
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
                      /^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i.test(
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
      // Keep exact successful bytes. Scene extraction still fails closed when
      // an unavailable asset is required by a visible control.
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
            "text",
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
  if (
    !tab?.playwright ||
    (typeof tab.playwright.evaluate !== "function" &&
      (typeof tab?.capabilities?.list !== "function" ||
        typeof tab?.capabilities?.get !== "function"))
  ) {
    throw new TypeError(
      "OpenAI Browser isolation verification needs the exact selected tab with an approved isolated evaluation path."
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
  const probeRuntime = async (runtime, probePage) => {
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
    try {
      return await Promise.race([runtime.evaluate(probePage), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const directRuntime =
    typeof tab.playwright.evaluate === "function"
      ? Object.freeze({
          transport: "host-readonly-evaluate",
          evaluate(pageFunction, options) {
            return tab.playwright.evaluate(pageFunction, options);
          }
        })
      : undefined;
  let selectedOrigin;
  if (typeof tab?.url === "function") {
    try {
      selectedOrigin = exactWebOrigin(await tab.url());
    } catch {
      selectedOrigin = undefined;
    }
  }
  let runtime = directRuntime;
  let probe;
  const probePage = () => ({
    ok: true,
    documentNodeType: document.nodeType,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  });
  try {
    if (!runtime) throw new Error("Direct read-only evaluation is unavailable.");
    probe = await probeRuntime(runtime, probePage);
  } catch (directError) {
    if (
      typeof tab?.capabilities?.list !== "function" ||
      typeof tab?.capabilities?.get !== "function"
    ) {
      throw directError;
    }
    const capabilities = await tab.capabilities.list();
    if (
      !Array.isArray(capabilities) ||
      !capabilities.some((capability) => capability?.id === "cdp")
    ) {
      throw directError;
    }
    const cdp = await tab.capabilities.get("cdp");
    runtime = await createApprovedCdpRuntime(tab, cdp, selectedOrigin);
    probe = await probeRuntime(runtime, probePage);
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
  if (
    runtime === directRuntime &&
    selectedOrigin !== undefined &&
    typeof tab?.capabilities?.list === "function" &&
    typeof tab?.capabilities?.get === "function"
  ) {
    try {
      const capabilities = await tab.capabilities.list();
      if (
        Array.isArray(capabilities) &&
        capabilities.some((capability) => capability?.id === "cdp")
      ) {
        runtime = createAdaptiveApprovedRuntime(
          tab,
          directRuntime,
          selectedOrigin
        );
      }
    } catch {
      // The verified host-owned read-only evaluator remains available.
    }
  }
  const validation = Object.freeze({
    [CODEX_BROWSER_VALIDATION]: true,
    provider: "openai-browser",
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    executionWorld: OPENAI_BROWSER_ISOLATION_VERSION,
    implementationHash,
    transport: runtime.transport
  });
  OPENAI_BROWSER_VERIFIED_BINDINGS.set(validation, tab);
  OPENAI_BROWSER_VERIFIED_RUNTIMES.set(validation, runtime);
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
  const runtime = OPENAI_BROWSER_VERIFIED_RUNTIMES.get(hostValidation);
  if (typeof runtime?.evaluate !== "function") {
    throw new Error("Read-only browser DOM access is unavailable.");
  }
  const environment = await runtime.evaluate(() => ({
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
  const captureStartedAt = performance.now();
  const capturePerformance = {
    htmlSceneCount: 0,
    sceneExtractionMs: 0,
    assetPreparationCount: 0,
    assetPreparationMs: 0,
    actionCount: 0,
    actionSettleMs: 0
  };

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
        typeof adapter.waitForTargetStatus === "function"
          ? await adapter.waitForTargetStatus(step.target)
          : typeof adapter.targetStatus === "function"
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

      phase = "target-positioning";
      if (typeof adapter.prepareTargetForCapture === "function") {
        await adapter.prepareTargetForCapture(step.target);
      }

      const anchorId = `sk-${step.id}`;
      phase = "asset-preparation";
      let remoteAssetReplacements = [];
      const assetPreparationStartedAt = performance.now();
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
      } finally {
        capturePerformance.assetPreparationCount += 1;
        capturePerformance.assetPreparationMs +=
          performance.now() - assetPreparationStartedAt;
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
      const sceneExtractionStartedAt = performance.now();
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
          pageAssetConsent: confirmedAssets,
          remoteAssetPolicy,
          fontFaces,
          remoteAssetReplacements
        }),
        cli.readFrozenSceneTransferKernel
      );
      capturePerformance.htmlSceneCount += 1;
      capturePerformance.sceneExtractionMs +=
        performance.now() - sceneExtractionStartedAt;
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
      const actionStartedAt = performance.now();
      await adapter.performAction(step.target, step.actionKind);
      capturePerformance.actionCount += 1;
      capturePerformance.actionSettleMs += performance.now() - actionStartedAt;
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
    const terminalAssetPreparationStartedAt = performance.now();
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
    } finally {
      capturePerformance.assetPreparationCount += 1;
      capturePerformance.assetPreparationMs +=
        performance.now() - terminalAssetPreparationStartedAt;
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
    const terminalExtractionStartedAt = performance.now();
    const terminalResult = await adapter.evaluateTerminal(
      cli.extractSceneKernel,
      kernelOptions(cli, {
        targetPresent: false,
        scanOnly: false,
        stepIndex: recipe.steps.length,
        sensitiveSelectors,
        sensitiveTextRedaction: confirmedRedaction,
        privateContentConsent: confirmedPrivateContent,
        pageAssetConsent: confirmedAssets,
        remoteAssetPolicy,
        fontFaces: terminalFontFaces,
        remoteAssetReplacements: terminalRemoteAssetReplacements
      }),
      cli.readFrozenSceneTransferKernel
    );
    capturePerformance.htmlSceneCount += 1;
    capturePerformance.sceneExtractionMs +=
      performance.now() - terminalExtractionStartedAt;
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
    const rounded = (value) => Number(value.toFixed(3));
    return {
      status: "captured",
      sourceMode: "agent-browser-session",
      replayLevel: "session-captured",
      captureId: envelope.capture.captureId,
      stepCount: captureSteps.length,
      capturePerformance: {
        htmlSceneCount: capturePerformance.htmlSceneCount,
        sceneExtractionMs: rounded(capturePerformance.sceneExtractionMs),
        assetPreparationCount: capturePerformance.assetPreparationCount,
        assetPreparationMs: rounded(capturePerformance.assetPreparationMs),
        actionCount: capturePerformance.actionCount,
        actionSettleMs: rounded(capturePerformance.actionSettleMs),
        totalMs: rounded(performance.now() - captureStartedAt)
      },
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
