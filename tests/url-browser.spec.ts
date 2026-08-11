import { expect, test } from "@playwright/test";
import {
  DEFAULT_SECRET_PATTERN_SOURCES,
  SCHEMA_VERSION,
  extractSceneKernel,
  readFrozenSceneTransferKernel
} from "@showkit/cli";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureScene } from "../packages/cli/src/capture/browser.js";
import { createPlayerFiles } from "../packages/cli/src/player/assets.js";
import {
  parseCaptureTarget,
  resolveCaptureTarget
} from "../packages/cli/src/capture/session.js";
import { captureFailure } from "../packages/cli/src/commands.js";
import {
  collectVisiblePageAssetInventory,
  preparePlaywrightPageAssets
} from "../packages/cli/src/capture/page-assets.js";
import {
  collectPageFontFaceDescriptors,
  collectRenderedIconCandidatesInPage,
  createCodexBrowserAdapter
} from "../skills/showkit/scripts/capture-browser-session.mjs";

const sessionCanary = "SHOWKIT_SECRET_CANARY_BROWSER_STORAGE_8C42";
const queryCanary = "URL_QUERY_SECRET_BROWSER_5A17";

const baseOptions = {
  targetPresent: true,
  scanOnly: false,
  stepIndex: 0,
  secretPatternSources: [...DEFAULT_SECRET_PATTERN_SOURCES],
  sensitiveSelectors: [] as string[],
  remoteAssetPolicy: "decorative-remove" as const,
  targetErrorCode: "BrowserTargetAmbiguous" as const
};

test.use({
  storageState: {
    cookies: [
      {
        name: "session",
        value: sessionCanary,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax"
      }
    ],
    origins: [
      {
        origin: "http://127.0.0.1:4173",
        localStorage: [
          {
            name: "session",
            value: sessionCanary
          }
        ]
      }
    ]
  }
});

test("extracts 5 signed-in HTML steps without reading session values or URL secrets", async ({
  page
}) => {
  await page.goto(
    `http://127.0.0.1:4173/signed-in/index.html?token=${queryCanary}#private`
  );
  const names = ["Overview", "Reports", "Filters", "Activity", "Settings"];
  const results: unknown[] = [];

  for (const [stepIndex, name] of names.entries()) {
    const target = page.getByRole("button", { name, exact: true });
    await expect(target).toHaveCount(1);
    const result = await target.evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: `sk-step-${stepIndex + 1}`,
      stepIndex
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.scanOnly) continue;
    expect(result.target).toEqual(
      expect.objectContaining({
        role: "button",
        name
      })
    );
    expect(result.html).not.toContain(sessionCanary);
    expect(result.html).not.toContain(queryCanary);
    expect(result.html).not.toMatch(/<script|<form|https?:\/\//i);
    results.push(result);
    await target.click();
  }

  expect(results).toHaveLength(5);
  await expect(page.getByRole("heading", { name: "Settings is ready" })).toBeVisible();
});

test("does not mutate the live DOM while deriving a scene", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/signed-in/index.html");
  await page.evaluate(() => {
    const state = {
      count: 0,
      observer: new MutationObserver((records) => {
        state.count += records.filter((record) => record.type === "attributes").length;
      })
    };
    state.observer.observe(document.documentElement, {
      attributes: true,
      subtree: true
    });
    Object.defineProperty(globalThis, "__showkitMutationState", {
      value: state,
      configurable: true
    });
  });

  const result = await page
    .getByRole("button", { name: "Overview", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-overview"
    });
  expect(result.ok).toBe(true);
  const mutationCount = await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __showkitMutationState: {
          count: number;
          observer: MutationObserver;
        };
      }
    ).__showkitMutationState;
    state.observer.disconnect();
    return state.count;
  });
  expect(mutationCount).toBe(0);
});

test("rejects full-scene CSS and SVG image surfaces without a raster fallback", async ({
  page
}) => {
  const raster =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  for (const markup of [
    `
      <style>
        html, body, main { width: 100%; height: 100%; margin: 0; }
        main { background: url("${raster}") center / cover no-repeat; }
        button { position: fixed; z-index: 2; top: 20px; left: 20px; }
      </style>
      <main><button type="button">Continue</button></main>
    `,
    `
      <style>
        html, body, main, svg { width: 100%; height: 100%; margin: 0; }
        svg { position: fixed; inset: 0; }
        button { position: fixed; z-index: 2; top: 20px; left: 20px; }
      </style>
      <main>
        <svg aria-label="Captured product image">
          <image href="${raster}" width="100%" height="100%"></image>
        </svg>
        <button type="button">Continue</button>
      </main>
    `,
    `
      <style>
        html, body, main { width: 100%; height: 100%; margin: 0; }
        main::before {
          background: url("${raster}") center / cover no-repeat;
          content: "";
          height: 100vh;
          inset: 0;
          position: fixed;
          width: 100vw;
        }
        button { position: fixed; z-index: 2; top: 20px; left: 20px; }
      </style>
      <main><button type="button">Continue</button></main>
    `
  ]) {
    await page.setContent(markup);
    const result = await page
      .getByRole("button", { name: "Continue", exact: true })
      .evaluate(extractSceneKernel, {
        ...baseOptions,
        anchorId: "sk-continue"
      });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        blocker: expect.objectContaining({
          code: "UnsupportedSurface",
          category: "full-scene-raster"
        })
      })
    );
  }
});

test("keeps a full-viewport CSS gradient as semantic styling", async ({
  page
}) => {
  await page.setContent(`
    <style>
      html, body, main { width: 100%; height: 100%; margin: 0; }
      main { background: linear-gradient(135deg, #ffffff, #e8eefc); }
    </style>
    <main><button type="button">Continue</button></main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue"
    });
  expect(result.ok).toBe(true);
});

test("builds evidence only from captured visible semantic nodes", async ({
  page
}) => {
  const hiddenCanary = "SHOWKIT_HIDDEN_EVIDENCE_CANARY_3D91";
  await page.setContent(`
    <main>
      <button type="button">Open assurance</button>
      <p hidden>${hiddenCanary}</p>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Open assurance", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-assurance"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.evidenceTexts).toEqual(["Open assurance"]);
  expect(JSON.stringify(result)).not.toContain(hiddenCanary);
});

test("resolves every browser-session target strategy in page scope", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <a href="/docs">Open docs</a>
      <button type="button" data-testid="filters-trigger">Open filters</button>
      <button type="button" data-testid="filters-trigger">Open sorting</button>
      <button type="button" aria-label="Account menu"></button>
      <label for="project-query">Project query</label>
      <input id="project-query" type="search">
      <label for="zoom-level">Zoom level</label>
      <input id="zoom-level" type="range">
      <a href="#install" title="Install CLI">Install CLI</a>
      <button type="button"><span>Review activity</span></button>
      <button type="button">
        <span hidden>SHOWKIT_HOSTILE_HIDDEN_TARGET</span>
        <span>Open safe target</span>
      </button>
      <button type="button">
        <span aria-hidden="true">+</span>
        <span>Add filter</span>
      </button>
      <button type="button">
        <span>Date</span>
        <span>Add dates</span>
      </button>
      <span id="hidden-option-label" aria-hidden="true">
        <img alt="Full Pink">
        <span hidden>with savings</span>
        <span>$31.99</span>
      </span>
      <input type="submit" role="radio" aria-labelledby="hidden-option-label">
    </main>
  `);
  const targets = [
    {
      scopeTarget: {
        strategy: "href" as const,
        path: "/docs",
        name: "Open docs"
      },
      expectedName: "Open docs"
    },
    {
      scopeTarget: {
        strategy: "test-id" as const,
        testId: "filters-trigger",
        name: "Open filters"
      },
      expectedName: "Open filters"
    },
    {
      scopeTarget: {
        strategy: "label" as const,
        name: "Account menu"
      },
      expectedName: "Account menu"
    },
    {
      scopeTarget: {
        strategy: "label" as const,
        name: "Project query"
      },
      expectedName: "Project query"
    },
    {
      scopeTarget: {
        strategy: "role" as const,
        role: "slider",
        name: "Zoom level"
      },
      expectedName: "Zoom level"
    },
    {
      scopeTarget: {
        strategy: "title" as const,
        name: "Install CLI"
      },
      expectedName: "Install CLI"
    },
    {
      scopeTarget: {
        strategy: "visible-text" as const,
        name: "Review activity"
      },
      expectedName: "Review activity"
    },
    {
      scopeTarget: {
        strategy: "role" as const,
        role: "button",
        name: "Open safe target"
      },
      expectedName: "Open safe target"
    },
    {
      scopeTarget: {
        strategy: "role" as const,
        role: "button",
        name: "Add filter"
      },
      expectedName: "Add filter"
    },
    {
      scopeTarget: {
        strategy: "role" as const,
        role: "button",
        name: "Date Add dates"
      },
      expectedName: "Date Add dates"
    },
    {
      scopeTarget: {
        strategy: "role" as const,
        role: "radio",
        name: "Full Pink with savings $31.99"
      },
      expectedName: "Full Pink with savings $31.99"
    }
  ];

  for (const [index, target] of targets.entries()) {
    const result = await page.evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: `sk-browser-target-${index + 1}`,
      scopeTarget: target.scopeTarget
    });
    expect(
      result.ok,
      JSON.stringify({ index, result })
    ).toBe(true);
    if (!result.ok || result.scanOnly) continue;
    expect(result.target?.name).toBe(target.expectedName);
  }
});

test("uses the target name to disambiguate repeated browser-session test IDs", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <span data-testid="filter-chip" role="listitem" tabindex="0">Date and time</span>
      <span data-testid="filter-chip" role="listitem" tabindex="0">Amount</span>
      <button type="button" data-testid="amount-trigger" aria-label="Amount" data-result="Exact amount"></button>
      <button type="button" data-testid="amount-trigger" aria-label="Amount due" data-result="Amount due"></button>
      <span id="date-trigger-label">Date and time</span>
      <button type="button" data-testid="date-trigger" aria-labelledby="date-trigger-label" data-result="Labelled by"></button>
      <label for="currency-trigger">Currency</label>
      <input id="currency-trigger" type="checkbox" data-testid="currency-trigger" data-result="Associated label">
      <input type="button" data-testid="apply-trigger" value="Apply" data-result="Input value">
      <output id="selection">No filter selected</output>
      <script>
        for (const chip of document.querySelectorAll('[data-testid="filter-chip"]')) {
          chip.addEventListener("click", () => {
            document.querySelector("#selection").textContent = chip.textContent + " opened";
          });
        }
        for (const target of document.querySelectorAll("[data-result]")) {
          target.addEventListener("click", () => {
            document.querySelector("#selection").textContent = target.dataset.result;
          });
        }
      </script>
    </main>
  `);
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        waitForTimeout: (milliseconds: number) => page.waitForTimeout(milliseconds),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options),
        getByTestId: (testId: string) => page.getByTestId(testId)
      },
      url: () => Promise.resolve(page.url())
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 }
  });

  await adapter.performAction(
    {
      strategy: "test-id",
      testId: "filter-chip",
      name: "Amount"
    },
    "disclose"
  );

  await expect(page.locator("#selection")).toHaveText("Amount opened");

  const accessibleNameTargets = [
    {
      target: {
        strategy: "test-id" as const,
        testId: "amount-trigger",
        name: "Amount"
      },
      expected: "Exact amount"
    },
    {
      target: {
        strategy: "test-id" as const,
        testId: "date-trigger",
        name: "Date and time"
      },
      expected: "Labelled by"
    },
    {
      target: {
        strategy: "test-id" as const,
        testId: "currency-trigger",
        name: "Currency"
      },
      expected: "Associated label"
    },
    {
      target: {
        strategy: "test-id" as const,
        testId: "apply-trigger",
        name: "Apply"
      },
      expected: "Input value"
    }
  ];

  for (const { target, expected } of accessibleNameTargets) {
    await adapter.performAction(target, "disclose");
    await expect(page.locator("#selection")).toHaveText(expected);
  }
});

test("keeps browser-session inspect actions read-only", async ({ page }) => {
  await page.setContent(`
    <main>
      <button type="button">Defer action to human</button>
      <output id="selection">Unchanged</output>
      <script>
        document.querySelector("button").addEventListener("click", () => {
          document.querySelector("#selection").textContent = "Selected";
        });
      </script>
    </main>
  `);
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options)
      },
      url: () => Promise.resolve(page.url())
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1440, height: 900 }
  });

  await adapter.performAction(
    {
      strategy: "role",
      role: "button",
      name: "Defer action to human"
    },
    "inspect"
  );

  await expect(page.locator("#selection")).toHaveText("Unchanged");
});

