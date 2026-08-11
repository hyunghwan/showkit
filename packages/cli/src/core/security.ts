import { EXIT_CODES, ShowKitError } from "./errors.js";
import type { CaptureSource, SanitizedNode } from "./schemas.js";

export const DEFAULT_SECRET_PATTERN_SOURCES = [
  "SHOWKIT_SECRET_CANARY_[A-Z0-9_-]+",
  "\\b(?:api|access|auth|secret)[_-]?(?:key|token)\\s*[:=]\\s*[^\\s]+",
  "\\bsk-[A-Za-z0-9]{16,}\\b",
  "\\bgh[oprsu]_[A-Za-z0-9]{20,}\\b",
  "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b",
  "\\b(?:\\d[ -]*?){13,19}\\b"
] as const;

const VISIBLE_PRIVATE_CONTENT_PATTERN_SOURCES = new Set<string>([
  DEFAULT_SECRET_PATTERN_SOURCES[4]
]);
const PAYMENT_CARD_PATTERN_SOURCE = DEFAULT_SECRET_PATTERN_SOURCES[5];

const FORBIDDEN_SCENE_PATTERNS = [
  /<script\b/i,
  /<form\b/i,
  /<iframe\b/i,
  /<canvas\b/i,
  /<video\b/i,
  /<audio\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<link\b/i,
  /<style\b/i,
  /\son[a-z]+\s*=/i,
  /<[^>]*\b(?:href|src|style)\s*=\s*["'][^"']*(?:https?:)?\/\//i,
  /javascript:/i,
  /data:text\/html/i,
  /@import/i,
  /expression\s*\(/i
] as const;

const ALLOWED_NODE_ATTRIBUTES = new Set([
  "alt",
  "aria-current",
  "aria-describedby",
  "aria-disabled",
  "aria-expanded",
  "aria-haspopup",
  "aria-hidden",
  "aria-label",
  "aria-labelledby",
  "aria-live",
  "aria-pressed",
  "aria-selected",
  "checked",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "cx",
  "cy",
  "d",
  "disabled",
  "dir",
  "fill",
  "fill-opacity",
  "fill-rule",
  "focusable",
  "height",
  "href",
  "id",
  "lang",
  "multiple",
  "opacity",
  "points",
  "placeholder",
  "preserveAspectRatio",
  "r",
  "readonly",
  "role",
  "rx",
  "ry",
  "src",
  "stroke",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "selected",
  "tabindex",
  "title",
  "transform",
  "type",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
  "data-showkit-anchor",
  "data-showkit-interaction-box",
  "data-showkit-position-lock",
  "data-showkit-pseudo",
  "data-showkit-scroll-x",
  "data-showkit-scroll-y",
  "data-showkit-text",
  "data-showkit-scene-root"
]);

export function visitSanitizedNodes(
  nodes: SanitizedNode[],
  visitor: (node: SanitizedNode) => void
): void {
  for (const node of nodes) {
    visitor(node);
    if (node.type === "element") {
      visitSanitizedNodes(node.children, visitor);
    }
  }
}

function isAllowedNodeAttribute(name: string): boolean {
  return ALLOWED_NODE_ATTRIBUTES.has(name) || /^aria-[a-z][a-z-]*$/.test(name);
}

function usesOnlyLocalAssetUrls(
  value: string,
  assetPaths: ReadonlySet<string>
): boolean {
  let invalid = false;
  const withoutLocalAssets = value.replace(
    /url\s*\(\s*["']?(\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg|woff2))["']?\s*\)/gi,
    (_match, assetPath: string) => {
      if (!assetPaths.has(assetPath)) invalid = true;
      return "";
    }
  ).replace(
    /url\s*\(\s*["']?#[A-Za-z_][A-Za-z0-9_.:-]*["']?\s*\)/gi,
    ""
  );
  return !invalid && !/url\s*\(/i.test(withoutLocalAssets);
}

export function containsConfiguredSensitiveText(
  value: string,
  patternSources: readonly string[] = DEFAULT_SECRET_PATTERN_SOURCES
): boolean {
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
  return patternSources.some((source) => {
    const expression = new RegExp(source, "gi");
    if (source !== PAYMENT_CARD_PATTERN_SOURCE) {
      return expression.test(value);
    }
    return [...value.matchAll(expression)].some((match) =>
      isPaymentCardNumber(match[0])
    );
  });
}

export function inspectCaptureContentPolicy(capture: CaptureSource): {
  sensitiveTextAbsent: boolean;
  htmlPolicyPassed: boolean;
  screenshotPolicyPassed: boolean;
} {
  const allScenes = [...capture.steps.map((step) => step.scene), capture.terminalScene];
  const assetPaths = new Set(capture.assets.map((asset) => `./${asset.path}`));
  const capturedTextAttributeNames = new Set([
    "alt",
    "aria-description",
    "aria-label",
    "aria-placeholder",
    "placeholder",
    "title"
  ]);
  const sensitiveContent = [
    ...capture.fixture.steps.flatMap((step) => [
      step.title,
      step.target.name
    ]),
    ...capture.steps.flatMap((step) => [
      step.title,
      step.scene.target?.name ?? "",
      step.actionOutcome.title,
      ...step.evidence.map((evidence) => evidence.text)
    ]),
    capture.terminalScene.target?.name ?? ""
  ];
  let nodePolicyPassed = true;

  for (const scene of allScenes) {
    for (const fontFace of scene.fontFaces ?? []) {
      if (!assetPaths.has(fontFace.src)) {
        nodePolicyPassed = false;
      }
    }
    visitSanitizedNodes(scene.nodes, (node) => {
      if (node.type === "text") {
        sensitiveContent.push(node.text);
        return;
      }
      for (const [name, value] of Object.entries(node.attributes)) {
        const safeInputButtonValue =
          node.tag === "input" &&
          name === "value" &&
          ["button", "reset", "submit"].includes(
            node.attributes.type ?? "text"
          );
        if (capturedTextAttributeNames.has(name)) {
          sensitiveContent.push(value);
        }
        if (safeInputButtonValue) {
          sensitiveContent.push(value);
        }
        if (!isAllowedNodeAttribute(name) && !safeInputButtonValue) {
          nodePolicyPassed = false;
        }
        if (
          (name === "data-showkit-scroll-x" ||
            name === "data-showkit-scroll-y") &&
          !/^\d{1,6}$/.test(value)
        ) {
          nodePolicyPassed = false;
        }
        if (
          name === "data-showkit-position-lock" &&
          !["fixed", "sticky"].includes(value)
        ) {
          nodePolicyPassed = false;
        }
        if (
          (name === "src" || name === "href") &&
          !assetPaths.has(value) &&
          !(name === "href" && /^#[A-Za-z][A-Za-z0-9_.:-]*$/.test(value))
        ) {
          nodePolicyPassed = false;
        }
        if (
          name.startsWith("on") ||
          /javascript:|data:text\/html|(?:https?:)?\/\//i.test(value)
        ) {
          nodePolicyPassed = false;
        }
      }
      for (const [name, value] of Object.entries(node.styles)) {
        if (
          !/^[a-z-]+$/.test(name) ||
          /@import|expression\s*\(/i.test(value) ||
          !usesOnlyLocalAssetUrls(value, assetPaths)
        ) {
          nodePolicyPassed = false;
        }
      }
    });
  }

  return {
    sensitiveTextAbsent: !containsConfiguredSensitiveText(
      sensitiveContent.join("\n"),
      capture.redaction.privateContent
        ? DEFAULT_SECRET_PATTERN_SOURCES.filter(
            (source) =>
              !VISIBLE_PRIVATE_CONTENT_PATTERN_SOURCES.has(source)
          )
        : DEFAULT_SECRET_PATTERN_SOURCES
    ),
    htmlPolicyPassed:
      nodePolicyPassed &&
      allScenes.every((scene) =>
        FORBIDDEN_SCENE_PATTERNS.every((pattern) => !pattern.test(scene.html))
      ),
    screenshotPolicyPassed: capture.redaction.fullSceneRasterCount === 0
  };
}

export function assertCaptureSafeForPersistence(capture: CaptureSource): void {
  const result = inspectCaptureContentPolicy(capture);
  if (!result.sensitiveTextAbsent) {
    throw new ShowKitError({
      code: "SensitiveDataDetected",
      message:
        "[SHOWKIT:SensitiveDataDetected] Sensitive data was found. ShowKit did not save the captured page. Your previous captured product flow has not changed.",
      exitCode: EXIT_CODES.validation,
      recovery: "Hide the data or update the capture rule, then try again."
    });
  }
  if (!result.htmlPolicyPassed || !result.screenshotPolicyPassed) {
    throw new ShowKitError({
      code: "UnsupportedSurface",
      message:
        "ShowKit cannot capture this part of the page yet. No captured page was saved. Your previous captured product flow has not changed.",
      exitCode: EXIT_CODES.validation,
      recovery: "Use supported HTML elements or remove this step.",
      details: {
        category: !result.htmlPolicyPassed
          ? "sanitized-html-policy"
          : "screenshot-policy"
      }
    });
  }
}
