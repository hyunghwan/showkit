import {
  brotliCompressSync,
  deflateSync,
  gzipSync
} from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  decodePublicAssetBytes,
  fontMetricSignaturesMatch,
  fontSourcesFromCss,
  fontsFromObservedPublicRequests,
  importedStyleSheetsFromCss,
  isPublicAssetAddress,
  isRasterizableStaticSvg,
  type VisiblePageAssetInventory
} from "./page-assets.js";

describe("public page asset address policy", () => {
  test.each([
    ["127.0.0.1", 4],
    ["10.0.0.1", 4],
    ["169.254.169.254", 4],
    ["::1", 6],
    ["::7f00:1", 6],
    ["64:ff9b::7f00:1", 6],
    ["64:ff9b:1::7f00:1", 6],
    ["2001::ffff:7f00:1", 6],
    ["2002:7f00:1::", 6],
    ["fc00::1", 6],
    ["fe80::1", 6]
  ])("rejects private or transition address %s", (address, family) => {
    expect(isPublicAssetAddress(address, family)).toBe(false);
  });

  test.each([
    ["1.1.1.1", 4],
    ["8.8.8.8", 4],
    ["2606:4700:4700::1111", 6],
    ["2001:4860:4860::8888", 6]
  ])("accepts public address %s", (address, family) => {
    expect(isPublicAssetAddress(address, family)).toBe(true);
  });
});

describe("isolated static SVG rasterization policy", () => {
  test("accepts a static sprite with internal references and embedded raster data", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const sprite = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
        <defs>
          <path id="shape" d="M0 0h16v16H0z"/>
          <clipPath id="clip"><circle cx="8" cy="8" r="8"/></clipPath>
          <filter id="shadow"><feGaussianBlur stdDeviation="1"/></filter>
          <pattern id="tile" width="1" height="1">
            <image href="data:image/png;base64,${png}" width="1" height="1"/>
          </pattern>
        </defs>
        <g clip-path="url(#clip)" filter="url(#shadow)">
          <use href="#shape" fill="url(#tile)"/>
        </g>
      </svg>
    `);
    expect(isRasterizableStaticSvg(sprite)).toBe(true);
  });

  test.each([
    '<svg><script>alert(1)</script></svg>',
    '<svg><foreignObject><p>unsafe</p></foreignObject></svg>',
    '<svg><image href="https://private.example/image.png"/></svg>',
    '<svg><use href="javascript:alert(1)"/></svg>',
    '<svg><path style="fill:url(https://private.example/x)"/></svg>'
  ])("rejects active or externally referenced SVG content", (svg) => {
    expect(isRasterizableStaticSvg(Buffer.from(svg))).toBe(false);
  });
});

describe("public page asset response decoding", () => {
  const woff2 = Buffer.concat([
    Buffer.from("wOF2", "ascii"),
    Buffer.alloc(64, 7)
  ]);

  test.each([
    ["identity", woff2],
    ["gzip", gzipSync(woff2)],
    ["br", brotliCompressSync(woff2)],
    ["deflate", deflateSync(woff2)]
  ])("decodes bounded %s responses", (encoding, bytes) => {
    expect(decodePublicAssetBytes(bytes, encoding)).toEqual(woff2);
  });

  test("rejects unknown, malformed, and oversized responses", () => {
    expect(decodePublicAssetBytes(woff2, "zstd")).toBeUndefined();
    expect(decodePublicAssetBytes(Buffer.from("not-gzip"), "gzip")).toBeUndefined();
    expect(
      decodePublicAssetBytes(
        gzipSync(Buffer.alloc(1_048_577, 1)),
        "gzip"
      )
    ).toBeUndefined();
  });
});

describe("public font source discovery", () => {
  test("matches only complete bounded font metric signatures", () => {
    const signature = [
      [224.32, 12.064, 3.488],
      [111.04, 11.84, 3.488],
      [262.88, 11.328, 2.592],
      [213.552, 12.064, 3.488]
    ];
    expect(
      fontMetricSignaturesMatch(
        signature,
        signature.map((row) => row.map((value) => value + 0.005))
      )
    ).toBe(true);
    expect(
      fontMetricSignaturesMatch(
        signature,
        signature.map((row, index) =>
          row.map((value) => value + (index === 0 ? 0.02 : 0))
        )
      )
    ).toBe(false);
    expect(fontMetricSignaturesMatch(signature, signature.slice(1))).toBe(false);
  });

  const inventory: VisiblePageAssetInventory = {
    images: [],
    fonts: [],
    visibleFontFamilies: ["amazon ember"],
    visibleFontFaces: [
      {
        family: "Amazon Ember",
        style: "normal",
        weight: "normal",
        stretch: "normal",
        display: "block"
      }
    ],
    visibleFontMetrics: [],
    unreadableStyleSheets: [],
    renderedIcons: []
  };

  test("matches an observed public WOFF2 filename to a visible family", () => {
    const credentialedCandidate = new URL(
      "https://cdn.example.test/AmazonEmber.woff2"
    );
    credentialedCandidate.username = "fixture-user";
    credentialedCandidate.password = "fixture-value";
    expect(
      fontsFromObservedPublicRequests(inventory, [
        "https://cdn.example.test/icons.woff2",
        "https://cdn.example.test/AmazonUIFont-amazonember_rg.woff2",
        credentialedCandidate.href
      ])
    ).toEqual([
      expect.objectContaining({
        source:
          "https://cdn.example.test/AmazonUIFont-amazonember_rg.woff2",
        family: "Amazon Ember",
        style: "normal",
        weight: "normal"
      })
    ]);
  });

  test("extracts visible WOFF2 faces and bounded public imports from CSS", () => {
    const css = Buffer.from(`
      @import url("./fonts.css");
      @font-face {
        font-family: "Amazon Ember";
        font-style: normal;
        font-weight: 400;
        src: url("../fonts/amazon-ember.woff2") format("woff2");
      }
      @font-face {
        font-family: "Unused";
        src: url("../fonts/unused.woff2") format("woff2");
      }
    `);
    expect(
      fontSourcesFromCss(
        css,
        "https://cdn.example.test/css/app.css",
        new Set(["amazon ember"])
      )
    ).toEqual([
      expect.objectContaining({
        source: "https://cdn.example.test/fonts/amazon-ember.woff2",
        family: "Amazon Ember",
        weight: "400"
      })
    ]);
    expect(
      importedStyleSheetsFromCss(
        css,
        "https://cdn.example.test/css/app.css"
      )
    ).toEqual(["https://cdn.example.test/css/fonts.css"]);
  });

  test("extracts a bounded embedded WOFF2 face without retaining its data URL", () => {
    const bytes = Buffer.concat([
      Buffer.from("wOF2", "ascii"),
      Buffer.alloc(64, 9)
    ]);
    const css = Buffer.from(`
      @font-face {
        font-family: "Amazon Ember";
        font-style: normal;
        font-weight: 400;
        src: url("data:font/woff2;base64,${bytes.toString("base64")}") format("woff2");
      }
    `);
    const [font] = fontSourcesFromCss(
      css,
      "https://cdn.example.test/css/fonts.css",
      new Set(["amazon ember"])
    );
    expect(font).toEqual(
      expect.objectContaining({
        source: expect.stringMatching(/^showkit:embedded-font:[a-f0-9]{64}$/),
        family: "Amazon Ember",
        weight: "400",
        payload: expect.objectContaining({
          mimeType: "font/woff2",
          byteLength: bytes.byteLength,
          base64: bytes.toString("base64")
        })
      })
    );
    expect(JSON.stringify(font)).not.toContain("data:font/woff2");
  });
});
