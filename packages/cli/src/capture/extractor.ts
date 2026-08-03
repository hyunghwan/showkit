import type {
  AssetPayload,
  SanitizedNode,
  SceneFontFace
} from "../core/schemas.js";

export type SceneKernelOptions = {
  anchorId?: string;
  targetPresent: boolean;
  scanOnly: boolean;
  stepIndex: number;
  secretPatternSources: string[];
  sensitiveSelectors: string[];
  remoteAssetPolicy: "strict" | "decorative-remove";
  targetErrorCode: "TargetMissing" | "BrowserTargetAmbiguous";
  nodeMode?: "tree" | "flat" | "json";
  transferEncoding?: "chunked-json" | "lzss-json";
  maxSerializedElements?: number;
  transferOffset?: number;
  transferChunkSize?: number;
  scopeSelector?: string;
  scopeTarget?:
    | {
        strategy: "role";
        role: string;
        name: string;
      }
    | {
        strategy: "test-id";
        testId: string;
        name: string;
      }
    | {
        strategy: "href";
        path: string;
        name: string;
      }
    | {
        strategy: "label" | "visible-text";
        name: string;
      }
    | {
        strategy: "title";
        name: string;
      };
  sensitiveTextRedaction?: {
    mode: "text-only";
    consent: "confirmed";
    selectors: string[];
  };
  privateContentConsent?: {
    mode: "visible-session";
    consent: "confirmed";
  };
  fontFaces?: SceneFontFace[];
  remoteAssetReplacements?: Array<{
    source: string;
    captureKind?:
      | "isolated-rendered-icon"
      | "isolated-rendered-canvas";
    match?: {
      pseudo?: "before";
      canvasElement?: true;
      dimensions: { width: number; height: number };
      intrinsicDimensions?: { width: number; height: number };
      backgroundPosition?: string;
      backgroundRepeat?: string;
      backgroundSize?: string;
      opacity: string;
      backdropColor: string;
    };
    payload: Omit<AssetPayload, "base64"> & {
      base64?: string;
    };
  }>;
};

export type SceneKernelBlocker = {
  code:
    | "SensitiveDataDetected"
    | "UnsupportedSurface"
    | "CaptureTooLarge"
    | "TargetMissing"
    | "BrowserTargetAmbiguous";
  category: string;
  stepIndex: number;
  sourceFingerprint: string;
};

export type SceneKernelResult =
  | {
      ok: false;
      blocker: SceneKernelBlocker;
    }
  | {
      ok: true;
      scanOnly: true;
      excludedSurfaces: string[];
    }
  | {
      ok: true;
      scanOnly: false;
      html: string;
      nodes: SanitizedNode[];
      nodesJson?: string;
      transfer?:
        | {
            mode: "chunked-json";
            offset: number;
            chunkSize: number;
            htmlLength: number;
            nodesJsonLength: number;
          }
        | {
            mode: "lzss-json";
            encoding: "lzss-15bit";
            compressedLength: number;
            nodesJsonLength: number;
          };
      viewport: { width: number; height: number };
      target?: {
        tag: string;
        role?: string;
        name: string;
        bounds: { x: number; y: number; width: number; height: number };
      };
      evidenceTexts: string[];
      assetPayloads: AssetPayload[];
      fontFaces: SceneFontFace[];
      excludedSurfaces: string[];
      sensitiveText: {
        mode: "blocked-by-default" | "text-only";
        redactedTextNodeCount: number;
        redactedAttributeCount: number;
        regionCount: number;
      };
    };

/**
 * This function is serialized by Playwright and host browser adapters. Keep all
 * runtime values local to the function so it can execute without module state.
 * It reads the live document and builds the sanitized derivative as plain data.
 * It does not create or mutate live or detached DOM nodes.
 */
