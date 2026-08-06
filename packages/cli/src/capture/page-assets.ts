import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync
} from "node:zlib";
import type { Page } from "@playwright/test";
import type {
  AssetPayload,
  SceneFontFace
} from "../core/schemas.js";
import type {
  PageAssetConsent,
  SceneKernelOptions
} from "./extractor.js";

type RemoteAssetReplacement = NonNullable<
  SceneKernelOptions["remoteAssetReplacements"]
>[number];

type VisibleFontSource = Omit<SceneFontFace, "src"> & {
  source: string;
  payload?: AssetPayload;
};

export type VisibleFontMetricSignature = Omit<SceneFontFace, "src"> & {
  metrics: number[][];
};

export type VisiblePageAssetInventory = {
  images: string[];
  fonts: VisibleFontSource[];
  visibleFontFamilies: string[];
  visibleFontFaces: Array<Omit<SceneFontFace, "src">>;
  visibleFontMetrics: VisibleFontMetricSignature[];
  unreadableStyleSheets: string[];
  renderedIcons: Array<{
    source: string;
    elementIndex: number;
    left: number;
    top: number;
    width: number;
    height: number;
    boxWidth: number;
    boxHeight: number;
    transform: string;
    directElementSafe: boolean;
    match: NonNullable<RemoteAssetReplacement["match"]>;
  }>;
};

export type PreparedPageAssets = {
  assets: AssetPayload[];
  fontFaces: SceneFontFace[];
  replacements: RemoteAssetReplacement[];
};

/**
 * Discovers only currently rendered image sources, required loaded WOFF2
 * descriptors, and tightly bounded background-image candidates. This function is
 * serialized into ShowKit's isolated browser world, so keep it standalone.
 */