test("normalizes absolute browser-session href targets and follows the matched URL", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <a href="https://example.com/docs">Open guide</a>
      <a href="/docs">Open archive</a>
      <a href="https://example.com/help">Open guide</a>
    </main>
  `);
  const navigatedUrls: string[] = [];
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options)
      },
      url: () => Promise.resolve(page.url()),
      goto: (url: string) => {
        navigatedUrls.push(url);
        return Promise.resolve();
      }
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 }
  });

  await expect(
    adapter.targetStatus({
      strategy: "href",
      path: "/docs",
      name: "Open guide"
    })
  ).resolves.toEqual({ matchedCount: 1, visibleCount: 1 });

  await adapter.performAction(
    {
      strategy: "href",
      path: "/docs",
      name: "Open guide"
    },
    "navigate"
  );

  expect(navigatedUrls).toEqual(["https://example.com/docs"]);
});

test("waits through a transient action state before accepting the durable state", async ({
  page
}) => {
  await page.setContent(`
    <button type="button">Open panel</button>
    <output>Closed</output>
    <script>
      document.querySelector("button").addEventListener("click", () => {
        document.querySelector("output").textContent = "Opening";
        setTimeout(() => {
          document.querySelector("output").textContent = "Ready";
        }, 90);
      });
    </script>
  `);
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options)
      },
      url: () => Promise.resolve(page.url())
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 }
  });

  const startedAt = Date.now();
  await adapter.performAction(
    {
      strategy: "role",
      role: "button",
      name: "Open panel"
    },
    "disclose"
  );

  await expect(page.locator("output")).toHaveText("Ready");
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
});

test("rejects a transient action state that returns to the baseline", async ({
  page
}) => {
  await page.setContent(`
    <button type="button">Open panel</button>
    <output>Closed</output>
    <script>
      document.querySelector("button").addEventListener("click", () => {
        document.querySelector("output").textContent = "Opening";
        setTimeout(() => {
          document.querySelector("output").textContent = "Closed";
        }, 90);
      });
    </script>
  `);
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options)
      },
      url: () => Promise.resolve(page.url())
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 }
  });

  await expect(
    adapter.performAction(
      {
        strategy: "role",
        role: "button",
        name: "Open panel"
      },
      "disclose"
    )
  ).rejects.toThrow("did not change the visible state");
  await expect(page.locator("output")).toHaveText("Closed");
});

test("centers a capture target that is too close to the viewport edge", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`
    <main style="height:1600px;position:relative">
      <a href="#ready" style="position:absolute;top:670px">Open report</a>
      <div id="ready" style="position:absolute;top:1500px">Ready</div>
    </main>
  `);
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options)
      },
      url: () => Promise.resolve(page.url())
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 }
  });

  await adapter.prepareTargetForCapture({
    strategy: "role",
    role: "link",
    name: "Open report"
  });

  const positioned = await page
    .getByRole("link", { name: "Open report", exact: true })
    .evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return { top: rectangle.top, bottom: rectangle.bottom, scrollY };
    });
  expect(positioned.scrollY).toBeGreaterThan(0);
  expect(positioned.top).toBeGreaterThan(240);
  expect(positioned.bottom).toBeLessThan(480);
});

test("resolves the viewport target when an offscreen duplicate has the same role and name", async ({
  page
}) => {
  await page.setContent(`
    <main style="min-height:1600px">
      <a href="#details">Details</a>
      <a href="#details" style="position:absolute;top:1200px">Details</a>
    </main>
  `);
  const result = await page.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-details",
    scopeTarget: {
      strategy: "role",
      role: "link",
      name: "Details"
    }
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.target).toEqual(
    expect.objectContaining({
      role: "link",
      name: "Details",
      bounds: expect.objectContaining({
        y: expect.any(Number)
      })
    })
  );
  expect(result.target?.bounds.y).toBeLessThan(0.2);
});

test("matches Playwright's native table roles and accessible names", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <table>
        <caption>Expense queue</caption>
        <thead>
          <tr><th>Merchant</th><th>Amount</th></tr>
        </thead>
        <tbody>
          <tr><th>App review</th><td>$42</td></tr>
        </tbody>
      </table>
      <table role="grid" aria-label="Review grid">
        <tbody><tr><td>Grid amount</td></tr></tbody>
      </table>
      <table>
        <tbody><tr><th>Quarter</th><th>Region</th><td>Total</td></tr></tbody>
      </table>
      <table role="future-role presentation">
        <tbody><tr><td>Decorative value</td></tr></tbody>
      </table>
      <table role="presentation" aria-label="Recovered table">
        <tbody><tr><td>ARIA conflict cell</td></tr></tbody>
      </table>
      <table role="presentation" tabindex="0">
        <tbody><tr><td>Focusable row</td></tr></tbody>
      </table>
      <span id="table-description">Table description</span>
      <table role="presentation" aria-describedby="table-description">
        <tbody><tr><td>Described row</td></tr></tbody>
      </table>
      <table>
        <tbody role="presentation"><tr><td>Decorative section</td></tr></tbody>
        <tbody><tr role="presentation"><td>Decorative row cell</td></tr></tbody>
      </table>
      <label for="receipt">Upload receipt</label>
      <input id="receipt" type="file">
      <datalist id="people"><option value="Ada"></option></datalist>
      <input list="people" aria-label="People">
      <select size="2" aria-label="Choices">
        <option>One</option><option>Two</option>
      </select>
    </main>
  `);
  const targets = [
    { role: "table", name: "Expense queue" },
    { role: "row", name: "App review $42" },
    { role: "columnheader", name: "Merchant" },
    { role: "rowheader", name: "App review" },
    { role: "columnheader", name: "Quarter" },
    { role: "rowheader", name: "Region" },
    { role: "cell", name: "$42" },
    { role: "grid", name: "Review grid" },
    { role: "gridcell", name: "Grid amount" },
    { role: "table", name: "Recovered table" },
    { role: "row", name: "Focusable row" },
    { role: "row", name: "Described row" },
    { role: "button", name: "Upload receipt" },
    { role: "combobox", name: "People" },
    { role: "listbox", name: "Choices" }
  ];

  for (const [index, target] of targets.entries()) {
    await expect(
      page.getByRole(target.role as never, {
        name: target.name,
        exact: true
      })
    ).toHaveCount(1);
    const result = await page.evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: `sk-table-${index + 1}`,
      scopeTarget: {
        strategy: "role" as const,
        role: target.role,
        name: target.name
      }
    });
    expect(
      result.ok,
      `${target.role} ${target.name}: ${JSON.stringify(result)}`
    ).toBe(true);
    if (!result.ok || result.scanOnly) continue;
    expect(result.target).toEqual(
      expect.objectContaining({
        role: target.role,
        name: target.name
      })
    );
  }

  const recoveredTable = page.getByRole("table", {
    name: "Recovered table",
    exact: true
  });
  const capturedTable = await captureScene(page, {
    target: recoveredTable,
    captureTarget: {
      strategy: "role",
      role: "table",
      name: "Recovered table"
    },
    anchorId: "sk-recovered-table"
  });
  expect(capturedTable.scene.target).toEqual(
    expect.objectContaining({ role: "table", name: "Recovered table" })
  );
  const fileTarget = page.getByRole("button", {
    name: "Upload receipt",
    exact: true
  });
  const capturedFile = await captureScene(page, {
    target: fileTarget,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Upload receipt"
    },
    anchorId: "sk-upload-receipt"
  });
  expect(capturedFile.scene.target).toEqual(
    expect.objectContaining({ role: "button", name: "Upload receipt" })
  );
  const replay = await page.context().newPage();
  try {
    await replay.setContent(capturedTable.scene.html);
    await expect(
      replay.getByRole("button", { name: "Upload receipt", exact: true })
    ).toHaveCount(1);
    await expect(
      replay.getByRole("combobox", { name: "People", exact: true })
    ).toHaveCount(1);
    await expect(
      replay.getByRole("listbox", { name: "Choices", exact: true })
    ).toHaveCount(1);
  } finally {
    await replay.close();
  }

  for (const [index, target] of [
    { role: "row", name: "Decorative value" },
    { role: "row", name: "Decorative section" },
    { role: "cell", name: "Decorative row cell" }
  ].entries()) {
    const presentationalTarget = await page.evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: `sk-presentational-${index + 1}`,
      scopeTarget: {
        strategy: "role" as const,
        ...target
      }
    });
    expect(presentationalTarget).toEqual(
      expect.objectContaining({
        ok: false,
        blocker: expect.objectContaining({ category: "target-missing" })
      })
    );
  }
});

test("captures in isolated worlds without HTML element constructors", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <label for="receipt">Upload evidence</label>
      <input id="receipt" type="file">
      <datalist id="people"><option value="Ada"></option></datalist>
      <input list="people" aria-label="People">
      <select size="2" aria-label="Choices">
        <option selected>One</option><option>Two</option>
      </select>
      <details open><summary>Policy details</summary><p>Visible policy</p></details>
      <textarea placeholder="Add a note"></textarea>
      <img alt="Report thumbnail" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    </main>
  `);
  await page.evaluate(() => {
    for (const name of [
      "HTMLElement",
      "HTMLDetailsElement",
      "HTMLImageElement",
      "HTMLInputElement",
      "HTMLOptionElement",
      "HTMLSelectElement",
      "HTMLTextAreaElement"
    ]) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: undefined,
        writable: true
      });
    }
  });

  const target = page.getByRole("button", {
    name: "Upload evidence",
    exact: true
  });
  const captured = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Upload evidence"
    },
    anchorId: "sk-isolated-constructor-free"
  });

  expect(captured.scene.target).toEqual(
    expect.objectContaining({ role: "button", name: "Upload evidence" })
  );
  expect(captured.scene.html).toContain("Upload evidence");
  expect(captured.scene.html).toContain("selected");
  expect(captured.scene.html).toContain("open");
  expect(captured.scene.html).toContain("Add a note");
});

test("preserves safe live control state through capture and the final player", async ({
  browser,
  page
}) => {
  await page.setContent(`
    <main>
      <details open>
        <summary>More options</summary>
        <input type="button" value="Approve" style="height:36px;width:100px">
        <label><input id="keep-open" type="checkbox"> Keep open</label>
        <select aria-label="Choices" size="2">
          <option value="one">One</option>
          <option value="two">Two</option>
        </select>
        <label for="receipt-state">Upload receipt</label>
        <input id="receipt-state" type="file">
      </details>
    </main>
  `);
  await page.getByRole("checkbox", { name: "Keep open", exact: true }).check();
  await page.getByRole("listbox", { name: "Choices", exact: true }).selectOption("two");
  const target = page.getByRole("button", { name: "Approve", exact: true });
  const captured = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Approve"
    },
    anchorId: "sk-state-approve"
  });

  const replay = await page.context().newPage();
  try {
    await replay.setContent(captured.scene.html);
    await expect(replay.locator("details")).toHaveAttribute("open", "");
    await expect(
      replay.getByRole("checkbox", { name: "Keep open", exact: true })
    ).toBeChecked();
    const replaySelectedOption = replay
      .getByRole("listbox", { name: "Choices", exact: true })
      .locator("option:checked");
    await expect(replaySelectedOption).toHaveText("Two");
    await expect(replaySelectedOption).toHaveAttribute("selected", "");
    await expect(
      replay.getByRole("button", { name: "Upload receipt", exact: true })
    ).toHaveCount(1);
  } finally {
    await replay.close();
  }

  const playerNodes = structuredClone(captured.scene.nodes);
  const playerRoot = playerNodes[0];
  if (playerRoot?.type !== "element") throw new Error("Expected scene root.");
  playerRoot.children.push({
    type: "element",
    tag: "input",
    attributes: {
      type: "password",
      value: "SHOWKIT_PLAYER_PASSWORD_VALUE_CANARY"
    },
    styles: {},
    children: []
  });
  let deepPlayerNode: (typeof playerRoot.children)[number] = {
    type: "element",
    tag: "span",
    attributes: { title: "deep-player-end" },
    styles: {},
    children: []
  };
  for (let depth = 0; depth < 300; depth += 1) {
    deepPlayerNode = {
      type: "element",
      tag: "span",
      attributes: {},
      styles: {},
      children: [deepPlayerNode]
    };
  }
  playerRoot.children.push(deepPlayerNode);
  const playerScene = { ...captured.scene, nodes: playerNodes };
  const files = createPlayerFiles(
    {
      steps: [{ id: "state", scene: playerScene }],
      terminalScene: playerScene,
      redaction: { policyChecksPassed: true, fullSceneRasterCount: 0 }
    } as never,
    {
      title: "State fidelity",
      goal: "Verify safe state replay.",
      locale: "en-US",
      welcome: {
        title: "State fidelity",
        body: "Verify safe state replay.",
        actionLabel: "Explore state",
        backdrop: "heavy"
      },
      theme: {
        accent: "#ff5a36",
        ink: "#17211b",
        paper: "#f3efe6",
        fonts: {
          heading: '"Avenir Next", Avenir, "Gill Sans", sans-serif',
          body: '"Avenir Next", Avenir, "Gill Sans", sans-serif'
        }
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
      steps: [
        {
          id: "state",
          captureStepId: "state",
          anchorId: "sk-state-approve",
          tooltip: {
            title: "Approve",
            body: "Review the captured state.",
            placement: "auto",
            backdrop: "off"
          },
          advance: "hotspot"
        }
      ],
      cta: null,
      completion: null
    } as never
  );
  const playerContext = await browser.newContext({ bypassCSP: true });
  const player = await playerContext.newPage();
  try {
    const playerErrors: string[] = [];
    player.on("pageerror", (error) => playerErrors.push(error.message));
    await player.setContent(files["index.html"]);
    await player.addStyleTag({ content: files["styles.css"] });
    await player.addScriptTag({ content: files["story.js"] });
    await player.addScriptTag({ content: files["player.js"] });
    expect(playerErrors).toEqual([]);
    await player.getByRole("button", { name: "Explore state" }).click();
    const viewport = player.locator("#scene-viewport");
    await expect(viewport.locator('input[type="button"]')).toHaveAttribute(
      "value",
      "Approve"
    );
    await expect(viewport.locator("details")).toHaveAttribute("open", "");
    await expect(viewport.locator('input[type="checkbox"]')).toBeChecked();
    const playerSelectedOption = viewport
      .getByRole("listbox", { name: "Choices", exact: true })
      .locator("option:checked");
    await expect(playerSelectedOption).toHaveText("Two");
    await expect(playerSelectedOption).toHaveAttribute("selected", "");
    await expect(
      viewport.getByRole("button", { name: "Upload receipt", exact: true })
    ).toHaveCount(1);
    await expect(viewport.locator('input[type="password"]')).not.toHaveAttribute(
      "value",
      /.+/
    );
    await expect(viewport.locator('input[type="password"]')).toHaveValue("");
    await expect(viewport.locator('[title="deep-player-end"]')).toHaveCount(0);
  } finally {
    await playerContext.close();
  }
});

test("classifies an invalid captureTarget before browser capture", async ({
  page
}) => {
  let thrown: unknown;
  try {
    parseCaptureTarget({ strategy: "role", role: "row" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({
    code: "DemoFixtureSetupFailed",
    exitCode: 2,
    details: { category: "capture-target-name-required" }
  });

  const directory = await mkdtemp(join(tmpdir(), "showkit-capture-target-"));
  const diagnosticPath = join(directory, "diagnostic.json");
  try {
    await writeFile(
      diagnosticPath,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        code: "DemoFixtureSetupFailed",
        exitCode: 2,
        phase: "setup",
        category: "capture-target-name-required",
        stepProgress: []
      }),
      "utf8"
    );
    const mapped = await captureFailure("", diagnosticPath);
    expect(mapped).toMatchObject({
      code: "DemoFixtureSetupFailed",
      exitCode: 2,
      recovery: expect.stringContaining("captureTarget.name")
    });
    expect(mapped.message).toContain("accessible name");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await page.setContent(`<button type="button">Continue</button>`);
  let invalidThrown: unknown;
  try {
    await resolveCaptureTarget(
      { strategy: "role", role: "" },
      page.getByRole("button", { name: "Continue", exact: true })
    );
  } catch (error) {
    invalidThrown = error;
  }
  expect(invalidThrown).toMatchObject({
    code: "DemoFixtureSetupFailed",
    details: { category: "capture-target-invalid" }
  });
});

test("infers a missing captureTarget name from Playwright semantics", async ({
  page
}) => {
  await page.setContent(`
    <table aria-label="Expense queue">
      <tbody><tr><th scope="row">App review</th><td>$42</td></tr></tbody>
    </table>
  `);
  const target = page.getByRole("row", {
    name: "App review $42",
    exact: true
  });
  await expect(target).toHaveCount(1);
  await expect(
    resolveCaptureTarget({ strategy: "role", role: "row" }, target)
  ).resolves.toEqual({
    strategy: "role",
    role: "row",
    name: "App review $42"
  });
});

test("prefers aria-labelledby without reading descendant form values", async ({
  page
}) => {
  await page.setContent(`
    <span id="actual-name">Actual name</span>
    <div role="row" aria-labelledby="actual-name" aria-label="Wrong fallback">
      <input type="password" value="do-not-read-this-value" aria-label="Password">
      <span>Fallback text</span>
    </div>
  `);
  const target = page.getByRole("row", {
    name: "Actual name",
    exact: true
  });
  await expect(target).toHaveCount(1);
  await expect(
    resolveCaptureTarget({ strategy: "role", role: "row" }, target)
  ).resolves.toEqual({
    strategy: "role",
    role: "row",
    name: "Actual name"
  });
});

test("infers bounded native accessible-name sources", async ({ page }) => {
  await page.setContent(`
    <table>
      <caption>Expense queue</caption>
      <tbody><tr><td>One</td></tr></tbody>
    </table>
    <input type="submit" value="Approve">
    <input type="submit" value="">
    <input type="reset" value=" ">
    <button type="button" title="Save draft"></button>
    <button type="button" title="Wrong fallback">Store changes</button>
    <button type="button"><img alt="Approve report" style="width:20px;height:20px"></button>
    <button type="button"><img alt="Save" style="width:20px;height:20px">changes</button>
    <button type="button"><img alt="" aria-label="Archive report" style="width:20px;height:20px"></button>
    <button type="button"><img title="Print report" style="width:20px;height:20px"></button>
    <span id="image-reference">Save report</span>
    <button type="button"><img aria-labelledby="image-reference" style="width:20px;height:20px"></button>
    <img alt="Receipt image" style="display:block;width:40px;height:40px">
    <img title="Titled image" style="display:block;width:40px;height:40px">
    <img alt="" aria-label="ARIA image" style="display:block;width:40px;height:40px">
    <input type="image" title="Image submit" style="width:40px;height:40px">
    <input type="image" alt="Approve image" style="width:40px;height:40px">
  `);
  const cases = [
    {
      locator: page.getByRole("table", { name: "Expense queue", exact: true }),
      target: { strategy: "role" as const, role: "table" },
      name: "Expense queue"
    },
    {
      locator: page.getByRole("button", { name: "Approve", exact: true }),
      target: { strategy: "role" as const, role: "button" },
      name: "Approve"
    },
    {
      locator: page.locator('input[type="submit"][value=""]'),
      target: { strategy: "role" as const, role: "button" },
      name: "Submit"
    },
    {
      locator: page.locator('input[type="reset"]'),
      target: { strategy: "role" as const, role: "button" },
      name: "Reset"
    },
    {
      locator: page.getByRole("button", { name: "Save draft", exact: true }),
      target: { strategy: "role" as const, role: "button" },
      name: "Save draft"
    },
    {
      locator: page.getByRole("button", {
        name: "Store changes",
        exact: true
      }),
      target: { strategy: "role" as const, role: "button" },
      name: "Store changes"
    },
    {
      locator: page.getByRole("button", {
        name: "Approve report",
        exact: true
      }),
      target: { strategy: "role" as const, role: "button" },
      name: "Approve report"
    },
    {
      locator: page.getByRole("button", {
        name: "Savechanges",
        exact: true
      }),
      target: { strategy: "role" as const, role: "button" },
      name: "Savechanges"
    },
    {
      locator: page.getByRole("button", {
        name: "Archive report",
        exact: true
      }),
      target: { strategy: "role" as const, role: "button" },
      name: "Archive report"
    },
    {
      locator: page.getByRole("button", {
        name: "Print report",
        exact: true
      }),
      target: { strategy: "role" as const, role: "button" },
      name: "Print report"
    },
    {
      locator: page.getByRole("button", {
        name: "Save report",
        exact: true
      }),
      target: { strategy: "role" as const, role: "button" },
      name: "Save report"
    },
    {
      locator: page.getByRole("img", { name: "Receipt image", exact: true }),
      target: { strategy: "role" as const, role: "img" },
      name: "Receipt image"
    },
    {
      locator: page.getByRole("img", { name: "Titled image", exact: true }),
      target: { strategy: "role" as const, role: "img" },
      name: "Titled image"
    },
    {
      locator: page.getByRole("img", { name: "ARIA image", exact: true }),
      target: { strategy: "role" as const, role: "img" },
      name: "ARIA image"
    },
    {
      locator: page.getByRole("button", { name: "Image submit", exact: true }),
      target: { strategy: "role" as const, role: "button" },
      name: "Image submit"
    },
    {
      locator: page.getByRole("button", { name: "Approve image", exact: true }),
      target: { strategy: "role" as const, role: "button" },
      name: "Approve image"
    }
  ];

  for (const [index, { locator, target, name }] of cases.entries()) {
    await expect(locator).toHaveCount(1);
    await expect(resolveCaptureTarget(target, locator)).resolves.toEqual({
      ...target,
      name
    });
    const captured = await captureScene(page, {
      target: locator,
      captureTarget: { ...target, name },
      anchorId: `sk-native-name-${index + 1}`
    });
    expect(captured.scene.target).toEqual(
      expect.objectContaining({ role: target.role, name })
    );
  }
});

test("uses native defaults for empty submit-control labels", async ({ page }) => {
  const cases = [
    { markup: '<input type="submit" value="">', selector: 'input[type="submit"]', name: "Submit" },
    { markup: '<input type="reset" value=" ">', selector: 'input[type="reset"]', name: "Reset" },
    { markup: '<input type="image" alt=" " style="width:40px;height:40px">', selector: 'input[type="image"]', name: "Submit" },
    { markup: '<input type="file">', selector: 'input[type="file"]', name: "Choose File" }
  ];
  for (const [index, item] of cases.entries()) {
    await page.setContent(item.markup);
    const locator = page.locator(item.selector);
    await expect(
      page.getByRole("button", { name: item.name, exact: true })
    ).toHaveCount(1);
    const captureTarget = await resolveCaptureTarget(
      { strategy: "role", role: "button" },
      locator
    );
    expect(captureTarget.name).toBe(item.name);
    const captured = await captureScene(page, {
      target: locator,
      captureTarget,
      anchorId: `sk-default-input-${index + 1}`
    });
    expect(captured.scene.target?.name).toBe(item.name);
  }
});

test("infers the selector value for each capture target strategy", async ({
  page
}) => {
  await page.setContent(`
    <button type="button" title="Draft tooltip"><span>Store changes</span></button>
    <label for="search">Search catalog</label>
    <input id="search" style="width:160px;height:32px">
    <a href="/reports">Reports</a>
    <button type="button" data-testid="queue">Queue</button>
    <details><summary>More options</summary><p>Details content</p></details>
  `);
  const cases = [
    {
      locator: page.getByRole("button", { name: "Store changes", exact: true }),
      target: { strategy: "title" as const },
      inferredName: "Draft tooltip",
      accessibleName: "Store changes"
    },
    {
      locator: page.getByRole("button", { name: "Store changes", exact: true }),
      target: { strategy: "visible-text" as const },
      inferredName: "Store changes",
      accessibleName: "Store changes"
    },
    {
      locator: page.getByRole("textbox", {
        name: "Search catalog",
        exact: true
      }),
      target: { strategy: "label" as const },
      inferredName: "Search catalog",
      accessibleName: "Search catalog"
    },
    {
      locator: page.getByRole("link", { name: "Reports", exact: true }),
      target: { strategy: "href" as const, path: "/reports" },
      inferredName: "Reports",
      accessibleName: "Reports"
    },
    {
      locator: page.getByTestId("queue"),
      target: { strategy: "test-id" as const, testId: "queue" },
      inferredName: "Queue",
      accessibleName: "Queue"
    },
    {
      locator: page.getByText("More options", { exact: true }),
      target: { strategy: "visible-text" as const },
      inferredName: "More options",
      accessibleName: "More options"
    }
  ];

  for (const [index, item] of cases.entries()) {
    const resolved = await resolveCaptureTarget(item.target, item.locator);
    expect(resolved).toEqual({ ...item.target, name: item.inferredName });
    const captured = await captureScene(page, {
      target: item.locator,
      captureTarget: resolved,
      anchorId: `sk-strategy-${index + 1}`
    });
    expect(captured.scene.target?.name).toBe(item.accessibleName);
  }
});

test("recovers bounded generated and referenced accessible names", async ({
  page
}) => {
  await page.setContent(`
    <style>#generated-name::before { content: "Continue"; }</style>
    <span id="referenced-name" aria-label="Referenced action">Fallback text</span>
    <button type="button" aria-labelledby="referenced-name"></button>
    <label for="terms"><img alt="Accept terms"></label>
    <input id="terms" type="checkbox">
    <button id="generated-name" type="button"></button>
    <span id="image-button-name">Save report</span>
    <button type="button"><img alt="" aria-label="Archive report"></button>
    <button type="button"><img aria-labelledby="image-button-name"></button>
  `);
  const cases = [
    {
      locator: page.getByRole("button", {
        name: "Referenced action",
        exact: true
      }),
      role: "button",
      name: "Referenced action"
    },
    {
      locator: page.getByRole("checkbox", {
        name: "Accept terms",
        exact: true
      }),
      role: "checkbox",
      name: "Accept terms"
    },
    {
      locator: page.getByRole("button", { name: "Continue", exact: true }),
      role: "button",
      name: "Continue"
    },
    {
      locator: page.getByRole("button", {
        name: "Archive report",
        exact: true
      }),
      role: "button",
      name: "Archive report"
    },
    {
      locator: page.getByRole("button", {
        name: "Save report",
        exact: true
      }),
      role: "button",
      name: "Save report"
    }
  ];

  for (const [index, item] of cases.entries()) {
    const captureTarget = await resolveCaptureTarget(
      { strategy: "role", role: item.role },
      item.locator
    );
    expect(captureTarget.name).toBe(item.name);
    const captured = await captureScene(page, {
      target: item.locator,
      captureTarget,
      anchorId: `sk-derived-name-${index + 1}`
    });
    expect(captured.scene.target?.name).toBe(item.name);
    const replay = await page.context().newPage();
    try {
      await replay.setContent(captured.scene.html);
      await expect(
        replay.getByRole(item.role as never, {
          name: item.name,
          exact: true
        })
      ).toHaveCount(1);
    } finally {
      await replay.close();
    }
  }
});

test("does not infer a link name through an accessibility snapshot", async ({
  page
}) => {
  await page.setContent(`
    <style>#private-link::before { content: "Open report"; }</style>
    <a id="private-link" href="/reports?token=do-not-read-url"></a>
  `);
  const target = page.getByRole("link", { name: "Open report", exact: true });
  await expect(target).toHaveCount(1);
  await expect(
    resolveCaptureTarget({ strategy: "role", role: "link" }, target)
  ).rejects.toMatchObject({
    code: "DemoFixtureSetupFailed",
    details: { category: "capture-target-name-required" }
  });

  const oversizedName = "A".repeat(600);
  await page.setContent(
    `<button type="button" aria-label="${oversizedName}">Fallback</button>`
  );
  const oversizedTarget = page.getByRole("button", {
    name: oversizedName,
    exact: true
  });
  await expect(oversizedTarget).toHaveCount(1);
  const oversizedStartedAt = performance.now();
  await expect(
    resolveCaptureTarget(
      { strategy: "role", role: "button" },
      oversizedTarget
    )
  ).rejects.toMatchObject({
    code: "DemoFixtureSetupFailed",
    details: { category: "capture-target-name-required" }
  });
  expect(performance.now() - oversizedStartedAt).toBeLessThan(2_000);
});

test("detects a portal state appended after a large application tree", async ({
  page
}) => {
  const filler = Array.from(
    { length: 2_100 },
    (_, index) => `<span>Application item ${index + 1}</span>`
  ).join("");
  await page.setContent(`
    <button type="button" id="priority">Priority</button>
    <main>${filler}</main>
    <label><input type="checkbox">Keep composer open</label>
    <script>
      document.querySelector("#priority").addEventListener("click", () => {
        const portal = document.createElement("div");
        portal.setAttribute("role", "dialog");
        portal.textContent = "Priority options";
        document.body.append(portal);
      });
    </script>
  `);
  const adapter = createCodexBrowserAdapter({
    tab: {
      playwright: {
        domSnapshot: () => Promise.resolve(""),
        evaluate: (pageFunction: unknown, argument?: unknown) =>
          page.evaluate(pageFunction as never, argument),
        waitForTimeout: (milliseconds: number) => page.waitForTimeout(milliseconds),
        locator: (selector: string) => page.locator(selector),
        getByRole: (role: string, options: { name: string; exact: boolean }) =>
          page.getByRole(role as never, options)
      },
      url: () => Promise.resolve(page.url())
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 }
  });

  await adapter.performAction(
    {
      strategy: "role",
      role: "button",
      name: "Priority"
    },
    "disclose"
  );

  await expect(page.getByRole("dialog")).toHaveText("Priority options");

  await adapter.performAction(
    {
      strategy: "role",
      role: "checkbox",
      name: "Keep composer open"
    },
    "toggle"
  );

  await expect(
    page.getByRole("checkbox", { name: "Keep composer open" })
  ).toBeChecked();
});

test("fails closed before recursively serializing an excessively deep scene", async ({
  page
}) => {
  const nested = Array.from({ length: 300 }, () => '<span style="display:contents">')
    .join("");
  await page.setContent(
    `<main>${nested}<button type="button">Continue</button>${"</span>".repeat(300)}</main>`
  );
  const target = page.getByRole("button", { name: "Continue", exact: true });
  await expect(
    captureScene(page, {
      target,
      captureTarget: {
        strategy: "role",
        role: "button",
        name: "Continue"
      },
      anchorId: "sk-deep-scene"
    })
  ).rejects.toMatchObject({
    code: "CaptureTooLarge",
    details: expect.objectContaining({ category: "serialized-node-limit" })
  });
});

test("preserves zero-height flex spacers that affect sibling geometry", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <div style="display:flex;align-items:center">
        <span>Contact</span>
        <span aria-hidden="true" style="display:block;height:0;width:12px"></span>
        <span>Docs</span>
      </div>
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).toContain('"height":"0px"');
  expect(result.nodesJson).toContain('"width":"12px"');
});

test("keeps non-payment long numeric public identifiers", async ({ page }) => {
  await page.setContent(`
    <main>
      <a href="/listing/home/1234567890123456789">View public listing</a>
      <button type="button">Filter homes</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Filter homes", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-filter-homes"
    });
  expect(result.ok).toBe(true);
});