export async function extractSceneKernel(
  scopeOrOptions: Element | SceneKernelOptions,
  providedOptions?: SceneKernelOptions
): Promise<SceneKernelResult> {
  const options =
    providedOptions ??
    (scopeOrOptions as SceneKernelOptions);
  const pageDocument =
    providedOptions !== undefined
      ? (scopeOrOptions as Element).ownerDocument
      : document;
  const normalizedText = (value: string): string =>
    value.replace(/\s+/g, " ").trim();
  const visibleTextContent = (element: Element): string => {
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
    let value = "";
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3) {
        value += child.textContent ?? "";
      } else if (child.nodeType === 1) {
        value += visibleTextContent(child as Element);
      }
    }
    return value;
  };
  const accessibleTextContent = (
    element: Element,
    options: {
      allowHiddenRoot?: boolean;
      allowHiddenSubtree?: boolean;
      separateChildElements?: boolean;
    } = {}
  ): string => {
    const tag = element.tagName.toLowerCase();
    if (["noscript", "script", "style", "template"].includes(tag)) {
      return "";
    }
    if (
      !options.allowHiddenSubtree &&
      !options.allowHiddenRoot &&
      element.getAttribute("aria-hidden") === "true"
    ) {
      return "";
    }
    const style = pageDocument.defaultView?.getComputedStyle(element);
    if (
      !options.allowHiddenSubtree &&
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
    const parts: string[] = [];
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 3) {
        parts.push(child.textContent ?? "");
      } else if (child.nodeType === 1) {
        parts.push(
          accessibleTextContent(
            child as Element,
            {
              ...(options.allowHiddenSubtree
                ? { allowHiddenSubtree: true }
                : {}),
              ...(options.separateChildElements
                ? { separateChildElements: true }
                : {})
            }
          )
        );
      }
    }
    return parts.join(options.separateChildElements ? " " : "");
  };
  const implicitRole = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") {
      return element.hasAttribute("multiple") ? "listbox" : "combobox";
    }
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "reset", "submit"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (!["hidden", "image"].includes(type)) return "textbox";
    }
    return undefined;
  };
  const labelledText = (element: Element): string => {
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
  const associatedLabelText = (element: Element): string =>
    Array.from(pageDocument.querySelectorAll("label"))
      .filter((label) => {
        const labelFor = label.getAttribute("for");
        return (
          (labelFor !== null &&
            element.id !== "" &&
            labelFor === element.id) ||
          label.contains(element)
        );
      })
      .map((label) => accessibleTextContent(label))
      .join(" ");
  const explicitLabelName = (element: Element): string => {
    const candidate = [
      element.getAttribute("aria-label"),
      labelledText(element),
      associatedLabelText(element)
    ].find((value) => normalizedText(value ?? "") !== "");
    return normalizedText(candidate ?? "");
  };
  const simpleAccessibleName = (element: Element): string => {
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
  const segmentedAccessibleTextContent = (element: Element): string => {
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
    const parts: string[] = [];
    for (const child of Array.from(element.childNodes)) {
      const value =
        child.nodeType === 3
          ? child.textContent ?? ""
          : child.nodeType === 1
            ? segmentedAccessibleTextContent(child as Element)
            : "";
      if (normalizedText(value) !== "") parts.push(value);
    }
    return parts.join(" ");
  };
  const simpleAccessibleNameVariants = (element: Element): string[] => {
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
    if (authoredName) return [primary];
    return [
      ...new Set([
        primary,
        normalizedText(segmentedAccessibleTextContent(element))
      ])
    ];
  };
  let scopeTargetFailureCategory:
    | "target-missing"
    | "target-hidden"
    | "target-duplicate"
    | undefined;
  const resolveScopeTarget = (): Element | null => {
    const target = options.scopeTarget;
    if (!target) {
      return pageDocument.querySelector(options.scopeSelector ?? "body");
    }
    const candidates = Array.from(pageDocument.querySelectorAll("*"));
    const uniqueVisibleMatch = (matches: Element[]): Element | null => {
      const visibleMatches = matches.filter((element) => {
        const style = pageDocument.defaultView?.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          style !== undefined &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          Number.parseFloat(style.opacity || "1") !== 0 &&
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          rectangle.bottom > 0 &&
          rectangle.right > 0 &&
          rectangle.top < (pageDocument.defaultView?.innerHeight ?? 0) &&
          rectangle.left < (pageDocument.defaultView?.innerWidth ?? 0)
        );
      });
      if (visibleMatches.length === 1) return visibleMatches[0]!;
      scopeTargetFailureCategory =
        matches.length === 0
          ? "target-missing"
          : visibleMatches.length === 0
            ? "target-hidden"
            : "target-duplicate";
      return null;
    };
    if (target.strategy === "role") {
      return uniqueVisibleMatch(
        candidates.filter(
          (element) =>
            implicitRole(element) === target.role &&
            simpleAccessibleNameVariants(element).includes(
              normalizedText(target.name)
            )
        )
      );
    }
    if (target.strategy === "href") {
      return uniqueVisibleMatch(
        candidates.filter((element) => {
          if (
            element.tagName.toLowerCase() !== "a" ||
            !element.hasAttribute("href")
          ) {
            return false;
          }
          let path: string;
          try {
            const href = element.getAttribute("href") ?? "";
            path =
              href === target.path
                ? href
                : new URL(href, pageDocument.baseURI).pathname;
          } catch {
            return false;
          }
          return (
            path === target.path &&
            simpleAccessibleName(element) === normalizedText(target.name)
          );
        })
      );
    }
    if (target.strategy === "test-id") {
      return uniqueVisibleMatch(
        candidates.filter(
          (element) =>
            element.getAttribute("data-testid") === target.testId
        )
      );
    }
    if (target.strategy === "title") {
      return uniqueVisibleMatch(
        candidates.filter(
          (element) =>
            normalizedText(element.getAttribute("title") ?? "") ===
            normalizedText(target.name)
        )
      );
    }
    const targetName = normalizedText(target.name);
    if (target.strategy === "label") {
      return uniqueVisibleMatch(
        candidates.filter(
          (element) =>
            [
              "button",
              "input",
              "meter",
              "output",
              "progress",
              "select",
              "textarea"
            ].includes(element.tagName.toLowerCase()) &&
            explicitLabelName(element) === targetName
        )
      );
    }
    const textMatches = candidates.filter(
      (element) =>
        normalizedText(visibleTextContent(element)) === targetName
    );
    const smallestMatches = textMatches.filter(
      (element) =>
        !textMatches.some(
          (candidate) =>
            candidate !== element && element.contains(candidate)
        )
    );
    const semanticMatches = smallestMatches.map((element) => {
      if (implicitRole(element)) return element;
      let ancestor = element.parentElement;
      while (ancestor) {
        if (textMatches.includes(ancestor) && implicitRole(ancestor)) {
          return ancestor;
        }
        ancestor = ancestor.parentElement;
      }
      return element;
    });
    return uniqueVisibleMatch([...new Set(semanticMatches)]);
  };
  const scopeElement =
    providedOptions !== undefined
      ? (scopeOrOptions as Element)
      : resolveScopeTarget();
  const window = pageDocument.defaultView;
  if (!window || !pageDocument.body) {
    return {
      ok: false,
      blocker: {
        code: "UnsupportedSurface",
        category: "document-unavailable",
        stepIndex: options.stepIndex,
        sourceFingerprint: "0".repeat(64)
      }
    };
  }
  if (!scopeElement) {
    return {
      ok: false,
      blocker: {
        code: options.targetErrorCode,
        category: scopeTargetFailureCategory ?? "target-missing",
        stepIndex: options.stepIndex,
        sourceFingerprint: "0".repeat(64)
      }
    };
  }
  type CompleteSceneResult = Extract<
    SceneKernelResult,
    { ok: true; scanOnly: false }
  >;
  const transferOffset = Math.max(
    0,
    Math.trunc(options.transferOffset ?? 0)
  );
  const transferChunkSize = Math.max(
    1,
    // Keep each browser-evaluate response comfortably below embedded-browser
    // message limits. Large pages (especially those with local font data)
    // are reassembled from these deterministic chunks.
    Math.min(48_000, Math.trunc(options.transferChunkSize ?? 48_000))
  );

  const utf8Bytes = (value: string): number[] => {
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      let codePoint = value.charCodeAt(index);
      if (
        codePoint >= 0xd800 &&
        codePoint <= 0xdbff &&
        index + 1 < value.length
      ) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          codePoint =
            0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
          index += 1;
        }
      }
      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >>> 12),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >>> 18),
          0x80 | ((codePoint >>> 12) & 0x3f),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      }
    }
    return bytes;
  };
  const sha256Bytes = (inputBytes: number[]): string => {
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
      0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
      0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
      0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
      0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
      0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
      0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
      0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
      0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const words = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const bytes = [...inputBytes, 0x80];
    while (bytes.length % 64 !== 56) bytes.push(0);
    const bitLengthHigh = Math.floor(inputBytes.length / 0x20000000);
    const bitLengthLow = (inputBytes.length << 3) >>> 0;
    bytes.push(
      (bitLengthHigh >>> 24) & 0xff,
      (bitLengthHigh >>> 16) & 0xff,
      (bitLengthHigh >>> 8) & 0xff,
      bitLengthHigh & 0xff,
      (bitLengthLow >>> 24) & 0xff,
      (bitLengthLow >>> 16) & 0xff,
      (bitLengthLow >>> 8) & 0xff,
      bitLengthLow & 0xff
    );
    const rotateRight = (value: number, amount: number): number =>
      (value >>> amount) | (value << (32 - amount));
    for (let offset = 0; offset < bytes.length; offset += 64) {
      const schedule = new Array<number>(64).fill(0);
      for (let index = 0; index < 16; index += 1) {
        const cursor = offset + index * 4;
        schedule[index] =
          ((bytes[cursor]! << 24) |
            (bytes[cursor + 1]! << 16) |
            (bytes[cursor + 2]! << 8) |
            bytes[cursor + 3]!) >>>
          0;
      }
      for (let index = 16; index < 64; index += 1) {
        const previous = schedule[index - 15]!;
        const secondPrevious = schedule[index - 2]!;
        const sigma0 =
          rotateRight(previous, 7) ^
          rotateRight(previous, 18) ^
          (previous >>> 3);
        const sigma1 =
          rotateRight(secondPrevious, 17) ^
          rotateRight(secondPrevious, 19) ^
          (secondPrevious >>> 10);
        schedule[index] =
          (schedule[index - 16]! +
            sigma0 +
            schedule[index - 7]! +
            sigma1) >>>
          0;
      }
      let [a, b, c, d, e, f, g, h] = words;
      for (let index = 0; index < 64; index += 1) {
        const sum1 =
          rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
        const choice = (e! & f!) ^ (~e! & g!);
        const temporary1 =
          (h! + sum1 + choice + constants[index]! + schedule[index]!) >>> 0;
        const sum0 =
          rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
        const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
        const temporary2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d! + temporary1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temporary1 + temporary2) >>> 0;
      }
      words[0] = (words[0]! + a!) >>> 0;
      words[1] = (words[1]! + b!) >>> 0;
      words[2] = (words[2]! + c!) >>> 0;
      words[3] = (words[3]! + d!) >>> 0;
      words[4] = (words[4]! + e!) >>> 0;
      words[5] = (words[5]! + f!) >>> 0;
      words[6] = (words[6]! + g!) >>> 0;
      words[7] = (words[7]! + h!) >>> 0;
    }
    return words.map((value) => value.toString(16).padStart(8, "0")).join("");
  };
  const decodeBase64 = (value: string): number[] | null => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let payloadLength = value.length;
    while (payloadLength > 0 && value.charCodeAt(payloadLength - 1) === 61) {
      payloadLength -= 1;
    }
    const normalized = value.slice(0, payloadLength);
    const output: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const character of normalized) {
      const digit = alphabet.indexOf(character);
      if (digit < 0) return null;
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output.push((buffer >>> bits) & 0xff);
      }
    }
    return output;
  };

  const fingerprint = async (category: string): Promise<string> => {
    const input = [
      category,
      window.location.origin,
      window.location.pathname,
      String(options.stepIndex)
    ].join("|");
    return sha256Bytes(utf8Bytes(input));
  };
  const blocked = async (
    code: SceneKernelBlocker["code"],
    category: string
  ): Promise<SceneKernelResult> => ({
    ok: false,
    blocker: {
      code,
      category,
      stepIndex: options.stepIndex,
      sourceFingerprint: await fingerprint(category)
    }
  });

  const redactionRequest = options.sensitiveTextRedaction;
  if (
    redactionRequest !== undefined &&
    (redactionRequest.mode !== "text-only" ||
      redactionRequest.consent !== "confirmed" ||
      !Array.isArray(redactionRequest.selectors) ||
      redactionRequest.selectors.length > 20 ||
      redactionRequest.selectors.some(
        (selector) =>
          typeof selector !== "string" ||
          selector.trim() === "" ||
          selector.length > 500
      ))
  ) {
    return blocked("SensitiveDataDetected", "redaction-consent-required");
  }
  const textRedactionActive = redactionRequest !== undefined;
  const blockingSecretPatternSources =
    options.privateContentConsent === undefined
      ? options.secretPatternSources
      : options.secretPatternSources.filter(
          (source) => !source.includes("@")
        );
  const redactionRegions = new Set<Element>();
  for (const selector of redactionRequest?.selectors ?? []) {
    let matches: Element[];
    try {
      matches = Array.from(pageDocument.querySelectorAll(selector));
    } catch {
      return blocked("SensitiveDataDetected", "redaction-region-invalid");
    }
    if (matches.length === 0) {
      return blocked("SensitiveDataDetected", "redaction-region-missing");
    }
    for (const match of matches) redactionRegions.add(match);
  }
  const isInsideRedactionRegion = (element: Element | null): boolean => {
    let current = element;
    while (current) {
      if (
        [...redactionRegions].some(
          (region) => region === current || region.contains(current)
        )
      ) {
        return true;
      }
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const root = current.getRootNode() as ShadowRoot;
      current = root?.host ?? null;
    }
    return false;
  };
  const maskText = (value: string): string =>
    Array.from(value)
      .map((character) => (/\s/u.test(character) ? character : "•"))
      .join("");
  const paymentCardPatternSource = "\\b(?:\\d[ -]*?){13,19}\\b";
  const isPaymentCardNumber = (candidate: string): boolean => {
    const digits = candidate.replace(/\D/g, "");
    if (
      digits.length < 13 ||
      digits.length > 19 ||
      new Set(digits).size < 2
    ) {
      return false;
    }
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number.parseInt(digits[index] ?? "", 10);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  };
  const hasSensitivePatternMatch = (
    value: string,
    source: string
  ): boolean => {
    const expression = new RegExp(source, "gi");
    if (source !== paymentCardPatternSource) {
      return expression.test(value);
    }
    return [...value.matchAll(expression)].some((match) =>
      isPaymentCardNumber(match[0])
    );
  };
  const redactPatternMatches = (value: string): string => {
    let redacted = value;
    for (const source of options.secretPatternSources) {
      redacted = redacted.replace(
        new RegExp(source, "gi"),
        (match) =>
          source === paymentCardPatternSource &&
          !isPaymentCardNumber(match)
            ? match
            : maskText(match)
      );
    }
    return redacted;
  };
  const redactTextValue = (value: string, redactEntireValue: boolean): string =>
    textRedactionActive
      ? redactEntireValue
        ? maskText(value)
        : redactPatternMatches(value)
      : value;

  const lightDomElements = [
    pageDocument.body,
    ...Array.from(pageDocument.body.querySelectorAll("*"))
  ];
  const openShadowHosts: Element[] = [];
  const openShadowElements: Element[] = [];
  const collectOpenShadowElements = (elements: Element[]): void => {
    for (const element of elements) {
      if (!element.shadowRoot) continue;
      openShadowHosts.push(element);
      const descendants = Array.from(
        element.shadowRoot.querySelectorAll("*")
      );
      openShadowElements.push(...descendants);
      collectOpenShadowElements(descendants);
    }
  };
  collectOpenShadowElements(lightDomElements);
  const allElements = [...lightDomElements, ...openShadowElements];
  const capturedTextAttributeNames = new Set([
    "alt",
    "aria-description",
    "aria-label",
    "aria-placeholder",
    "placeholder",
    "title"
  ]);
  const computedStyleCache = new Map<Element, CSSStyleDeclaration>();
  const rectangleCache = new Map<Element, DOMRect>();
  const computedFor = (element: Element): CSSStyleDeclaration => {
    const cached = computedStyleCache.get(element);
    if (cached) return cached;
    const computed = window.getComputedStyle(element);
    computedStyleCache.set(element, computed);
    return computed;
  };
  const rectangleFor = (element: Element): DOMRect => {
    const cached = rectangleCache.get(element);
    if (cached) return cached;
    const rectangle = element.getBoundingClientRect();
    rectangleCache.set(element, rectangle);
    return rectangle;
  };
  const renderedCanvasSource = (element: Element): string => {
    const rectangle = rectangleFor(element);
    const canvas = element as HTMLCanvasElement;
    return [
      "showkit:rendered-canvas",
      rectangle.left.toFixed(2),
      rectangle.top.toFixed(2),
      rectangle.width.toFixed(2),
      rectangle.height.toFixed(2),
      String(canvas.width),
      String(canvas.height)
    ].join(":");
  };
  const renderedCanvasReplacementFor = (
    element: Element
  ):
    | NonNullable<
        SceneKernelOptions["remoteAssetReplacements"]
      >[number]
    | undefined => {
    if (element.tagName.toLowerCase() !== "canvas") return undefined;
    const rectangle = rectangleFor(element);
    const computed = computedFor(element);
    const canvas = element as HTMLCanvasElement;
    return options.remoteAssetReplacements?.find((replacement) => {
      const match = replacement.match;
      return (
        replacement.captureKind === "isolated-rendered-canvas" &&
        replacement.source === renderedCanvasSource(element) &&
        match?.canvasElement === true &&
        Math.abs(match.dimensions.width - rectangle.width) < 0.5 &&
        Math.abs(match.dimensions.height - rectangle.height) < 0.5 &&
        match.intrinsicDimensions?.width === canvas.width &&
        match.intrinsicDimensions.height === canvas.height &&
        match.opacity === computed.opacity
      );
    });
  };
  const unsupportedSurfaceTags = new Set([
    "audio",
    "canvas",
    "embed",
    "iframe",
    "object",
    "video"
  ]);
  const interactiveShadowTags = new Set([
    "a",
    "button",
    "details",
    "form",
    "input",
    "select",
    "summary",
    "textarea"
  ]);
  const interactiveShadowRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "dialog",
    "link",
    "listbox",
    "menu",
    "menuitem",
    "option",
    "radio",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "tree",
    "treeitem"
  ]);
  const safeShadowTextTags = new Set([
    "b",
    "em",
    "i",
    "small",
    "span",
    "strong",
    "time"
  ]);
  const visibleOpenShadowElements = (element: Element): Element[] =>
    element.shadowRoot
      ? Array.from(element.shadowRoot.querySelectorAll("*")).filter(
          isVisualSurface
        )
      : [];
  const isSafeTextOpenShadowRoot = (element: Element): boolean => {
    if (!element.shadowRoot) return false;
    const visibleElements = visibleOpenShadowElements(element);
    if (visibleElements.length === 0) return true;
    if (
      Array.from(element.shadowRoot.querySelectorAll("slot")).length > 0 ||
      visibleElements.some((descendant) => {
        const tag = descendant.tagName.toLowerCase();
        const role = descendant.getAttribute("role")?.toLowerCase() ?? "";
        return (
          !safeShadowTextTags.has(tag) ||
          tag.includes("-") ||
          interactiveShadowTags.has(tag) ||
          interactiveShadowRoles.has(role) ||
          descendant.attributes.getNamedItem("contenteditable") !== null
        );
      })
    ) {
      return false;
    }
    return visibleElements.some(
      (descendant) => (descendant.textContent ?? "").trim() !== ""
    );
  };
  const hasRenderableLightDom = (element: Element): boolean =>
    Array.from(element.childNodes).some(
      (child) =>
        child.nodeType === 1 ||
        (child.nodeType === 3 && (child.textContent ?? "").trim() !== "")
    );
  const isSafeTransparentCustomElement = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (!tag.includes("-")) return false;
    if (element.shadowRoot) return isSafeTextOpenShadowRoot(element);
    return hasRenderableLightDom(element);
  };
  const isUnsupportedElement = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    return (
      (unsupportedSurfaceTags.has(tag) &&
        !(tag === "canvas" && renderedCanvasReplacementFor(element))) ||
      (tag.includes("-") && !isSafeTransparentCustomElement(element))
    );
  };
  const isVisualSurface = (element: Element): boolean => {
    const computed = computedFor(element);
    if (
      computed.display === "none" ||
      computed.visibility === "hidden" ||
      computed.visibility === "collapse" ||
      Number.parseFloat(computed.opacity || "1") === 0
    ) {
      return false;
    }
    const rectangle = rectangleFor(element);
    if (rectangle.width <= 0 || rectangle.height <= 0) return false;
    return (
      rectangle.bottom > 0 &&
      rectangle.right > 0 &&
      rectangle.top < window.innerHeight &&
      rectangle.left < window.innerWidth
    );
  };
  const nonVisualUnsupportedElements = allElements.filter(
    (element) => isUnsupportedElement(element) && !isVisualSurface(element)
  );
  const unsupportedShadowHost = openShadowHosts.find(
    (element) =>
      isVisualSurface(element) && !isSafeTextOpenShadowRoot(element)
  );
  if (unsupportedShadowHost) {
    return blocked("UnsupportedSurface", "shadow-root");
  }
  const unsupportedElement = allElements.find(
    (element) => isUnsupportedElement(element) && isVisualSurface(element)
  );
  if (unsupportedElement) {
    return blocked("UnsupportedSurface", unsupportedElement.tagName.toLowerCase());
  }

  const imageBearingCss = (value: string): boolean =>
    /\burl\s*\(|\b(?:-webkit-)?image-set\s*\(/i.test(value);
  const fullSceneRaster = allElements.find((element) => {
    const tag = element.tagName.toLowerCase();
    const computed = computedFor(element);
    const imageSurface =
      tag === "img" ||
      (element.namespaceURI === "http://www.w3.org/2000/svg" &&
        tag === "image") ||
      [
        computed.getPropertyValue("background-image"),
        computed.getPropertyValue("list-style-image"),
        computed.getPropertyValue("mask-image"),
        computed.getPropertyValue("-webkit-mask-image")
      ].some(imageBearingCss);
    if (!imageSurface || !isVisualSurface(element)) return false;
    const rectangle = rectangleFor(element);
    const visibleWidth =
      Math.min(rectangle.right, window.innerWidth) -
      Math.max(rectangle.left, 0);
    const visibleHeight =
      Math.min(rectangle.bottom, window.innerHeight) -
      Math.max(rectangle.top, 0);
    return (
      rectangle.width >= window.innerWidth * 0.8 &&
      rectangle.height >= window.innerHeight * 0.8 &&
      visibleWidth >= window.innerWidth * 0.8 &&
      visibleHeight >= window.innerHeight * 0.8
    );
  });
  if (fullSceneRaster) {
    return blocked("UnsupportedSurface", "full-scene-raster");
  }

  for (const selector of options.sensitiveSelectors) {
    try {
      if (selector && pageDocument.querySelector(selector)) {
        return blocked("SensitiveDataDetected", "configured-selector");
      }
    } catch {
      return blocked("SensitiveDataDetected", "configured-selector-invalid");
    }
  }
  if (
    allElements.some((element) =>
      element.matches('input[type="password"]')
    )
  ) {
    return blocked("SensitiveDataDetected", "sensitive-input");
  }
  if (
    !textRedactionActive &&
    options.privateContentConsent === undefined &&
    allElements.some((element) => element.matches('input[type="hidden"]'))
  ) {
    return blocked("SensitiveDataDetected", "sensitive-input");
  }

  if (!textRedactionActive && options.scanOnly) {
    const candidateText = [
      pageDocument.title,
      pageDocument.body.innerText,
      ...openShadowHosts.flatMap((host) =>
        visibleOpenShadowElements(host)
          .filter(
            (element) =>
              !Array.from(element.children).some(isVisualSurface)
          )
          .map(
            (element) =>
              (element as HTMLElement).innerText ||
              element.textContent ||
              ""
          )
      ),
      ...allElements.flatMap((element) =>
        Array.from(element.attributes)
          .filter((attribute) =>
            capturedTextAttributeNames.has(attribute.name)
          )
          .map((attribute) => attribute.value)
      )
    ].join("\n");
    if (
      blockingSecretPatternSources.some((source) =>
        hasSensitivePatternMatch(candidateText, source)
      )
    ) {
      return blocked("SensitiveDataDetected", "configured-pattern");
    }
  }

  const targetElement = options.targetPresent ? scopeElement : null;
  if (targetElement) {
    const rectangle = rectangleFor(targetElement);
    const style = computedFor(targetElement);
    if (
      !pageDocument.body.contains(targetElement) ||
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      style.display === "none" ||
      style.visibility === "hidden"
    ) {
      return blocked(options.targetErrorCode, "target-not-visible");
    }
  }
  const targetMarker = targetElement
    ? {
        tag: targetElement.tagName,
        role: implicitRole(targetElement),
        accessibleName: simpleAccessibleName(targetElement),
        ariaLabel: targetElement.getAttribute("aria-label"),
        title: targetElement.getAttribute("title"),
        rectangle: rectangleFor(targetElement)
      }
    : undefined;
  const isTargetSource = (element: Element): boolean => {
    if (element === targetElement) return true;
    if (!targetMarker || element.tagName !== targetMarker.tag) return false;
    if (
      implicitRole(element) !== targetMarker.role ||
      simpleAccessibleName(element) !== targetMarker.accessibleName ||
      element.getAttribute("aria-label") !== targetMarker.ariaLabel ||
      element.getAttribute("title") !== targetMarker.title
    ) {
      return false;
    }
    const rectangle = rectangleFor(element);
    return (
      Math.abs(rectangle.x - targetMarker.rectangle.x) < 0.5 &&
      Math.abs(rectangle.y - targetMarker.rectangle.y) < 0.5 &&
      Math.abs(rectangle.width - targetMarker.rectangle.width) < 0.5 &&
      Math.abs(rectangle.height - targetMarker.rectangle.height) < 0.5
    );
  };

  const remoteAssetReplacements = new Map<
    string,
    NonNullable<SceneKernelOptions["remoteAssetReplacements"]>
  >();
  for (const replacement of options.remoteAssetReplacements ?? []) {
    const existing = remoteAssetReplacements.get(replacement.source) ?? [];
    existing.push(replacement);
    remoteAssetReplacements.set(replacement.source, existing);
  }
  const transparentColor = (value: string): boolean =>
    value === "transparent" ||
    value === "rgba(0, 0, 0, 0)" ||
    value === "rgba(0,0,0,0)";
  const transparentBackgroundImage = (value: string): boolean =>
    value === "none" ||
    /^-(?:webkit-)?linear-gradient\(top, rgba\(0, 0, 0, 0\), rgba\(0, 0, 0, 0\)\)$/i.test(
      value
    );
  const effectiveBackdropColor = (
    element: Element,
    includeSelf = false
  ): string | undefined => {
    let current = includeSelf ? element : element.parentElement;
    while (current) {
      const style = computedFor(current);
      if (!transparentBackgroundImage(style.backgroundImage)) {
        return undefined;
      }
      if (!transparentColor(style.backgroundColor)) {
        return style.backgroundColor;
      }
      current = current.parentElement;
    }
    return "rgba(0, 0, 0, 0)";
  };
  const matchesRenderedReplacement = (
    replacement: NonNullable<
      SceneKernelOptions["remoteAssetReplacements"]
    >[number],
    element: Element,
    computed: CSSStyleDeclaration,
    pseudo?: "before"
  ): boolean => {
    if (!replacement.captureKind || !replacement.match) {
      return !replacement.captureKind;
    }
    const rectangle = rectangleFor(element);
    const dimensions = replacement.match.dimensions;
    const renderedWidth =
      pseudo === "before"
        ? Number.parseFloat(computed.width || "0")
        : rectangle.width;
    const renderedHeight =
      pseudo === "before"
        ? Number.parseFloat(computed.height || "0")
        : rectangle.height;
    return (
      replacement.captureKind === "isolated-rendered-icon" &&
      replacement.match.pseudo === pseudo &&
      Math.abs(renderedWidth - dimensions.width) < 0.5 &&
      Math.abs(renderedHeight - dimensions.height) < 0.5 &&
      computed.backgroundPosition ===
        replacement.match.backgroundPosition &&
      computed.backgroundRepeat === replacement.match.backgroundRepeat &&
      computed.backgroundSize === replacement.match.backgroundSize &&
      computed.opacity === replacement.match.opacity &&
      effectiveBackdropColor(element, pseudo === "before") ===
        replacement.match.backdropColor
    );
  };
  const replacementFor = (
    source: string,
    element: Element,
    computed = computedFor(element),
    pseudo?: "before"
  ):
    | NonNullable<
        SceneKernelOptions["remoteAssetReplacements"]
      >[number]
    | undefined => {
    const replacements = remoteAssetReplacements.get(source) ?? [];
    return (
      replacements.find(
        (replacement) => !replacement.captureKind
      ) ??
      replacements.find((replacement) =>
        matchesRenderedReplacement(
          replacement,
          element,
          computed,
          pseudo
        )
      )
    );
  };
  type SanitizedElementNode = Extract<
    SanitizedNode,
    { type: "element" }
  >;
  const assetPayloads = new Map<string, AssetPayload>();
  const nodeRectangles = new Map<
    SanitizedElementNode,
    { x: number; y: number; width: number; height: number }
  >();
  const nodeContainingBlockOrigins = new Map<
    SanitizedElementNode,
    { x: number; y: number }
  >();
  const nodeSourceElements = new Map<
    SanitizedElementNode,
    Element
  >();
  const sourceSanitizedElements = new Map<
    Element,
    SanitizedElementNode
  >();
  let serializationBlocker:
    | {
        code: SceneKernelBlocker["code"];
        category: string;
      }
    | undefined;
  const supportedDataImagePattern =
    /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
  const normalizeDataImageSource = (source: string): string => {
    if (!source.startsWith("data:") || !source.includes("%")) {
      return source;
    }
    return source.replace(
      /%([0-9a-fA-F]{2})/g,
      (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
  };
  const hasOnlyEmptyUrlSources = (value: string): boolean => {
    const pattern = /url\s*\(\s*["']?([^"')]*)["']?\s*\)/gi;
    let match: RegExpExecArray | null;
    let matched = false;
    while ((match = pattern.exec(value)) !== null) {
      matched = true;
      if ((match[1] ?? "").trim() !== "") return false;
    }
    return matched;
  };
  const styleAssetSources = (value: string): string[] => {
    const sources: string[] = [];
    const pattern = /url\s*\(\s*["']?([^"')]*)["']?\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      if (raw.startsWith("data:")) {
        sources.push(raw);
        continue;
      }
      if (raw.startsWith("#")) {
        sources.push(raw);
        continue;
      }
      try {
        sources.push(new URL(raw, pageDocument.baseURI).href);
      } catch {
        sources.push(raw);
      }
    }
    return sources;
  };
  const isSafeDocumentFragmentSource = (source: string): boolean =>
    /^#[A-Za-z_][\w:.-]*$/.test(source) &&
    pageDocument.getElementById(source.slice(1)) !== null;
  const isResolvedAssetSource = (source: string): boolean =>
    isSafeDocumentFragmentSource(source) ||
    supportedDataImagePattern.test(normalizeDataImageSource(source)) ||
    remoteAssetReplacements.has(source);
  const imageSourceFor = (element: Element): string => {
    if (element.tagName === "IMG") {
      const image = element as HTMLImageElement;
      return image.currentSrc || image.src;
    }
    if (
      element.namespaceURI === "http://www.w3.org/2000/svg" &&
      element.tagName.toLowerCase() === "image"
    ) {
      const raw =
        element.getAttribute("href") ??
        element.getAttribute("src") ??
        "";
      if (raw.startsWith("data:")) return raw;
      try {
        return raw ? new URL(raw, pageDocument.baseURI).href : "";
      } catch {
        return raw;
      }
    }
    return "";
  };
  const remoteElements = new Set<Element>();
  const hasInteractiveAssetSemantics = (element: Element): boolean =>
    element.closest(
      [
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
      ].join(",")
    ) !== null;
  const isVisibleRemoteAsset = (element: Element): boolean => {
    const rectangle = rectangleFor(element);
    const computed = computedFor(element);
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
  const isCriticalRemoteAsset = (element: Element): boolean =>
    options.remoteAssetPolicy === "strict" ||
    element.hasAttribute("data-showkit-critical-asset") ||
    element === targetElement ||
    (targetElement !== null &&
      (targetElement.contains(element) || element.contains(targetElement))) ||
    (hasInteractiveAssetSemantics(element) &&
      isVisibleRemoteAsset(element));
  const assetScanElements = options.scanOnly ? allElements : [];
  for (const element of assetScanElements) {
    const imageSource = imageSourceFor(element);
    const imageRemote =
      imageSource !== "" &&
      !isResolvedAssetSource(imageSource);
    const computed = computedFor(element);
    const styleRemote = [
      computed.getPropertyValue("background-image"),
      computed.getPropertyValue("border-image-source"),
      computed.getPropertyValue("content"),
      computed.getPropertyValue("cursor"),
      computed.getPropertyValue("list-style-image"),
      computed.getPropertyValue("mask-image"),
      computed.getPropertyValue("-webkit-mask-image")
    ].some((value) => {
      if (!/url\s*\(/i.test(value)) return false;
      if (hasOnlyEmptyUrlSources(value)) return false;
      const sources = styleAssetSources(value);
      return (
        sources.length === 0 ||
        sources.some((source) => !isResolvedAssetSource(source))
      );
    });
    if (imageRemote || styleRemote) {
      remoteElements.add(element);
    }
  }
  if (remoteElements.size > 0) {
    const criticalRemote = [...remoteElements].find(isCriticalRemoteAsset);
    if (criticalRemote) {
      return blocked("UnsupportedSurface", "remote-asset");
    }
  }

  const safeTransparentCustomElements = allElements.filter(
    (element) =>
      element.tagName.toLowerCase().includes("-") &&
      !element.shadowRoot &&
      isSafeTransparentCustomElement(element) &&
      isVisualSurface(element)
  );
  const safeTextShadowHosts = openShadowHosts.filter(
    (element) =>
      isVisualSurface(element) && isSafeTextOpenShadowRoot(element)
  );
  const buildExcludedSurfaces = (): string[] => [
      "scripts",
      "inline-handlers",
      "forms",
      "browser-storage",
      "network-data",
      ...(textRedactionActive
        ? ["sensitive-text-redacted", "hidden-inputs"]
        : []),
      ...(nonVisualUnsupportedElements.length > 0
        ? ["nonvisual-unsupported-surfaces"]
        : []),
      ...(safeTransparentCustomElements.length > 0
        ? ["transparent-custom-elements"]
        : []),
      ...(safeTextShadowHosts.length > 0
        ? ["text-only-open-shadow-roots"]
        : []),
      ...(remoteElements.size > 0
        ? ["remote-decorative-assets"]
        : remoteAssetReplacements.size > 0
          ? ["remote-assets-localized"]
          : ["remote-assets"])
    ];
  if (options.scanOnly) {
    return {
      ok: true,
      scanOnly: true,
      excludedSurfaces: buildExcludedSurfaces()
    };
  }

  const allowedTags = new Set([
    "a",
    "article",
    "aside",
    "b",
    "blockquote",
    "button",
    "circle",
    "clippath",
    "code",
    "dd",
    "defs",
    "details",
    "div",
    "dl",
    "dt",
    "ellipse",
    "em",
    "figcaption",
    "figure",
    "footer",
    "g",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "img",
    "image",
    "input",
    "kbd",
    "label",
    "li",
    "line",
    "main",
    "mark",
    "nav",
    "ol",
    "option",
    "p",
    "path",
    "polygon",
    "polyline",
    "pre",
    "rect",
    "s",
    "section",
    "select",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "svg",
    "symbol",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "textarea",
    "u",
    "ul",
    "use"
  ]);
  const droppedTags = new Set([
    "base",
    "canvas",
    "embed",
    "iframe",
    "link",
    "meta",
    "noscript",
    "object",
    "script",
    "style",
    "template"
  ]);
  const blockTags = new Set([
    "address",
    "article",
    "aside",
    "div",
    "footer",
    "form",
    "header",
    "main",
    "nav",
    "section"
  ]);
  const styleProperties = [
    "appearance",
    "align-content",
    "align-items",
    "align-self",
    "background-color",
    "background-image",
    "background-position",
    "background-repeat",
    "background-size",
    "border-image-source",
    "border-bottom",
    "border-left",
    "border-radius",
    "border-right",
    "border-top",
    "bottom",
    "box-shadow",
    "box-sizing",
    "clip-path",
    "color",
    "display",
    "fill",
    "fill-opacity",
    "fill-rule",
    "filter",
    "flex-basis",
    "flex-direction",
    "flex-grow",
    "flex-shrink",
    "flex-wrap",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "gap",
    "grid-auto-columns",
    "grid-auto-flow",
    "grid-auto-rows",
    "grid-column-end",
    "grid-column-start",
    "grid-row-end",
    "grid-row-start",
    "grid-template-areas",
    "grid-template-columns",
    "grid-template-rows",
    "height",
    "justify-content",
    "justify-items",
    "justify-self",
    "letter-spacing",
    "left",
    "line-height",
    "list-style",
    "list-style-image",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "max-height",
    "max-width",
    "min-height",
    "min-width",
    "mask-image",
    "mask-position",
    "mask-repeat",
    "mask-size",
    "object-fit",
    "opacity",
    "order",
    "overflow",
    "overflow-x",
    "overflow-y",
    "overflow-wrap",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "position",
    "right",
    "stroke",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "stroke-width",
    "text-align",
    "text-decoration",
    "text-overflow",
    "text-transform",
    "top",
    "transform",
    "transform-origin",
    "vertical-align",
    "white-space",
    "width",
    "word-break",
    "-webkit-appearance",
    "-webkit-mask-image",
    "-webkit-mask-position",
    "-webkit-mask-repeat",
    "-webkit-mask-size",
    "z-index"
  ];
  let redactedTextNodeCount = 0;
  let redactedAttributeCount = 0;
  const inheritedStyleProperties = new Set([
    "color",
    "fill",
    "fill-opacity",
    "fill-rule",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "letter-spacing",
    "line-height",
    "stroke",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "stroke-width",
    "text-align",
    "text-transform",
    "white-space",
    "word-break"
  ]);
  const zeroDefaultPrefixes = [
    "margin-",
    "padding-"
  ];
  const exactDefaultStyles = new Map<string, string>([
    ["appearance", "auto"],
    ["align-content", "normal"],
    ["align-items", "normal"],
    ["align-self", "auto"],
    ["background-color", "rgba(0, 0, 0, 0)"],
    ["background-image", "none"],
    ["background-position", "0% 0%"],
    ["background-repeat", "repeat"],
    ["background-size", "auto"],
    ["border-image-source", "none"],
    ["bottom", "auto"],
    ["box-shadow", "none"],
    ["box-sizing", "content-box"],
    ["clip-path", "none"],
    ["flex-basis", "auto"],
    ["flex-direction", "row"],
    ["flex-grow", "0"],
    ["flex-shrink", "1"],
    ["flex-wrap", "nowrap"],
    ["filter", "none"],
    ["gap", "normal"],
    ["grid-auto-columns", "auto"],
    ["grid-auto-flow", "row"],
    ["grid-auto-rows", "auto"],
    ["grid-column-end", "auto"],
    ["grid-column-start", "auto"],
    ["grid-row-end", "auto"],
    ["grid-row-start", "auto"],
    ["grid-template-areas", "none"],
    ["grid-template-columns", "none"],
    ["grid-template-rows", "none"],
    ["justify-content", "normal"],
    ["justify-items", "normal"],
    ["justify-self", "auto"],
    ["left", "auto"],
    ["list-style-image", "none"],
    ["mask-image", "none"],
    ["mask-position", "0% 0%"],
    ["mask-repeat", "repeat"],
    ["mask-size", "auto"],
    ["max-height", "none"],
    ["max-width", "none"],
    ["object-fit", "fill"],
    ["opacity", "1"],
    ["order", "0"],
    ["overflow", "visible"],
    ["overflow-x", "visible"],
    ["overflow-y", "visible"],
    ["overflow-wrap", "normal"],
    ["position", "static"],
    ["right", "auto"],
    ["text-decoration", "none"],
    ["text-overflow", "clip"],
    ["top", "auto"],
    ["transform", "none"],
    ["vertical-align", "baseline"],
    ["-webkit-appearance", "auto"],
    ["-webkit-mask-image", "none"],
    ["-webkit-mask-position", "0% 0%"],
    ["-webkit-mask-repeat", "repeat"],
    ["-webkit-mask-size", "auto"],
    ["z-index", "auto"]
  ]);

  const localizeDataImage = (source: string): AssetPayload | undefined => {
    const match = normalizeDataImageSource(source).match(
      supportedDataImagePattern
    );
    if (!match?.[1] || !match[2]) return undefined;
    const binary = decodeBase64(match[2]);
    if (!binary || binary.length === 0) return undefined;
    if (binary.length > 1_048_576) {
      serializationBlocker = {
        code: "CaptureTooLarge",
        category: "single-asset-limit"
      };
      return undefined;
    }
    const hash = sha256Bytes(binary);
    const payload = {
      sha256: hash,
      mimeType: match[1] as AssetPayload["mimeType"],
      byteLength: binary.length,
      base64: match[2]
    };
    assetPayloads.set(hash, payload);
    return payload;
  };
  const persistBundledAsset = (
    payload: Omit<AssetPayload, "base64"> & { base64?: string }
  ): void => {
    if (typeof payload.base64 !== "string" || payload.base64 === "") return;
    assetPayloads.set(payload.sha256, payload as AssetPayload);
  };
  const localAssetPath = (
    payload: Omit<AssetPayload, "base64">
  ): string => {
    const extension = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/avif": "avif",
      "image/gif": "gif",
      "image/svg+xml": "svg",
      "font/woff2": "woff2"
    }[payload.mimeType];
    return `./assets/${payload.sha256}.${extension}`;
  };
  const markUnresolvedRemoteAsset = (source: Element): void => {
    remoteElements.add(source);
    if (isCriticalRemoteAsset(source)) {
      serializationBlocker = {
        code: "UnsupportedSurface",
        category: "remote-asset"
      };
    }
  };
  const localizeStyleAssets = (
    value: string,
    source: Element,
    computed: CSSStyleDeclaration,
    pseudo?: "before"
  ): string | undefined => {
    if (!/url\s*\(/i.test(value)) return value;
    if (hasOnlyEmptyUrlSources(value)) return undefined;
    let unresolved = false;
    const localized = value.replace(
      /url\s*\(\s*["']?([^"')]*)["']?\s*\)/gi,
      (_match, rawValue: string) => {
        const raw = rawValue.trim();
        let payload:
          | (Omit<AssetPayload, "base64"> & { base64?: string })
          | undefined;
        if (isSafeDocumentFragmentSource(raw)) {
          return `url("${raw}")`;
        } else if (raw.startsWith("data:")) {
          payload = localizeDataImage(raw);
        } else {
          try {
            payload = replacementFor(
              new URL(raw, pageDocument.baseURI).href,
              source,
              computed,
              pseudo
            )?.payload;
          } catch {
            payload = undefined;
          }
        }
        if (!payload) {
          unresolved = true;
          markUnresolvedRemoteAsset(source);
          return "";
        }
        persistBundledAsset(payload);
        return `url("${localAssetPath(payload)}")`;
      }
    );
    return unresolved ? undefined : localized;
  };
  const readStyleDeclaration = (
    source: Element,
    computed: CSSStyleDeclaration,
    parentComputed?: CSSStyleDeclaration,
    pseudo?: "before"
  ): Record<string, string> => {
    const styles: Record<string, string> = {};
    const preserveControlReset =
      pseudo === undefined &&
      ["button", "input", "select", "textarea"].includes(
        source.tagName.toLowerCase()
      );
    for (const property of styleProperties) {
      const value = computed.getPropertyValue(property).trim();
      if (value === "" || /@import|expression\s*\(/i.test(value)) continue;
      if (
        options.nodeMode !== "flat" &&
        options.nodeMode !== "json" &&
        inheritedStyleProperties.has(property) &&
        parentComputed?.getPropertyValue(property).trim() === value
      ) {
        continue;
      }
      if (
        (!preserveControlReset &&
          exactDefaultStyles.get(property) === value) ||
        (!preserveControlReset &&
          zeroDefaultPrefixes.some((prefix) => property.startsWith(prefix)) &&
          value === "0px") ||
        (!preserveControlReset &&
          property.startsWith("border-") &&
          /^0px\s+none\b/i.test(value))
      ) {
        continue;
      }
      if (
        property === "transform-origin" &&
        computed.getPropertyValue("transform").trim() === "none"
      ) {
        continue;
      }
      const localized = localizeStyleAssets(
        value,
        source,
        computed,
        pseudo
      );
      if (localized !== undefined && localized !== "") {
        styles[property] = localized;
      }
    }
    const renderedBackgroundReplacement = styleAssetSources(
      computed.getPropertyValue("background-image")
    )
      .map((assetSource) =>
        replacementFor(assetSource, source, computed, pseudo)
      )
      .find(
        (replacement) =>
          replacement?.captureKind === "isolated-rendered-icon"
      );
    if (renderedBackgroundReplacement) {
      styles["background-position"] = "0px 0px";
      styles["background-repeat"] = "no-repeat";
      styles["background-size"] = "100% 100%";
      styles.opacity = "1";
    }
    return styles;
  };
  const readStyles = (source: Element): Record<string, string> =>
    readStyleDeclaration(
      source,
      computedFor(source),
      source !== pageDocument.body && source.parentElement
        ? computedFor(source.parentElement)
        : undefined
    );
  const pseudoText = (content: string): string => {
    const trimmed = content.trim();
    if (
      trimmed === "" ||
      trimmed === "none" ||
      trimmed === "normal"
    ) {
      return "";
    }
    let visualContent = trimmed;
    let quote = "";
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "/") {
        visualContent = trimmed.slice(0, index).trim();
        break;
      }
    }
    const literals: string[] = [];
    let cursor = 0;
    while (cursor < visualContent.length) {
      while (/\s/.test(visualContent[cursor] ?? "")) cursor += 1;
      if (cursor >= visualContent.length) break;
      const literalQuote = visualContent[cursor];
      if (literalQuote !== '"' && literalQuote !== "'") return "";
      cursor += 1;
      let literal = "";
      let closed = false;
      while (cursor < visualContent.length) {
        const character = visualContent[cursor] ?? "";
        if (character === "\\") {
          literal += character;
          cursor += 1;
          if (cursor < visualContent.length) {
            literal += visualContent[cursor] ?? "";
            cursor += 1;
          }
          continue;
        }
        cursor += 1;
        if (character === literalQuote) {
          closed = true;
          break;
        }
        literal += character;
      }
      if (!closed) return "";
      literals.push(literal);
    }
    const decoded = literals
      .map((literal) =>
        literal
          .replace(
            /\\([0-9a-fA-F]{1,6})(?:\s)?/g,
            (_match, hex: string) => {
              const codePoint = Number.parseInt(hex, 16);
              return Number.isFinite(codePoint) &&
                codePoint > 0 &&
                codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : "";
            }
          )
          .replace(/\\(["'\\])/g, "$1")
      )
      .join("")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .slice(0, 200);
    return decoded.trim() === "" ? "" : decoded;
  };
  const pseudoNode = (
    source: Element,
    pseudo: "::before" | "::after"
  ): SanitizedElementNode | null => {
    const computed = window.getComputedStyle(source, pseudo);
    const text = pseudoText(computed.content);
    const hasAsset =
      computed.backgroundImage !== "none" ||
      computed.maskImage !== "none" ||
      computed.getPropertyValue("-webkit-mask-image").trim() !== "none";
    const hasSize =
      Number.parseFloat(computed.width || "0") > 0 &&
      Number.parseFloat(computed.height || "0") > 0;
    const sourceComputed = computedFor(source);
    const parentComputed = source.parentElement
      ? computedFor(source.parentElement)
      : undefined;
    const parentDisplay = parentComputed?.display ?? "";
    const pseudoWidth = Number.parseFloat(computed.width || "0");
    const pseudoHeight = Number.parseFloat(computed.height || "0");
    const pseudoImageSurface = [
      computed.getPropertyValue("background-image"),
      computed.getPropertyValue("list-style-image"),
      computed.getPropertyValue("mask-image"),
      computed.getPropertyValue("-webkit-mask-image")
    ].some(imageBearingCss);
    if (
      pseudoImageSurface &&
      pseudoWidth >= window.innerWidth * 0.8 &&
      pseudoHeight >= window.innerHeight * 0.8
    ) {
      serializationBlocker ??= {
        code: "UnsupportedSurface",
        category: "full-scene-raster"
      };
      return null;
    }
    const contributesThroughDisplayContents =
      sourceComputed.display === "contents" &&
      (parentDisplay === "grid" ||
        parentDisplay === "inline-grid" ||
        parentDisplay === "flex" ||
        parentDisplay === "inline-flex") &&
      (parentDisplay.includes("grid")
        ? pseudoWidth > 0 || pseudoHeight > 0
        : (parentComputed?.flexDirection ?? "row").startsWith("row")
          ? pseudoWidth > 0
          : pseudoHeight > 0);
    if (
      computed.display === "none" ||
      computed.visibility === "hidden" ||
      computed.visibility === "collapse" ||
      Number.parseFloat(computed.opacity || "1") === 0 ||
      (!text && !hasAsset && !hasSize && !contributesThroughDisplayContents)
    ) {
      return null;
    }
    const styles = readStyleDeclaration(
      source,
      computed,
      computedFor(source),
      pseudo === "::before" ? "before" : undefined
    );
    if (serializationBlocker) return null;
    return {
      type: "element",
      tag: "span",
      attributes: {
        "aria-hidden": "true",
        "data-showkit-pseudo": pseudo === "::before" ? "before" : "after"
      },
      styles,
      children: text ? [{ type: "text", text }] : []
    };
  };
  const readAttributes = (source: Element): Record<string, string> => {
    const attributes: Record<string, string> = {};
    const redactEntireValue = isInsideRedactionRegion(source);
    const svgAttributeNames = new Set([
      "clip-path",
      "clip-rule",
      "clipPathUnits",
      "cx",
      "cy",
      "d",
      "fill",
      "fill-opacity",
      "fill-rule",
      "focusable",
      "height",
      "id",
      "opacity",
      "points",
      "preserveAspectRatio",
      "r",
      "rx",
      "ry",
      "stroke",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-opacity",
      "stroke-width",
      "transform",
      "viewBox",
      "width",
      "x",
      "x1",
      "x2",
      "y",
      "y1",
      "y2"
    ]);
    const svgElement =
      source.namespaceURI === "http://www.w3.org/2000/svg";
    const svgTag = svgElement ? source.tagName.toLowerCase() : "";
    for (const attribute of Array.from(source.attributes)) {
      const fragmentReference = attribute.value
        .match(/^url\(\s*["']?(#[A-Za-z_][\w:.-]*)["']?\s*\)$/)?.[1];
      const safeSvgFragmentReference =
        svgElement &&
        attribute.name === "clip-path" &&
        fragmentReference !== undefined &&
        isSafeDocumentFragmentSource(fragmentReference);
      const safeSvgUseReference =
        svgTag === "use" &&
        (attribute.name === "href" ||
          attribute.name.toLowerCase() === "xlink:href") &&
        isSafeDocumentFragmentSource(attribute.value);
      if (
        attribute.name === "role" ||
        attribute.name === "title" ||
        attribute.name === "lang" ||
        attribute.name === "dir" ||
        attribute.name.startsWith("aria-") ||
        (svgElement && svgAttributeNames.has(attribute.name)) ||
        safeSvgUseReference
      ) {
        if (
          (!safeSvgFragmentReference &&
            !safeSvgUseReference &&
            /url\s*\(|javascript:|data:|(?:https?:)?\/\//i.test(
              attribute.value
            )) ||
          attribute.value.length > 50_000
        ) {
          continue;
        }
        const value = capturedTextAttributeNames.has(attribute.name)
          ? redactTextValue(attribute.value, redactEntireValue)
          : attribute.value;
        if (value !== attribute.value) redactedAttributeCount += 1;
        attributes[safeSvgUseReference ? "href" : attribute.name] = value;
      }
    }
    if (source.hasAttribute("disabled")) {
      attributes.disabled = "";
    }
    if (source.tagName === "INPUT") {
      const inputType = (source.getAttribute("type") ?? "text").toLowerCase();
      const safeInputTypes = new Set([
        "button",
        "checkbox",
        "email",
        "number",
        "radio",
        "range",
        "reset",
        "search",
        "submit",
        "tel",
        "text",
        "url"
      ]);
      attributes.type = safeInputTypes.has(inputType) ? inputType : "text";
      const placeholder = source.getAttribute("placeholder");
      if (placeholder) {
        const value = redactTextValue(placeholder, redactEntireValue);
        if (value !== placeholder) redactedAttributeCount += 1;
        attributes.placeholder = value;
      }
      if (source.hasAttribute("checked")) attributes.checked = "";
      if (source.hasAttribute("readonly")) attributes.readonly = "";
    }
    if (source.tagName === "TEXTAREA") {
      const placeholder = source.getAttribute("placeholder");
      if (placeholder) {
        const value = redactTextValue(placeholder, redactEntireValue);
        if (value !== placeholder) redactedAttributeCount += 1;
        attributes.placeholder = value;
      }
      if (source.hasAttribute("readonly")) attributes.readonly = "";
    }
    if (source.tagName === "SELECT" && source.hasAttribute("multiple")) {
      attributes.multiple = "";
    }
    if (source.tagName === "OPTION" && source.hasAttribute("selected")) {
      attributes.selected = "";
    }
    if (source.tagName === "IMG") {
      const alternativeText = source.getAttribute("alt");
      if (alternativeText) {
        const value = redactTextValue(alternativeText, redactEntireValue);
        if (value !== alternativeText && attributes.alt === undefined) {
          redactedAttributeCount += 1;
        }
        attributes.alt = value;
      }
      if (source.hasAttribute("width")) {
        attributes.width = source.getAttribute("width") ?? "";
      }
      if (source.hasAttribute("height")) {
        attributes.height = source.getAttribute("height") ?? "";
      }
    }
    if (!svgElement) {
      attributes.tabindex = "-1";
    }
    return attributes;
  };

  const safeSvgDefinitionTags = new Set([
    "circle",
    "clippath",
    "defs",
    "ellipse",
    "g",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
    "symbol",
    "use"
  ]);
  const safeSvgDefinitionStyleNames = new Set([
    "color",
    "fill",
    "fill-opacity",
    "fill-rule",
    "opacity",
    "stroke",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "stroke-width",
    "transform",
    "transform-origin"
  ]);
  const sanitizeSvgDefinition = (
    source: Element
  ): SanitizedElementNode | null => {
    const sourceTag = source.tagName.toLowerCase();
    if (
      source.namespaceURI !== "http://www.w3.org/2000/svg" ||
      !safeSvgDefinitionTags.has(sourceTag)
    ) {
      serializationBlocker ??= {
        code: "UnsupportedSurface",
        category: "svg-fragment-unsupported"
      };
      return null;
    }
    const children: SanitizedNode[] = [];
    for (const child of Array.from(source.children)) {
      const sanitizedChild = sanitizeSvgDefinition(child);
      if (!sanitizedChild) return null;
      children.push(sanitizedChild);
    }
    const styles = Object.fromEntries(
      Object.entries(readStyles(source)).filter(([name]) =>
        safeSvgDefinitionStyleNames.has(name)
      )
    );
    return {
      type: "element",
      tag: sourceTag as SanitizedElementNode["tag"],
      attributes: readAttributes(source),
      styles,
      children
    };
  };
  const externalSvgDefinitions = (
    sourceSvg: Element
  ): SanitizedElementNode | null => {
    const pendingIds: string[] = [];
    const queuedIds = new Set<string>();
    const enqueueReferences = (root: Element): void => {
      for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
        for (const attribute of Array.from(element.attributes)) {
          const directReference =
            element.tagName.toLowerCase() === "use" &&
            (attribute.name === "href" ||
              attribute.name.toLowerCase() === "xlink:href")
              ? attribute.value
              : undefined;
          const urlReference = attribute.value.match(
            /^url\(\s*["']?(#[A-Za-z_][\w:.-]*)["']?\s*\)$/
          )?.[1];
          const reference = directReference ?? urlReference;
          if (
            reference &&
            isSafeDocumentFragmentSource(reference) &&
            !queuedIds.has(reference.slice(1))
          ) {
            queuedIds.add(reference.slice(1));
            pendingIds.push(reference.slice(1));
          }
        }
      }
    };
    enqueueReferences(sourceSvg);
    const definitions: SanitizedNode[] = [];
    const capturedIds = new Set<string>();
    while (pendingIds.length > 0) {
      const id = pendingIds.shift();
      if (!id || capturedIds.has(id)) continue;
      capturedIds.add(id);
      const sourceDefinition = pageDocument.getElementById(id);
      if (!sourceDefinition || sourceSvg.contains(sourceDefinition)) continue;
      enqueueReferences(sourceDefinition);
      const definition = sanitizeSvgDefinition(sourceDefinition);
      if (!definition) return null;
      definitions.push(definition);
    }
    if (definitions.length === 0) return null;
    return {
      type: "element",
      tag: "defs",
      attributes: {},
      styles: {},
      children: definitions
    };
  };

  const normalizeFontFamily = (value: string): string =>
    value
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2")
      .trim()
      .toLocaleLowerCase("en-US");
  const firstFontFamily = (value: string): string => {
    const match = value.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/);
    return normalizeFontFamily(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
  };
  const loadedDocumentFontFamilies = new Set(
    Array.from(pageDocument.fonts ?? [])
      .filter((fontFace) => fontFace.status === "loaded")
      .map((fontFace) => normalizeFontFamily(fontFace.family))
      .filter(Boolean)
  );
  const bundledFontFamilies = new Set(
    (options.fontFaces ?? [])
      .map((fontFace) => normalizeFontFamily(fontFace.family))
      .filter(Boolean)
  );
  const unbundledVisibleFontFamilies = new Set<string>();

  let sanitizedTarget: SanitizedElementNode | undefined;
  const sanitizeNode = async (
    source: Node,
    includeText = true
  ): Promise<SanitizedNode | null> => {
    if (serializationBlocker) return null;
    if (source.nodeType === 3) {
      if (!includeText) return null;
      const originalText = (source.textContent ?? "").slice(0, 100_000);
      const text = redactTextValue(
        originalText,
        isInsideRedactionRegion(source.parentElement)
      );
      if (text !== originalText) redactedTextNodeCount += 1;
      if (
        options.nodeMode === "json" &&
        text.trim() !== "" &&
        source.parentElement
      ) {
        const range = pageDocument.createRange();
        range.selectNodeContents(source);
        const textRectangle = range.getBoundingClientRect();
        const textLineRectangles = Array.from(range.getClientRects()).filter(
          (rectangle) => rectangle.width > 0 && rectangle.height > 0
        );
        if (
          textRectangle.width > 0 &&
          textRectangle.height > 0 &&
          textRectangle.bottom > 0 &&
          textRectangle.right > 0 &&
          textRectangle.top < window.innerHeight &&
          textRectangle.left < window.innerWidth
        ) {
          const computed = computedFor(source.parentElement);
          const family = firstFontFamily(
            computed.getPropertyValue("font-family")
          );
          if (
            family !== "" &&
            loadedDocumentFontFamilies.has(family) &&
            !bundledFontFamilies.has(family)
          ) {
            unbundledVisibleFontFamilies.add(family);
          }
          const sourceWhiteSpace =
            computed.getPropertyValue("white-space").trim() || "normal";
          const textNode: SanitizedElementNode = {
            type: "element",
            tag: "span",
            attributes: {
              "data-showkit-text": ""
            },
            styles: {
              "clip-path": "inset(-4px 0 -4px 0)",
              display: "block",
              ...(textLineRectangles.length === 1
                ? { "line-height": `${textRectangle.height}px` }
                : {}),
              overflow: "visible",
              "white-space":
                textLineRectangles.length === 1 &&
                (sourceWhiteSpace === "normal" ||
                  sourceWhiteSpace === "pre-line")
                  ? "nowrap"
                  : sourceWhiteSpace
            },
            children: [{ type: "text", text }]
          };
          nodeRectangles.set(textNode, {
            x: textRectangle.x,
            y: textRectangle.y,
            width: textRectangle.width,
            height: textRectangle.height
          });
          return textNode;
        }
      }
      return {
        type: "text",
        text
      };
    }
    if (source.nodeType !== 1) return null;
    const sourceElement = source as Element;
    if (sourceElement.matches('input[type="hidden"]')) {
      return null;
    }
    const sourceTag = sourceElement.tagName.toLowerCase();
    const renderedCanvasReplacement =
      renderedCanvasReplacementFor(sourceElement);
    const imageElement =
      sourceElement.tagName === "IMG" ||
      (sourceElement.namespaceURI === "http://www.w3.org/2000/svg" &&
        sourceTag === "image");
    if (
      droppedTags.has(sourceTag) &&
      renderedCanvasReplacement === undefined
    ) {
      return null;
    }
    const viewportOnly = options.nodeMode === "json";
    const sourceRectangle = rectangleFor(sourceElement);
    const outsideViewport =
      sourceRectangle.width > 0 &&
      sourceRectangle.height > 0 &&
      (sourceRectangle.bottom <= 0 ||
        sourceRectangle.right <= 0 ||
        sourceRectangle.top >= window.innerHeight ||
        sourceRectangle.left >= window.innerWidth);
    if (
      viewportOnly &&
      outsideViewport &&
      sourceElement !== targetElement &&
      (targetElement === null || !sourceElement.contains(targetElement))
    ) {
      return null;
    }
    const computed = computedFor(sourceElement);
    if (
      computed.display === "none" ||
      (viewportOnly &&
        Number.parseFloat(computed.opacity || "1") === 0 &&
        !imageElement)
    ) {
      return null;
    }
    const elementVisible =
      computed.visibility !== "hidden" &&
      computed.visibility !== "collapse";
    const visualInViewport =
      !viewportOnly ||
      (elementVisible &&
        sourceRectangle.width > 0 &&
        sourceRectangle.height > 0 &&
        sourceRectangle.bottom > 0 &&
        sourceRectangle.right > 0 &&
        sourceRectangle.top < window.innerHeight &&
        sourceRectangle.left < window.innerWidth);
    const childTextVisible =
      !viewportOnly ||
      visualInViewport ||
      (elementVisible && computed.display === "contents");
    const outputTag = renderedCanvasReplacement
      ? "img"
      : allowedTags.has(sourceTag)
      ? sourceTag
      : blockTags.has(sourceTag)
        ? "div"
        : "span";
    const attributes = readAttributes(sourceElement);
    if (renderedCanvasReplacement) {
      attributes.src = localAssetPath(
        renderedCanvasReplacement.payload
      );
      attributes.alt = "";
      attributes["aria-hidden"] = "true";
      persistBundledAsset(renderedCanvasReplacement.payload);
    }
    if (imageElement) {
      const sourceValue = imageSourceFor(sourceElement);
      const replacement = replacementFor(
        sourceValue,
        sourceElement
      )?.payload;
      if (replacement) {
        attributes[sourceTag === "image" ? "href" : "src"] =
          localAssetPath(replacement);
        persistBundledAsset(replacement);
      } else if (sourceValue.startsWith("data:")) {
        const payload = localizeDataImage(sourceValue);
        if (!payload) {
          serializationBlocker ??= {
            code: "UnsupportedSurface",
            category: "image-asset-type"
          };
          return null;
        }
        attributes[sourceTag === "image" ? "href" : "src"] =
          localAssetPath(payload);
      } else if (sourceValue !== "") {
        markUnresolvedRemoteAsset(sourceElement);
        return null;
      }
    }
    const sourceIsTarget = isTargetSource(sourceElement);
    if (sourceIsTarget) {
      attributes["data-showkit-anchor"] = options.anchorId ?? "";
    }
    const children: SanitizedNode[] = [];
    const before = pseudoNode(sourceElement, "::before");
    if (before) children.push(before);
    const shadowRootVisibleElements = sourceElement.shadowRoot
      ? visibleOpenShadowElements(sourceElement)
      : [];
    const sourceChildNodes =
      sourceElement.shadowRoot &&
      isSafeTextOpenShadowRoot(sourceElement) &&
      shadowRootVisibleElements.length > 0
        ? Array.from(sourceElement.shadowRoot.childNodes)
        : Array.from(sourceElement.childNodes);
    for (const child of sourceChildNodes) {
      const sanitizedChild = await sanitizeNode(child, childTextVisible);
      if (sanitizedChild) children.push(sanitizedChild);
      if (serializationBlocker) return null;
    }
    const after = pseudoNode(sourceElement, "::after");
    if (after) children.push(after);
    if (sourceTag === "svg") {
      const definitions = externalSvgDefinitions(sourceElement);
      if (serializationBlocker) return null;
      if (definitions) children.unshift(definitions);
    }
    if (serializationBlocker) return null;
    if (
      sourceElement.shadowRoot &&
      isSafeTextOpenShadowRoot(sourceElement) &&
      shadowRootVisibleElements.length === 0 &&
      children.length === 0 &&
      !sourceIsTarget
    ) {
      return null;
    }
    const parentComputed = sourceElement.parentElement
      ? computedFor(sourceElement.parentElement)
      : undefined;
    const parentDisplay = parentComputed?.display ?? "";
    const parentFlexDirection = parentComputed?.flexDirection ?? "row";
    const contributesToParentLayout =
      viewportOnly &&
      elementVisible &&
      children.length === 0 &&
      (parentDisplay === "grid" ||
        parentDisplay === "inline-grid" ||
        parentDisplay === "flex" ||
        parentDisplay === "inline-flex") &&
      (parentDisplay.includes("grid")
        ? (sourceRectangle.width > 0 &&
            sourceRectangle.right > 0 &&
            sourceRectangle.left < window.innerWidth) ||
          (sourceRectangle.height > 0 &&
            sourceRectangle.bottom > 0 &&
            sourceRectangle.top < window.innerHeight)
        : parentFlexDirection.startsWith("row")
          ? sourceRectangle.width > 0 &&
            sourceRectangle.right > 0 &&
            sourceRectangle.left < window.innerWidth
          : sourceRectangle.height > 0 &&
            sourceRectangle.bottom > 0 &&
            sourceRectangle.top < window.innerHeight);
    if (
      viewportOnly &&
      !visualInViewport &&
      children.length === 0 &&
      !contributesToParentLayout
    ) {
      return null;
    }
    const nodeStyles = readStyles(sourceElement);
    if (renderedCanvasReplacement) {
      nodeStyles["object-fit"] = "fill";
      nodeStyles.opacity = "1";
      nodeStyles.transform = "none";
      delete nodeStyles["transform-origin"];
    }
    const node: SanitizedElementNode = {
      type: "element",
      tag: outputTag as SanitizedElementNode["tag"],
      attributes,
      styles: nodeStyles,
      children
    };
    nodeSourceElements.set(node, sourceElement);
    sourceSanitizedElements.set(sourceElement, node);
    if (sourceRectangle.width > 0 && sourceRectangle.height > 0) {
      nodeRectangles.set(node, {
        x: sourceRectangle.x,
        y: sourceRectangle.y,
        width: sourceRectangle.width,
        height: sourceRectangle.height
      });
      nodeContainingBlockOrigins.set(node, {
        x: sourceRectangle.x + sourceElement.clientLeft,
        y: sourceRectangle.y + sourceElement.clientTop
      });
    }
    if (sourceIsTarget) {
      sanitizedTarget = node;
    }
    return node;
  };

  const rootChildren: SanitizedNode[] = [];
  for (const child of Array.from(pageDocument.body.childNodes)) {
    const sanitizedChild = await sanitizeNode(child);
    if (sanitizedChild) rootChildren.push(sanitizedChild);
  }
  if (serializationBlocker) {
    return blocked(serializationBlocker.code, serializationBlocker.category);
  }
  if (unbundledVisibleFontFamilies.size > 0) {
    return blocked("UnsupportedSurface", "font-asset-required");
  }
  const rootStyles = readStyles(pageDocument.body);
  rootStyles.width = `${window.innerWidth}px`;
  rootStyles.height = `${window.innerHeight}px`;
  rootStyles.overflow = "hidden";
  const root: SanitizedElementNode = {
    type: "element",
    tag: "div",
    attributes: {
      "data-showkit-scene-root": "",
      "aria-label": "Captured product state"
    },
    styles: rootStyles,
    children: rootChildren
  };
  const flattenForTransfer = (): SanitizedElementNode | null => {
    const flattened: SanitizedNode[] = [];
    const elementLimit = options.maxSerializedElements ?? 2_000;
    const appendElement = (
      node: SanitizedElementNode,
      text: string,
      preserveChildren: boolean
    ): void => {
      const rectangle = nodeRectangles.get(node);
      if (!rectangle || flattened.length >= elementLimit) return;
      flattened.push({
        type: "element",
        tag: node.tag,
        attributes: { ...node.attributes },
        styles: {
          ...node.styles,
          position: "absolute",
          left: `${rectangle.x}px`,
          top: `${rectangle.y}px`,
          width: `${rectangle.width}px`,
          height: `${rectangle.height}px`,
          "margin-bottom": "0px",
          "margin-left": "0px",
          "margin-right": "0px",
          "margin-top": "0px",
          transform: "none"
        },
        children: preserveChildren
          ? node.children
          : text !== ""
            ? [
                {
                  type: "text",
                  text: text.slice(0, 100_000)
                }
              ]
            : []
      });
    };
    const visit = (node: SanitizedNode): void => {
      if (node.type === "text" || flattened.length >= elementLimit) return;
      const preserveChildren = node.tag === "svg";
      const directText = node.children
        .filter(
          (child): child is Extract<SanitizedNode, { type: "text" }> =>
            child.type === "text"
        )
        .map((child) => child.text)
        .join("");
      appendElement(node, directText, preserveChildren);
      if (preserveChildren) return;
      for (const child of node.children) visit(child);
    };
    for (const child of root.children) visit(child);
    if (flattened.length >= elementLimit) return null;
    return {
      ...root,
      styles: {
        ...root.styles,
        position: "relative"
      },
      children: flattened
    };
  };
  const treeFitsTransferLimit = (): boolean => {
    const elementLimit = options.maxSerializedElements ?? 2_000;
    let elementCount = 0;
    const visit = (node: SanitizedNode): boolean => {
      if (node.type === "text") return true;
      elementCount += 1;
      if (elementCount >= elementLimit) return false;
      return node.children.every(visit);
    };
    return visit(root);
  };
  const positionTreeForTransfer = (): SanitizedElementNode | null => {
    if (!treeFitsTransferLimit()) return null;
    const positionedStyles = (
      styles: Record<string, string>
    ): Record<string, string> => {
      const positioned = { ...styles };
      delete positioned["grid-column-end"];
      delete positioned["grid-column-start"];
      delete positioned["grid-row-end"];
      delete positioned["grid-row-start"];
      return positioned;
    };
    const cloneSvgSubtree = (node: SanitizedNode): SanitizedNode =>
      node.type === "text"
        ? { ...node }
        : {
            ...node,
            attributes: { ...node.attributes },
            styles: { ...node.styles },
            children: node.children.map(cloneSvgSubtree)
          };
    const preservesTransformedCoordinateSpace = (
      styles: Record<string, string>,
      rectangle: { width: number; height: number }
    ): boolean => {
      const transform = styles.transform;
      const transformOrigin = styles["transform-origin"];
      const width = Number.parseFloat(styles.width ?? "");
      const height = Number.parseFloat(styles.height ?? "");
      if (
        !transform ||
        !transformOrigin ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        return false;
      }
      const matrixMatch = transform.match(
        /^matrix\(\s*([^)]+)\s*\)$/
      );
      if (!matrixMatch?.[1]) return false;
      const matrix = matrixMatch[1]
        .split(",")
        .map((part) => Number.parseFloat(part.trim()));
      if (matrix.length !== 6 || matrix.some((value) => !Number.isFinite(value))) {
        return false;
      }
      const [scaleX, skewY, skewX, scaleY, translateX, translateY] =
        matrix as [number, number, number, number, number, number];
      const origin = transformOrigin
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => Number.parseFloat(part));
      const epsilon = 0.001;
      const noOpTransform =
        Math.abs(scaleX - 1) <= epsilon &&
        Math.abs(scaleY - 1) <= epsilon &&
        Math.abs(skewX) <= epsilon &&
        Math.abs(skewY) <= epsilon &&
        Math.abs(translateX) <= epsilon &&
        Math.abs(translateY) <= epsilon;
      if (noOpTransform) return false;
      const preservesOriginScale =
        scaleX > 0 &&
        scaleY > 0 &&
        scaleX <= 4 &&
        scaleY <= 4 &&
        Math.abs(skewX) <= epsilon &&
        Math.abs(skewY) <= epsilon &&
        Math.abs(translateX) <= epsilon &&
        Math.abs(translateY) <= epsilon &&
        origin.length === 2 &&
        origin.every(
          (value) => Number.isFinite(value) && Math.abs(value) <= epsilon
        );
      if (preservesOriginScale) return true;
      const firstAxisLength = Math.hypot(scaleX, skewY);
      const secondAxisLength = Math.hypot(skewX, scaleY);
      const axesDotProduct = scaleX * skewX + skewY * scaleY;
      const preservesBox =
        Math.abs(rectangle.width - width) <= 0.5 &&
        Math.abs(rectangle.height - height) <= 0.5;
      const originInsideBox =
        origin.length === 2 &&
        Number.isFinite(origin[0]) &&
        Number.isFinite(origin[1]) &&
        origin[0]! >= -epsilon &&
        origin[1]! >= -epsilon &&
        origin[0]! <= width + epsilon &&
        origin[1]! <= height + epsilon;
      return (
        Math.abs(firstAxisLength - 1) <= epsilon &&
        Math.abs(secondAxisLength - 1) <= epsilon &&
        Math.abs(axesDotProduct) <= epsilon &&
        Math.abs(translateX) <= epsilon &&
        Math.abs(translateY) <= epsilon &&
        preservesBox &&
        originInsideBox
      );
    };
    const scrolledCoordinateSpaceCache = new Map<Element, boolean>();
    const participatesInScrolledCoordinateSpace = (
      node: SanitizedElementNode
    ): boolean => {
      const source = nodeSourceElements.get(node);
      if (!source) return false;
      const cached = scrolledCoordinateSpaceCache.get(source);
      if (cached !== undefined) return cached;
      if (
        Math.abs(window.scrollX) > 0.5 ||
        Math.abs(window.scrollY) > 0.5
      ) {
        scrolledCoordinateSpaceCache.set(source, true);
        return true;
      }
      let current: Element | null = source;
      while (current) {
        if (
          Math.abs(current.scrollLeft) > 0.5 ||
          Math.abs(current.scrollTop) > 0.5
        ) {
          scrolledCoordinateSpaceCache.set(source, true);
          return true;
        }
        if (current.parentElement) {
          current = current.parentElement;
          continue;
        }
        const root = current.getRootNode() as ShadowRoot;
        current = root?.host ?? null;
      }
      const hasScrolledDescendant = Array.from(
        source.querySelectorAll("*")
      ).some(
        (descendant) =>
          Math.abs(descendant.scrollLeft) > 0.5 ||
          Math.abs(descendant.scrollTop) > 0.5
      );
      scrolledCoordinateSpaceCache.set(
        source,
        hasScrolledDescendant
      );
      return hasScrolledDescendant;
    };
    const positionNode = (
      node: SanitizedNode,
      parentRectangle: { x: number; y: number }
    ): SanitizedNode => {
      if (node.type === "text") return { ...node };
      const rectangle = nodeRectangles.get(node);
      const isSvgRoot = node.tag === "svg";
      const isPseudo = node.attributes["data-showkit-pseudo"] !== undefined;
      const preserveScaledCoordinateSpace =
        rectangle !== undefined &&
        !isPseudo &&
        !participatesInScrolledCoordinateSpace(node) &&
        preservesTransformedCoordinateSpace(node.styles, rectangle);
      const containingBlockOrigin = rectangle
        ? (nodeContainingBlockOrigins.get(node) ?? {
            x: rectangle.x,
            y: rectangle.y
          })
        : parentRectangle;
      const children = isSvgRoot || preserveScaledCoordinateSpace
        ? node.children.map(cloneSvgSubtree)
        : node.children.map((child) =>
            positionNode(child, containingBlockOrigin)
          );
      return {
        ...node,
        attributes: { ...node.attributes },
        styles: isPseudo
          ? { ...node.styles }
          : rectangle
          ? {
              ...positionedStyles(node.styles),
              position: "absolute",
              left: `${rectangle.x - parentRectangle.x}px`,
              top: `${rectangle.y - parentRectangle.y}px`,
              width: preserveScaledCoordinateSpace
                ? (node.styles.width ?? `${rectangle.width}px`)
                : `${rectangle.width}px`,
              height: preserveScaledCoordinateSpace
                ? (node.styles.height ?? `${rectangle.height}px`)
                : `${rectangle.height}px`,
              "margin-bottom": "0px",
              "margin-left": "0px",
              "margin-right": "0px",
              "margin-top": "0px",
              transform: preserveScaledCoordinateSpace
                ? (node.styles.transform ?? "none")
                : "none"
            }
          : {
              ...node.styles,
              display: "contents",
              position: "static"
            },
        children
      };
    };
    return {
      ...root,
      styles: {
        ...root.styles,
        position: "relative"
      },
      children: root.children.map((child) =>
        positionNode(child, { x: 0, y: 0 })
      )
    };
  };
  const transferableRoot =
    options.nodeMode === "flat"
      ? flattenForTransfer()
      : options.nodeMode === "json"
        ? positionTreeForTransfer()
      : root;
  if (!transferableRoot) {
    return blocked("CaptureTooLarge", "serialized-node-limit");
  }
  const escapeText = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const escapeAttribute = (value: string): string =>
    escapeText(value).replace(/"/g, "&quot;");
  const serializeNode = (node: SanitizedNode): string => {
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
    if (node.tag === "img" || node.tag === "hr" || node.tag === "input") {
      return `<${node.tag}${attributes}${style}>`;
    }
    return `<${node.tag}${attributes}${style}>${node.children
      .map(serializeNode)
      .join("")}</${node.tag}>`;
  };
  const roleFromTag = (element: Element): string | undefined => {
    const explicitRole = element.getAttribute("role");
    if (explicitRole) return explicitRole;
    if (element.tagName === "INPUT") {
      const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
      const inputRoles: Record<string, string | undefined> = {
        button: "button",
        checkbox: "checkbox",
        color: undefined,
        file: "button",
        hidden: undefined,
        image: "button",
        number: "spinbutton",
        radio: "radio",
        range: "slider",
        reset: "button",
        search: "searchbox",
        submit: "button"
      };
      return inputType in inputRoles ? inputRoles[inputType] : "textbox";
    }
    if (element.tagName === "TEXTAREA") return "textbox";
    if (element.tagName === "SELECT") {
      return element.hasAttribute("multiple") ? "listbox" : "combobox";
    }
    const roles: Record<string, string> = {
      A: "link",
      BUTTON: "button",
      DETAILS: "group",
      H1: "heading",
      H2: "heading",
      H3: "heading",
      H4: "heading",
      H5: "heading",
      H6: "heading",
      LI: "listitem",
      NAV: "navigation",
      SUMMARY: "button"
    };
    return roles[element.tagName];
  };
  const sanitizedTextParts = (node: SanitizedNode): string[] => {
    if (node.type === "text") return [node.text];
    return node.children.flatMap(sanitizedTextParts);
  };
  const sanitizedAccessibleTextParts = (node: SanitizedNode): string[] => {
    if (node.type === "text") return [node.text];
    if (node.attributes["aria-hidden"] === "true") return [];
    return node.children.flatMap(sanitizedAccessibleTextParts);
  };
  const sanitizedTextForElement = (element: Element | null): string => {
    if (!element) return "";
    const sanitized = sourceSanitizedElements.get(element);
    return sanitized
      ? sanitizedAccessibleTextParts(sanitized)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  };
  const redactedAssistiveLabels = new Set<Element>();
  const sanitizedReferencedText = (element: Element | null): string => {
    if (!element) return "";
    const original = accessibleTextContent(element, {
      allowHiddenRoot: true,
      allowHiddenSubtree: true,
      separateChildElements: true
    });
    const text = redactTextValue(
      original,
      isInsideRedactionRegion(element)
    );
    if (text !== original && !redactedAssistiveLabels.has(element)) {
      redactedAssistiveLabels.add(element);
      redactedTextNodeCount += 1;
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 560);
  };
  const sanitizedLabelName = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => {
            const label = pageDocument.getElementById(id);
            return (
              sanitizedTextForElement(label) ||
              sanitizedReferencedText(label)
            );
          })
          .join(" ")
      : "";
    const associatedText = Array.from(
      pageDocument.querySelectorAll("label")
    )
      .filter((label) => {
        const labelFor = label.getAttribute("for");
        return (
          (labelFor !== null &&
            element.id !== "" &&
            labelFor === element.id) ||
          label.contains(element)
        );
      })
      .map((label) => sanitizedTextForElement(label))
      .join(" ");
    return [labelledByText, associatedText]
      .map((value) => value.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  };
  const accessibleName = (
    element: Element,
    sanitizedElement: SanitizedElementNode
  ): string => {
    const candidate = [
      sanitizedElement.attributes["aria-label"],
      sanitizedLabelName(element),
      sanitizedElement.attributes.title,
      sanitizedAccessibleTextParts(sanitizedElement).join(" ")
    ]
      .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
      .find(Boolean);
    return (candidate ?? "Hotspot target").slice(0, 180);
  };

  const evidenceTexts: string[] = [];
  if (targetElement && sanitizedTarget) {
    evidenceTexts.push(accessibleName(targetElement, sanitizedTarget));
    const context = targetElement.closest("section, article, main, [role='dialog']");
    const sanitizedContext = context
      ? sourceSanitizedElements.get(context)
      : undefined;
    const contextText = (sanitizedContext
      ? sanitizedTextParts(sanitizedContext)
      : []
    )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 560);
    if (contextText) evidenceTexts.push(contextText);
  }
  const rectangle = targetElement ? rectangleFor(targetElement) : undefined;
  const normalize = (value: number, total: number) =>
    Math.max(0, Math.min(1, Number((value / total).toFixed(6))));
  const targetRole = targetElement ? roleFromTag(targetElement) : undefined;
  if (targetElement && (!rectangle || !sanitizedTarget || !targetRole)) {
    return blocked(options.targetErrorCode, "semantic-target-required");
  }
  const serializedHtml = serializeNode(transferableRoot);
  const serializedNodes = JSON.stringify([transferableRoot]);
  const capturedSensitiveText: string[] = [];
  const collectCapturedSensitiveText = (node: SanitizedNode): void => {
    if (node.type === "text") {
      capturedSensitiveText.push(node.text);
      return;
    }
    for (const [name, value] of Object.entries(node.attributes)) {
      if (capturedTextAttributeNames.has(name)) {
        capturedSensitiveText.push(value);
      }
    }
    for (const child of node.children) {
      collectCapturedSensitiveText(child);
    }
  };
  collectCapturedSensitiveText(transferableRoot);
  const transferredSensitiveContent = [
    ...capturedSensitiveText,
    targetElement && sanitizedTarget
      ? accessibleName(targetElement, sanitizedTarget)
      : "",
    ...evidenceTexts
  ].join("\n");
  if (
    blockingSecretPatternSources.some((source) =>
      hasSensitivePatternMatch(transferredSensitiveContent, source)
    )
  ) {
    return blocked(
      "SensitiveDataDetected",
      textRedactionActive ? "redaction-incomplete" : "configured-pattern"
    );
  }

  const baseResult: Omit<
    CompleteSceneResult,
    "html" | "nodes" | "nodesJson" | "transfer"
  > = {
    ok: true,
    scanOnly: false,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...(targetElement && rectangle && sanitizedTarget
      ? {
          target: {
            tag: sanitizedTarget.tag,
            ...(targetRole ? { role: targetRole } : {}),
            name: accessibleName(targetElement, sanitizedTarget),
            bounds: {
              x: normalize(rectangle.x, window.innerWidth),
              y: normalize(rectangle.y, window.innerHeight),
              width: normalize(rectangle.width, window.innerWidth),
              height: normalize(rectangle.height, window.innerHeight)
            }
          }
        }
      : {}),
    evidenceTexts: [...new Set(evidenceTexts)].filter(Boolean),
    assetPayloads: [...assetPayloads.values()].sort((left, right) =>
      left.sha256.localeCompare(right.sha256)
    ),
    fontFaces: [...(options.fontFaces ?? [])],
    excludedSurfaces: buildExcludedSurfaces(),
    sensitiveText: {
      mode: textRedactionActive ? "text-only" : "blocked-by-default",
      redactedTextNodeCount,
      redactedAttributeCount,
      regionCount: redactionRegions.size
    }
  };
  if (options.nodeMode === "json") {
    if (options.transferEncoding === "lzss-json") {
      const sourceBytes = utf8Bytes(serializedNodes);
      const compressed: number[] = [];
      const positions = new Map<number, number[]>();
      const addPosition = (position: number): void => {
        if (position + 2 >= sourceBytes.length) return;
        const key =
          (sourceBytes[position]! << 16) |
          (sourceBytes[position + 1]! << 8) |
          sourceBytes[position + 2]!;
        const candidates = positions.get(key) ?? [];
        candidates.push(position);
        while (candidates.length > 32) candidates.shift();
        while (
          candidates.length > 0 &&
          position - candidates[0]! > 65_536
        ) {
          candidates.shift();
        }
        positions.set(key, candidates);
      };
      let sourceOffset = 0;
      while (sourceOffset < sourceBytes.length) {
        const flagOffset = compressed.length;
        compressed.push(0);
        let flags = 0;
        for (
          let bit = 0;
          bit < 8 && sourceOffset < sourceBytes.length;
          bit += 1
        ) {
          let bestLength = 0;
          let bestDistance = 0;
          if (sourceOffset + 2 < sourceBytes.length) {
            const key =
              (sourceBytes[sourceOffset]! << 16) |
              (sourceBytes[sourceOffset + 1]! << 8) |
              sourceBytes[sourceOffset + 2]!;
            const candidates = positions.get(key) ?? [];
            for (
              let index = candidates.length - 1;
              index >= 0;
              index -= 1
            ) {
              const candidate = candidates[index]!;
              const distance = sourceOffset - candidate;
              if (distance > 65_536) break;
              const maximumLength = Math.min(
                258,
                sourceBytes.length - sourceOffset
              );
              let length = 0;
              while (
                length < maximumLength &&
                sourceBytes[candidate + length] ===
                  sourceBytes[sourceOffset + length]
              ) {
                length += 1;
              }
              if (length > bestLength) {
                bestLength = length;
                bestDistance = distance;
                if (length === maximumLength) break;
              }
            }
          }
          if (bestLength >= 3) {
            flags |= 1 << bit;
            const distance = bestDistance - 1;
            compressed.push(
              distance >> 8,
              distance & 0xff,
              bestLength - 3
            );
            for (let index = 0; index < bestLength; index += 1) {
              addPosition(sourceOffset + index);
            }
            sourceOffset += bestLength;
          } else {
            compressed.push(sourceBytes[sourceOffset]!);
            addPosition(sourceOffset);
            sourceOffset += 1;
          }
        }
        compressed[flagOffset] = flags;
      }
      let packedBuffer = 0;
      let packedBits = 0;
      let compressedNodes = "";
      for (const byte of compressed) {
        packedBuffer = (packedBuffer << 8) | byte;
        packedBits += 8;
        while (packedBits >= 15) {
          packedBits -= 15;
          compressedNodes += String.fromCharCode(
            0x100 + ((packedBuffer >> packedBits) & 0x7fff)
          );
          packedBuffer &= (1 << packedBits) - 1;
        }
      }
      if (packedBits > 0) {
        compressedNodes += String.fromCharCode(
          0x100 + ((packedBuffer << (15 - packedBits)) & 0x7fff)
        );
      }
      if (compressedNodes.length <= transferChunkSize) {
        return {
          ...baseResult,
          html: "",
          nodes: [],
          nodesJson: compressedNodes,
          transfer: {
            mode: "lzss-json",
            encoding: "lzss-15bit",
            compressedLength: compressed.length,
            nodesJsonLength: serializedNodes.length
          }
        };
      }
    }
    return {
      ...baseResult,
      html: serializedHtml.slice(
        transferOffset,
        transferOffset + transferChunkSize
      ),
      nodes: [],
      nodesJson: serializedNodes.slice(
        transferOffset,
        transferOffset + transferChunkSize
      ),
      transfer: {
        mode: "chunked-json",
        offset: transferOffset,
        chunkSize: transferChunkSize,
        htmlLength: serializedHtml.length,
        nodesJsonLength: serializedNodes.length
      }
    };
  }
  return {
    ...baseResult,
    html: serializedHtml,
    nodes: [transferableRoot]
  };
}