export function collectVisiblePageAssetInventory(): VisiblePageAssetInventory {
  const images = new Set<string>();
  const priorityImages = new Set<string>();
  const fonts: VisibleFontSource[] = [];
  const unreadableStyleSheets = new Set<string>();
  const renderedIcons: VisiblePageAssetInventory["renderedIcons"] = [];
  const normalizedFamily = (value: string): string =>
    value
      .trim()
      .replace(/^(?:"([^"]+)"|'([^']+)'|([^,]+)).*$/, "$1$2$3")
      .trim()
      .toLocaleLowerCase("en-US");
  const safeHttpSource = (raw: string): string | undefined => {
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 10_000) {
      return undefined;
    }
    try {
      const url = new URL(raw, document.baseURI);
      return ["http:", "https:"].includes(url.protocol) &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  };
  const addImage = (raw: string, priority = false): void => {
    const source = safeHttpSource(raw);
    if (!source) return;
    const collection = priority ? priorityImages : images;
    if (collection.size < 64) collection.add(source);
  };
  const styleSources = (value: string): string[] => {
    if (!/url\s*\(/i.test(value)) return [];
    return [...value.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)]
      .map((match) => safeHttpSource(match[1] ?? ""))
      .filter((source): source is string => Boolean(source));
  };
  const directRenderableBackground = (value: string): string | undefined => {
    const match = /^url\(\s*["']?([^"')]+)["']?\s*\)$/i.exec(value.trim());
    if (!match?.[1] || match[1].length > 10_000) return undefined;
    if (
      /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(
        match[1]
      )
    ) {
      return match[1];
    }
    return safeHttpSource(match[1]);
  };
  const visible = (element: Element, computed: CSSStyleDeclaration): boolean => {
    const rectangle = element.getBoundingClientRect();
    return (
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      rectangle.bottom > 0 &&
      rectangle.right > 0 &&
      rectangle.top < innerHeight &&
      rectangle.left < innerWidth &&
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
  const transparent = (value: string): boolean =>
    value === "transparent" ||
    value === "rgba(0, 0, 0, 0)" ||
    value === "rgba(0,0,0,0)";
  const transparentBackground = (value: string): boolean =>
    value === "none" ||
    /^-(?:webkit-)?linear-gradient\(top, rgba\(0, 0, 0, 0\), rgba\(0, 0, 0, 0\)\)$/i.test(
      value
    );
  const backdropColor = (element: Element): string | undefined => {
    let current = element.parentElement;
    while (current) {
      const computed = getComputedStyle(current);
      if (!transparentBackground(computed.backgroundImage)) return undefined;
      if (!transparent(computed.backgroundColor)) return computed.backgroundColor;
      current = current.parentElement;
    }
    return "rgba(0, 0, 0, 0)";
  };
  const ancestorsOpaque = (element: Element): boolean => {
    let current = element.parentElement;
    while (current) {
      if (Number.parseFloat(getComputedStyle(current).opacity || "1") !== 1) {
        return false;
      }
      if (current.matches(interactiveSelector)) break;
      current = current.parentElement;
    }
    return true;
  };
  const shadowRoots: ShadowRoot[] = [];
  const allElements: Element[] = [];
  const collectElements = (root: Document | ShadowRoot): void => {
    const elements = Array.from(root.querySelectorAll("*"));
    allElements.push(...elements);
    for (const element of elements) {
      if (!element.shadowRoot) continue;
      shadowRoots.push(element.shadowRoot);
      collectElements(element.shadowRoot);
    }
  };
  collectElements(document);
  const textIntersects = (rectangle: DOMRect): boolean =>
    allElements.some((element) => {
      const computed = getComputedStyle(element);
      if (
        computed.display === "none" ||
        computed.visibility !== "visible" ||
        Number.parseFloat(computed.opacity || "1") <= 0
      ) {
        return false;
      }
      return Array.from(element.childNodes).some((node) => {
        if (node.nodeType !== 3 || (node.textContent ?? "").trim() === "") {
          return false;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects()).some(
          (bounds) =>
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.bottom > 0 &&
            bounds.right > 0 &&
            bounds.top < innerHeight &&
            bounds.left < innerWidth &&
            rectangle.left < bounds.right &&
            rectangle.right > bounds.left &&
            rectangle.top < bounds.bottom &&
            rectangle.bottom > bounds.top
        );
      });
    });
  const visibleFontFamilies = new Set<string>();

  for (const [elementIndex, element] of allElements.entries()) {
    const computed = getComputedStyle(element);
    if (!visible(element, computed)) continue;
    const interactiveAsset = element.closest(interactiveSelector) !== null;
    if (element instanceof HTMLImageElement) {
      addImage(element.currentSrc || element.src, interactiveAsset);
    } else if (
      element.namespaceURI === "http://www.w3.org/2000/svg" &&
      element.tagName.toLowerCase() === "image"
    ) {
      addImage(
        element.getAttribute("href") ?? element.getAttribute("src") ?? "",
        interactiveAsset
      );
    }
    for (const declaration of [
      computed,
      getComputedStyle(element, "::before"),
      getComputedStyle(element, "::after")
    ]) {
      for (const property of styleProperties) {
        for (const source of styleSources(declaration.getPropertyValue(property))) {
          addImage(source, interactiveAsset);
        }
      }
    }
    if (
      Array.from(element.childNodes).some(
        (node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== ""
      )
    ) {
      const family = normalizedFamily(computed.fontFamily);
      if (family) visibleFontFamilies.add(family);
    }

    if (renderedIcons.length >= 32 || !element.closest(interactiveSelector)) {
      continue;
    }
    const source = directRenderableBackground(computed.backgroundImage);
    if (!source) continue;
    const rectangle = element.getBoundingClientRect();
    const boxWidth =
      element instanceof HTMLElement ? element.offsetWidth : rectangle.width;
    const boxHeight =
      element instanceof HTMLElement ? element.offsetHeight : rectangle.height;
    const backdrop = backdropColor(element);
    const zeroBorders = [
      computed.borderTopWidth,
      computed.borderRightWidth,
      computed.borderBottomWidth,
      computed.borderLeftWidth
    ].every((width) => Number.parseFloat(width || "0") === 0);
    const zeroPadding = [
      computed.paddingTop,
      computed.paddingRight,
      computed.paddingBottom,
      computed.paddingLeft
    ].every((width) => Number.parseFloat(width || "0") === 0);
    const hasGeneratedPseudoSurface = ["::before", "::after"].some(
      (pseudo) => {
        const content = getComputedStyle(element, pseudo).content.trim();
        return !["none", "normal"].includes(content);
      }
    );
    const directElementSafe =
      !element.querySelector("canvas,img,picture,svg,video") &&
      element.children.length === 0 &&
      !hasGeneratedPseudoSurface &&
      computed.transform === "none" &&
      computed.filter === "none" &&
      computed.boxShadow === "none" &&
      transparent(computed.backgroundColor) &&
      ancestorsOpaque(element) &&
      backdrop !== undefined &&
      !textIntersects(rectangle) &&
      zeroBorders;
    if (
      rectangle.width < 4 ||
      rectangle.height < 4 ||
      rectangle.width > 96 ||
      rectangle.height > 96 ||
      rectangle.width * rectangle.height > 4_096 ||
      !Number.isFinite(boxWidth) ||
      !Number.isFinite(boxHeight) ||
      boxWidth < 4 ||
      boxHeight < 4 ||
      boxWidth > 96 ||
      boxHeight > 96 ||
      boxWidth * boxHeight > 4_096 ||
      !zeroBorders ||
      !zeroPadding
    ) {
      continue;
    }
    renderedIcons.push({
      source,
      elementIndex,
      left: rectangle.left,
      top: rectangle.top,
      width: rectangle.width,
      height: rectangle.height,
      boxWidth,
      boxHeight,
      transform: computed.transform,
      directElementSafe,
      match: {
        captureSurface: "element",
        dimensions: {
          width: rectangle.width,
          height: rectangle.height
        },
        backgroundPosition: computed.backgroundPosition,
        backgroundRepeat: computed.backgroundRepeat,
        backgroundSize: computed.backgroundSize,
        opacity: computed.opacity,
        backdropColor: backdrop ?? "rgba(0, 0, 0, 0)"
      }
    });
  }

  const loadedFamilies = new Set(
    Array.from(document.fonts ?? [])
      .filter((face) => face.status === "loaded")
      .map((face) => normalizedFamily(face.family))
      .filter(Boolean)
  );
  const relatedFontFamily = (left: string, right: string): boolean =>
    left === right ||
    left.startsWith(`${right} `) ||
    right.startsWith(`${left} `);
  const visibleFontFaces = Array.from(document.fonts ?? [])
    .filter((face) => {
      const family = normalizedFamily(face.family);
      return (
        face.status === "loaded" &&
        [...visibleFontFamilies].some((visibleFamily) =>
          relatedFontFamily(visibleFamily, family)
        )
      );
    })
    .map((face) => {
      const family = face.family
        .trim()
        .replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
      const style = face.style.trim().toLowerCase();
      const weight = face.weight.trim().toLowerCase();
      const stretch = face.stretch.trim().toLowerCase();
      const display = face.display.trim().toLowerCase();
      const unicodeRange = face.unicodeRange.trim();
      return {
        family,
        style: ["normal", "italic", "oblique"].includes(style)
          ? (style as SceneFontFace["style"])
          : "normal",
        weight: /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(weight)
          ? weight
          : "normal",
        stretch: /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/.test(
          stretch
        )
          ? stretch
          : "normal",
        display: ["auto", "block", "swap", "fallback", "optional"].includes(
          display
        )
          ? (display as SceneFontFace["display"])
          : "block",
        ...(unicodeRange &&
        /^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i.test(
          unicodeRange
        )
          ? { unicodeRange }
          : {})
      };
    })
    .filter(
      (face, index, faces) =>
        face.family !== "" &&
        /^[^{};@<>"'\\\r\n]{1,120}$/.test(face.family) &&
        faces.findIndex(
          (candidate) =>
            normalizedFamily(candidate.family) === normalizedFamily(face.family) &&
            candidate.style === face.style &&
            candidate.weight === face.weight &&
            candidate.stretch === face.stretch
        ) === index
    )
    .slice(0, 32);
  const metricSamples = [
    "Hamburgefontsiv 0123456789",
    "MWmwilI1.,!?@",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz"
  ];
  const visibleFontMetrics = (() => {
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return [];
    const metricValue = (value: number): number =>
      Number.isFinite(value) ? Math.round(value * 1_024) / 1_024 : 0;
    return visibleFontFaces.flatMap((face) => {
      const weight =
        face.weight === "bold"
          ? "700"
          : /^[1-9]00$/.test(face.weight)
            ? face.weight
            : "400";
      const style = ["italic", "oblique"].includes(face.style)
        ? face.style
        : "normal";
      const font = `${style} ${weight} 16px "${face.family}"`;
      if (!document.fonts.check(font)) return [];
      context.font = font;
      const metrics = metricSamples.map((sample) => {
        const measured = context.measureText(sample);
        return [
          metricValue(measured.width),
          metricValue(measured.actualBoundingBoxAscent),
          metricValue(measured.actualBoundingBoxDescent)
        ];
      });
      return [{ ...face, metrics }];
    });
  })();
  const visitedSheets = new Set<CSSStyleSheet>();
  const visitRule = (rule: CSSRule): void => {
    if (fonts.length >= 32) return;
    if (rule instanceof CSSFontFaceRule) {
      const family = rule.style
        .getPropertyValue("font-family")
        .trim()
        .replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
      const familyKey = normalizedFamily(family);
      if (
        !family ||
        !visibleFontFamilies.has(familyKey) ||
        !loadedFamilies.has(familyKey) ||
        !/^[^{};@<>"'\\\r\n]{1,120}$/.test(family)
      ) {
        return;
      }
      const sourceMatches = [
        ...rule.style
          .getPropertyValue("src")
          .matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)
      ];
      for (const match of sourceMatches) {
        const source = safeHttpSource(match[1] ?? "");
        if (!source || fonts.some((font) => font.source === source)) continue;
        const style = rule.style.getPropertyValue("font-style").trim().toLowerCase();
        const weight = rule.style.getPropertyValue("font-weight").trim().toLowerCase();
        const stretch = rule.style.getPropertyValue("font-stretch").trim().toLowerCase();
        const display = rule.style.getPropertyValue("font-display").trim().toLowerCase();
        const unicodeRange = rule.style.getPropertyValue("unicode-range").trim();
        fonts.push({
          source,
          family,
          style: ["normal", "italic", "oblique"].includes(style)
            ? (style as SceneFontFace["style"])
            : "normal",
          weight: /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(weight)
            ? weight
            : "normal",
          stretch: /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/.test(
            stretch
          )
            ? stretch
            : "normal",
          display: ["auto", "block", "swap", "fallback", "optional"].includes(
            display
          )
            ? (display as SceneFontFace["display"])
            : "block",
          ...(unicodeRange &&
          /^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i.test(
            unicodeRange
          )
            ? { unicodeRange }
            : {})
        });
        break;
      }
      return;
    }
    for (const nested of Array.from((rule as CSSGroupingRule).cssRules ?? [])) {
      visitRule(nested);
    }
  };
  const visitSheet = (sheet: CSSStyleSheet): void => {
    if (visitedSheets.has(sheet) || fonts.length >= 32) return;
    visitedSheets.add(sheet);
    try {
      for (const rule of Array.from(sheet.cssRules ?? [])) visitRule(rule);
    } catch {
      const source = safeHttpSource(sheet.href ?? "");
      if (source && unreadableStyleSheets.size < 32) {
        unreadableStyleSheets.add(source);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visitSheet(sheet);
  for (const sheet of Array.from(document.adoptedStyleSheets ?? [])) {
    visitSheet(sheet);
  }
  for (const shadowRoot of shadowRoots) {
    for (const sheet of Array.from(shadowRoot.adoptedStyleSheets ?? [])) {
      visitSheet(sheet);
    }
    for (const owner of Array.from(
      shadowRoot.querySelectorAll("style,link[rel='stylesheet']")
    )) {
      const sheet = (owner as HTMLStyleElement | HTMLLinkElement).sheet;
      if (sheet) visitSheet(sheet);
    }
  }

  return {
    images: [
      ...priorityImages,
      ...[...images].filter((source) => !priorityImages.has(source))
    ].slice(0, 64),
    fonts: fonts.slice(0, 32),
    visibleFontFamilies: [
      ...visibleFontFamilies,
      ...[...loadedFamilies].filter((loadedFamily) =>
        [...visibleFontFamilies].some((visibleFamily) =>
          relatedFontFamily(visibleFamily, loadedFamily)
        )
      )
    ].filter((family, index, families) => families.indexOf(family) === index)
      .slice(0, 32),
    visibleFontFaces,
    visibleFontMetrics,
    unreadableStyleSheets: [...unreadableStyleSheets].slice(0, 32),
    renderedIcons
  };
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicAssetAddress(address: string, family: number): boolean {
  return (
    (family === 4 || family === 6) &&
    isIP(address) === family &&
    !(family === 6 && /^::ffff:/i.test(address)) &&
    !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
  );
}

function safeAssetUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const defaultPort =
    url.port === "" ||
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !defaultPort ||
    hostname === "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan")
  ) {
    return undefined;
  }
  return url;
}

async function resolvedPublicAddress(
  hostname: string
): Promise<{ address: string; family: 4 | 6 } | undefined> {
  try {
    const normalized = hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(normalized);
    const addresses = literalFamily
      ? [{ address: normalized, family: literalFamily }]
      : await lookup(normalized, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some(
        (entry) => !isPublicAssetAddress(entry.address, entry.family)
      )
    ) {
      return undefined;
    }
    const selected = addresses[0];
    return selected && (selected.family === 4 || selected.family === 6)
      ? { address: selected.address, family: selected.family }
      : undefined;
  } catch {
    return undefined;
  }
}

type DownloadedAsset = {
  bytes: Buffer;
  contentType: string;
};

export function decodePublicAssetBytes(
  bytes: Buffer,
  contentEncoding: string,
  maxOutputLength = 1_048_576
): Buffer | undefined {
  const normalized = contentEncoding.trim().toLowerCase();
  try {
    const decoded =
      normalized === "" || normalized === "identity"
        ? bytes
        : normalized === "gzip" || normalized === "x-gzip"
          ? gunzipSync(bytes, { maxOutputLength })
          : normalized === "br"
            ? brotliDecompressSync(bytes, { maxOutputLength })
            : normalized === "deflate"
              ? inflateSync(bytes, { maxOutputLength })
              : undefined;
    return decoded && decoded.byteLength > 0 && decoded.byteLength <= maxOutputLength
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

async function downloadPublicAsset(
  rawUrl: string,
  redirectsRemaining = 3,
  previousProtocol?: string,
  maxBytes = 1_048_576
): Promise<DownloadedAsset | undefined> {
  const url = safeAssetUrl(rawUrl);
  if (
    !url ||
    (previousProtocol === "https:" && url.protocol !== "https:")
  ) {
    return undefined;
  }
  const resolved = await resolvedPublicAddress(url.hostname);
  if (!resolved) return undefined;

  return new Promise((resolve) => {
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      url,
      {
        headers: {
          accept:
            "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,font/woff2;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "ShowKit-public-asset-fetch/1"
        },
        lookup: ((_hostname: string, options: unknown, callback: Function) => {
          if (
            options &&
            typeof options === "object" &&
            "all" in options &&
            (options as { all?: boolean }).all
          ) {
            callback(null, [resolved]);
          } else {
            callback(null, resolved.address, resolved.family);
          }
        }) as never
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          location &&
          redirectsRemaining > 0
        ) {
          response.resume();
          const nextUrl = (() => {
            try {
              return new URL(location, url).href;
            } catch {
              return undefined;
            }
          })();
          if (!nextUrl) {
            resolve(undefined);
            return;
          }
          void downloadPublicAsset(
            nextUrl,
            redirectsRemaining - 1,
            url.protocol,
            maxBytes
          ).then(resolve);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          resolve(undefined);
          return;
        }
        const declaredLength = Number(response.headers["content-length"] ?? "0");
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > maxBytes
        ) {
          response.destroy();
          resolve(undefined);
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const bytes = Buffer.from(chunk);
          byteLength += bytes.byteLength;
          if (byteLength > maxBytes) {
            response.destroy();
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          if (byteLength === 0 || byteLength > maxBytes) {
            resolve(undefined);
            return;
          }
          const bytes = decodePublicAssetBytes(
            Buffer.concat(chunks, byteLength),
            String(response.headers["content-encoding"] ?? ""),
            maxBytes
          );
          if (!bytes) {
            resolve(undefined);
            return;
          }
          resolve({
            bytes,
            contentType: String(response.headers["content-type"] ?? "")
              .split(";", 1)[0]!
              .trim()
              .toLowerCase()
          });
        });
        response.once("error", () => resolve(undefined));
        response.once("aborted", () => resolve(undefined));
      }
    );
    request.setTimeout(10_000, () => request.destroy());
    request.once("error", () => resolve(undefined));
    request.end();
  });
}

function safeSvg(bytes: Buffer): boolean {
  let svgText: string;
  try {
    svgText = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return false;
  }
  const svgWithoutDeclaration = svgText
    .replace(/^<\?xml\s+[^?]*\?>\s*/i, "")
    .replace(/\s+xmlns(?::[A-Za-z][\w.-]*)?\s*=\s*["'][^"']*["']/gi, "");
  const tags = [
    ...svgWithoutDeclaration.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)
  ].map((match) => match[1]?.toLowerCase() ?? "");
  const allowed = new Set([
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
  return (
    /^<svg\b/i.test(svgWithoutDeclaration) &&
    /<\/svg>\s*$/i.test(svgWithoutDeclaration) &&
    tags.every((tag) => allowed.has(tag)) &&
    !/<!DOCTYPE|<!ENTITY|<\?(?!xml\b)/i.test(svgWithoutDeclaration) &&
    !/<(?:script|style|foreignObject|iframe|object|embed|image|use)\b/i.test(
      svgWithoutDeclaration
    ) &&
    !/\son[a-z]+\s*=|(?:href|xlink:href)\s*=|javascript:|data:|url\s*\(|@import|expression\s*\(|(?:https?:)?\/\//i.test(
      svgWithoutDeclaration
    )
  );
}

export function isRasterizableStaticSvg(bytes: Buffer): boolean {
  let svgText: string;
  try {
    svgText = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return false;
  }
  const svgWithoutDeclaration = svgText.replace(
    /^<\?xml\s+[^?]*\?>\s*/i,
    ""
  );
  if (
    !/^<svg\b/i.test(svgWithoutDeclaration) ||
    !/<\/svg>\s*$/i.test(svgWithoutDeclaration) ||
    /<!DOCTYPE|<!ENTITY|<\?(?!xml\b)/i.test(svgWithoutDeclaration) ||
    /<(?:script|style|foreignObject|iframe|object|embed|a|animate|animateMotion|animateTransform|set)\b/i.test(
      svgWithoutDeclaration
    ) ||
    /\son[a-z]+\s*=|javascript:|@import|expression\s*\(/i.test(
      svgWithoutDeclaration
    )
  ) {
    return false;
  }
  const allowedTags = new Set([
    "circle",
    "clippath",
    "defs",
    "desc",
    "ellipse",
    "feblend",
    "fecolormatrix",
    "fecomposite",
    "feflood",
    "fegaussianblur",
    "feoffset",
    "filter",
    "g",
    "image",
    "line",
    "lineargradient",
    "mask",
    "path",
    "pattern",
    "polygon",
    "polyline",
    "radialgradient",
    "rect",
    "stop",
    "svg",
    "text",
    "title",
    "use"
  ]);
  const tags = [
    ...svgWithoutDeclaration.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)
  ].map((match) => match[1]?.toLowerCase() ?? "");
  if (!tags.every((tag) => allowedTags.has(tag))) return false;

  const safeEmbeddedImage = (value: string): boolean =>
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(
      value.trim()
    );
  for (const match of svgWithoutDeclaration.matchAll(
    /(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi
  )) {
    const value = match[1]?.trim() ?? "";
    if (
      !/^#[A-Za-z_][\w:.-]*$/.test(value) &&
      !safeEmbeddedImage(value)
    ) {
      return false;
    }
  }
  for (const match of svgWithoutDeclaration.matchAll(
    /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi
  )) {
    const value = match[1]?.trim() ?? "";
    if (
      !/^#[A-Za-z_][\w:.-]*$/.test(value) &&
      !safeEmbeddedImage(value)
    ) {
      return false;
    }
  }
  return true;
}

function safeBackgroundGeometryValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9+.,()%\-\s]+$/.test(value)
  );
}

async function rasterizeStaticSvgBackgrounds(
  sourcePage: Page,
  candidates: VisiblePageAssetInventory["renderedIcons"],
  downloads: Map<string, DownloadedAsset>
): Promise<RemoteAssetReplacement[]> {
  const eligible = candidates.filter((candidate) => {
    const download = downloads.get(candidate.source);
    return (
      download?.contentType === "image/svg+xml" &&
      isRasterizableStaticSvg(download.bytes) &&
      Number.isInteger(candidate.boxWidth) &&
      Number.isInteger(candidate.boxHeight) &&
      safeBackgroundGeometryValue(
        candidate.match.backgroundPosition ?? "0px 0px"
      ) &&
      safeBackgroundGeometryValue(
        candidate.match.backgroundSize ?? "auto"
      ) &&
      /^(?:repeat|no-repeat|repeat-x|repeat-y|space|round)(?:\s+(?:repeat|no-repeat|space|round))?$/.test(
        candidate.match.backgroundRepeat ?? "repeat"
      )
    );
  });
  if (eligible.length === 0) return [];
  const browser = sourcePage.context().browser();
  if (!browser) return [];

  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
    viewport: { width: 128, height: 128 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC"
  });
  let externalRequestAttempted = false;
  await context.route("**/*", async (route) => {
    const protocol = new URL(route.request().url()).protocol;
    if (protocol === "http:" || protocol === "https:") {
      externalRequestAttempted = true;
    }
    await route.abort();
  });
  const rasterPage = await context.newPage();
  const replacements: RemoteAssetReplacement[] = [];
  try {
    for (const candidate of eligible) {
      const download = downloads.get(candidate.source);
      if (!download) continue;
      externalRequestAttempted = false;
      const dataSource = `data:image/svg+xml;base64,${download.bytes.toString("base64")}`;
      const position = candidate.match.backgroundPosition ?? "0px 0px";
      const repeat = candidate.match.backgroundRepeat ?? "repeat";
      const size = candidate.match.backgroundSize ?? "auto";
      await rasterPage.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{background:transparent;margin:0;overflow:hidden}#icon{background-color:transparent;background-image:url("${dataSource}");background-position:${position};background-repeat:${repeat};background-size:${size};box-sizing:border-box;height:${candidate.boxHeight}px;width:${candidate.boxWidth}px}</style></head><body><div id="icon"></div></body></html>`,
        { waitUntil: "load" }
      );
      const icon = rasterPage.locator("#icon");
      const screenshot = await icon.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        omitBackground: true,
        scale: "css"
      });
      if (externalRequestAttempted) continue;
      const dimensions = pngDimensions(screenshot);
      if (
        !dimensions ||
        screenshot.byteLength === 0 ||
        screenshot.byteLength > 262_144 ||
        Math.abs(dimensions.width - candidate.boxWidth) > 1 ||
        Math.abs(dimensions.height - candidate.boxHeight) > 1
      ) {
        continue;
      }
      const payload: AssetPayload = {
        sha256: createHash("sha256").update(screenshot).digest("hex"),
        mimeType: "image/png",
        byteLength: screenshot.byteLength,
        base64: screenshot.toString("base64")
      };
      replacements.push({
        source: candidate.source,
        captureKind: "isolated-rendered-icon",
        match: {
          ...candidate.match,
          captureSurface: "background-image",
          boxDimensions: {
            width: candidate.boxWidth,
            height: candidate.boxHeight
          },
          transform: candidate.transform
        },
        payload
      });
    }
  } finally {
    await context.close();
  }
  return replacements;
}