test("blocks Luhn-valid payment card numbers", async ({ page }) => {
  await page.setContent(`
    <main>
      <p>Payment card 4111 1111 1111 1111</p>
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "SensitiveDataDetected"
      })
    })
  );
});

test("does not treat asset names or SVG geometry as private text", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <div data-image-name="listing-card@2x.png"></div>
      <svg aria-hidden="true">
        <path d="4111111111111111"></path>
      </svg>
      <button type="button">Filter homes</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Filter homes", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-filter-homes"
    });
  expect(result.ok).toBe(true);
});

test("drops nonvisual unsupported surfaces but blocks visible ones", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <h1>Compose a message</h1>
      <button type="button">Compose</button>
      <iframe aria-hidden="true" style="position:fixed;top:-1000px;width:100px;height:100px"></iframe>
      <iframe style="display:none"></iframe>
    </main>
  `);
  const target = page.getByRole("button", { name: "Compose", exact: true });
  const safeResult = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose"
  });
  expect(safeResult.ok).toBe(true);
  if (safeResult.ok && !safeResult.scanOnly) {
    expect(safeResult.excludedSurfaces).toContain(
      "nonvisual-unsupported-surfaces"
    );
    expect(safeResult.html).not.toContain("<iframe");
    expect(safeResult.html).toContain("Compose");
  }

  await page.locator("main").evaluate((main) => {
    const frame = main.ownerDocument.createElement("iframe");
    frame.title = "Visible embedded content";
    frame.style.cssText = "display:block;width:240px;height:120px";
    main.append(frame);
  });
  const blockedResult = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose"
  });
  expect(blockedResult).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "iframe"
      })
    })
  );
});

test("preserves transparent custom containers and text-only open shadow roots", async ({
  page
}) => {
  await page.setContent(`
    <capture-shell style="display:block;padding:12px">
      <main>
        <h1>Capture readiness</h1>
        <status-label style="display:inline"></status-label>
        <button type="button">Review capture</button>
      </main>
    </capture-shell>
  `);
  await page.locator("status-label").evaluate((host) => {
    const root = host.attachShadow({ mode: "open" });
    const label = host.ownerDocument.createElement("span");
    label.textContent = "Updated recently";
    root.append(label);
  });

  const target = page.getByRole("button", {
    name: "Review capture",
    exact: true
  });
  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-review-capture"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain("Capture readiness");
  expect(result.html).toContain("Updated recently");
  expect(result.html).not.toContain("<capture-shell");
  expect(result.html).not.toContain("<status-label");
  expect(result.excludedSurfaces).toContain("transparent-custom-elements");
  expect(result.excludedSurfaces).toContain("text-only-open-shadow-roots");

  const redacted = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-review-capture",
    sensitiveTextRedaction: {
      mode: "text-only",
      consent: "confirmed",
      selectors: ["body"]
    }
  });
  expect(redacted.ok).toBe(true);
  if (!redacted.ok || redacted.scanOnly) return;
  expect(redacted.html).not.toContain("Updated recently");
  expect(redacted.sensitiveText?.redactedTextNodeCount).toBeGreaterThan(0);
});

test("blocks interactive content inside an open shadow root", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <h1>Capture readiness</h1>
      <interactive-shell style="display:block;width:200px;height:40px"></interactive-shell>
      <button type="button">Review capture</button>
    </main>
  `);
  await page.locator("interactive-shell").evaluate((host) => {
    const root = host.attachShadow({ mode: "open" });
    const action = host.ownerDocument.createElement("button");
    action.textContent = "Shadow action";
    root.append(action);
  });

  const result = await page
    .getByRole("button", { name: "Review capture", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-review-capture"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "shadow-root"
      })
    })
  );
});

test("keeps implicit form-control semantics for exact hotspots", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <label for="subject">Subject</label>
      <input id="subject" aria-label="Subject">
    </main>
  `);
  const result = await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-subject"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.target).toEqual(
    expect.objectContaining({
      role: "textbox",
      name: "Subject"
    })
  );
});

test("clips a promoted form-control label to the capture viewport", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      input {
        position: absolute;
        width: 1px;
        height: 1px;
        clip-path: inset(100%);
      }
      label {
        position: absolute;
        left: -40px;
        top: 100px;
        display: flex;
        width: 200px;
        height: 48px;
        align-items: center;
        justify-content: center;
      }
    </style>
    <main>
      <input id="weekend" type="radio" name="length" aria-label="Weekend">
      <label for="weekend">Weekend</label>
    </main>
  `);
  const target = page.getByRole("radio", { name: "Weekend", exact: true });
  const result = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "radio",
      name: "Weekend"
    },
    anchorId: "sk-weekend",
    stepIndex: 0,
    remoteAssetPolicy: "decorative-remove"
  });
  expect(result.scene.target?.bounds).toEqual(
    expect.objectContaining({
      x: 0,
      y: expect.closeTo(100 / 720, 5),
      width: expect.closeTo(160 / 1280, 5),
      height: expect.closeTo(48 / 720, 5)
    })
  );
  expect(result.scene.html).toContain(
    'data-showkit-interaction-box="sk-weekend"'
  );
});

test("promotes a compact disclosure button to its visible sibling label", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      .control { position: relative; width: 72px; height: 44px; }
      .label { display: flex; width: 52px; height: 44px; align-items: center; }
      button {
        position: absolute;
        left: 50px;
        top: 0;
        width: 22px;
        height: 44px;
        border: 0;
        background: transparent;
      }
    </style>
    <main>
      <div class="control">
        <span class="label">Reports</span>
        <button type="button" aria-label="Reports menu"><span></span></button>
      </div>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Reports menu",
    exact: true
  });
  const result = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Reports menu"
    },
    anchorId: "sk-reports-menu"
  });
  expect(result.scene.target?.bounds).toEqual(
    expect.objectContaining({
      x: 0,
      width: expect.closeTo(72 / 1280, 5),
      height: expect.closeTo(44 / 720, 5)
    })
  );
  expect(result.scene.html).toContain(
    'data-showkit-interaction-box="sk-reports-menu"'
  );
});

test("promotes a wide accordion disclosure button to its full labeled row", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      .control { position: relative; width: 980px; height: 102px; margin-left: 150px; }
      h2 { display: flex; width: 980px; height: 102px; margin: 0; align-items: center; }
      button {
        position: absolute;
        right: 5px;
        top: 14px;
        width: 27px;
        height: 74px;
        border: 0;
        background: transparent;
      }
    </style>
    <main>
      <div class="control">
        <h2>Personal Data Apple Collects from You</h2>
        <button
          type="button"
          aria-label="Personal Data Apple Collects from You"
        ></button>
      </div>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Personal Data Apple Collects from You",
    exact: true
  });
  const result = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Personal Data Apple Collects from You"
    },
    anchorId: "sk-wide-accordion"
  });
  expect(result.scene.target?.bounds).toEqual(
    expect.objectContaining({
      x: expect.closeTo(150 / 1280, 5),
      width: expect.closeTo(980 / 1280, 5),
      height: expect.closeTo(102 / 720, 5)
    })
  );
  expect(result.scene.html).toContain(
    'data-showkit-interaction-box="sk-wide-accordion"'
  );
});

test("marks only the exact role target when a same-size wrapper shares its bounds", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <div style="width: 84px; height: 42px">
        <div role="button" tabindex="0" style="width: 84px; height: 42px">Price</div>
      </div>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Price", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-price"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(
    result.html.match(/data-showkit-anchor="sk-price"/g) ?? []
  ).toHaveLength(1);
});

test("transfers a deep semantic tree as JSON without flattening it", async ({
  page
}) => {
  await page.setContent(`
    <main><section><article><div><div><div><button>Compose</button></div></div></div></article></section></main>
  `);
  const target = page.getByRole("button", { name: "Compose", exact: true });
  const result = await target.evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose",
      nodeMode: "json",
      transferChunkSize: 64
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodes).toEqual([]);
  expect(result.transfer).toEqual(
    expect.objectContaining({
      mode: "chunked-json",
      offset: 0,
      chunkSize: 64
    })
  );
  let html = result.html;
  let nodesJson = result.nodesJson ?? "";
  const totalLength = Math.max(
    result.transfer?.htmlLength ?? 0,
    result.transfer?.nodesJsonLength ?? 0
  );
  for (let offset = 64; offset < totalLength; offset += 64) {
    const segment = await target.evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose",
      nodeMode: "json",
      transferOffset: offset,
      transferChunkSize: 64
    });
    expect(segment.ok).toBe(true);
    if (!segment.ok || segment.scanOnly) continue;
    html += segment.html;
    nodesJson += segment.nodesJson ?? "";
  }
  expect(html).toContain("Compose");
  const transferred = JSON.parse(nodesJson);
  expect(transferred).toHaveLength(1);
  const serialized = JSON.stringify(transferred);
  expect(serialized).toContain('"data-showkit-anchor":"sk-compose"');
  expect(serialized).toMatch(
    /"tag":"main".*"tag":"section".*"tag":"article".*"tag":"button"/
  );
});

test("streams one frozen HTML scene after the live DOM changes", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button">Continue</button>
      ${Array.from(
        { length: 120 },
        (_, index) => `<p>Stable product row ${index + 1}</p>`
      ).join("")}
    </main>
  `);
  const transferId = "frozen-html-scene-0001";
  const result = await page.evaluate(extractSceneKernel, {
    ...baseOptions,
    scopeTarget: {
      strategy: "role",
      role: "button",
      name: "Continue"
    },
    anchorId: "sk-continue",
    nodeMode: "json",
    transferChunkSize: 64,
    transferId
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.transfer).toEqual(
    expect.objectContaining({
      mode: "chunked-json",
      captureId: transferId,
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  );

  await page.locator("main").evaluate((main) => {
    main.textContent = "Changed after the HTML scene was frozen";
  });

  let html = result.html;
  let nodesJson = result.nodesJson ?? "";
  if (result.transfer?.mode !== "chunked-json") return;
  const totalLength = Math.max(
    result.transfer.htmlLength,
    result.transfer.nodesJsonLength
  );
  for (
    let offset = result.transfer.chunkSize;
    offset < totalLength;
    offset += result.transfer.chunkSize
  ) {
    const segment = await page.evaluate(readFrozenSceneTransferKernel, {
      captureId: transferId,
      offset,
      chunkSize: result.transfer.chunkSize
    });
    expect(segment.ok).toBe(true);
    if (!segment.ok) continue;
    html += segment.html;
    nodesJson += segment.nodesJson;
  }
  html = html.slice(0, result.transfer.htmlLength);
  nodesJson = nodesJson.slice(0, result.transfer.nodesJsonLength);
  expect(
    createHash("sha256").update(`${html}\u0000${nodesJson}`).digest("hex")
  ).toBe(result.transfer.payloadSha256);
  expect(html).toContain("Stable product row 1");
  expect(nodesJson).toContain("Stable product row 20");
  expect(`${html}\n${nodesJson}`).not.toContain(
    "Changed after the HTML scene was frozen"
  );
  expect(
    await page.evaluate(readFrozenSceneTransferKernel, {
      captureId: transferId,
      release: true
    })
  ).toEqual({ ok: false, category: "capture-missing" });
});

test("recreates the cached isolated world after main-frame navigation", async ({
  page
}) => {
  await page.route("**/showkit-navigation/**", async (route) => {
    const name = route.request().url().endsWith("/second") ? "Second" : "First";
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><body><main><button type="button" style="width:120px;height:40px">${name}</button></main></body></html>`
    });
  });

  const captureNamedButton = async (name: string, anchorId: string) => {
    const target = page.getByRole("button", { name, exact: true });
    await expect(target).toBeVisible();
    return captureScene(page, {
      target,
      captureTarget: {
        strategy: "role",
        role: "button",
        name
      },
      anchorId
    });
  };

  await page.goto("http://127.0.0.1:4173/showkit-navigation/first");
  const first = await captureNamedButton("First", "sk-first");
  expect(first.scene.html).toContain("First");
  expect(first.scene.html).toContain('data-showkit-anchor="sk-first"');

  await page.goto("http://127.0.0.1:4173/showkit-navigation/second");
  const second = await captureNamedButton("Second", "sk-second");
  expect(second.scene.html).toContain("Second");
  expect(second.scene.html).toContain('data-showkit-anchor="sk-second"');
  expect(second.scene.html).not.toContain("First");
});

test("preserves an authored submit-button label without retaining typed input values", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <input aria-label="Search catalog" type="search" value="private query">
      <input type="submit" value="Go">
    </main>
  `);
  const target = page.getByRole("button", { name: "Go", exact: true });
  const result = await captureScene(page, {
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Go"
    },
    anchorId: "sk-go"
  });
  expect(result.scene.target?.name).toBe("Go");
  expect(result.scene.html).toContain('type="submit"');
  expect(result.scene.html).toContain('value="Go"');
  expect(result.scene.html).not.toContain("private query");
});

test("removes captured margins from positioned nodes to prevent coordinate drift", async ({
  page
}) => {
  await page.setContent(`
    <main style="position:relative;width:900px;height:120px">
      <section style="position:absolute;left:100px;top:20px;width:700px;height:80px">
        <button
          type="button"
          style="display:block;margin-left:68px;width:160px;height:40px"
        >
          Compose
        </button>
      </section>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Compose", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]");
  const findButton = (
    node: {
      type: string;
      tag?: string;
      styles?: Record<string, string>;
      children?: Array<{
        type: string;
        tag?: string;
        styles?: Record<string, string>;
        children?: unknown[];
      }>;
    }
  ): typeof node | undefined => {
    if (node.type === "element" && node.tag === "button") return node;
    for (const child of node.children ?? []) {
      const match = findButton(child);
      if (match) return match;
    }
    return undefined;
  };
  const button = findButton(transferred[0]);
  expect(button).toBeDefined();
  expect(button?.styles).toEqual(
    expect.objectContaining({
      left: "68px",
      "margin-bottom": "0px",
      "margin-left": "0px",
      "margin-right": "0px",
      "margin-top": "0px"
    })
  );
  expect(button?.styles?.margin).toBeUndefined();
});

test("positions visible virtual-list content independently of its live scroll offset", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <div
        id="virtual-scroll"
        style="height:120px;overflow-y:auto;position:relative;width:500px"
      >
        <div
          style="
            height:800px;
            position:relative;
            transform:matrix(1, 0, 0, 1, 0, 0);
            transform-origin:0 0
          "
        >
          <button
            id="visible-row"
            style="height:40px;left:20px;position:absolute;top:680px;width:140px"
            type="button"
          >
            Visible row
          </button>
        </div>
      </div>
    </main>
  `);
  await page.locator("#virtual-scroll").evaluate((element) => {
    element.scrollTop = 640;
  });
  const targetTop = await page
    .getByRole("button", { name: "Visible row", exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  const result = await page
    .getByRole("button", { name: "Visible row", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-visible-row",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const [root] = JSON.parse(result.nodesJson ?? "[]") as Array<{
    type: "element";
    styles: Record<string, string>;
    attributes: Record<string, string>;
    children: unknown[];
  }>;
  const anchoredTop = (
    node: {
      type: string;
      styles?: Record<string, string>;
      attributes?: Record<string, string>;
      children?: unknown[];
    },
    accumulatedTop = 0
  ): number | undefined => {
    const top =
      accumulatedTop + Number.parseFloat(node.styles?.top ?? "0");
    if (node.attributes?.["data-showkit-anchor"] === "sk-visible-row") {
      return top;
    }
    for (const child of node.children ?? []) {
      if (
        typeof child !== "object" ||
        child === null ||
        !("type" in child)
      ) {
        continue;
      }
      const match = anchoredTop(
        child as {
          type: string;
          styles?: Record<string, string>;
          attributes?: Record<string, string>;
          children?: unknown[];
        },
        top
      );
      if (match !== undefined) return match;
    }
    return undefined;
  };
  expect(anchoredTop(root!)).toBeCloseTo(targetTop, 0);
});

test("captures the revealed semantic scroll range and restores nested scroll state", async ({
  page
}) => {
  await page.setViewportSize({ width: 800, height: 500 });
  await page.setContent(`
    <style>
      html, body { margin: 0; width: 800px; }
      header { background: white; height: 48px; position: sticky; top: 0; z-index: 2; }
      main { height: 1600px; position: relative; }
      #intro { left: 24px; position: absolute; top: 80px; }
      #panel { height: 120px; left: 80px; overflow-y: auto; position: absolute; top: 850px; width: 420px; }
      #panel-content { height: 620px; position: relative; }
      #review-row { left: 24px; position: absolute; top: 340px; }
      #nested-unrevealed { left: 24px; position: absolute; top: 520px; }
      #document-unrevealed { left: 24px; position: absolute; top: 1450px; }
    </style>
    <header>Workspace navigation</header>
    <main>
      <p id="intro">Previously revealed overview</p>
      <section id="panel" aria-label="Review queue">
        <div id="panel-content">
          <button id="review-row" type="button">Review row</button>
          <p id="nested-unrevealed">Nested content not revealed yet</p>
        </div>
      </section>
      <p id="document-unrevealed">Document content not revealed yet</p>
    </main>
  `);
  await page.evaluate(() => {
    window.scrollTo(0, 700);
    const panel = document.querySelector("#panel");
    if (panel instanceof HTMLElement) panel.scrollTop = 300;
  });

  const result = await page
    .getByRole("button", { name: "Review row", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-review-row",
      nodeMode: "json",
      scrollCapture: "revealed"
    });

  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.scroll).toEqual({ x: 0, y: 700, width: 800, height: 1200 });
  expect(result.html).toContain("Previously revealed overview");
  expect(result.html).toContain("Review row");
  expect(result.html).not.toContain("Nested content not revealed yet");
  expect(result.html).not.toContain("Document content not revealed yet");
  expect(result.html).toContain('data-showkit-scroll-y="300"');
  expect(result.html).toContain('data-showkit-position-lock="sticky"');

  const transferred = JSON.parse(result.nodesJson ?? "[]") as unknown[];
  type TransferNode = {
    type: string;
    attributes?: Record<string, string>;
    styles?: Record<string, string>;
    children?: unknown[];
  };
  const findNode = (
    nodes: unknown[],
    predicate: (node: TransferNode) => boolean
  ): TransferNode | undefined => {
    for (const candidate of nodes) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const node = candidate as TransferNode;
      if (predicate(node)) return node;
      const match = findNode(node.children ?? [], predicate);
      if (match) return match;
    }
    return undefined;
  };
  expect(
    findNode(
      transferred,
      (node) => node.attributes?.["data-showkit-scroll-y"] === "300"
    )?.styles
  ).toEqual(expect.objectContaining({ height: "120px" }));
  expect(
    findNode(
      transferred,
      (node) => node.attributes?.["data-showkit-anchor"] === "sk-review-row"
    )?.styles?.top
  ).toBe("340px");
});

test("preserves named grid placement when replaying a captured scene", async ({
  page
}) => {
  await page.setContent(`
    <main
      style="
        display:grid;
        grid-template-columns:
          [full-start] 120px
          [content-start] 360px
          [content-end] 120px
          [full-end];
        grid-template-rows:40px 80px;
        height:120px;
        width:600px
      "
    >
      <div
        style="
          grid-column:full-start / full-end;
          grid-row:1;
          height:40px
        "
      >
        Full-width header
      </div>
      <button
        id="grid-target"
        style="
          grid-column:content-start / content-end;
          grid-row:2;
          height:80px;
          width:360px
        "
        type="button"
      >
        Grid target
      </button>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Grid target",
    exact: true
  });
  const sourceBounds = await target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const rootRectangle = document.body.getBoundingClientRect();
    return {
      x: rectangle.x - rootRectangle.x,
      y: rectangle.y - rootRectangle.y,
      width: rectangle.width,
      height: rectangle.height
    };
  });
  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-grid-target"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain("grid-column-start:content-start");
  expect(result.html).toContain("grid-column-end:content-end");
  expect(result.html).toContain("grid-row-start:2");

  await page.setContent(result.html);
  const replayBounds = await page
    .locator('[data-showkit-anchor="sk-grid-target"]')
    .evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const root = element.closest("[data-showkit-scene-root]");
      if (!(root instanceof HTMLElement)) {
        throw new Error("Expected captured scene root.");
      }
      const rootRectangle = root.getBoundingClientRect();
      return {
        x: rectangle.x - rootRectangle.x,
        y: rectangle.y - rootRectangle.y,
        width: rectangle.width,
        height: rectangle.height
      };
    });
  expect(replayBounds).toEqual(sourceBounds);
});

test("removes named grid areas after fixing a JSON scene to absolute coordinates", async ({
  page
}) => {
  await page.setContent(`
    <main
      id="area-grid"
      style="
        display:grid;
        grid-template-areas:'scroller';
        grid-template-columns:600px;
        grid-template-rows:120px;
        height:120px;
        width:600px
      "
    >
      <button
        id="area-target"
        style="
          grid-area:scroller;
          height:120px;
          width:600px
        "
        type="button"
      >
        Area target
      </button>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Area target",
    exact: true
  });
  const sourceBounds = await target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const grid = document.querySelector("#area-grid");
    if (!(grid instanceof HTMLElement)) {
      throw new Error("Expected source area grid.");
    }
    const gridComputed = getComputedStyle(grid);
    const targetComputed = getComputedStyle(element);
    return {
      bounds: {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height
      },
      gridTemplateColumns: gridComputed.gridTemplateColumns,
      columnStart: targetComputed.gridColumnStart,
      rowStart: targetComputed.gridRowStart
    };
  });
  expect(sourceBounds.gridTemplateColumns).toBe("600px");
  expect(sourceBounds.columnStart).toBe("scroller");
  expect(sourceBounds.rowStart).toBe("scroller");

  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-area-target",
    nodeMode: "json"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).not.toContain("grid-column-start:scroller");
  expect(result.html).not.toContain("grid-column-end:scroller");
  expect(result.html).not.toContain("grid-row-start:scroller");
  expect(result.html).not.toContain("grid-row-end:scroller");

  await page.setContent(result.html);
  const replayBounds = await page
    .locator('[data-showkit-anchor="sk-area-target"]')
    .evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const root = element.closest("[data-showkit-scene-root]");
      if (!(root instanceof HTMLElement)) {
        throw new Error("Expected captured scene root.");
      }
      const rootRectangle = root.getBoundingClientRect();
      return {
        x: rectangle.x - rootRectangle.x,
        y: rectangle.y - rootRectangle.y,
        width: rectangle.width,
        height: rectangle.height
      };
    });
  expect(replayBounds).toEqual(sourceBounds.bounds);
});