function payloadFromDownload(
  download: DownloadedAsset,
  expectedKind: "image" | "font"
): AssetPayload | undefined {
  const { bytes } = download;
  const ascii = (start: number, end: number): string =>
    bytes.subarray(start, end).toString("ascii");
  const declared = download.contentType;
  const detected = (() => {
    if (
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ) {
      return "image/png" as const;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg" as const;
    }
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
      return "image/webp" as const;
    }
    if (
      bytes.byteLength >= 16 &&
      ascii(4, 8) === "ftyp" &&
      /^(?:avif|avis)$/.test(ascii(8, 12))
    ) {
      return "image/avif" as const;
    }
    if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
      return "image/gif" as const;
    }
    if (safeSvg(bytes)) return "image/svg+xml" as const;
    if (ascii(0, 4) === "wOF2") return "font/woff2" as const;
    return undefined;
  })();
  if (!detected) return undefined;
  if (expectedKind === "font" && detected !== "font/woff2") return undefined;
  if (expectedKind === "image" && !detected.startsWith("image/")) {
    return undefined;
  }
  const declaredAliases = new Set(
    detected === "font/woff2"
      ? [
          "font/woff2",
          "application/font-woff2",
          "application/x-font-woff2",
          "application/octet-stream"
        ]
      : detected === "image/jpeg"
        ? ["image/jpeg", "image/jpg", "application/octet-stream"]
        : [detected, "application/octet-stream"]
  );
  if (declared !== "" && !declaredAliases.has(declared)) return undefined;
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType: detected,
    byteLength: bytes.byteLength,
    base64: bytes.toString("base64")
  };
}