test("preserves named grid areas inside transformed coordinate spaces", async ({
  page
}) => {
  await page.setContent(`
    <style>body { margin: 0 }</style>
    <section
      style="
        height:120px;
        transform:matrix(1, 0, 0, 1, 0, 0);
        transform-origin:0 0;
        width:600px
      "
    >
      <main
        style="
          display:grid;
          grid-template-areas:'scroller';
          grid-template-columns:600px;
          grid-template-rows:120px;
          height:120px;
          width:600px
        "
      >
        <button
          style="
            grid-area:scroller;
            height:120px;
            width:600px
          "
          type="button"
        >
          Transformed area target
        </button>
      </main>
    </section>
  `);
  const target = page.getByRole("button", {
    name: "Transformed area target",
    exact: true
  });
  const sourceBounds = await target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height
    };
  });
  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-transformed-area-target",
    nodeMode: "json"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain(
    "grid-template-areas:&quot;scroller&quot;"
  );

  await page.setContent(result.html);
  const replayBounds = await page
    .locator('[data-showkit-anchor="sk-transformed-area-target"]')
    .evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const root = element.closest("[data-showkit-scene-root]");
      if (!(root instanceof HTMLElement)) {
        throw new Error("Expected captured scene root.");
      }
      const rootRectangle = root.getBoundingClientRect();
      return {
        x: rectangle.x - rootRectangle.x,
        y: rectangle.y - rootRectangle.y,
        width: rectangle.width,
        height: rectangle.height
      };
    });
  expect(replayBounds).toEqual(sourceBounds);
});

test("positions text fragments under a no-op transform", async ({
  page
}) => {
  await page.setContent(`
    <style>body { margin: 0 }</style>
    <section
      style="
        font-size:0;
        height:60px;
        transform:matrix(1, 0, 0, 1, 0, 0);
        transform-origin:110px 30px;
        width:220px
      "
    >
      <span style="font-size:14px">Fee</span><span style="font-size:14px"> included</span>
      <button
        style="height:24px;left:0;position:absolute;top:30px;width:80px"
        type="button"
      >
        Continue
      </button>
    </section>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-no-op-transform",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const [root] = JSON.parse(result.nodesJson ?? "[]") as Array<{
    type: "element";
    attributes: Record<string, string>;
    styles: Record<string, string>;
    children: unknown[];
  }>;
  const textFragments: Array<Record<string, string>> = [];
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || !("type" in node)) {
      return;
    }
    const candidate = node as {
      type: string;
      attributes?: Record<string, string>;
      styles?: Record<string, string>;
      children?: unknown[];
    };
    if (candidate.attributes?.["data-showkit-text"] !== undefined) {
      textFragments.push(candidate.styles ?? {});
    }
    for (const child of candidate.children ?? []) visit(child);
  };
  visit(root);
  expect(textFragments.length).toBeGreaterThanOrEqual(3);
  expect(textFragments.every((styles) => styles.position === "absolute")).toBe(
    true
  );
});

test("preserves an empty generated grid item that controls auto-placement", async ({
  page
}) => {
  await page.setContent(`
    <style>
      #layout-grid {
        display: grid;
        grid-template-columns:
          [full-start] 100px
          [content-start] 300px
          [content-end] 100px
          [full-end];
        grid-template-rows: 0px 80px 40px;
        height: 120px;
        width: 500px;
      }
      #layout-ghost {
        display: contents;
      }
      #layout-ghost::after {
        content: "" / "";
        display: block;
        grid-column: full;
        height: 0;
        width: 500px;
      }
      #layout-title {
        grid-column: content;
        height: 80px;
      }
      #layout-target {
        grid-column: content;
        height: 40px;
        width: 300px;
      }
    </style>
    <main id="layout-grid">
      <div id="layout-ghost"></div>
      <h1 id="layout-title">Layout title</h1>
      <button id="layout-target" type="button">Layout target</button>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Layout target",
    exact: true
  });
  const sourceTop = await target.evaluate((element) => {
    const grid = document.querySelector("#layout-grid");
    if (!(grid instanceof HTMLElement)) {
      throw new Error("Expected source grid.");
    }
    return (
      element.getBoundingClientRect().top -
      grid.getBoundingClientRect().top
    );
  });
  expect(sourceTop).toBe(80);
  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-layout-target"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain('data-showkit-pseudo="after"');
  expect(result.html).not.toContain('"" / ""');

  await page.setContent(result.html);
  const replayLayout = await page
    .locator('[data-showkit-anchor="sk-layout-target"]')
    .evaluate((element) => {
      let grid = element.parentElement;
      while (
        grid &&
        !["grid", "inline-grid"].includes(getComputedStyle(grid).display)
      ) {
        grid = grid.parentElement;
      }
      if (!(grid instanceof HTMLElement)) {
        throw new Error("Expected replay grid.");
      }
      return {
        top:
          element.getBoundingClientRect().top -
          grid.getBoundingClientRect().top,
        children: Array.from(grid.children).map((child) => {
          const computed = getComputedStyle(child);
          const rectangle = child.getBoundingClientRect();
          return {
            display: computed.display,
            columnStart: computed.gridColumnStart,
            columnEnd: computed.gridColumnEnd,
            rowStart: computed.gridRowStart,
            rowEnd: computed.gridRowEnd,
            top: rectangle.top - grid.getBoundingClientRect().top,
            width: rectangle.width,
            height: rectangle.height,
            pseudoCount: child.querySelectorAll(
              "[data-showkit-pseudo]"
            ).length
          };
        })
      };
    });
  expect(replayLayout).toEqual({
    top: sourceTop,
    children: expect.any(Array)
  });
});

test("transfers one immutable positioned scene as bounded compressed JSON", async ({
  page
}) => {
  await page.setContent(`
    <main style="font:5px/5px Arial, sans-serif">
      ${Array.from(
        { length: 120 },
        (_, index) =>
          `<p style="margin:0">Repeated product row ${index + 1}</p>`
      ).join("")}
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json",
      transferEncoding: "lzss-json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.transfer?.mode).toBe("lzss-json");
  expect(result.html).toBe("");
  expect(result.nodes).toEqual([]);
  expect(result.nodesJson?.length).toBeLessThanOrEqual(48_000);
  expect(result.transfer?.compressedLength).toBeGreaterThan(0);
  expect(result.transfer?.nodesJsonLength).toBeGreaterThan(
    result.nodesJson?.length ?? 0
  );

  const chunkedFallback = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json",
      transferEncoding: "lzss-json",
      transferChunkSize: 64
    });
  expect(chunkedFallback.ok).toBe(true);
  if (!chunkedFallback.ok || chunkedFallback.scanOnly) return;
  expect(chunkedFallback.transfer).toEqual(
    expect.objectContaining({
      mode: "chunked-json",
      offset: 0,
      chunkSize: 64
    })
  );
});

test("preserves inherited text styles and inline SVG structure in positioned transfer", async ({
  page
}) => {
  await page.setContent(`
    <main style="font-family: Georgia, serif; font-size: 18px; line-height: 27px; color: rgb(12, 34, 56); overflow-x: hidden">
      <button type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="currentColor">
            <path d="M4 4h16v16H4z"></path>
          </g>
        </svg>
        <span>Compose</span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Compose", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]");
  const serialized = JSON.stringify(transferred);
  expect(serialized).toContain('"font-family":"Georgia, serif"');
  expect(serialized).toContain('"font-size":"18px"');
  expect(serialized).toContain('"line-height":"27px"');
  expect(serialized).toContain('"overflow-x":"hidden"');
  expect(serialized).toContain('"data-showkit-text":""');
  const findElement = (
    node: {
      type: string;
      tag?: string;
      children?: Array<{
        type: string;
        tag?: string;
        children?: unknown[];
      }>;
    },
    tag: string
  ): typeof node | undefined => {
    if (node.type === "element" && node.tag === tag) return node;
    for (const child of node.children ?? []) {
      const match = findElement(child, tag);
      if (match) return match;
    }
    return undefined;
  };
  const svg = findElement(transferred[0], "svg");
  expect(svg).toBeDefined();
  expect(JSON.stringify(svg?.children)).toContain('"tag":"g"');
  expect(JSON.stringify(svg?.children)).toContain('"tag":"path"');
  expect(serialized.match(/"tag":"path"/g)).toHaveLength(1);
});

test("preserves inline icon and text baselines inside bordered controls", async ({
  page
}) => {
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
    </style>
    <main style="padding: 32px">
      <button
        type="button"
        style="
          align-items: center;
          background: white;
          border: 1px solid rgb(0, 120, 130);
          border-radius: 21px;
          display: inline-flex;
          font-family: Arial, sans-serif;
          font-size: 14px;
          gap: 8px;
          height: 42px;
          line-height: 24px;
          padding: 0 14px;
        "
      >
        <svg
          aria-hidden="true"
          height="20"
          style="display: block"
          viewBox="0 0 20 20"
          width="20"
        >
          <path d="M3 6h14M6 10h8M8 14h4" fill="none" stroke="currentColor"></path>
        </svg>
        <span>Filters • 3</span>
      </button>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Filters • 3",
    exact: true
  });
  const sourceMetrics = await target.evaluate((button) => {
    const buttonRectangle = button.getBoundingClientRect();
    const iconRectangle = button.querySelector("svg")!.getBoundingClientRect();
    const label = button.querySelector("span")!;
    const range = document.createRange();
    range.selectNodeContents(label);
    const textRectangle = range.getBoundingClientRect();
    return {
      iconCenter:
        iconRectangle.top +
        iconRectangle.height / 2 -
        (buttonRectangle.top + buttonRectangle.height / 2),
      textTop: textRectangle.top - buttonRectangle.top
    };
  });
  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-filters",
    nodeMode: "json"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]");

  await page.setContent("<main id=\"captured-scene\"></main>");
  await page.locator("#captured-scene").evaluate((mount, nodes) => {
    const svgTags = new Set([
      "circle",
      "defs",
      "ellipse",
      "g",
      "image",
      "line",
      "path",
      "polygon",
      "polyline",
      "rect",
      "svg"
    ]);
    const createNode = (
      node:
        | { type: "text"; text: string }
        | {
            type: "element";
            tag: string;
            attributes: Record<string, string>;
            styles: Record<string, string>;
            children: unknown[];
          }
    ): Node => {
      if (node.type === "text") return document.createTextNode(node.text);
      const element = svgTags.has(node.tag)
        ? document.createElementNS("http://www.w3.org/2000/svg", node.tag)
        : document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attributes)) {
        element.setAttribute(name, value);
      }
      for (const [name, value] of Object.entries(node.styles)) {
        (element as HTMLElement).style.setProperty(name, value);
      }
      for (const child of node.children) {
        element.append(createNode(child as Parameters<typeof createNode>[0]));
      }
      return element;
    };
    mount.replaceChildren(
      ...(nodes as Parameters<typeof createNode>[0][]).map(createNode)
    );
  }, transferred);

  const capturedMetrics = await page
    .locator('[data-showkit-anchor="sk-filters"]')
    .evaluate((button) => {
      const buttonRectangle = button.getBoundingClientRect();
      const iconRectangle = button.querySelector("svg")!.getBoundingClientRect();
      const textWrapper = button.querySelector<HTMLElement>(
        "[data-showkit-text]"
      )!;
      const range = document.createRange();
      range.selectNodeContents(textWrapper);
      const textRectangle = range.getBoundingClientRect();
      return {
        iconCenter:
          iconRectangle.top +
          iconRectangle.height / 2 -
          (buttonRectangle.top + buttonRectangle.height / 2),
        textTop: textRectangle.top - buttonRectangle.top
      };
    });

  expect(capturedMetrics.iconCenter).toBeCloseTo(
    sourceMetrics.iconCenter,
    1
  );
  expect(capturedMetrics.textTop).toBeCloseTo(sourceMetrics.textTop, 1);
});

test("splits wrapping text into positioned selectable line fragments", async ({
  page
}) => {
  await page.setContent(`
    <main style="font: 14px/20px Arial, sans-serif">
      <p style="width: 90px">Wrapping text keeps each captured line aligned.</p>
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]") as Array<{
    type: string;
    attributes?: Record<string, string>;
    styles?: Record<string, string>;
    children?: unknown[];
  }>;
  const textWrappers: typeof transferred = [];
  const visit = (node: (typeof transferred)[number]): void => {
    if (node.attributes?.["data-showkit-text"] !== undefined) {
      textWrappers.push(node);
    }
    for (const child of node.children ?? []) {
      if (typeof child === "object" && child !== null) {
        visit(child as (typeof transferred)[number]);
      }
    }
  };
  transferred.forEach(visit);
  const fragmentText = (node: (typeof transferred)[number]): string =>
    (node.children ?? [])
      .map((child) =>
        typeof child === "object" &&
        child !== null &&
        "type" in child &&
        child.type === "text" &&
        "text" in child &&
        typeof child.text === "string"
          ? child.text
          : ""
      )
      .join("");
  const wrappingText = textWrappers.filter(
    (node) => fragmentText(node).trim() !== "Continue"
  );
  expect(wrappingText.length).toBeGreaterThan(1);
  const capturedText = (nodes: Array<(typeof transferred)[number]>): string =>
    nodes
      .map((node) =>
        node.type === "text"
          ? String(node.text ?? "")
          : capturedText(node.children ?? [])
      )
      .join("");
  expect(capturedText(transferred).replace(/\s+/g, " ").trim()).toContain(
    "Wrapping text keeps each captured line aligned."
  );
  expect(
    wrappingText.every(
      (node) =>
        node.styles?.["line-height"] !== undefined &&
        node.styles?.["white-space"] === "pre"
    )
  ).toBe(true);
});

test("preserves explicit newlines between positioned preformatted fragments", async ({
  page
}) => {
  await page.setContent(`
    <main style="font: 14px/20px Arial, sans-serif">
      <pre style="font: inherit; margin: 0">First line\nSecond line</pre>
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]") as Array<{
    type: string;
    text?: string;
    children?: unknown[];
  }>;
  const capturedText = (nodes: unknown[]): string =>
    nodes
      .map((node) => {
        if (typeof node !== "object" || node === null || !("type" in node)) {
          return "";
        }
        const candidate = node as {
          type: string;
          text?: string;
          children?: unknown[];
        };
        return candidate.type === "text"
          ? candidate.text ?? ""
          : capturedText(candidate.children ?? []);
      })
      .join("");

  expect(capturedText(transferred)).toContain("First line\nSecond line");
});

test("redacts a sensitive value before splitting wrapped text", async ({
  page
}) => {
  await page.setContent(`
    <main style="font: 16px/20px monospace">
      <p style="overflow-wrap:anywhere;width:92px">demo-user@example.invalid</p>
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json",
      sensitiveTextRedaction: {
        mode: "text-only",
        consent: "confirmed",
        selectors: []
      }
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const serialized = JSON.stringify(result);
  expect(serialized).toContain("••••");
  expect(serialized).not.toMatch(/demo-user|example\.invalid/);
});

test("keeps a captured single-line text node on one line", async ({
  page
}) => {
  await page.setContent(`
    <main style="font: 14px/20px Arial, sans-serif">
      <p>What’s new</p>
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]") as Array<{
    type: string;
    attributes?: Record<string, string>;
    styles?: Record<string, string>;
    children?: unknown[];
  }>;
  const textWrappers: typeof transferred = [];
  const visit = (node: (typeof transferred)[number]): void => {
    if (node.attributes?.["data-showkit-text"] !== undefined) {
      textWrappers.push(node);
    }
    for (const child of node.children ?? []) {
      if (typeof child === "object" && child !== null) {
        visit(child as (typeof transferred)[number]);
      }
    }
  };
  transferred.forEach(visit);
  const singleLineText = textWrappers.find((node) =>
    JSON.stringify(node.children).includes("What’s new")
  );
  expect(singleLineText?.styles?.["white-space"]).toBe("pre");
});