export function fontSourcesFromCss(
  cssBytes: Buffer,
  stylesheetUrl: string,
  visibleFontFamilies: Set<string>
): VisibleFontSource[] {
  let css: string;
  try {
    css = new TextDecoder("utf-8", { fatal: true })
      .decode(cssBytes)
      .replace(/\/\*[\s\S]*?\*\//g, "");
  } catch {
    return [];
  }
  const normalizeFamily = (value: string): string =>
    value
      .trim()
      .replace(/^(?:"([^"]+)"|'([^']+)'|([^,]+)).*$/, "$1$2$3")
      .trim()
      .toLocaleLowerCase("en-US");
  const declaration = (body: string, name: string): string => {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*:`, "i").exec(body);
    if (!match) return "";
    const start = match.index + match[0].length;
    let quote = "";
    let parenthesisDepth = 0;
    let escaped = false;
    for (let index = start; index < body.length; index += 1) {
      const character = body[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && quote !== "") {
        escaped = true;
        continue;
      }
      if (quote !== "") {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "(") {
        parenthesisDepth += 1;
        continue;
      }
      if (character === ")") {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        continue;
      }
      if (character === ";" && parenthesisDepth === 0) {
        return body.slice(start, index).trim();
      }
    }
    return body.slice(start).trim();
  };
  const discovered: VisibleFontSource[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
    if (discovered.length >= 32) break;
    const body = match[1] ?? "";
    const family = declaration(body, "font-family")
      .replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2")
      .trim();
    if (
      !family ||
      !visibleFontFamilies.has(normalizeFamily(family)) ||
      !/^[^{};@<>"'\\\r\n]{1,120}$/.test(family)
    ) {
      continue;
    }
    const src = declaration(body, "src");
    const sourceCandidates = [...src.matchAll(
      /url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/gi
    )];
    const selected =
      sourceCandidates.find((candidate) =>
        /woff2/i.test(candidate[2] ?? "")
      ) ??
      sourceCandidates.find((candidate) =>
        /\.woff2(?:[?#]|$)/i.test(candidate[1] ?? "")
      );
    if (!selected?.[1]) continue;
    const embeddedMatch = selected[1].match(
      /^data:(?:font\/woff2|application\/(?:font-woff2|x-font-woff2|octet-stream));base64,([A-Za-z0-9+/]+={0,2})$/i
    );
    let embeddedPayload: AssetPayload | undefined;
    if (embeddedMatch?.[1] && embeddedMatch[1].length <= 1_398_104) {
      try {
        const bytes = Buffer.from(embeddedMatch[1], "base64");
        if (
          bytes.byteLength > 0 &&
          bytes.byteLength <= 1_048_576 &&
          bytes.subarray(0, 4).toString("ascii") === "wOF2" &&
          bytes.toString("base64").replace(/=+$/, "") ===
            embeddedMatch[1].replace(/=+$/, "")
        ) {
          embeddedPayload = {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            mimeType: "font/woff2",
            byteLength: bytes.byteLength,
            base64: bytes.toString("base64")
          };
        }
      } catch {
        embeddedPayload = undefined;
      }
    }
    let source: string;
    if (embeddedPayload) {
      source = `showkit:embedded-font:${embeddedPayload.sha256}`;
    } else {
      try {
        source = new URL(selected[1], stylesheetUrl).href;
      } catch {
        continue;
      }
      if (!safeAssetUrl(source)) continue;
    }
    const style = declaration(body, "font-style").toLowerCase();
    const weight = declaration(body, "font-weight").toLowerCase();
    const stretch = declaration(body, "font-stretch").toLowerCase();
    const display = declaration(body, "font-display").toLowerCase();
    const unicodeRange = declaration(body, "unicode-range");
    discovered.push({
      source,
      ...(embeddedPayload ? { payload: embeddedPayload } : {}),
      family,
      style: ["normal", "italic", "oblique"].includes(style)
        ? (style as SceneFontFace["style"])
        : "normal",
      weight: /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/.test(weight)
        ? weight
        : "normal",
      stretch: /^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/.test(
        stretch
      )
        ? stretch
        : "normal",
      display: ["auto", "block", "swap", "fallback", "optional"].includes(
        display
      )
        ? (display as SceneFontFace["display"])
        : "block",
      ...(unicodeRange &&
      /^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i.test(
        unicodeRange
      )
        ? { unicodeRange }
        : {})
    });
  }
  return discovered;
}

export function importedStyleSheetsFromCss(
  cssBytes: Buffer,
  stylesheetUrl: string
): string[] {
  let css: string;
  try {
    css = new TextDecoder("utf-8", { fatal: true })
      .decode(cssBytes)
      .replace(/\/\*[\s\S]*?\*\//g, "");
  } catch {
    return [];
  }
  const sources = new Set<string>();
  for (const match of css.matchAll(
    /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi
  )) {
    if (sources.size >= 16 || !match[1]) break;
    try {
      const source = new URL(match[1], stylesheetUrl).href;
      if (safeAssetUrl(source)) sources.add(source);
    } catch {
      // Invalid imports are ignored and the font check remains fail-closed.
    }
  }
  return [...sources];
}

async function fontsFromUnreadableStyleSheets(
  inventory: VisiblePageAssetInventory
): Promise<VisibleFontSource[]> {
  const families = new Set(
    inventory.visibleFontFamilies.map((family) =>
      family.trim().toLocaleLowerCase("en-US")
    )
  );
  if (families.size === 0) return [];
  const discovered: VisibleFontSource[] = [];
  const queue = inventory.unreadableStyleSheets.map((source) => ({
    source,
    depth: 0
  }));
  const visited = new Set<string>();
  let aggregateCssBytes = 0;
  for (let cursor = 0; cursor < queue.length && visited.size < 32; cursor += 1) {
    const entry = queue[cursor];
    if (!entry || visited.has(entry.source) || entry.depth > 3) continue;
    visited.add(entry.source);
    const remainingCssBytes = 4 * 1_048_576 - aggregateCssBytes;
    if (remainingCssBytes <= 0) break;
    const download = await downloadPublicAsset(
      entry.source,
      3,
      undefined,
      remainingCssBytes
    );
    if (!download) continue;
    const contentType = download.contentType;
    if (
      !["text/css", "text/plain", "application/octet-stream"].includes(
        contentType
      )
    ) {
      continue;
    }
    aggregateCssBytes += download.bytes.byteLength;
    discovered.push(
      ...fontSourcesFromCss(download.bytes, entry.source, families)
    );
    if (entry.depth < 3) {
      for (const source of importedStyleSheetsFromCss(
        download.bytes,
        entry.source
      )) {
        if (!visited.has(source) && queue.length < 64) {
          queue.push({ source, depth: entry.depth + 1 });
        }
      }
    }
    if (discovered.length >= 32) break;
  }
  return discovered.slice(0, 32);
}

export function fontsFromObservedPublicRequests(
  inventory: VisiblePageAssetInventory,
  observedSources: string[]
): VisibleFontSource[] {
  const candidates = observedSources.flatMap((source) => {
    const url = safeAssetUrl(source);
    if (!url || !/\.woff2$/i.test(url.pathname)) return [];
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname).toLocaleLowerCase("en-US");
    } catch {
      pathname = url.pathname.toLocaleLowerCase("en-US");
    }
    return [{ source: url.href, pathname }];
  });
  const selected: VisibleFontSource[] = [];
  for (const face of inventory.visibleFontFaces) {
    const compactFamily = face.family
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/g, "");
    if (compactFamily.length < 4) continue;
    const candidate = candidates.find(
      (item) =>
        item.pathname.replace(/[^a-z0-9]+/g, "").includes(compactFamily) &&
        !selected.some((font) => font.source === item.source)
    );
    if (!candidate) continue;
    selected.push({
      source: candidate.source,
      family: face.family,
      style: face.style,
      weight: face.weight,
      stretch: face.stretch,
      display: face.display,
      ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {})
    });
    if (selected.length >= 16) break;
  }
  return selected;
}

const FONT_METRIC_SAMPLES = [
  "Hamburgefontsiv 0123456789",
  "MWmwilI1.,!?@",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz"
];

export function fontMetricSignaturesMatch(
  left: number[][],
  right: number[][],
  tolerance = 0.01
): boolean {
  return (
    left.length === FONT_METRIC_SAMPLES.length &&
    right.length === FONT_METRIC_SAMPLES.length &&
    left.every(
      (row, rowIndex) =>
        row.length === 3 &&
        right[rowIndex]?.length === 3 &&
        row.every(
          (value, columnIndex) =>
            Number.isFinite(value) &&
            Number.isFinite(right[rowIndex]?.[columnIndex]) &&
            Math.abs(value - right[rowIndex]![columnIndex]!) <= tolerance
        )
    )
  );
}

async function fontsFromObservedPublicMetrics(
  page: Page,
  inventory: VisiblePageAssetInventory,
  observedSources: string[],
  knownFonts: VisibleFontSource[]
): Promise<VisibleFontSource[]> {
  const normalizeFamily = (value: string): string =>
    value.trim().toLocaleLowerCase("en-US");
  const relatedFamily = (left: string, right: string): boolean => {
    const normalizedLeft = normalizeFamily(left);
    const normalizedRight = normalizeFamily(right);
    return (
      normalizedLeft === normalizedRight ||
      normalizedLeft.startsWith(`${normalizedRight} `) ||
      normalizedRight.startsWith(`${normalizedLeft} `)
    );
  };
  const unmatchedFaces = inventory.visibleFontMetrics
    .filter(
      (face) =>
        !knownFonts.some((font) => relatedFamily(face.family, font.family))
    )
    .slice(0, 4);
  if (unmatchedFaces.length === 0) return [];

  const candidateSources = [
    ...new Set(
      observedSources.flatMap((source) => {
        const url = safeAssetUrl(source);
        return url && /\.woff2$/i.test(url.pathname) ? [url.href] : [];
      })
    )
  ].slice(0, 24);
  if (candidateSources.length === 0) return [];

  const candidates = new Map<
    string,
    { source: string; payload: AssetPayload }
  >();
  let candidateBytes = 0;
  for (const source of candidateSources) {
    const remainingBytes = 8 * 1_048_576 - candidateBytes;
    if (remainingBytes <= 0) break;
    const response = await downloadPublicAsset(
      source,
      3,
      undefined,
      Math.min(1_048_576, remainingBytes)
    );
    const payload = response
      ? payloadFromDownload(response, "font")
      : undefined;
    if (!payload || candidates.has(payload.sha256)) continue;
    candidateBytes += payload.byteLength;
    candidates.set(payload.sha256, { source, payload });
  }
  if (candidates.size === 0) return [];

  const browser = page.context().browser();
  if (!browser) return [];
  const context = await browser.newContext({
    javaScriptEnabled: true,
    serviceWorkers: "block",
    viewport: { width: 32, height: 32 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC"
  });
  let externalRequestAttempted = false;
  await context.route("**/*", async (route) => {
    const protocol = new URL(route.request().url()).protocol;
    if (protocol === "http:" || protocol === "https:") {
      externalRequestAttempted = true;
    }
    await route.abort();
  });
  const metricPage = await context.newPage();
  const metricCache = new Map<string, number[][] | undefined>();
  const matched: VisibleFontSource[] = [];
  try {
    await metricPage.setContent(
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; font-src data:">',
      { waitUntil: "load" }
    );
    for (const [faceIndex, face] of unmatchedFaces.entries()) {
      const matchingCandidates = new Map<
        string,
        { source: string; payload: AssetPayload }
      >();
      for (const [candidateIndex, candidate] of [
        ...candidates.values()
      ].entries()) {
        const cacheKey = [
          candidate.payload.sha256,
          face.style,
          face.weight,
          face.stretch
        ].join("|");
        let metrics = metricCache.get(cacheKey);
        if (!metricCache.has(cacheKey)) {
          externalRequestAttempted = false;
          try {
            metrics = await metricPage.evaluate(
              async ({ base64, descriptor, family, samples }) => {
                const loadedFace = new FontFace(
                  family,
                  `url(data:font/woff2;base64,${base64})`,
                  descriptor
                );
                await loadedFace.load();
                document.fonts.add(loadedFace);
                try {
                  const canvas =
                    typeof OffscreenCanvas === "function"
                      ? new OffscreenCanvas(1, 1)
                      : document.createElement("canvas");
                  const context = canvas.getContext("2d");
                  if (!context) return undefined;
                  const weight =
                    descriptor.weight === "bold"
                      ? "700"
                      : /^[1-9]00$/.test(descriptor.weight)
                        ? descriptor.weight
                        : "400";
                  const style = ["italic", "oblique"].includes(
                    descriptor.style
                  )
                    ? descriptor.style
                    : "normal";
                  context.font = `${style} ${weight} 16px "${family}"`;
                  const metricValue = (value: number): number =>
                    Number.isFinite(value)
                      ? Math.round(value * 1_024) / 1_024
                      : 0;
                  return samples.map((sample) => {
                    const measured = context.measureText(sample);
                    return [
                      metricValue(measured.width),
                      metricValue(measured.actualBoundingBoxAscent),
                      metricValue(measured.actualBoundingBoxDescent)
                    ];
                  });
                } finally {
                  document.fonts.delete(loadedFace);
                }
              },
              {
                base64: candidate.payload.base64,
                descriptor: {
                  style: face.style,
                  weight: face.weight,
                  stretch: face.stretch
                },
                family: `ShowKitCandidate${faceIndex}_${candidateIndex}`,
                samples: FONT_METRIC_SAMPLES
              }
            );
          } catch {
            metrics = undefined;
          }
          if (externalRequestAttempted) metrics = undefined;
          metricCache.set(cacheKey, metrics);
        }
        if (
          metrics &&
          fontMetricSignaturesMatch(face.metrics, metrics)
        ) {
          matchingCandidates.set(candidate.payload.sha256, candidate);
        }
      }
      if (matchingCandidates.size !== 1) continue;
      const candidate = [...matchingCandidates.values()][0];
      if (!candidate) continue;
      matched.push({
        source: candidate.source,
        payload: candidate.payload,
        family: face.family,
        style: face.style,
        weight: face.weight,
        stretch: face.stretch,
        display: face.display,
        ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {})
      });
    }
  } finally {
    await context.close();
  }
  return matched;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return undefined;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

export async function preparePlaywrightPageAssets(
  page: Page,
  consent: PageAssetConsent,
  inventory: VisiblePageAssetInventory,
  observedPublicFontSources: string[] = []
): Promise<PreparedPageAssets> {
  const consentValid =
    (consent.mode === "public-page" && consent.consent === "requested") ||
    (consent.mode === "visible-session" && consent.consent === "confirmed");
  if (!consentValid) return { assets: [], fontFaces: [], replacements: [] };

  const stylesheetFonts = await fontsFromUnreadableStyleSheets(inventory);
  const observedFonts = fontsFromObservedPublicRequests(
    inventory,
    observedPublicFontSources
  );
  const directlyMappedFonts = [
    ...inventory.fonts,
    ...stylesheetFonts,
    ...observedFonts
  ];
  const metricMatchedFonts = await fontsFromObservedPublicMetrics(
    page,
    inventory,
    observedPublicFontSources,
    directlyMappedFonts
  );
  const allFonts = [...directlyMappedFonts, ...metricMatchedFonts].filter(
    (font, index, fonts) =>
      fonts.findIndex(
        (candidate) =>
          candidate.source === font.source &&
          candidate.family === font.family &&
          candidate.style === font.style &&
          candidate.weight === font.weight
      ) === index
  );
  const selectedFonts = allFonts.slice(0, 16);
  const imageBudget = Math.max(0, 64 - selectedFonts.length);

  const requested = [
    ...inventory.images
      .slice(0, imageBudget)
      .map((source) => ({ source, kind: "image" as const })),
    ...selectedFonts
      .filter((font) => !font.payload)
      .map((font) => ({
        source: font.source,
        kind: "font" as const,
        font
      }))
  ];
  const assets = new Map<string, AssetPayload>();
  const replacements: RemoteAssetReplacement[] = [];
  const fontFaces: SceneFontFace[] = [];
  const resolvedSources = new Set<string>();
  const downloadedImages = new Map<string, DownloadedAsset>();
  for (const font of selectedFonts) {
    if (!font.payload) continue;
    assets.set(font.payload.sha256, font.payload);
    resolvedSources.add(font.source);
    fontFaces.push({
      family: font.family,
      style: font.style,
      weight: font.weight,
      stretch: font.stretch,
      display: font.display,
      ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}),
      src: `./assets/${font.payload.sha256}.woff2`
    });
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < requested.length) {
      const item = requested[cursor];
      cursor += 1;
      if (!item) continue;
      const download = await downloadPublicAsset(item.source);
      if (download && item.kind === "image") {
        downloadedImages.set(item.source, download);
      }
      const payload = download
        ? payloadFromDownload(download, item.kind)
        : undefined;
      if (!payload) continue;
      assets.set(payload.sha256, payload);
      resolvedSources.add(item.source);
      if (item.kind === "image") {
        replacements.push({ source: item.source, payload });
      } else if (item.font) {
        fontFaces.push({
          family: item.font.family,
          style: item.font.style,
          weight: item.font.weight,
          stretch: item.font.stretch,
          display: item.font.display,
          ...(item.font.unicodeRange
            ? { unicodeRange: item.font.unicodeRange }
            : {}),
          src: `./assets/${payload.sha256}.woff2`
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, requested.length) }, () => worker())
  );

  const rasterizedBackgrounds = await rasterizeStaticSvgBackgrounds(
    page,
    inventory.renderedIcons.filter(
      (candidate) => !resolvedSources.has(candidate.source)
    ),
    downloadedImages
  );
  const renderedMatchKey = (
    source: string,
    match: NonNullable<RemoteAssetReplacement["match"]>
  ): string =>
    [
      source,
      match.dimensions.width,
      match.dimensions.height,
      match.boxDimensions?.width ?? "",
      match.boxDimensions?.height ?? "",
      match.backgroundPosition ?? "",
      match.backgroundRepeat ?? "",
      match.backgroundSize ?? "",
      match.opacity,
      match.captureSurface ?? "element",
      match.transform ?? ""
    ].join("|");
  const rasterizedMatchKeys = new Set<string>();
  for (const replacement of rasterizedBackgrounds) {
    if (!replacement.match || !replacement.payload.base64) continue;
    assets.set(replacement.payload.sha256, {
      ...replacement.payload,
      base64: replacement.payload.base64
    });
    replacements.push(replacement);
    rasterizedMatchKeys.add(
      renderedMatchKey(replacement.source, replacement.match)
    );
  }

  const viewport = page.viewportSize();
  for (const candidate of inventory.renderedIcons) {
    const rasterizedCandidateKey = renderedMatchKey(candidate.source, {
      ...candidate.match,
      captureSurface: "background-image",
      boxDimensions: {
        width: candidate.boxWidth,
        height: candidate.boxHeight
      },
      transform: candidate.transform
    });
    if (
      resolvedSources.has(candidate.source) ||
      rasterizedMatchKeys.has(rasterizedCandidateKey) ||
      !candidate.directElementSafe ||
      !viewport ||
      candidate.left < 0 ||
      candidate.top < 0 ||
      candidate.left + candidate.width > viewport.width ||
      candidate.top + candidate.height > viewport.height ||
      assets.size >= 64
    ) {
      continue;
    }
    try {
      const locator = page.locator("*").nth(candidate.elementIndex);
      if ((await locator.count()) !== 1) continue;
      const bounds = await locator.boundingBox();
      if (
        !bounds ||
        Math.abs(bounds.x - candidate.left) >= 0.5 ||
        Math.abs(bounds.y - candidate.top) >= 0.5 ||
        Math.abs(bounds.width - candidate.width) >= 0.5 ||
        Math.abs(bounds.height - candidate.height) >= 0.5
      ) {
        continue;
      }
      const screenshot = await locator.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css"
      });
      const dimensions = pngDimensions(screenshot);
      if (
        !dimensions ||
        screenshot.byteLength === 0 ||
        screenshot.byteLength > 262_144 ||
        dimensions.width > 256 ||
        dimensions.height > 256 ||
        Math.abs(dimensions.width / candidate.width - 1) > 0.15 ||
        Math.abs(dimensions.height / candidate.height - 1) > 0.15
      ) {
        continue;
      }
      const payload: AssetPayload = {
        sha256: createHash("sha256").update(screenshot).digest("hex"),
        mimeType: "image/png",
        byteLength: screenshot.byteLength,
        base64: screenshot.toString("base64")
      };
      assets.set(payload.sha256, payload);
      replacements.push({
        source: candidate.source,
        captureKind: "isolated-rendered-icon",
        match: candidate.match,
        payload
      });
    } catch {
      // The extractor remains fail-closed when the exact icon cannot be isolated.
    }
  }

  const assetList = [...assets.values()];
  const totalBytes = assetList.reduce(
    (total, asset) => total + asset.byteLength,
    0
  );
  if (assetList.length > 64 || totalBytes > 20 * 1_048_576) {
    return { assets: [], fontFaces: [], replacements: [] };
  }
  return {
    assets: assetList,
    fontFaces: fontFaces.slice(0, 32),
    replacements
  };
}