test("preserves mixed inline spacing and line geometry without text collisions", async ({
  page
}) => {
  await page.goto(
    "http://127.0.0.1:4173/assurance/inline-typography.html"
  );
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).not.toContain('"placeholder":"Search reports"');
  expect(result.nodesJson).not.toContain('"value":"status:open"');
  const transferred = JSON.parse(result.nodesJson ?? "[]");

  await page.setContent('<main id="captured-scene"></main>');
  await page.locator("#captured-scene").evaluate((mount, nodes) => {
    const svgTags = new Set([
      "circle",
      "defs",
      "ellipse",
      "g",
      "image",
      "line",
      "path",
      "polygon",
      "polyline",
      "rect",
      "svg"
    ]);
    const createNode = (node: any): Node => {
      if (node.type === "text") return document.createTextNode(node.text);
      const element = svgTags.has(node.tag)
        ? document.createElementNS("http://www.w3.org/2000/svg", node.tag)
        : document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attributes)) {
        element.setAttribute(name, String(value));
      }
      for (const [name, value] of Object.entries(node.styles)) {
        (element as HTMLElement).style.setProperty(name, String(value));
      }
      for (const child of node.children) element.append(createNode(child));
      return element;
    };
    mount.replaceChildren(...nodes.map(createNode));
  }, transferred);

  const metrics = await page.evaluate(() => {
    const wrappers = Array.from(
      document.querySelectorAll<HTMLElement>("[data-showkit-text]")
    ).map((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rectangle = range.getBoundingClientRect();
      return {
        element,
        text: element.textContent ?? "",
        rectangle
      };
    });
    const collisions: Array<{ left: string; right: string; area: number }> = [];
    for (let leftIndex = 0; leftIndex < wrappers.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < wrappers.length;
        rightIndex += 1
      ) {
        const left = wrappers[leftIndex]!;
        const right = wrappers[rightIndex]!;
        const overlapWidth = Math.max(
          0,
          Math.min(left.rectangle.right, right.rectangle.right) -
            Math.max(left.rectangle.left, right.rectangle.left)
        );
        const overlapHeight = Math.max(
          0,
          Math.min(left.rectangle.bottom, right.rectangle.bottom) -
            Math.max(left.rectangle.top, right.rectangle.top)
        );
        if (overlapWidth * overlapHeight > 1) {
          collisions.push({
            left: left.text,
            right: right.text,
            area: overlapWidth * overlapHeight
          });
        }
      }
    }
    const downloaded = wrappers.find(
      (wrapper) => wrapper.text === "downloaded"
    );
    const following = wrappers.find((wrapper) =>
      wrapper.text.includes("and used for")
    );
    if (!downloaded || !following || !following.element.firstChild) {
      throw new Error("Expected captured inline text fragments");
    }
    const followingWord = document.createRange();
    followingWord.setStart(following.element.firstChild, 1);
    followingWord.setEnd(following.element.firstChild, 4);
    return {
      collisions,
      syntheticHyphenCount: Array.from(
        document.querySelectorAll<HTMLElement>('[aria-hidden="true"]')
      ).filter((element) => element.textContent === "-").length,
      wordGap:
        followingWord.getBoundingClientRect().left - downloaded.rectangle.right,
      text: document.querySelector("[data-showkit-scene-root]")?.textContent
    };
  });

  expect(metrics.collisions).toEqual([]);
  expect(metrics.syntheticHyphenCount).toBeGreaterThan(0);
  expect(metrics.wordGap).toBeGreaterThan(1);
  expect(metrics.text?.replace(/\s+/g, " ")).toContain(
    "Tip: This tutorial is designed for people learning the language, not for readers who already know every concept."
  );
});

test("splits confirmed multi-line redaction into positioned line wrappers", async ({
  page
}) => {
  await page.goto(
    "http://127.0.0.1:4173/assurance/inline-typography.html"
  );
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json",
      sensitiveTextRedaction: {
        mode: "text-only",
        consent: "confirmed",
        selectors: ["[data-private-note]"]
      }
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;

  const redactedWrappers: Array<{
    attributes?: Record<string, string>;
    styles?: Record<string, string>;
    children?: unknown[];
  }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as {
      attributes?: Record<string, string>;
      styles?: Record<string, string>;
      children?: unknown[];
    };
    if (node.attributes?.["data-showkit-text"] === "redacted") {
      redactedWrappers.push(node);
    }
    for (const child of node.children ?? []) visit(child);
  };
  (JSON.parse(result.nodesJson ?? "[]") as unknown[]).forEach(visit);

  expect(redactedWrappers.length).toBeGreaterThan(1);
  expect(
    redactedWrappers.every(
      (wrapper) => wrapper.styles?.["white-space"] === "pre"
    )
  ).toBe(true);
  expect(JSON.stringify(redactedWrappers)).toContain("••••");
  expect(JSON.stringify(result)).not.toContain(
    "Internal planning details wrap across several visible lines."
  );
});

test("maps relative font-face URLs when an isolated document omits baseURI", async ({
  page
}) => {
  await page.goto("http://127.0.0.1:4173/signed-in/index.html");
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      @font-face {
        font-family: "QA Sans";
        font-style: normal;
        font-weight: 600;
        src: url("/fonts/qa-sans-semibold.woff2") format("woff2");
      }
    `;
    document.head.append(style);
    Object.defineProperty(document, "baseURI", {
      configurable: true,
      value: undefined
    });
  });
  const source = "http://127.0.0.1:4173/fonts/qa-sans-semibold.woff2";
  const descriptors = await page.evaluate(collectPageFontFaceDescriptors, [
    source
  ]);
  expect(descriptors).toEqual([
    expect.objectContaining({
      source,
      family: "QA Sans",
      style: "normal",
      weight: "600"
    })
  ]);
});

test("keeps a declared font stack when no matching font face loaded", async ({
  page
}) => {
  await page.setContent(`
    <main style="font-family: 'Declared but unloaded', Arial, sans-serif">
      <button type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-continue",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).toContain(
    '"font-family":"\\"Declared but unloaded\\", Arial, sans-serif"'
  );
});

test("uses a bounded system fallback for a consented unbundled text font", async ({
  page
}) => {
  await page.setContent(`
    <main style="font-family:'Demo Face', sans-serif">
      <p>Visible product text</p>
      <button type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: [
        {
          family: "Demo Face",
          status: "loaded"
        }
      ]
    });
  });
  const target = page.getByRole("button", {
    name: "Continue",
    exact: true
  });
  const blocked = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json"
  });
  expect(blocked).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "font-asset-required"
      })
    })
  );

  const publicPage = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "public-page",
      consent: "requested"
    }
  });
  expect(publicPage).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "font-asset-required"
      })
    })
  );

  const recovered = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(recovered.ok).toBe(true);
  if (!recovered.ok || recovered.scanOnly) return;
  expect(recovered.excludedSurfaces).toContain(
    "bounded-font-metric-fallback"
  );
  expect(recovered.nodesJson).toContain(
    'system-ui, -apple-system, BlinkMacSystemFont, \\"Segoe UI\\", sans-serif'
  );
  expect(recovered.nodesJson).not.toContain("Demo Face");

  await page.evaluate(() => {
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: undefined
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => {
        let font = "";
        return {
          get font() {
            return font;
          },
          set font(value: string) {
            font = value;
          },
          measureText(value: string) {
            const scale = font.includes("Demo Face") ? 4 : 1;
            return {
              width: value.length * 8 * scale,
              actualBoundingBoxAscent: 12 * scale,
              actualBoundingBoxDescent: 4 * scale
            } as TextMetrics;
          }
        } as CanvasRenderingContext2D;
      }
    });
  });
  const outOfBounds = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(outOfBounds).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "font-asset-required"
      })
    })
  );

  await page.setContent(`
    <main style="font-family:'Demo Face', sans-serif">
      <span>\uF309</span>
      <button type="button">Continue</button>
    </main>
  `);
  const iconFont = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(iconFont).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "icon-font"
      })
    })
  );

  await page.setContent(`
    <style>
      .mixed-icon::before {
        content: "\uF309 x";
        font-family: "Demo Face";
      }
    </style>
    <main>
      <span class="mixed-icon"></span>
      <button type="button">Continue</button>
    </main>
  `);
  const mixedPseudoIcon = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(mixedPseudoIcon).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({ category: "icon-font" })
    })
  );

  await page.setContent(`
    <main style="font-family:'Unavailable Icon', sans-serif">
      <span>\uF309</span>
      <button type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: []
    });
  });
  const unloadedIconFont = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(unloadedIconFont).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({ category: "icon-font" })
    })
  );

  await page.setContent(`
    <main>
      <input type="button" value="\uF309" style="font-family:'Demo Face', sans-serif">
      <button type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: [{ family: "Demo Face", status: "loaded" }]
    });
  });
  const loadedInputIcon = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(loadedInputIcon).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({ category: "icon-font" })
    })
  );

  await page.setContent(`
    <main>
      <input type="button" value="\uF309" style="font-family:'Unavailable Icon', sans-serif">
      <button type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: []
    });
  });
  const unloadedInputIcon = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(unloadedInputIcon).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({ category: "icon-font" })
    })
  );

  await page.setContent(`
    <main>
      <input placeholder="\uF309" style="font-family:'Unavailable Icon', sans-serif">
      <button type="button">Continue</button>
    </main>
  `);
  const placeholderIcon = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(placeholderIcon).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({ category: "icon-font" })
    })
  );

  await page.setContent(`
    <style>
      input { font-family: "Safe Text", sans-serif; }
      input::placeholder { font-family: "Unavailable Icon", sans-serif; }
    </style>
    <main>
      <input placeholder="">
      <button type="button">Continue</button>
    </main>
  `);
  const pseudoPlaceholderIcon = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(pseudoPlaceholderIcon).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({ category: "icon-font" })
    })
  );

  await page.setContent(`
    <main>
      <input type="button" value="${"A".repeat(50_000)}\uF309" style="font-family:'Unavailable Icon', sans-serif">
      <button type="button">Continue</button>
    </main>
  `);
  const oversizedTextAttribute = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    pageAssetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(oversizedTextAttribute).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "text-attribute-limit"
      })
    })
  );

  await page.setContent(`
    <main style="font-family:'Demo Face', sans-serif">
      <p>Visible product text</p>
      <button type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: [{ family: "Demo Face", status: "loaded" }]
    });
  });

  const bundled = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-continue",
    nodeMode: "json",
    fontFaces: [
      {
        family: "Demo Face",
        style: "normal",
        weight: "400",
        stretch: "normal",
        display: "block",
        src: `./assets/${"a".repeat(64)}.woff2`
      }
    ]
  });
  expect(bundled.ok).toBe(true);
});

test("preserves visible filter, clip path, and mask geometry", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button" aria-label="Ask Gemini">
        <span
          style="
            display:block;
            filter:blur(1.75px);
            height:22px;
            mask-image:linear-gradient(to bottom right, black, transparent);
            mask-position:0% 0%;
            mask-repeat:repeat;
            mask-size:auto;
            width:22px;
          "
        >
          <span
            style="
              background:rgb(168, 199, 250);
              clip-path:path('M 0 11 L 11 0 L 22 11 L 11 22 Z');
              display:block;
              height:22px;
              width:22px;
            "
          ></span>
        </span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Ask Gemini", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-gemini",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const serialized = result.nodesJson ?? "";
  expect(serialized).toContain('"filter":"blur(1.75px)"');
  expect(serialized).toContain('"clip-path":"path(');
  expect(serialized).toContain(
    '"mask-image":"linear-gradient(to right bottom, rgb(0, 0, 0), rgba(0, 0, 0, 0))"'
  );
});

test("preserves a scaled coordinate space for clipped source artwork", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button" aria-label="Ask Gemini">
        <span
          data-testid="scaled-artwork"
          style="
            display:block;
            height:192px;
            position:absolute;
            transform:matrix(0.114583, 0, 0, 0.114583, 0, 0);
            transform-origin:0 0;
            width:192px;
          "
        >
          <span
            style="
              background:rgb(168, 199, 250);
              clip-path:path('M 0 96 L 96 0 L 192 96 L 96 192 Z');
              display:block;
              height:192px;
              width:192px;
            "
          ></span>
        </span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Ask Gemini", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-scaled-gemini",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]");
  const serialized = JSON.stringify(transferred);
  expect(serialized).toContain('"width":"192px"');
  expect(serialized).toContain('"height":"192px"');
  expect(serialized).toContain(
    '"transform":"matrix(0.114583, 0, 0, 0.114583, 0, 0)"'
  );
  expect(serialized).toContain('"clip-path":"path(');
});

test("preserves a box-stable rotation used by disclosure icons", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button">
        Workspace
        <svg
          aria-hidden="true"
          height="16"
          style="transform:matrix(0, 1, -1, 0, 0, 0);transform-origin:8px 8px"
          viewBox="0 0 16 16"
          width="16"
        >
          <path d="M6 4l5 4-5 4z"></path>
        </svg>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Workspace", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-workspace",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).toContain(
    '"transform":"matrix(0, 1, -1, 0, 0, 0)"'
  );
  expect(result.nodesJson).toContain('"transform-origin":"8px 8px"');
});

test("preserves visible pseudo-element icons as local semantic children", async ({
  page
}) => {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await page.setContent(`
    <style>
      #compose {
        align-items: center;
        display: flex;
        gap: 12px;
      }
      #compose::before {
        background-image: url("data:image/png;base64,${base64}");
        background-position: center;
        background-repeat: no-repeat;
        background-size: 24px 24px;
        content: "";
        display: block;
        height: 24px;
        width: 52px;
      }
      #compose::after {
        content: "›" / "More actions";
        display: inline-block;
      }
    </style>
    <main><button id="compose" type="button" aria-label="Compose">Compose</button></main>
  `);
  const result = await page
    .getByRole("button", { name: "Compose", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const serialized = result.nodesJson ?? "";
  expect(serialized).toContain('"data-showkit-pseudo":"before"');
  expect(serialized).toContain('"data-showkit-pseudo":"after"');
  expect(serialized).toContain(`./assets/${sha256}.png`);
  expect(serialized).toContain('"text":"›"');
  expect(serialized).not.toContain("More actions");
  expect(result.assetPayloads).toEqual([
    expect.objectContaining({
      sha256,
      mimeType: "image/png",
      byteLength: bytes.byteLength
    })
  ]);
});

test("bundles a safe base64 SVG data icon without retaining the data source", async ({
  page
}) => {
  const svg =
    '<svg viewBox="0 0 16 16"><path d="M2 8h12M8 2v12"></path></svg>';
  const base64 = Buffer.from(svg, "utf8").toString("base64");
  const sha256 = createHash("sha256")
    .update(Buffer.from(svg, "utf8"))
    .digest("hex");
  await page.setContent(`
    <main>
      <button type="button" aria-label="Add item">
        <span
          style="
            background-image:url('data:image/svg+xml;base64,${base64}');
            display:block;
            height:16px;
            width:16px;
          "
        ></span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Add item", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-add-item",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).toContain(`./assets/${sha256}.svg`);
  expect(result.nodesJson).not.toContain("data:image/svg+xml");
  expect(result.assetPayloads).toEqual([
    expect.objectContaining({
      sha256,
      mimeType: "image/svg+xml",
      byteLength: Buffer.byteLength(svg)
    })
  ]);
});

test("bundles a safe percent-encoded SVG data icon with quoted attributes", async ({
  page
}) => {
  const svg =
    "<svg width='12' height='12' viewBox='0 0 12 12' xmlns='http://www.w3.org/2000/svg'><path fill-rule='evenodd' d='M5 0h2v5h5v2H7v5H5V7H0V5h5z' fill='white'/></svg>";
  const encoded = encodeURIComponent(svg);
  const sha256 = createHash("sha256")
    .update(Buffer.from(svg, "utf8"))
    .digest("hex");
  await page.setContent(`
    <main>
      <button type="button" aria-label="Subscribe">
        <span
          style="
            background-image:url(&quot;data:image/svg+xml,${encoded}&quot;);
            display:block;
            height:12px;
            width:12px;
          "
        ></span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Subscribe", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-subscribe",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).toContain(`./assets/${sha256}.svg`);
  expect(result.nodesJson).not.toContain("data:image/svg+xml");
  expect(result.assetPayloads).toEqual([
    expect.objectContaining({
      sha256,
      mimeType: "image/svg+xml",
      byteLength: Buffer.byteLength(svg)
    })
  ]);
});

test("blocks an active percent-encoded SVG data icon on a visible control", async ({
  page
}) => {
  const activeSvg =
    "<svg viewBox='0 0 12 12'><script>alert(1)</script><path d='M0 0h12v12H0z'/></svg>";
  await page.setContent(`
    <main>
      <button type="button" aria-label="Unsafe action">
        <span
          style="
            background-image:url(&quot;data:image/svg+xml,${encodeURIComponent(activeSvg)}&quot;);
            display:block;
            height:12px;
            width:12px;
          "
        ></span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Unsafe action", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-unsafe-action",
      nodeMode: "json"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "remote-asset"
      })
    })
  );
  expect(JSON.stringify(result)).not.toContain("alert(1)");
});

test("bundles a static base64 SVG wordmark while rejecting active SVG content", async ({
  page
}) => {
  const wordmark = '<svg viewBox="0 0 80 20"><text x="0" y="16">Shop</text></svg>';
  const active = '<svg viewBox="0 0 16 16"><script>alert(1)</script><text x="0" y="12">No</text></svg>';
  const declared =
    '<!DOCTYPE svg [<!ENTITY label "No">]><svg viewBox="0 0 16 16"><text x="0" y="12">&label;</text></svg>';
  const wordmarkBase64 = Buffer.from(wordmark, "utf8").toString("base64");
  const activeBase64 = Buffer.from(active, "utf8").toString("base64");
  const declaredBase64 = Buffer.from(declared, "utf8").toString("base64");
  const sha256 = createHash("sha256")
    .update(Buffer.from(wordmark, "utf8"))
    .digest("hex");
  await page.setContent(`
    <main>
      <b
        aria-label="Shop"
        style="
          background-image:url('data:image/svg+xml;base64,${wordmarkBase64}');
          display:block;
          height:20px;
          width:80px;
        "
      ></b>
      <span
        style="
          background-image:url('data:image/svg+xml;base64,${activeBase64}');
          display:block;
          height:16px;
          width:16px;
        "
      ></span>
      <span
        style="
          background-image:url('data:image/svg+xml;base64,${declaredBase64}');
          display:block;
          height:16px;
          width:16px;
        "
      ></span>
    </main>
  `);
  const result = await page.locator("main").evaluate(extractSceneKernel, {
    ...baseOptions,
    targetPresent: false,
    nodeMode: "json"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.nodesJson).toContain(`./assets/${sha256}.svg`);
  expect(result.nodesJson).not.toContain(wordmarkBase64);
  expect(result.nodesJson).not.toContain(activeBase64);
  expect(result.nodesJson).not.toContain(declaredBase64);
  expect(result.assetPayloads).toEqual([
    expect.objectContaining({
      sha256,
      mimeType: "image/svg+xml",
      byteLength: Buffer.byteLength(wordmark)
    })
  ]);
});

test("ignores empty image-set content while preserving its rendered background icon", async ({
  page
}) => {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await page.setContent(`
    <style>
      #star {
        align-items: center;
        display: flex;
        height: 20px;
        justify-content: center;
        width: 20px;
      }
      #star::before {
        background-color: transparent;
        background-image: url("data:image/png;base64,${base64}");
        background-position: center;
        background-repeat: no-repeat;
        background-size: 20px 20px;
        content: image-set(url("") 1dppx, url("") 2dppx);
        display: block;
        height: 20px;
        position: static;
        width: 20px;
      }
    </style>
    <main>
      <button type="button" aria-label="Not starred">
        <span id="star"></span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Not starred", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-star",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const serialized = result.nodesJson ?? "";
  expect(serialized).toContain('"data-showkit-pseudo":"before"');
  expect(serialized).toContain(`./assets/${sha256}.png`);
  expect(serialized).not.toContain('url("")');
});

test("preserves visible form controls without persisting their values or UA chrome", async ({
  page
}) => {
  await page.setContent(`
    <style>
      #search {
        appearance: none;
        background-color: transparent;
        border: 0;
        color: rgb(32, 33, 36);
        height: 48px;
        padding: 0;
        width: 420px;
      }
      #icon {
        background-color: transparent;
        border: 0;
        height: 40px;
        padding: 0;
        width: 40px;
      }
    </style>
    <main>
      <input
        id="search"
        aria-label="Search mail"
        type="search"
        placeholder="Ask Gmail"
        value="must-not-persist"
      >
      <input
        id="empty-search"
        aria-label="Search archive"
        type="search"
        placeholder="Search archive"
      >
      <button id="icon" type="button" aria-label="Search options"></button>
    </main>
  `);
  const result = await page
    .getByRole("searchbox", { name: "Search mail", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-search",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const serialized = result.nodesJson ?? "";
  expect(serialized).toContain('"tag":"input"');
  expect(serialized).not.toContain('"placeholder":"Ask Gmail"');
  expect(serialized).toContain('"placeholder":"Search archive"');
  expect(serialized).toContain('"type":"search"');
  expect(serialized).toContain('"appearance":"none"');
  expect(serialized).not.toContain("must-not-persist");
  expect(serialized).toContain(
    '"background-color":"rgba(0, 0, 0, 0)"'
  );
  expect(serialized).toContain('"border-top":"0px none');
  expect(serialized).toContain('"padding-left":"0px"');
});

test("selects only isolated text-free control icons for rendered asset capture", async ({
  page
}) => {
  const wordmark = `data:image/svg+xml;base64,${Buffer.from(
    '<svg viewBox="0 0 80 20"><text x="0" y="16">Shop</text></svg>',
    "utf8"
  ).toString("base64")}`;
  await page.setContent(`
    <style>#generated-skill::before { content: "A"; }</style>
    <main>
      <button aria-label="Attach files" type="button">
        <span
          id="safe-icon"
          style="
            background-color: transparent;
            background-image: url('https://cdn.example.test/attach.png');
            background-position: center;
            background-repeat: no-repeat;
            background-size: 20px;
            display: block;
            height: 20px;
            width: 20px;
          "
        ></span>
      </button>
      <button aria-label="Text icon" type="button">
        <span
          style="
            background-image: url('https://cdn.example.test/text.png');
            background-position: center;
            background-repeat: no-repeat;
            background-size: 20px;
            display: block;
            height: 20px;
            width: 20px;
          "
        >A</span>
      </button>
      <button aria-label="Input tools" type="button">
        <span
          style="
            background-image: url('https://cdn.example.test/sprite.png');
            background-position: -14px -17px;
            background-repeat: repeat;
            background-size: 850px 250px;
            display: block;
            height: 16px;
            width: 20px;
          "
        ></span>
      </button>
      <button
        aria-label="Transparent gradient"
        type="button"
        style="background-image:-webkit-linear-gradient(top, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))"
      >
        <span
          style="
            background-color: transparent;
            background-image: url('https://cdn.example.test/gradient-icon.png');
            background-position: center;
            background-repeat: no-repeat;
            background-size: 20px;
            display: block;
            height: 20px;
            width: 20px;
          "
        ></span>
      </button>
      <a aria-label="Marketplace home" href="#home">
        <b
          style="
            background-image: url('${wordmark}');
            background-position: center;
            background-repeat: no-repeat;
            background-size: 80px 20px;
            display: block;
            height: 20px;
            width: 80px;
          "
        ></b>
      </a>
      <button aria-label="Large icon" type="button">
        <span
          style="
            background-image: url('https://cdn.example.test/large.png');
            background-position: center;
            background-repeat: no-repeat;
            background-size: 80px;
            display: block;
            height: 80px;
            width: 80px;
          "
        ></span>
      </button>
      <button aria-label="Nested skill surface" type="button">
        <span
          style="
            background-image: url('https://cdn.example.test/nested-skill.png');
            display: block;
            height: 20px;
            width: 20px;
          "
        ><i></i></span>
      </button>
      <button aria-label="Generated skill surface" type="button">
        <span
          id="generated-skill"
          style="
            background-image: url('https://cdn.example.test/generated-skill.png');
            display: block;
            height: 20px;
            width: 20px;
          "
        ></span>
      </button>
      <span
        style="
          background-image: url('https://cdn.example.test/noninteractive.png');
          background-position: center;
          background-repeat: no-repeat;
          background-size: 20px;
          display: block;
          height: 20px;
          width: 20px;
        "
      ></span>
    </main>
  `);
  const candidates = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidates).toEqual([
    expect.objectContaining({
      source: "https://cdn.example.test/attach.png",
      width: 20,
      height: 20
    }),
    expect.objectContaining({
      source: "https://cdn.example.test/sprite.png",
      width: 20,
      height: 16
    }),
    expect.objectContaining({
      source: "https://cdn.example.test/gradient-icon.png",
      width: 20,
      height: 20
    }),
    expect.objectContaining({
      source: wordmark,
      width: 80,
      height: 20
    })
  ]);
  expect(
    await page.evaluate(collectRenderedIconCandidatesInPage, [
      "https://cdn.example.test/attach.png",
      "https://cdn.example.test/sprite.png",
      "https://cdn.example.test/gradient-icon.png",
      wordmark
    ])
  ).toEqual([]);
});

test("allows direct icon capture only when text is not rendered in its bounds", async ({
  page
}) => {
  await page.setContent(`
    <style>#generated::before { content: "A"; }</style>
    <main>
      <button aria-label="Home settings" type="button">
        <span
          style="
            background-color:transparent;
            background-image:url('https://cdn.example.test/settings.svg');
            background-position:-145px 0;
            background-repeat:no-repeat;
            background-size:300px 300px;
            display:block;
            height:24px;
            overflow:hidden;
            text-indent:-9999px;
            width:24px;
          "
        >Home settings</span>
      </button>
      <button aria-label="Visible text" type="button">
        <span
          style="
            background-image:url('https://cdn.example.test/visible.svg');
            display:block;
            height:24px;
            width:24px;
          "
        >A</span>
      </button>
      <button aria-label="Nested surface" type="button">
        <span
          style="
            background-image:url('https://cdn.example.test/nested.svg');
            display:block;
            height:24px;
            width:24px;
          "
        ><i></i></span>
      </button>
      <button aria-label="Generated surface" type="button">
        <span
          id="generated"
          style="
            background-image:url('https://cdn.example.test/generated.svg');
            display:block;
            height:24px;
            width:24px;
          "
        ></span>
      </button>
    </main>
  `);
  const inventory = await page.evaluate(collectVisiblePageAssetInventory);
  expect(inventory.renderedIcons).toHaveLength(4);
  expect(inventory.renderedIcons).toEqual(expect.arrayContaining([
    expect.objectContaining({
      source: "https://cdn.example.test/settings.svg",
      width: 24,
      height: 24,
      directElementSafe: true
    }),
    expect.objectContaining({
      source: "https://cdn.example.test/visible.svg",
      width: 24,
      height: 24,
      directElementSafe: false
    }),
    expect.objectContaining({
      source: "https://cdn.example.test/nested.svg",
      directElementSafe: false
    }),
    expect.objectContaining({
      source: "https://cdn.example.test/generated.svg",
      directElementSafe: false
    })
  ]));
});

test("discovers an interactive sprite that is partially clipped by the viewport", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`
    <style>
      html, body { height: 720px; margin: 0; }
      button {
        position: absolute;
        top: 711px;
        left: 40px;
        border: 0;
        padding: 0;
        background: transparent;
      }
      span {
        display: block;
        width: 10px;
        height: 18px;
        background-image: url('http://127.0.0.1:4173/remote-consented/approved-icon.svg');
        background-position: -280px -125px;
        background-repeat: no-repeat;
        background-size: 300px 300px;
      }
    </style>
    <button type="button" aria-label="Open entertainment">
      <span></span>
    </button>
  `);

  const inventory = await page.evaluate(collectVisiblePageAssetInventory);
  expect(inventory.renderedIcons).toEqual([
    expect.objectContaining({
      source: "http://127.0.0.1:4173/remote-consented/approved-icon.svg",
      top: 711,
      width: 10,
      height: 18
    })
  ]);
  expect(
    inventory.renderedIcons[0]!.top + inventory.renderedIcons[0]!.height
  ).toBeGreaterThan(720);
  const prepared = await preparePlaywrightPageAssets(
    page,
    { mode: "public-page", consent: "requested" },
    inventory
  );
  expect(prepared.assets).toEqual([]);
  expect(prepared.replacements).toEqual([]);
});

test("selects pseudo icons whose computed content contains only empty image-set URLs", async ({
  page
}) => {
  await page.setContent(`
    <style>
      #star {
        align-items: center;
        display: flex;
        height: 20px;
        justify-content: flex-start;
        width: 20px;
      }
      #star::before {
        background-color: transparent;
        background-image: url("https://cdn.example.test/star.png");
        background-position: center;
        background-repeat: no-repeat;
        background-size: 20px 20px;
        content: image-set(url("") 1dppx, url("") 2dppx);
        display: block;
        height: 20px;
        position: static;
        width: 20px;
      }
    </style>
    <main>
      <button type="button" aria-label="Not starred">
        <span id="star"></span>
      </button>
    </main>
  `);
  const candidates = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidates).toEqual([
    expect.objectContaining({
      source: "https://cdn.example.test/star.png",
      width: 20,
      height: 20,
      match: expect.objectContaining({
        pseudo: "before"
      })
    })
  ]);
});

test("replays a bounded private-use icon glyph as an isolated local control asset", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      .control { height: 102px; margin-left: 150px; position: relative; width: 980px; }
      h2 { align-items: center; display: flex; height: 102px; margin: 0; width: 980px; }
      button {
        background: transparent;
        border: 0;
        height: 74px;
        position: absolute;
        right: 5px;
        top: 14px;
        width: 27px;
      }
      button::before {
        color: #333;
        content: "\\f309" / "";
        font: 50px/1 "Unavailable Icons";
      }
    </style>
    <main>
      <div class="control">
        <h2>Personal Data Apple Collects from You</h2>
        <button
          aria-label="Personal Data Apple Collects from You"
          type="button"
        ></button>
      </div>
    </main>
  `);
  const [candidate] = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidate).toEqual(
    expect.objectContaining({
      source: expect.stringMatching(/^showkit:rendered-font-icon:/),
      width: 27,
      height: 74,
      match: expect.objectContaining({
        fontGlyphElement: true,
        fontGlyphPseudo: "before"
      })
    })
  );
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await page
    .getByRole("button", {
      name: "Personal Data Apple Collects from You",
      exact: true
    })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-private-use-icon",
      remoteAssetReplacements: [
        {
          source: candidate!.source,
          captureKind: "isolated-rendered-icon",
          match: candidate!.match,
          payload: {
            sha256,
            mimeType: "image/png",
            byteLength: bytes.byteLength,
            base64
          }
        }
      ]
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain(`./assets/${sha256}.png`);
  expect(result.html).not.toContain("");
  expect(result.target?.bounds.width).toBeCloseTo(980 / 1280, 5);
});

test("distinguishes pseudo-glyph visual states in rendered-icon candidates", async ({
  page
}) => {
  await page.setContent(`
    <style>
      button {
        background: transparent;
        border: 0;
        height: 48px;
        width: 48px;
      }
      button::before {
        content: "\\f309" / "";
        display: inline-block;
        font: 24px/1 "Unavailable Icons";
      }
      button[aria-expanded="true"]::before {
        transform: rotate(180deg);
      }
    </style>
    <main>
      <button aria-expanded="false" aria-label="Collapsed" type="button"></button>
      <button aria-expanded="true" aria-label="Expanded" type="button"></button>
    </main>
  `);
  const candidates = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidates).toHaveLength(2);
  expect(
    new Set(
      candidates.map((candidate) => candidate.match.fontGlyphTransform)
    ).size
  ).toBe(2);
});

test("fails closed when a visible private-use icon font cannot be bundled", async ({
  page
}) => {
  await page.setContent(`
    <style>
      button::before {
        content: "\\f309" / "";
        font: 24px/1 "Unavailable Icons";
      }
    </style>
    <main>
      <button aria-label="Open details" type="button"></button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Open details", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-private-use-icon-missing-font"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "icon-font"
      })
    })
  );
});

test("does not treat clipped accessible text as visible icon fallback text", async ({
  page
}) => {
  await page.setContent(`
    <style>
      .sr-only {
        border: 0;
        clip: rect(0, 0, 0, 0);
        height: 1px;
        margin: -1px;
        overflow: hidden;
        padding: 0;
        position: absolute;
        white-space: nowrap;
        width: 1px;
      }
      button::before {
        content: "\\f309" / "";
        font: 24px/1 "Unavailable Icons";
      }
    </style>
    <main>
      <button type="button"><span class="sr-only">Open details</span></button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Open details", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-private-use-icon-clipped-label"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "icon-font"
      })
    })
  );
});

test("removes an unavailable decorative icon glyph from a visible text link", async ({
  page
}) => {
  await page.setContent(`
    <style>
      a::after {
        content: "\\f301" / "";
        font: 17px/1 "Unavailable Icons";
      }
    </style>
    <main>
      <a href="/legal/warranty/">Find your warranty</a>
    </main>
  `);
  const result = await page
    .getByRole("link", { name: "Find your warranty", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-decorative-private-use-icon"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain("Find your warranty");
  expect(result.html).not.toContain("");
  expect(result.excludedSurfaces).toContain(
    "decorative-icon-font-glyphs"
  );
});

test("does not expose descendants of a scale-zero status badge", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <a aria-label="Shopping Bag" href="/bag">
        <svg aria-hidden="true" height="44" viewBox="0 0 14 44" width="14">
          <path d="M1 16h12v12H1z"></path>
        </svg>
        <span
          aria-hidden="true"
          style="height:13px;position:absolute;transform:scale(0);width:13px"
        >
          <span style="background:#000;border-radius:13px;display:block;height:13px;width:13px"></span>
          <span>0</span>
        </span>
      </a>
    </main>
  `);
  const result = await page
    .getByRole("link", { name: "Shopping Bag", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-hidden-status-badge"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain('aria-label="Shopping Bag"');
  expect(result.html).not.toContain(">0<");
  expect(result.html).not.toContain("border-radius:13px");
});

test("does not rasterize a bounded content image as a rendered fallback", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button" aria-label="Property at 1 Example Way">
        <img
          alt=""
          src="https://cdn.example.test/property.webp"
          style="display:block;height:279px;width:418px"
        >
        <span>1 Example Way</span>
      </button>
    </main>
  `);
  const candidates = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidates).toEqual([]);
});

test("does not rasterize transformed image elements as icon fallbacks", async ({
  page
}) => {
  await page.setContent(`
    <main style="padding:80px">
      <div role="button" aria-label="Assistant" style="height:40px;position:relative;width:40px">
        <img
          alt="Decorative accessory"
          src="https://cdn.example.test/accessory.webp"
          style="
            height:40px;
            left:0;
            pointer-events:none;
            position:absolute;
            top:0;
            transform:rotate(45deg);
            width:40px
          "
        >
      </div>
      <div role="button" aria-label="Unsafe transformed image" style="height:40px;position:relative;width:40px">
        <img
          alt=""
          src="https://cdn.example.test/interactive.webp"
          style="
            height:40px;
            pointer-events:auto;
            transform:rotate(45deg);
            width:40px
          "
        >
      </div>
    </main>
  `);
  const candidates = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidates).toEqual([]);
});

test("replays one bounded canvas icon while preserving its semantic control", async ({
  page
}) => {
  await page.setContent(`
    <main style="padding:80px">
      <a
        aria-label="Connected app"
        href="#connected-app"
        role="button"
        style="display:block;height:32px;padding:8px;width:32px"
      >
        <canvas
          height="32"
          style="display:block;height:16px;width:16px"
          width="32"
        ></canvas>
      </a>
    </main>
  `);
  const [candidate] = await page.evaluate(
    collectRenderedIconCandidatesInPage,
    []
  );
  expect(candidate).toEqual(
    expect.objectContaining({
      source: expect.stringMatching(/^showkit:rendered-canvas:/),
      width: 16,
      height: 16,
      match: expect.objectContaining({
        canvasElement: true,
        intrinsicDimensions: {
          width: 32,
          height: 32
        }
      })
    })
  );
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await page
    .getByRole("button", { name: "Connected app", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-connected-app",
      remoteAssetReplacements: [
        {
          source: candidate!.source,
          captureKind: "isolated-rendered-canvas",
          match: candidate!.match,
          payload: {
            sha256,
            mimeType: "image/png",
            byteLength: bytes.byteLength,
            base64
          }
        }
      ]
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).not.toContain("<canvas");
  expect(result.html).toContain(`./assets/${sha256}.png`);
  expect(result.html).toContain('aria-label="Connected app"');
  expect(result.html).toContain('role="button"');
  expect(result.html).toContain('aria-hidden="true"');
});

test("continues to block a canvas that is not an isolated icon", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button">Open report</button>
      <canvas style="display:block;height:240px;width:480px"></canvas>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Open report", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-report"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "canvas"
      })
    })
  );
  const target = page.getByRole("button", {
    name: "Open report",
    exact: true
  });
  await expect(
    captureScene(page, {
      target,
      captureTarget: {
        strategy: "role",
        role: "button",
        name: "Open report"
      },
      anchorId: "sk-open-report"
    })
  ).rejects.toMatchObject({
    code: "UnsupportedSurface",
    details: expect.objectContaining({ category: "canvas" })
  });
});

test("keeps the viewport scene and omits offscreen-only content", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button type="button">Compose</button>
      <section style="position:absolute;top:2000px">
        Offscreen private row for demo-user@example.invalid
      </section>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Compose", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain("Compose");
  expect(result.html).not.toContain("Offscreen private row");
  expect(JSON.stringify(result)).not.toContain("demo-user@example.invalid");
});

test("drops hidden inputs without requiring private-content consent", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <h1>Public release notes</h1>
      <button type="button">Open release</button>
      <input type="hidden" value="SHOWKIT_SECRET_CANARY_HIDDEN_VALUE">
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Open release", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-release",
      nodeMode: "json"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.excludedSurfaces).toContain("hidden-inputs");
  expect(result.html).toContain("Open release");
  expect(result.html).not.toContain('type="hidden"');
  expect(JSON.stringify(result)).not.toContain(
    "SHOWKIT_SECRET_CANARY_HIDDEN_VALUE"
  );
});

test("requires explicit consent and then changes only captured text", async ({
  page
}) => {
  await page.setContent(`
    <main style="display:grid;gap:16px;padding:24px">
      <section
        data-private-message
        aria-label="Message from demo-user@example.invalid"
        style="border:1px solid #ccd2cc;padding:12px"
      >
        <strong>Demo sender</strong>
        <p>Quarterly plan for demo-user@example.invalid</p>
      </section>
      <button type="button">Compose email</button>
      <input type="hidden" value="runtime-only">
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Compose email",
    exact: true
  });
  const liveHtmlBefore = await page.locator("body").evaluate((body) => body.innerHTML);

  const blocked = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose-email"
  });
  expect(blocked).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "SensitiveDataDetected"
      })
    })
  );

  const baseline = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose-email",
    secretPatternSources: [],
    sensitiveTextRedaction: {
      mode: "text-only",
      consent: "confirmed",
      selectors: []
    }
  });
  const redacted = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose-email",
    sensitiveTextRedaction: {
      mode: "text-only",
      consent: "confirmed",
      selectors: ["[data-private-message]"]
    }
  });
  expect(baseline.ok).toBe(true);
  expect(redacted.ok).toBe(true);
  if (
    !baseline.ok ||
    baseline.scanOnly ||
    !redacted.ok ||
    redacted.scanOnly
  ) {
    return;
  }

  const structureWithoutText = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(structureWithoutText);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "text") return { type: "text" };
    const attributes =
      record.attributes && typeof record.attributes === "object"
        ? Object.fromEntries(
            Object.entries(record.attributes as Record<string, string>).map(
              ([name, content]) => [
                name,
                ["alt", "aria-description", "aria-label", "aria-placeholder", "title"].includes(
                  name
                )
                  ? "<text>"
                  : content
              ]
            )
          )
        : record.attributes;
    return {
      ...record,
      ...(attributes ? { attributes } : {}),
      children: structureWithoutText(record.children)
    };
  };

  expect(structureWithoutText(redacted.nodes)).toEqual(
    structureWithoutText(baseline.nodes)
  );
  expect(redacted.target?.bounds).toEqual(baseline.target?.bounds);
  expect(redacted.target?.name).toBe("Compose email");
  expect(redacted.html).toContain("Compose email");
  expect(redacted.html).toContain("••••");
  expect(redacted.nodes[0]).toEqual(
    expect.objectContaining({
      type: "element",
      children: expect.arrayContaining([
        expect.objectContaining({
          type: "element",
          tag: "main",
          children: expect.arrayContaining([
            expect.objectContaining({
              type: "element",
              tag: "section",
              children: expect.arrayContaining([
                expect.objectContaining({
                  type: "element",
                  tag: "strong"
                })
              ])
            })
          ])
        })
      ])
    })
  );
  expect(JSON.stringify(redacted)).not.toMatch(
    /Demo sender|Quarterly plan|demo-user@example\.invalid|runtime-only/
  );
  expect(redacted.sensitiveText).toEqual(
    expect.objectContaining({
      mode: "text-only",
      redactedTextNodeCount: 2,
      redactedAttributeCount: 1,
      regionCount: 1
    })
  );
  expect(await page.locator("body").evaluate((body) => body.innerHTML)).toBe(
    liveHtmlBefore
  );
});

test("keeps visible private text only after explicit local-session consent", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <p>Signed in as demo-user@example.invalid</p>
      <button type="button">Compose</button>
      <input type="hidden" value="hidden-runtime-value">
    </main>
  `);
  const target = page.getByRole("button", { name: "Compose", exact: true });
  const blocked = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose"
  });
  expect(blocked).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "SensitiveDataDetected"
      })
    })
  );

  const consented = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-compose",
    nodeMode: "json",
    privateContentConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
  expect(consented.ok).toBe(true);
  if (!consented.ok || consented.scanOnly) return;
  expect(consented.html).toContain("demo-user@example.invalid");
  expect(consented.nodesJson).toContain("demo-user@example.invalid");
  expect(JSON.stringify(consented)).not.toContain("hidden-runtime-value");
});

test("removes a decorative remote asset and keeps the semantic HTML state", async ({
  page
}) => {
  await page.goto("http://127.0.0.1:4173/remote-decorative/index.html");
  const result = await page
    .getByRole("button", { name: "Open report", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-report"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.excludedSurfaces).toContain("remote-decorative-assets");
  expect(result.html).not.toContain("decorative-image.png");
  expect(result.html).toContain("Open report");
  expect(result.target?.role).toBe("button");
});

test("keeps safe same-document SVG fragment references local", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button aria-label="Open home" type="button">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <defs>
            <clipPath id="logo-clip">
              <rect x="0" y="0" width="24" height="24"></rect>
            </clipPath>
          </defs>
          <g clip-path="url(#logo-clip)">
            <circle cx="12" cy="12" r="12"></circle>
          </g>
        </svg>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Open home", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-home"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain("logo-clip");
  expect(result.html).toContain("clippath");
  expect(result.html).not.toContain("https:");
  expect(result.target?.role).toBe("button");
});

test("copies safe external SVG symbols used by visible icons", async ({
  page
}) => {
  await page.setContent(`
    <svg aria-hidden="true" style="display:none">
      <symbol id="project-icon" viewBox="0 0 16 16">
        <path d="M2 2h12v12H2z"></path>
        <path d="M5 5h6v6H5z" fill="white"></path>
      </symbol>
    </svg>
    <main>
      <button type="button">
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <use href="#project-icon"></use>
        </svg>
        Projects
      </button>
    </main>
  `);
  const target = page.getByRole("button", {
    name: "Projects",
    exact: true
  });
  const sourceBounds = await target.locator("use").evaluate((use) => {
    const bounds = (use as SVGGraphicsElement).getBBox();
    return {
      width: bounds.width,
      height: bounds.height
    };
  });
  const result = await target.evaluate(extractSceneKernel, {
    ...baseOptions,
    anchorId: "sk-projects",
    nodeMode: "json"
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  const transferred = JSON.parse(result.nodesJson ?? "[]");
  const serialized = JSON.stringify(transferred);
  expect(serialized).toContain('"tag":"symbol"');
  expect(serialized).toContain('"tag":"use"');
  expect(serialized).toContain('"href":"#project-icon"');
  expect(serialized.match(/"tag":"path"/g)).toHaveLength(2);

  await page.setContent("<main id=\"captured-scene\"></main>");
  await page.locator("#captured-scene").evaluate((mount, nodes) => {
    const svgTagNames = new Map([
      ["clippath", "clipPath"]
    ]);
    const svgTags = new Set([
      "circle",
      "clippath",
      "defs",
      "ellipse",
      "g",
      "image",
      "line",
      "path",
      "polygon",
      "polyline",
      "rect",
      "svg",
      "symbol",
      "use"
    ]);
    const createNode = (
      node:
        | { type: "text"; text: string }
        | {
            type: "element";
            tag: string;
            attributes: Record<string, string>;
            styles: Record<string, string>;
            children: unknown[];
          }
    ): Node => {
      if (node.type === "text") return document.createTextNode(node.text);
      const element = svgTags.has(node.tag)
        ? document.createElementNS(
            "http://www.w3.org/2000/svg",
            svgTagNames.get(node.tag) ?? node.tag
          )
        : document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attributes)) {
        element.setAttribute(name, value);
      }
      for (const [name, value] of Object.entries(node.styles)) {
        (element as HTMLElement).style.setProperty(name, value);
      }
      for (const child of node.children) {
        element.append(createNode(child as Parameters<typeof createNode>[0]));
      }
      return element;
    };
    mount.replaceChildren(
      ...(nodes as Parameters<typeof createNode>[0][]).map(createNode)
    );
  }, transferred);

  const capturedBounds = await page
    .locator('[data-showkit-anchor="sk-projects"] use')
    .evaluate((use) => {
      const bounds = (use as SVGGraphicsElement).getBBox();
      return {
        width: bounds.width,
        height: bounds.height
      };
    });
  expect(capturedBounds.width).toBeCloseTo(sourceBounds.width, 3);
  expect(capturedBounds.height).toBeCloseTo(sourceBounds.height, 3);
});

test("blocks a visible interactive icon when the browser cannot bundle it", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <button id="compose" type="button">Compose</button>
      <button aria-label="Attach files" type="button">
        <span
          style="
            background-image: url('https://cdn.example.test/attach.png');
            display: block;
            height: 20px;
            width: 20px;
          "
        ></span>
      </button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Compose", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-compose"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "remote-asset"
      })
    })
  );
  expect(JSON.stringify(result)).not.toContain("attach.png");
});

test("restores a named native select when its decorative arrow cannot be bundled", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <label for="category">Category</label>
      <select
        id="category"
        style="
          appearance: none;
          background-image: url('https://cdn.example.test/select-arrow.svg');
          background-position: right 8px center;
          background-repeat: no-repeat;
          background-size: 12px 12px;
        "
      >
        <option>All categories</option>
      </select>
      <button id="continue" type="button">Continue</button>
    </main>
  `);
  const result = await page
    .getByRole("button", { name: "Continue", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      remoteAssetPolicy: "strict",
      anchorId: "sk-continue"
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).not.toContain("select-arrow.svg");
  const findSelect = (nodes: typeof result.nodes): (typeof result.nodes)[number] | undefined => {
    for (const node of nodes) {
      if (node.type === "element" && node.tag === "select") return node;
      if (node.type === "element") {
        const nested = findSelect(node.children);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  const select = findSelect(result.nodes);
  expect(select).toMatchObject({
    type: "element",
    tag: "select",
    styles: expect.objectContaining({ appearance: "auto" })
  });
  if (select?.type === "element") {
    expect(select.styles).not.toHaveProperty("background-position");
  }
  expect(result.excludedSurfaces).toContain("remote-decorative-assets");
});

test("blocks a target that depends on a remote asset", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/remote-critical/index.html");
  const result = await page
    .getByRole("button", { name: "Open document", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-document"
    });
  expect(result).toEqual(
    expect.objectContaining({
      ok: false,
      blocker: expect.objectContaining({
        code: "UnsupportedSurface",
        category: "remote-asset"
      })
    })
  );
  expect(JSON.stringify(result)).not.toContain("critical-illustration.png");
});

test("uses an explicitly approved local bundle for a critical public asset", async ({
  page
}) => {
  await page.goto("http://127.0.0.1:4173/remote-critical/index.html");
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await page
    .getByRole("button", { name: "Open document", exact: true })
    .evaluate(extractSceneKernel, {
      ...baseOptions,
      anchorId: "sk-open-document",
      remoteAssetReplacements: [
        {
          source:
            "http://127.0.0.1:4173/remote-critical/critical-illustration.png",
          payload: {
            sha256,
            mimeType: "image/png",
            byteLength: bytes.byteLength,
            base64
          }
        }
      ]
    });
  expect(result.ok).toBe(true);
  if (!result.ok || result.scanOnly) return;
  expect(result.html).toContain(`./assets/${sha256}.png`);
  expect(result.html).not.toContain("critical-illustration.png");
  expect(result.html).toContain("<svg");
  expect(result.html).toContain('<circle cx="12" cy="12" r="10"');
  expect(result.html).toContain('<path d="M8 12h8M12 8v8"');
  expect(
    JSON.stringify(result.nodes)
  ).toContain(`url(\\"./assets/${sha256}.png\\")`);
  expect(result.assetPayloads).toEqual([
    expect.objectContaining({
      sha256,
      mimeType: "image/png",
      byteLength: bytes.byteLength
    })
  ]);
});

test("rejects a local query-bearing image even after public-page consent", async ({
  page
}) => {
  await page.goto("http://127.0.0.1:4173/remote-consented/index.html");
  const target = page.getByRole("button", {
    name: "Open release",
    exact: true
  });
  const captureTarget = {
    strategy: "role" as const,
    role: "button",
    name: "Open release"
  };
  await expect(
    captureScene(page, {
      target,
      captureTarget,
      anchorId: "sk-open-release"
    })
  ).rejects.toMatchObject({
    code: "UnsupportedSurface",
    details: expect.objectContaining({ category: "remote-asset" })
  });

  await expect(
    captureScene(page, {
      target,
      captureTarget,
      anchorId: "sk-open-release",
      pageAssetConsent: {
        mode: "public-page",
        consent: "requested"
      }
    })
  ).rejects.toMatchObject({
    code: "UnsupportedSurface",
    details: expect.objectContaining({ category: "remote-asset" })
  });
});

test("exposes the failure fixtures without performing an external action", async ({
  page
}) => {
  await page.goto("http://127.0.0.1:4173/login-redirect/index.html");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();

  await page.goto("http://127.0.0.1:4173/ambiguous-target/index.html");
  await expect(page.getByRole("button", { name: "Open report" })).toHaveCount(2);

  await page.goto("http://127.0.0.1:4173/browser-side-effect/index.html");
  await expect(page.getByRole("status")).toHaveText(
    "The report has not been published."
  );
  expect(
    await page.evaluate(() => {
      return (
        globalThis as typeof globalThis & {
          browserSideEffectCount: number;
        }
      ).browserSideEffectCount;
    })
  ).toBe(0);
});
