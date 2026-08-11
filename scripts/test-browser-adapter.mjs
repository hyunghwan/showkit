import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as cli from "@showkit/cli";
import {
  browserSelectionPlan,
  captureBrowserSession,
  collectRenderedIconCandidatesInPage,
  createAdaptiveApprovedRuntime,
  createApprovedCdpRuntime,
  createCodexBrowserAdapter,
  createCodexPageAssetProvider,
  readCodexBrowserEnvironment,
  removeBrowserSessionEnvelope,
  verifyCodexBrowserHostIsolation
} from "../skills/showkit/scripts/capture-browser-session.mjs";

const SESSION_CANARY = "SHOWKIT_SECRET_CANARY_SESSION_STORAGE";
const stepNames = ["Overview", "Reports", "Filters", "Activity", "Settings"];

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // A trusted OpenAI host is optional in clean package test environments.
    }
  }
  return undefined;
}

function recipeSteps() {
  return stepNames.map((name, index) => ({
    id: `step-${index + 1}`,
    title: `Open ${name.toLowerCase()}`,
    target: {
      strategy: "role",
      role: "button",
      name
    },
    actionKind: index === 1 ? "navigate" : index === 2 ? "filter" : "select"
  }));
}

function sceneResult(name, options) {
  const anchorId = options.anchorId;
  return {
    ok: true,
    scanOnly: false,
    html: `<main data-showkit-scene-root=""><button role="button" data-showkit-anchor="${anchorId}">${name}</button></main>`,
    nodes: [
      {
        type: "element",
        tag: "main",
        attributes: { "data-showkit-scene-root": "" },
        styles: {},
        children: [
          {
            type: "element",
            tag: "button",
            attributes: {
              role: "button",
              "data-showkit-anchor": anchorId
            },
            styles: {},
            children: [{ type: "text", text: name }]
          }
        ]
      }
    ],
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0, width: 1280, height: 720 },
    target: {
      tag: "button",
      role: "button",
      name,
      bounds: {
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.08
      }
    },
    evidenceTexts: [name, `${name} dashboard section`],
    assetPayloads: [],
    fontFaces: options.fontFaces ?? [],
    excludedSurfaces: ["browser-storage", "network-data", "remote-assets"]
  };
}

function terminalResult() {
  return {
    ok: true,
    scanOnly: false,
    html: '<main data-showkit-scene-root=""><h1>Dashboard ready</h1></main>',
    nodes: [
      {
        type: "element",
        tag: "main",
        attributes: { "data-showkit-scene-root": "" },
        styles: {},
        children: [
          {
            type: "element",
            tag: "h1",
            attributes: {},
            styles: {},
            children: [{ type: "text", text: "Dashboard ready" }]
          }
        ]
      }
    ],
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0, width: 1280, height: 720 },
    evidenceTexts: [],
    assetPayloads: [],
    fontFaces: [],
    excludedSurfaces: ["browser-storage", "network-data", "remote-assets"]
  };
}

function mockAdapter(
  surface,
  {
    authenticated = true,
    hasDomAccess = true,
    count = 1,
    matchedCount = count,
    visibleCount = count,
    interruptAfterAction = false
  } = {}
) {
  let currentUrl =
    "https://app.example.test/dashboard?session=never-persist#private";
  let alive = true;
  const state = {
    actionCount: 0,
    cleanupCount: 0,
    privateCookie: SESSION_CANARY,
    privateStorage: SESSION_CANARY
  };
  return {
    adapter: {
      browserSurface: surface,
      browserName: surface === "iab" ? "Codex Browser" : "Google Chrome",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      authenticated,
      hasDomAccess,
      captureSecurity: {
        provider: "openai-browser",
        verified: true,
        executionWorld: "isolated-readonly-v1",
        pluginVersion: "test",
        implementationHash: "test"
      },
      async currentUrl() {
        return currentUrl;
      },
      async isAlive() {
        return alive;
      },
      async domSnapshot() {
        return stepNames.map((name) => `button "${name}"`).join("\n");
      },
      async targetCount() {
        return visibleCount;
      },
      async targetStatus() {
        return { matchedCount, visibleCount };
      },
      async targetVisible() {
        return true;
      },
      async evaluateTarget(target, _pageFunction, options) {
        assert.equal(options.scrollCapture, "revealed");
        return sceneResult(target.name, options);
      },
      async performAction() {
        state.actionCount += 1;
        currentUrl =
          "https://app.example.test/dashboard?after=never-persist#private";
        if (interruptAfterAction) alive = false;
      },
      async evaluateTerminal(_pageFunction, options) {
        assert.equal(options.scrollCapture, "revealed");
        return terminalResult();
      },
      async cleanup() {
        state.cleanupCount += 1;
      }
    },
    state
  };
}

async function capture(
  surface,
  adapter,
  steps = recipeSteps(),
  confirmedActionIds = [],
  sensitiveTextRedaction,
  pageAssetConsent,
  privateContentConsent,
  expectedViewport = { width: 1280, height: 720 },
  sourceHost = "codex"
) {
  return captureBrowserSession({
    adapter,
    sourceHost,
    expectedViewport,
    url: "https://app.example.test/dashboard?token=never-persist#private",
    id: `signed-in-${surface}`,
    steps,
    confirmedActionIds,
    ...(sensitiveTextRedaction ? { sensitiveTextRedaction } : {}),
    ...(pageAssetConsent ? { pageAssetConsent } : {}),
    ...(privateContentConsent ? { privateContentConsent } : {}),
    cli
  });
}

const hostFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "showkit-codex-host-")
);
await Promise.all([
  mkdir(path.join(hostFixtureRoot, ".codex-plugin"), { recursive: true }),
  mkdir(path.join(hostFixtureRoot, "docs"), { recursive: true }),
  mkdir(path.join(hostFixtureRoot, "scripts"), { recursive: true })
]);
await Promise.all([
  writeFile(
    path.join(hostFixtureRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "browser", version: "test-host" })
  ),
  writeFile(
    path.join(hostFixtureRoot, "docs", "api.json"),
    [
      "Evaluate JavaScript in a read-only page scope",
      "Maximum time to spend setting up the read-only DOM scope"
    ].join("\n")
  ),
  writeFile(
    path.join(hostFixtureRoot, "scripts", "browser-client.mjs"),
    [
      "Page.createIsolatedWorld",
      "browser-use-readonly-js",
      "grantUniveralAccess:!1",
      "readonly_live_dom"
    ].join("\n")
  )
]);
let forgedProbeCount = 0;
await assert.rejects(
  () =>
    verifyCodexBrowserHostIsolation({
      pluginRoot: hostFixtureRoot,
      tab: {
        playwright: {
          async evaluate() {
            forgedProbeCount += 1;
            return {
              ok: true,
              documentNodeType: 9,
              viewport: { width: 1280, height: 720 }
            };
          }
        }
      }
    }),
  /does not satisfy ShowKit's isolated read-only execution contract/
);
assert.equal(forgedProbeCount, 0);
await rm(hostFixtureRoot, { recursive: true, force: true });

const trustedPluginRoot = process.env.SHOWKIT_TEST_SKIP_INSTALLED_HOST === "1"
  ? undefined
  : await firstExisting([
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.730.61639"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
    "26.730.61639"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.730.61309"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
    "26.730.61309"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.727.51351"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
    "26.727.51351"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.727.40816"
  ),
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
    "26.727.40816"
  )
    ]);
if (trustedPluginRoot) {
  const trustedPluginVersion = path.basename(trustedPluginRoot);
  let environmentResult = {
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "UTC"
  };
  let probing = true;
  const trustedTab = {
    playwright: {
      async evaluate() {
        if (probing) {
          return {
            ok: true,
            documentNodeType: 9,
            viewport: { width: 1280, height: 720 }
          };
        }
        return environmentResult;
      },
      async domSnapshot() {
        return 'button "Overview"';
      },
      locator() {
        return {
          async count() {
            return 1;
          },
          async isVisible() {
            return true;
          }
        };
      },
      getByRole() {
        return this.locator();
      }
    }
  };
  const verifiedHost = await verifyCodexBrowserHostIsolation({
    pluginRoot: trustedPluginRoot,
    tab: trustedTab
  });
  probing = false;
  assert.equal(verifiedHost.provider, "openai-browser");
  assert.match(verifiedHost.pluginName, /^(?:browser|chrome)$/);
  assert.equal(verifiedHost.pluginVersion, trustedPluginVersion);
  assert.equal(verifiedHost.executionWorld, "isolated-readonly-v1");
  const boundHostAdapter = createCodexBrowserAdapter({
    tab: trustedTab,
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 },
    hostValidation: verifiedHost
  });
  assert.equal(boundHostAdapter.captureSecurity.verified, true);
  const differentTabAdapter = createCodexBrowserAdapter({
    tab: {
      playwright: trustedTab.playwright
    },
    browserSurface: "iab",
    browserName: "Codex Browser",
    viewport: { width: 1280, height: 720 },
    hostValidation: verifiedHost
  });
  assert.equal(differentTabAdapter.captureSecurity.verified, false);
  await assert.rejects(
    () =>
      readCodexBrowserEnvironment(
        {
          playwright: trustedTab.playwright
        },
        verifiedHost
      ),
    /exact selected tab/
  );
  environmentResult = {
    viewport: { width: "poisoned", height: 720 },
    locale: null,
    timezoneId: "UTC"
  };
  await assert.rejects(
    () => readCodexBrowserEnvironment(trustedTab, verifiedHost),
    (error) => {
      assert.equal(error.code, "BrowserSessionInterrupted");
      assert.equal(error.details?.category, "environment-result-malformed");
      return true;
    }
  );
  environmentResult = {
    viewport: { width: 1280, height: 720 },
    locale: "SHOWKIT_HOSTILE_LOCALE",
    timezoneId: "SHOWKIT/HOSTILE/TIME/ZONE"
  };
  await assert.rejects(
    () => readCodexBrowserEnvironment(trustedTab, verifiedHost),
    (error) => {
      assert.equal(error.code, "BrowserSessionInterrupted");
      assert.equal(error.details?.category, "environment-result-malformed");
      return true;
    }
  );
}

let approvedCdpFallbackVerified = false;
let approvedCdpCommandAllowlistVerified = false;
let approvedCdpNavigationRefreshVerified = false;
let deniedCdpCapabilityRejected = false;
let adaptiveCdpTimeoutFallbackVerified = false;
{
  let currentUrl = "https://dashboard.example.test/payments";
  let loaderId = "loader-1";
  let nextExecutionContextId = 40;
  let failNextRuntimeContext = false;
  let capabilityGetCount = 0;
  const cdpCommands = [];
  const locator = {
    async count() {
      return 1;
    },
    async isVisible() {
      return true;
    }
  };
  const cdpCapability = {
    async send(method, params, options) {
      cdpCommands.push({ method, params, options });
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId,
              url: currentUrl
            }
          }
        };
      }
      if (method === "Page.createIsolatedWorld") {
        nextExecutionContextId += 1;
        return { executionContextId: nextExecutionContextId };
      }
      if (method === "Runtime.evaluate") {
        if (failNextRuntimeContext) {
          failNextRuntimeContext = false;
          return {
            exceptionDetails: {
              text: "Execution context was destroyed during navigation."
            }
          };
        }
        const value = params.expression.includes("timezoneId")
          ? {
              viewport: { width: 1280, height: 720 },
              locale: "en-US",
              timezoneId: "UTC"
            }
          : {
              ok: true,
              documentNodeType: 9,
              viewport: { width: 1280, height: 720 }
            };
        return { result: { type: "object", value } };
      }
      throw new Error(`Unexpected CDP command: ${method}`);
    }
  };
  const cdpTab = {
    async url() {
      return currentUrl;
    },
    capabilities: {
      async list() {
        return [{ id: "cdp", description: "Raw CDP" }];
      },
      async get(id) {
        assert.equal(id, "cdp");
        capabilityGetCount += 1;
        return cdpCapability;
      }
    },
    playwright: {
      async evaluate() {
        throw new Error("admin-enforced policy could not be verified");
      },
      async domSnapshot() {
        return 'button "Payments"';
      },
      locator() {
        return locator;
      },
      getByRole() {
        return locator;
      }
    }
  };
  let readCdpEnvironment;
  if (trustedPluginRoot) {
    const cdpValidation = await verifyCodexBrowserHostIsolation({
      pluginRoot: trustedPluginRoot,
      tab: cdpTab
    });
    assert.equal(cdpValidation.transport, "approved-cdp-capability");
    assert.equal(cdpValidation.send, undefined);
    assert.equal(capabilityGetCount, 1);
    const cdpAdapter = createCodexBrowserAdapter({
      tab: cdpTab,
      browserSurface: "chrome",
      browserName: "Google Chrome",
      viewport: { width: 1280, height: 720 },
      hostValidation: cdpValidation
    });
    assert.equal(cdpAdapter.hasDomAccess, true);
    assert.equal(cdpAdapter.captureSecurity.verified, true);
    assert.equal(
      cdpAdapter.captureSecurity.transport,
      "approved-cdp-capability"
    );
    assert.equal(cdpAdapter.send, undefined);
    readCdpEnvironment = () =>
      readCodexBrowserEnvironment(cdpTab, cdpValidation);
  } else {
    const cdpRuntime = await createApprovedCdpRuntime(
      cdpTab,
      cdpCapability,
      new URL(currentUrl).origin
    );
    readCdpEnvironment = () =>
      cdpRuntime.evaluate(() => ({
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        locale: window.navigator.language,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone
      }));
  }
  assert.deepEqual(
    await readCdpEnvironment(),
    {
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      timezoneId: "UTC"
    }
  );
  const isolatedWorldCountBeforeNavigation = cdpCommands.filter(
    ({ method }) => method === "Page.createIsolatedWorld"
  ).length;
  loaderId = "loader-2";
  await readCdpEnvironment();
  assert.equal(
    cdpCommands.filter(({ method }) => method === "Page.createIsolatedWorld")
      .length,
    isolatedWorldCountBeforeNavigation + 1
  );
  failNextRuntimeContext = true;
  await readCdpEnvironment();
  assert.equal(
    cdpCommands.filter(({ method }) => method === "Page.createIsolatedWorld")
      .length,
    isolatedWorldCountBeforeNavigation + 2
  );
  const runtimeCountBeforeOriginChange = cdpCommands.filter(
    ({ method }) => method === "Runtime.evaluate"
  ).length;
  currentUrl = "https://example.test/payments";
  await assert.rejects(
    () => readCdpEnvironment(),
    /left the origin approved for this capture/
  );
  assert.equal(
    cdpCommands.filter(({ method }) => method === "Runtime.evaluate").length,
    runtimeCountBeforeOriginChange
  );
  assert.deepEqual(
    [...new Set(cdpCommands.map(({ method }) => method))].sort(),
    [
      "Page.createIsolatedWorld",
      "Page.getFrameTree",
      "Runtime.evaluate"
    ]
  );
  assert.ok(
    cdpCommands.every(
      ({ options }) =>
        options?.timeoutMs === 10_000
    )
  );
  approvedCdpFallbackVerified = true;
  approvedCdpCommandAllowlistVerified = true;
  approvedCdpNavigationRefreshVerified = true;

  const deniedTab = {
    async url() {
      return "https://dashboard.example.test/payments";
    },
    playwright: {
      async evaluate() {
        throw new Error("admin-enforced policy could not be verified");
      }
    },
    capabilities: {
      async list() {
        return [{ id: "cdp" }];
      },
      async get() {
        throw new Error("Chrome CDP access was not approved.");
      }
    }
  };
  if (trustedPluginRoot) {
    await assert.rejects(
      () =>
        verifyCodexBrowserHostIsolation({
          pluginRoot: trustedPluginRoot,
          tab: deniedTab
        }),
      /was not approved/
    );
  } else {
    const deniedRuntime = await createApprovedCdpRuntime(
      deniedTab,
      {
        async send() {
          throw new Error("Chrome CDP access was not approved.");
        }
      },
      "https://dashboard.example.test"
    );
    await assert.rejects(
      () => deniedRuntime.evaluate(() => true),
      /was not approved/
    );
  }
  deniedCdpCapabilityRejected = true;

  let adaptiveDirectEvaluateCount = 0;
  let adaptiveCapabilityGetCount = 0;
  const adaptiveCdpCommands = [];
  const adaptiveCdpCapability = {
    async send(method) {
      adaptiveCdpCommands.push(method);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "adaptive-frame",
              loaderId: "adaptive-loader",
              url: "https://dashboard.example.test/payments"
            }
          }
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 77 };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: {
              viewport: { width: 1280, height: 720 },
              locale: "en-US",
              timezoneId: "UTC"
            }
          }
        };
      }
      throw new Error(`Unexpected adaptive CDP command: ${method}`);
    }
  };
  const adaptiveTab = {
    async url() {
      return "https://dashboard.example.test/payments";
    },
    capabilities: {
      async list() {
        return [{ id: "cdp" }];
      },
      async get() {
        adaptiveCapabilityGetCount += 1;
        return adaptiveCdpCapability;
      }
    },
    playwright: {
      async evaluate() {
        adaptiveDirectEvaluateCount += 1;
        if (adaptiveDirectEvaluateCount === 1) {
          return {
            ok: true,
            documentNodeType: 9,
            viewport: { width: 1280, height: 720 }
          };
        }
        throw new Error(
          "Timed out after 3000ms waiting for CDP command Page.getFrameTree."
        );
      }
    }
  };
  let readAdaptiveEnvironment;
  if (trustedPluginRoot) {
    const adaptiveValidation = await verifyCodexBrowserHostIsolation({
      pluginRoot: trustedPluginRoot,
      tab: adaptiveTab
    });
    assert.equal(
      adaptiveValidation.transport,
      "host-readonly-evaluate+approved-cdp-fallback"
    );
    readAdaptiveEnvironment = () =>
      readCodexBrowserEnvironment(adaptiveTab, adaptiveValidation);
  } else {
    const directRuntime = {
      evaluate(pageFunction, options) {
        return adaptiveTab.playwright.evaluate(pageFunction, options);
      }
    };
    const adaptiveRuntime = createAdaptiveApprovedRuntime(
      adaptiveTab,
      directRuntime,
      "https://dashboard.example.test"
    );
    await adaptiveRuntime.evaluate(() => ({
      ok: true,
      documentNodeType: document.nodeType,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }));
    readAdaptiveEnvironment = () =>
      adaptiveRuntime.evaluate(() => ({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        locale: window.navigator.language,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone
      }));
  }
  await readAdaptiveEnvironment();
  await readAdaptiveEnvironment();
  assert.equal(adaptiveDirectEvaluateCount, 2);
  assert.equal(adaptiveCapabilityGetCount, 1);
  assert.deepEqual(
    [...new Set(adaptiveCdpCommands)].sort(),
    [
      "Page.createIsolatedWorld",
      "Page.getFrameTree",
      "Runtime.evaluate"
    ]
  );
  adaptiveCdpTimeoutFallbackVerified = true;
}

const noPageEvaluateLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  }
};
const noPageEvaluateAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'button "Overview"';
      },
      locator() {
        return noPageEvaluateLocator;
      },
      getByRole() {
        return noPageEvaluateLocator;
      }
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
assert.equal(noPageEvaluateAdapter.hasDomAccess, false);
assert.equal(noPageEvaluateAdapter.captureSecurity.verified, false);
await assert.rejects(
  () =>
    noPageEvaluateAdapter.evaluateTarget(
      {
        strategy: "role",
        role: "button",
        name: "Overview"
      },
      () => {},
      {}
    ),
  /cannot provide isolated page evaluation/
);

const unverifiedHostMock = mockAdapter("iab");
unverifiedHostMock.adapter.captureSecurity = {
  provider: "openai-browser",
  verified: false,
  executionWorld: "unverified"
};
await assert.rejects(
  () => capture("iab", unverifiedHostMock.adapter),
  (error) => {
    assert.equal(error.code, "UnsupportedSurface");
    assert.equal(error.details?.category, "browser-isolation-unverified");
    return true;
  }
);
assert.equal(unverifiedHostMock.state.actionCount, 0);
assert.equal(unverifiedHostMock.state.cleanupCount, 1);

for (const targetCase of [
  {
    name: "missing",
    matchedCount: 0,
    visibleCount: 0,
    category: "target-missing"
  },
  {
    name: "hidden",
    matchedCount: 1,
    visibleCount: 0,
    category: "target-hidden"
  },
  {
    name: "duplicate",
    matchedCount: 2,
    visibleCount: 2,
    category: "target-duplicate"
  }
]) {
  const targetMock = mockAdapter("iab", targetCase);
  await assert.rejects(
    () => capture("iab", targetMock.adapter),
    (error) => {
      assert.equal(error.code, "BrowserTargetAmbiguous");
      assert.equal(error.details?.category, targetCase.category);
      assert.equal(error.details?.targetCount, targetCase.matchedCount);
      assert.equal(
        error.details?.visibleTargetCount,
        targetCase.visibleCount
      );
      return true;
    },
    targetCase.name
  );
  assert.equal(targetMock.state.actionCount, 0);
  assert.equal(targetMock.state.cleanupCount, 1);
}

const snapshotCanary = "SHOWKIT_HOSTILE_SNAPSHOT_CANARY_71A4";
const poisonedSnapshotMock = mockAdapter("iab");
poisonedSnapshotMock.adapter.domSnapshot = async () => snapshotCanary;
const snapshotIndependentCapture = await capture(
  "iab",
  poisonedSnapshotMock.adapter
);
try {
  const persistedEnvelope = await readFile(
    snapshotIndependentCapture.envelopePath,
    "utf8"
  );
  assert.doesNotMatch(persistedEnvelope, new RegExp(snapshotCanary));
} finally {
  await removeBrowserSessionEnvelope(
    snapshotIndependentCapture.envelopePath
  );
}

const malformedSceneMock = mockAdapter("iab");
malformedSceneMock.adapter.evaluateTarget = async () => ({
  ok: true,
  scanOnly: false,
  target: {}
});
await assert.rejects(
  () => capture("iab", malformedSceneMock.adapter),
  (error) => {
    assert.equal(error.code, "BrowserSessionInterrupted");
    assert.equal(error.details?.category, "scene-result-malformed");
    return true;
  }
);
assert.equal(malformedSceneMock.state.actionCount, 0);
assert.equal(malformedSceneMock.state.cleanupCount, 1);

const malformedTerminalMock = mockAdapter("iab");
malformedTerminalMock.adapter.evaluateTerminal = async () => ({
  ok: true,
  scanOnly: false
});
await assert.rejects(
  () => capture("iab", malformedTerminalMock.adapter),
  (error) => {
    assert.equal(error.code, "BrowserSessionInterrupted");
    assert.equal(error.details?.category, "terminal-result-malformed");
    return true;
  }
);
assert.equal(malformedTerminalMock.state.actionCount, 5);
assert.equal(malformedTerminalMock.state.cleanupCount, 1);

const viewportMismatchMock = mockAdapter("iab");
await assert.rejects(
  () =>
    capture(
      "iab",
      viewportMismatchMock.adapter,
      recipeSteps(),
      [],
      undefined,
      undefined,
      undefined,
      { width: 1324, height: 1130 }
    ),
  (error) => {
    assert.equal(error.code, "BrowserSessionInterrupted");
    assert.equal(error.details?.category, "viewport-mismatch");
    assert.deepEqual(error.details?.expectedViewport, {
      width: 1324,
      height: 1130
    });
    assert.deepEqual(error.details?.actualViewport, {
      width: 1280,
      height: 720
    });
    assert.match(error.message, /No captured page was saved/);
    return true;
  }
);
assert.equal(viewportMismatchMock.state.actionCount, 0);
assert.equal(viewportMismatchMock.state.cleanupCount, 1);

const iabPlan = browserSelectionPlan({
  url: "https://app.example.test/dashboard?token=private#fragment",
  explicitSurface: "iab"
});
assert.deepEqual(
  {
    method: iabPlan.method,
    argument: iabPlan.argument,
    url: iabPlan.url
  },
  {
    method: "get",
    argument: "iab",
    url: "https://app.example.test/dashboard"
  }
);
const chromePlan = browserSelectionPlan({
  url: "https://app.example.test/dashboard",
  explicitSurface: "chrome"
});
assert.equal(chromePlan.argument, "extension");
const automaticPlan = browserSelectionPlan({
  url: "https://app.example.test/dashboard?token=private"
});
assert.equal(automaticPlan.method, "getForUrl");
assert.equal(automaticPlan.argument, "https://app.example.test/dashboard");

for (const surface of ["iab", "chrome"]) {
  const { adapter, state } = mockAdapter(surface);
  const sourceHost = surface === "chrome" ? "chatgpt" : "codex";
  const result = await capture(
    surface,
    adapter,
    recipeSteps(),
    [],
    undefined,
    undefined,
    undefined,
    { width: 1280, height: 720 },
    sourceHost
  );
  try {
    const serialized = await readFile(result.envelopePath, "utf8");
    const envelope = cli.validateAgentBrowserCaptureEnvelope(JSON.parse(serialized));
    assert.equal(result.stepCount, 5);
    assert.equal(result.replayLevel, "session-captured");
    assert.deepEqual(
      {
        htmlSceneCount: result.capturePerformance.htmlSceneCount,
        assetPreparationCount:
          result.capturePerformance.assetPreparationCount,
        actionCount: result.capturePerformance.actionCount
      },
      {
        htmlSceneCount: 6,
        assetPreparationCount: 6,
        actionCount: 5
      }
    );
    assert.equal(
      Number.isFinite(result.capturePerformance.totalMs),
      true
    );
    assert.equal(envelope.capture.source.host, sourceHost);
    assert.equal(envelope.capture.source.browserSurface, surface);
    assert.equal(envelope.capture.source.sessionPersisted, false);
    assert.equal(envelope.capture.steps.length, 5);
    assert.equal(state.actionCount, 5);
    assert.equal(state.cleanupCount, 1);
    assert.doesNotMatch(serialized, /never-persist|SHOWKIT_SECRET_CANARY/);
    assert.doesNotMatch(serialized, /[?#]/);
  } finally {
    await removeBrowserSessionEnvelope(result.envelopePath);
  }
}

const missingSourceHostMock = mockAdapter("iab");
await assert.rejects(
  () =>
    captureBrowserSession({
      adapter: missingSourceHostMock.adapter,
      expectedViewport: { width: 1280, height: 720 },
      url: "https://app.example.test/dashboard",
      id: "missing-source-host",
      steps: recipeSteps(),
      cli
    }),
  { code: "DemoFixtureSetupFailed" }
);
assert.equal(missingSourceHostMock.state.actionCount, 0);
assert.equal(missingSourceHostMock.state.cleanupCount, 1);

for (const [options, code] of [
  [{ authenticated: false }, "BrowserAuthenticationRequired"],
  [{ hasDomAccess: false }, "BrowserDomAccessRequired"],
  [{ count: 2 }, "BrowserTargetAmbiguous"]
]) {
  const { adapter, state } = mockAdapter("iab", options);
  await assert.rejects(() => capture("iab", adapter), { code });
  assert.equal(state.actionCount, 0);
  assert.equal(state.cleanupCount, 1);
}

const unconfirmedRedactionMock = mockAdapter("iab");
await assert.rejects(
  () =>
    capture(
      "iab",
      unconfirmedRedactionMock.adapter,
      recipeSteps(),
      [],
      {
        mode: "text-only",
        selectors: ["[data-private]"]
      }
    ),
  { code: "SensitiveDataDetected" }
);
assert.equal(unconfirmedRedactionMock.state.actionCount, 0);

const confirmedRedactionMock = mockAdapter("iab");
const redactedResult = await capture(
  "iab",
  confirmedRedactionMock.adapter,
  recipeSteps(),
  [],
  {
    mode: "text-only",
    consent: "confirmed",
    selectors: ["[data-private]"]
  }
);
try {
  const redactedEnvelope = cli.validateAgentBrowserCaptureEnvelope(
    JSON.parse(await readFile(redactedResult.envelopePath, "utf8"))
  );
  assert.deepEqual(redactedEnvelope.recipe.sensitiveTextRedaction, {
    mode: "text-only",
    consent: "confirmed",
    regionCount: 1
  });
  assert.deepEqual(redactedEnvelope.capture.redaction.sensitiveText, {
    mode: "text-only",
    redactedTextNodeCount: 0,
    redactedAttributeCount: 0,
    regionCount: 1
  });
} finally {
  await removeBrowserSessionEnvelope(redactedResult.envelopePath);
}

const confirmedPrivateMock = mockAdapter("iab");
const confirmedPrivateResult = await capture(
  "iab",
  confirmedPrivateMock.adapter,
  recipeSteps(),
  [],
  undefined,
  undefined,
  {
    mode: "visible-session",
    consent: "confirmed"
  }
);
try {
  const confirmedPrivateEnvelope = cli.validateAgentBrowserCaptureEnvelope(
    JSON.parse(await readFile(confirmedPrivateResult.envelopePath, "utf8"))
  );
  assert.deepEqual(confirmedPrivateEnvelope.recipe.privateContent, {
    mode: "visible-session",
    consent: "confirmed"
  });
  assert.deepEqual(confirmedPrivateEnvelope.capture.redaction.privateContent, {
    mode: "visible-session",
    consent: "confirmed",
    localOnly: true,
    hiddenValuesExcluded: true
  });
} finally {
  await removeBrowserSessionEnvelope(confirmedPrivateResult.envelopePath);
}

const consentedAssetMock = mockAdapter("iab");
consentedAssetMock.adapter.preparePublicAssets = async (context) => {
  assert.deepEqual(context.assetConsent, {
    mode: "visible-session",
    consent: "confirmed"
  });
  return [];
};
const consentedAssetResult = await capture(
  "iab",
  consentedAssetMock.adapter,
  recipeSteps(),
  [],
  undefined,
  {
    mode: "visible-session",
    consent: "confirmed"
  }
);
try {
  const consentedAssetEnvelope = cli.validateAgentBrowserCaptureEnvelope(
    JSON.parse(await readFile(consentedAssetResult.envelopePath, "utf8"))
  );
  assert.deepEqual(consentedAssetEnvelope.recipe.pageAssets, {
    mode: "visible-session",
    consent: "confirmed"
  });
  assert.deepEqual(consentedAssetEnvelope.capture.redaction.pageAssets, {
    mode: "visible-session",
    consent: "confirmed",
    localOnly: true,
    assetCount: 0
  });
} finally {
  await removeBrowserSessionEnvelope(consentedAssetResult.envelopePath);
}

const mutatingSteps = recipeSteps();
mutatingSteps[0] = {
  ...mutatingSteps[0],
  title: "Publish report",
  target: {
    strategy: "role",
    role: "button",
    name: "Publish"
  }
};
const mutationMock = mockAdapter("chrome");
mutationMock.adapter.domSnapshot = async () =>
  ["Publish", ...stepNames.slice(1)].map((name) => `button "${name}"`).join("\n");
await assert.rejects(
  () => capture("chrome", mutationMock.adapter, mutatingSteps),
  { code: "BrowserActionConfirmationRequired" }
);
assert.equal(mutationMock.state.actionCount, 0);

const confirmedMutationMock = mockAdapter("chrome");
confirmedMutationMock.adapter.domSnapshot = mutationMock.adapter.domSnapshot;
const confirmedResult = await capture(
  "chrome",
  confirmedMutationMock.adapter,
  mutatingSteps,
  ["step-1"]
);
assert.equal(confirmedMutationMock.state.actionCount, 5);
await removeBrowserSessionEnvelope(confirmedResult.envelopePath);

const discloseSteps = recipeSteps();
discloseSteps[2] = {
  ...discloseSteps[2],
  title: "Add Cc recipients",
  target: {
    strategy: "role",
    role: "link",
    name: "Add Cc recipients"
  },
  actionKind: "disclose"
};
const discloseMock = mockAdapter("iab");
discloseMock.adapter.domSnapshot = async () =>
  stepNames
    .map((name, index) =>
      index === 2 ? 'link "Add Cc recipients"' : `button "${name}"`
    )
    .join("\n");
const discloseResult = await capture(
  "iab",
  discloseMock.adapter,
  discloseSteps
);
assert.equal(discloseMock.state.actionCount, 5);
await removeBrowserSessionEnvelope(discloseResult.envelopePath);

const interruptedMock = mockAdapter("iab", { interruptAfterAction: true });
const temporaryFilesBefore = new Set(
  (await readdir(os.tmpdir())).filter((name) =>
    name.startsWith("showkit-browser-session-")
  )
);
await assert.rejects(
  () => capture("iab", interruptedMock.adapter),
  { code: "BrowserSessionInterrupted" }
);
const temporaryFilesAfter = new Set(
  (await readdir(os.tmpdir())).filter((name) =>
    name.startsWith("showkit-browser-session-")
  )
);
assert.deepEqual(temporaryFilesAfter, temporaryFilesBefore);
assert.equal(interruptedMock.state.cleanupCount, 1);

const assetDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-page-assets-"));
const assetPath = path.join(assetDirectory, "hero.png");
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
await writeFile(assetPath, pngBytes);
const publicInventoryAsset = {
  id: "hero-image",
  kind: "image",
  name: "hero.png",
  sources: [{ kind: "attribute" }],
  url: "https://assets.example.test/hero.png?im_w=1280&q=80&auto=format&dpr=2"
};
const unavailablePublicInventoryAsset = {
  id: "later-state-image",
  kind: "image",
  name: "later.png",
  sources: [{ kind: "attribute" }],
  url: "https://assets.example.test/later.png?im_w=640"
};
const pageAssetCapability = {
  async list() {
    return {
      assets: [publicInventoryAsset, unavailablePublicInventoryAsset],
      id: "inventory-1",
      inlineSvgs: [],
      pageUrl: "https://app.example.test/dashboard?session=runtime-only",
      summary: {
        byKind: { image: 2 },
        inlineSvgCount: 0,
        totalCount: 2
      }
    };
  },
  async bundle() {
    return {
      assets: [
        {
          contentType: "image/png",
          id: "hero-image",
          kind: "image",
          name: "hero.png",
          path: assetPath,
          url: publicInventoryAsset.url
        }
      ],
      directoryPath: assetDirectory,
      failures: [
        {
          id: unavailablePublicInventoryAsset.id,
          reason: "The exact public image bytes were unavailable."
        }
      ],
      manifestPath: path.join(assetDirectory, "manifest.json"),
      summary: {
        downloadedCount: 1,
        elapsedMs: 1,
        failedCount: 1,
        requestedCount: 2
      }
    };
  }
};
const pageAssetTab = {
  capabilities: {
    async list() {
      return [{ id: "pageAssets", description: "Page assets" }];
    },
    async get() {
      return pageAssetCapability;
    }
  },
  async url() {
    return "https://app.example.test/dashboard?session=runtime-only#private";
  }
};
const pageAssetProvider = createCodexPageAssetProvider({
  tab: pageAssetTab,
  approvals: [
    {
      id: "hero-image",
      origin: "https://assets.example.test",
      classification: "public"
    },
    {
      id: "later-state-image",
      origin: "https://assets.example.test",
      classification: "public"
    }
  ]
});
const replacements = await pageAssetProvider();
assert.equal(replacements.length, 1);
assert.equal(replacements[0].source, publicInventoryAsset.url);
assert.equal(replacements[0].payload.mimeType, "image/png");
assert.equal(replacements[0].payload.byteLength, pngBytes.byteLength);
assert.equal(
  replacements[0].payload.sha256,
  createHash("sha256").update(pngBytes).digest("hex")
);
await assert.rejects(access(assetDirectory));

const avifAssetDirectory = await mkdtemp(
  path.join(os.tmpdir(), "showkit-avif-page-assets-")
);
const avifAssetPath = path.join(avifAssetDirectory, "hero.avif");
const avifBytes = Buffer.concat([
  Buffer.from([0, 0, 0, 20]),
  Buffer.from("ftypavif", "ascii"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("avif", "ascii")
]);
await writeFile(avifAssetPath, avifBytes);
const avifInventoryAsset = {
  id: "avif-hero-image",
  kind: "image",
  name: "hero.png",
  sources: [{ kind: "attribute" }],
  url: "https://assets.example.test/hero.png?w=1280&q=80&auto=format&dpr=2"
};
const avifAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          async list() {
            return {
              ...(await pageAssetCapability.list()),
              assets: [avifInventoryAsset],
              id: "inventory-avif"
            };
          },
          async bundle() {
            return {
              assets: [
                {
                  contentType: "image/avif",
                  id: avifInventoryAsset.id,
                  kind: "image",
                  name: avifInventoryAsset.name,
                  path: avifAssetPath,
                  url: avifInventoryAsset.url
                }
              ],
              directoryPath: avifAssetDirectory,
              failures: [],
              manifestPath: path.join(avifAssetDirectory, "manifest.json"),
              summary: {
                downloadedCount: 1,
                elapsedMs: 1,
                failedCount: 0,
                requestedCount: 1
              }
            };
          }
        };
      }
    }
  },
  approvals: [
    {
      id: avifInventoryAsset.id,
      origin: "https://assets.example.test",
      classification: "public"
    }
  ]
});
const avifReplacements = await avifAssetProvider();
assert.equal(avifReplacements.length, 1);
assert.equal(avifReplacements[0].payload.mimeType, "image/avif");
assert.equal(avifReplacements[0].payload.byteLength, avifBytes.byteLength);
await assert.rejects(access(avifAssetDirectory));

const unsafeQueryAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          ...pageAssetCapability,
          async list() {
            return {
              ...(await pageAssetCapability.list()),
              assets: [
                {
                  ...publicInventoryAsset,
                  url: "https://assets.example.test/hero.png?token=not-allowed"
                }
              ]
            };
          }
        };
      }
    }
  },
  approvals: [
    {
      id: "hero-image",
      origin: "https://assets.example.test",
      classification: "public"
    }
  ]
});
await assert.rejects(() => unsafeQueryAssetProvider());

const privateAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          ...pageAssetCapability,
          async list() {
            return {
              ...(await pageAssetCapability.list()),
              assets: [
                {
                  ...publicInventoryAsset,
                  name: "profile-avatar.png"
                }
              ]
            };
          }
        };
      }
    }
  },
  approvals: [
    {
      id: "hero-image",
      origin: "https://assets.example.test",
      classification: "public"
    }
  ]
});
await assert.rejects(() => privateAssetProvider());

const privateSessionAssetDirectory = await mkdtemp(
  path.join(os.tmpdir(), "showkit-private-page-assets-")
);
const privateSessionAssetPath = path.join(
  privateSessionAssetDirectory,
  "profile-avatar.png"
);
await writeFile(privateSessionAssetPath, pngBytes);
const privateSessionInventoryAsset = {
  ...publicInventoryAsset,
  id: "profile-avatar",
  name: "profile-avatar.png",
  sources: [{ kind: "attribute", property: "src" }],
  url: "https://assets.example.test/profile-avatar.png?runtime=private"
};
const privateSessionAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          async list() {
            return {
              assets: [privateSessionInventoryAsset],
              id: "inventory-private",
              inlineSvgs: [],
              pageUrl:
                "https://app.example.test/dashboard?session=runtime-only",
              summary: {
                byKind: { image: 1 },
                inlineSvgCount: 0,
                totalCount: 1
              }
            };
          },
          async bundle() {
            return {
              assets: [
                {
                  contentType: "image/png",
                  id: privateSessionInventoryAsset.id,
                  kind: "image",
                  name: privateSessionInventoryAsset.name,
                  path: privateSessionAssetPath,
                  url: privateSessionInventoryAsset.url
                }
              ],
              directoryPath: privateSessionAssetDirectory,
              failures: [],
              manifestPath: path.join(
                privateSessionAssetDirectory,
                "manifest.json"
              ),
              summary: {
                downloadedCount: 1,
                elapsedMs: 1,
                failedCount: 0,
                requestedCount: 1
              }
            };
          }
        };
      }
    }
  }
});
const privateSessionReplacements = await privateSessionAssetProvider({
  assetConsent: {
    mode: "visible-session",
    consent: "confirmed"
  }
});
assert.equal(privateSessionReplacements.length, 1);
assert.equal(
  privateSessionReplacements[0].payload.mimeType,
  "image/png"
);
await assert.rejects(access(privateSessionAssetDirectory));

const renderedSessionAssetDirectory = await mkdtemp(
  path.join(os.tmpdir(), "showkit-rendered-page-assets-")
);
const renderedSessionAssetPath = path.join(
  renderedSessionAssetDirectory,
  "hero.png"
);
await writeFile(renderedSessionAssetPath, pngBytes);
const unusedInventoryAsset = {
  ...publicInventoryAsset,
  id: "unused-map-tile",
  name: "unused-map-tile.png",
  url: "https://maps.example.test/unused-map-tile.png"
};
let renderedSessionRequestedIds;
const renderedSessionAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    playwright: {
      async evaluate() {
        return [publicInventoryAsset.url];
      }
    },
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          async list() {
            return {
              assets: [publicInventoryAsset, unusedInventoryAsset],
              id: "inventory-rendered",
              inlineSvgs: [],
              pageUrl:
                "https://app.example.test/dashboard?session=runtime-only",
              summary: {
                byKind: { image: 2 },
                inlineSvgCount: 0,
                totalCount: 2
              }
            };
          },
          async bundle({ assetIds }) {
            renderedSessionRequestedIds = assetIds;
            return {
              assets: [
                {
                  contentType: "image/png",
                  id: publicInventoryAsset.id,
                  kind: "image",
                  name: publicInventoryAsset.name,
                  path: renderedSessionAssetPath,
                  url: publicInventoryAsset.url
                }
              ],
              directoryPath: renderedSessionAssetDirectory,
              failures: [],
              manifestPath: path.join(
                renderedSessionAssetDirectory,
                "manifest.json"
              ),
              summary: {
                downloadedCount: 1,
                elapsedMs: 1,
                failedCount: 0,
                requestedCount: 1
              }
            };
          }
        };
      }
    }
  }
});
const renderedSessionReplacements = await renderedSessionAssetProvider({
  assetConsent: {
    mode: "visible-session",
    consent: "confirmed"
  }
});
assert.deepEqual(renderedSessionRequestedIds, [publicInventoryAsset.id]);
assert.equal(renderedSessionReplacements.length, 1);
assert.equal(
  renderedSessionReplacements[0].source,
  publicInventoryAsset.url
);
await assert.rejects(access(renderedSessionAssetDirectory));

const aliasedSessionAssetDirectory = await mkdtemp(
  path.join(os.tmpdir(), "showkit-aliased-page-assets-")
);
const aliasedSessionAssetPath = path.join(
  aliasedSessionAssetDirectory,
  "runtime-image.png"
);
await writeFile(aliasedSessionAssetPath, pngBytes);
const renderedSessionSource =
  "https://assets.example.test/runtime-image.png";
const aliasedSessionInventoryAsset = {
  ...publicInventoryAsset,
  id: "runtime-image",
  name: "runtime-image.png",
  url: `${renderedSessionSource}?signed=visible-session`
};
let aliasedSessionRequestedIds;
const aliasedSessionAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    playwright: {
      async evaluate() {
        return [renderedSessionSource];
      }
    },
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          async list() {
            return {
              assets: [aliasedSessionInventoryAsset],
              id: "inventory-aliased",
              inlineSvgs: [],
              pageUrl:
                "https://app.example.test/dashboard?session=runtime-only",
              summary: {
                byKind: { image: 1 },
                inlineSvgCount: 0,
                totalCount: 1
              }
            };
          },
          async bundle({ assetIds }) {
            aliasedSessionRequestedIds = assetIds;
            return {
              assets: [
                {
                  contentType: "image/png",
                  id: aliasedSessionInventoryAsset.id,
                  kind: "image",
                  name: aliasedSessionInventoryAsset.name,
                  path: aliasedSessionAssetPath,
                  url: aliasedSessionInventoryAsset.url
                }
              ],
              directoryPath: aliasedSessionAssetDirectory,
              failures: [],
              manifestPath: path.join(
                aliasedSessionAssetDirectory,
                "manifest.json"
              ),
              summary: {
                downloadedCount: 1,
                elapsedMs: 1,
                failedCount: 0,
                requestedCount: 1
              }
            };
          }
        };
      }
    }
  }
});
const aliasedSessionReplacements = await aliasedSessionAssetProvider({
  assetConsent: {
    mode: "visible-session",
    consent: "confirmed"
  }
});
assert.deepEqual(aliasedSessionRequestedIds, [
  aliasedSessionInventoryAsset.id
]);
assert.deepEqual(
  aliasedSessionReplacements.map((replacement) => replacement.source).sort(),
  [aliasedSessionInventoryAsset.url, renderedSessionSource].sort()
);
assert.equal(
  new Set(
    aliasedSessionReplacements.map(
      (replacement) => replacement.payload.sha256
    )
  ).size,
  1
);
await assert.rejects(access(aliasedSessionAssetDirectory));

const ambiguousSessionAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    playwright: {
      async evaluate() {
        return [renderedSessionSource];
      }
    },
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          async list() {
            return {
              assets: [
                aliasedSessionInventoryAsset,
                {
                  ...aliasedSessionInventoryAsset,
                  id: "runtime-image-alternate",
                  url: `${renderedSessionSource}?signed=alternate`
                }
              ],
              id: "inventory-ambiguous",
              inlineSvgs: [],
              pageUrl:
                "https://app.example.test/dashboard?session=runtime-only",
              summary: {
                byKind: { image: 2 },
                inlineSvgCount: 0,
                totalCount: 2
              }
            };
          },
          async bundle() {
            throw new Error("Ambiguous aliases must not be bundled.");
          }
        };
      }
    }
  }
});
assert.deepEqual(
  await ambiguousSessionAssetProvider({
    assetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  }),
  []
);

const fontAssetDirectory = await mkdtemp(
  path.join(os.tmpdir(), "showkit-font-page-assets-")
);
const fontAssetPath = path.join(fontAssetDirectory, "google-sans.woff2");
const woff2Bytes = Buffer.concat([
  Buffer.from("wOF2", "ascii"),
  Buffer.alloc(32)
]);
await writeFile(fontAssetPath, woff2Bytes);
const fontInventoryAsset = {
  id: "google-sans",
  kind: "font",
  name: "google-sans.woff2",
  sources: [{ kind: "stylesheet" }],
  url: "https://fonts.example.test/google-sans.woff2"
};
const fontAssetProvider = createCodexPageAssetProvider({
  tab: {
    ...pageAssetTab,
    playwright: {
      async evaluate() {
        return [
          {
            source: fontInventoryAsset.url,
            family: "Google Sans",
            style: "normal",
            weight: "400",
            stretch: "normal",
            display: "swap"
          }
        ];
      }
    },
    capabilities: {
      ...pageAssetTab.capabilities,
      async get() {
        return {
          async list() {
            return {
              assets: [fontInventoryAsset],
              id: "inventory-font",
              inlineSvgs: [],
              pageUrl:
                "https://app.example.test/dashboard?session=runtime-only",
              summary: {
                byKind: { font: 1 },
                inlineSvgCount: 0,
                totalCount: 1
              }
            };
          },
          async bundle() {
            return {
              assets: [
                {
                  contentType: "application/octet-stream",
                  id: fontInventoryAsset.id,
                  kind: "font",
                  name: fontInventoryAsset.name,
                  path: fontAssetPath,
                  url: fontInventoryAsset.url
                }
              ],
              directoryPath: fontAssetDirectory,
              failures: [],
              manifestPath: path.join(fontAssetDirectory, "manifest.json"),
              summary: {
                downloadedCount: 1,
                elapsedMs: 1,
                failedCount: 0,
                requestedCount: 1
              }
            };
          }
        };
      }
    }
  }
});
const fontReplacements = await fontAssetProvider({
  assetConsent: {
    mode: "visible-session",
    consent: "confirmed"
  }
});
const fontSha256 = createHash("sha256").update(woff2Bytes).digest("hex");
assert.equal(fontReplacements.length, 1);
assert.equal(fontReplacements[0].payload.mimeType, "font/woff2");
assert.deepEqual(fontReplacements[0].fontFace, {
  family: "Google Sans",
  style: "normal",
  weight: "400",
  stretch: "normal",
  display: "swap",
  src: `./assets/${fontSha256}.woff2`
});
await assert.rejects(access(fontAssetDirectory));

const renderedIconBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGP4z8DwnxjMMKrwP12DBwCSw8c5lI9cnwAAAABJRU5ErkJggg==",
  "base64"
);
const partiallyVisibleImage = await cli.cropCapturedImage({
  bytes: renderedIconBytes,
  left: -2,
  top: 0,
  width: 10,
  height: 10,
  allowPartial: true,
  viewport: { width: 10, height: 10 }
});
assert.equal(partiallyVisibleImage.width, 10);
assert.equal(partiallyVisibleImage.height, 10);
assert.equal(partiallyVisibleImage.mimeType, "image/png");
const renderedIconSource =
  "https://assets.example.test/attach-file-20dp.png";
const renderedIconCandidateKey =
  `${renderedIconSource}|10|10|50% 50%|no-repeat|10px|1|rgb(255, 255, 255)`;
const renderedIconMatch = {
  dimensions: {
    width: 10,
    height: 10
  },
  backgroundPosition: "50% 50%",
  backgroundRepeat: "no-repeat",
  backgroundSize: "10px",
  opacity: "1",
  backdropColor: "rgb(255, 255, 255)"
};
let renderedIconScreenshotCount = 0;
let renderedIconInventoryCount = 0;
let renderedIconElementScreenshotCount = 0;
const renderedIconLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {},
  async evaluate() {
    return sceneResult("Compose", { anchorId: "sk-compose" });
  }
};
const renderedIconAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'button "Compose"';
      },
      locator() {
        return renderedIconLocator;
      },
      getByRole() {
        return renderedIconLocator;
      },
      async evaluate(pageFunction, configuration) {
        assert.equal(pageFunction, collectRenderedIconCandidatesInPage);
        renderedIconInventoryCount += 1;
        assert.deepEqual(
          configuration,
          renderedIconInventoryCount === 1
            ? { knownSources: [], knownCandidateKeys: [] }
            : {
                knownSources: [],
                knownCandidateKeys: [renderedIconCandidateKey]
              }
        );
        return renderedIconInventoryCount === 1
          ? [
              {
                candidateKey: renderedIconCandidateKey,
                deviceScaleFactor: 1,
                source: renderedIconSource,
                left: 35,
                top: 35,
                x: 40,
                y: 40,
                width: 10,
                height: 10,
                match: renderedIconMatch
              }
            ]
          : [];
      },
      async elementScreenshot() {
        renderedIconElementScreenshotCount += 1;
        return renderedIconBytes;
      }
    },
    async screenshot(options) {
      renderedIconScreenshotCount += 1;
      throw new Error(
        `A viewport screenshot must not be used for icon capture: ${JSON.stringify(options)}`
      );
    },
    async url() {
      return "https://app.example.test/dashboard";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
assert.deepEqual(await renderedIconAdapter.preparePublicAssets({}), []);
const renderedIconReplacements =
  await renderedIconAdapter.preparePublicAssets({
    assetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
assert.equal(renderedIconScreenshotCount, 0);
assert.equal(renderedIconElementScreenshotCount, 1);
assert.equal(renderedIconReplacements.length, 1);
assert.equal(renderedIconReplacements[0].source, renderedIconSource);
assert.equal(
  renderedIconReplacements[0].captureKind,
  "isolated-rendered-icon"
);
assert.deepEqual(renderedIconReplacements[0].match, renderedIconMatch);
assert.equal(
  renderedIconReplacements[0].payload.sha256,
  createHash("sha256").update(renderedIconBytes).digest("hex")
);
const cachedRenderedIconReplacements =
  await renderedIconAdapter.preparePublicAssets({
    assetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
assert.deepEqual(cachedRenderedIconReplacements, renderedIconReplacements);
assert.equal(renderedIconScreenshotCount, 0);

let renderedImageElementScreenshotCount = 0;
let renderedImageScreenshotCount = 0;
const renderedImageSource =
  "https://assets.example.test/listing-photo.webp";
const renderedImageMatch = {
  imageElement: true,
  dimensions: {
    width: 10,
    height: 10
  },
  objectFit: "cover",
  opacity: "1",
  backdropColor: "rgb(255, 255, 255)"
};
const renderedImageAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'link "Listing"';
      },
      locator() {
        return renderedIconLocator;
      },
      getByRole() {
        return renderedIconLocator;
      },
      async evaluate(pageFunction) {
        assert.equal(pageFunction, collectRenderedIconCandidatesInPage);
        return [
          {
            candidateKey: `${renderedImageSource}|image|10|10|cover|1|rgb(255, 255, 255)`,
            deviceScaleFactor: 1,
            source: renderedImageSource,
            left: -4,
            top: 25,
            x: 3,
            y: 30,
            width: 10,
            height: 10,
            match: renderedImageMatch
          }
        ];
      },
      async elementScreenshot() {
        renderedImageElementScreenshotCount += 1;
        return renderedIconBytes;
      }
    },
    async screenshot(options) {
      renderedImageScreenshotCount += 1;
      assert.deepEqual(options, {});
      return Buffer.from("full-screenshot");
    },
    async url() {
      return "https://app.example.test/listing";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
const renderedImageReplacements =
  await renderedImageAdapter.preparePublicAssets({
    assetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
assert.equal(renderedImageElementScreenshotCount, 0);
assert.equal(renderedImageScreenshotCount, 0);
assert.deepEqual(renderedImageReplacements, []);
const refreshedRenderedImageReplacements =
  await renderedImageAdapter.preparePublicAssets({
    assetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
assert.deepEqual(refreshedRenderedImageReplacements, []);
assert.equal(renderedImageElementScreenshotCount, 0);
assert.equal(renderedImageScreenshotCount, 0);

const renderedCanvasSource =
  "showkit:rendered-canvas:35.00:35.00:10.00:10.00:20:20";
const renderedCanvasMatch = {
  canvasElement: true,
  dimensions: {
    width: 10,
    height: 10
  },
  intrinsicDimensions: {
    width: 20,
    height: 20
  },
  opacity: "1",
  backdropColor: "rgb(255, 255, 255)"
};
let renderedCanvasElementScreenshotCount = 0;
let renderedCanvasScreenshotCount = 0;
const renderedCanvasAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'button "Connected app"';
      },
      locator() {
        return renderedIconLocator;
      },
      getByRole() {
        return renderedIconLocator;
      },
      async evaluate(pageFunction) {
        assert.equal(pageFunction, collectRenderedIconCandidatesInPage);
        return [
          {
            candidateKey: `${renderedCanvasSource}|1|rgb(255, 255, 255)`,
            deviceScaleFactor: 1,
            source: renderedCanvasSource,
            left: 35,
            top: 35,
            x: 40,
            y: 40,
            width: 10,
            height: 10,
            match: renderedCanvasMatch
          }
        ];
      },
      async elementScreenshot() {
        renderedCanvasElementScreenshotCount += 1;
        return renderedIconBytes;
      }
    },
    async screenshot(options) {
      renderedCanvasScreenshotCount += 1;
      assert.deepEqual(options, {});
      return Buffer.from("full-screenshot");
    },
    async url() {
      return "https://app.example.test/integrations";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
const renderedCanvasReplacements =
  await renderedCanvasAdapter.preparePublicAssets({
    assetConsent: {
      mode: "visible-session",
      consent: "confirmed"
    }
  });
assert.equal(renderedCanvasElementScreenshotCount, 1);
assert.equal(renderedCanvasScreenshotCount, 0);
assert.equal(renderedCanvasReplacements.length, 1);
assert.equal(
  renderedCanvasReplacements[0].captureKind,
  "isolated-rendered-canvas"
);
assert.equal(
  renderedCanvasReplacements[0].source,
  renderedCanvasSource
);
assert.deepEqual(
  renderedCanvasReplacements[0].match,
  renderedCanvasMatch
);

const transferredNodes = [
  {
    type: "element",
    tag: "main",
    attributes: {},
    styles: {},
    children: [
      {
        type: "element",
        tag: "button",
        attributes: { "data-showkit-anchor": "sk-compose" },
        styles: {},
        children: [{ type: "text", text: "Compose" }]
      }
    ]
  }
];
const transferredNodesJson = JSON.stringify(transferredNodes);
const transferredHtml =
  '<main><button data-showkit-anchor="sk-compose">Compose</button></main>';
const transferChunkSize = 32;
const transferredPayloadSha256 = createHash("sha256")
  .update(`${transferredHtml}\u0000${transferredNodesJson}`)
  .digest("hex");
let transferCallCount = 0;
let frozenTransferReadCount = 0;
let frozenTransferReleaseCount = 0;
let transferHashMismatch = false;
let activeTransferId;
let activeTransferHash;
const frozenTransferReader = () => {};
const transferLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {},
  async evaluate(_pageFunction, options) {
    transferCallCount += 1;
    activeTransferId = options.transferId;
    activeTransferHash = transferHashMismatch
      ? "0".repeat(64)
      : transferredPayloadSha256;
    const offset = 0;
    return {
      ok: true,
      scanOnly: false,
      html: transferredHtml.slice(offset, offset + transferChunkSize),
      nodes: [],
      nodesJson: transferredNodesJson.slice(
        offset,
        offset + transferChunkSize
      ),
      transfer: {
        mode: "chunked-json",
        captureId: activeTransferId,
        payloadSha256: activeTransferHash,
        offset,
        chunkSize: transferChunkSize,
        htmlLength: transferredHtml.length,
        nodesJsonLength: transferredNodesJson.length
      },
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0, width: 1280, height: 720 },
      evidenceTexts: ["Compose"],
      assetPayloads: [],
      excludedSurfaces: [],
      sensitiveText: {
        mode: "text-only",
        redactedTextNodeCount: 0,
        redactedAttributeCount: 0,
        regionCount: 0
      }
    };
  }
};
const transferAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'button "Compose"';
      },
      async evaluate(pageFunction, options) {
        if (pageFunction === frozenTransferReader) {
          assert.equal(options.captureId, activeTransferId);
          if (options.release === true) {
            frozenTransferReleaseCount += 1;
            return {
              ok: true,
              scanOnly: false,
              html: "",
              nodesJson: "",
              released: true,
              transfer: {
                mode: "chunked-json",
                captureId: activeTransferId,
                payloadSha256: activeTransferHash,
                offset: 0,
                chunkSize: 1,
                htmlLength: transferredHtml.length,
                nodesJsonLength: transferredNodesJson.length
              }
            };
          }
          frozenTransferReadCount += 1;
          const offset = options.offset;
          return {
            ok: true,
            scanOnly: false,
            html: transferredHtml.slice(offset, offset + transferChunkSize),
            nodesJson: transferredNodesJson.slice(
              offset,
              offset + transferChunkSize
            ),
            transfer: {
              mode: "chunked-json",
              captureId: activeTransferId,
              payloadSha256: activeTransferHash,
              offset,
              chunkSize: transferChunkSize,
              htmlLength: transferredHtml.length,
              nodesJsonLength: transferredNodesJson.length
            }
          };
        }
        return transferLocator.evaluate(pageFunction, options);
      },
      locator() {
        return transferLocator;
      },
      getByRole() {
        return transferLocator;
      }
    },
    async url() {
      return "https://app.example.test/dashboard";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
const transferredScene = await transferAdapter.evaluateTarget(
  {
    strategy: "role",
    role: "button",
    name: "Compose"
  },
  () => {},
  {},
  frozenTransferReader
);
assert.equal(transferredScene.html, transferredHtml);
assert.deepEqual(transferredScene.nodes, transferredNodes);
assert.equal(transferCallCount, 1);
assert.ok(frozenTransferReadCount > 0);
assert.equal(frozenTransferReleaseCount, 1);

transferHashMismatch = true;
await assert.rejects(
  () =>
    transferAdapter.evaluateTarget(
      {
        strategy: "role",
        role: "button",
        name: "Compose"
      },
      () => {},
      {},
      frozenTransferReader
    ),
  /changed content/
);
assert.equal(transferCallCount, 2);
assert.equal(frozenTransferReleaseCount, 2);

const compressedSource = new TextEncoder().encode(transferredNodesJson);
const compressedLiteralBytes = [];
for (let offset = 0; offset < compressedSource.length; offset += 8) {
  compressedLiteralBytes.push(
    0,
    ...compressedSource.subarray(
      offset,
      Math.min(offset + 8, compressedSource.length)
    )
  );
}
let compressedPackedBuffer = 0;
let compressedPackedBits = 0;
let compressedNodes = "";
for (const byte of compressedLiteralBytes) {
  compressedPackedBuffer = (compressedPackedBuffer << 8) | byte;
  compressedPackedBits += 8;
  while (compressedPackedBits >= 15) {
    compressedPackedBits -= 15;
    compressedNodes += String.fromCharCode(
      0x100 +
        ((compressedPackedBuffer >> compressedPackedBits) & 0x7fff)
    );
    compressedPackedBuffer &= (1 << compressedPackedBits) - 1;
  }
}
if (compressedPackedBits > 0) {
  compressedNodes += String.fromCharCode(
    0x100 +
      ((compressedPackedBuffer << (15 - compressedPackedBits)) & 0x7fff)
  );
}
let compressedTransferCallCount = 0;
const compressedTransferLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {},
  async evaluate() {
    compressedTransferCallCount += 1;
    return {
      ok: true,
      scanOnly: false,
      html: "",
      nodes: [],
      nodesJson: compressedNodes,
      transfer: {
        mode: "lzss-json",
        encoding: "lzss-15bit",
        compressedLength: compressedLiteralBytes.length,
        nodesJsonLength: transferredNodesJson.length
      },
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0, width: 1280, height: 720 },
      evidenceTexts: ["Compose"],
      assetPayloads: [],
      excludedSurfaces: [],
      sensitiveText: {
        mode: "text-only",
        redactedTextNodeCount: 0,
        redactedAttributeCount: 0,
        regionCount: 0
      }
    };
  }
};
const compressedTransferAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'button "Compose"';
      },
      async evaluate(pageFunction, options) {
        return compressedTransferLocator.evaluate(
          pageFunction,
          options
        );
      },
      locator() {
        return compressedTransferLocator;
      },
      getByRole() {
        return compressedTransferLocator;
      }
    },
    async url() {
      return "https://app.example.test/dashboard";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
const compressedTransferredScene =
  await compressedTransferAdapter.evaluateTarget(
    {
      strategy: "role",
      role: "button",
      name: "Compose"
    },
    () => {},
    {}
  );
assert.equal(compressedTransferredScene.html, transferredHtml);
assert.deepEqual(compressedTransferredScene.nodes, transferredNodes);
assert.equal(compressedTransferCallCount, 1);

let targetLocatorEvaluateCalls = 0;
let targetPageEvaluateCalls = 0;
const targetLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {},
  async evaluate() {
    targetLocatorEvaluateCalls += 1;
    return {
      ok: false,
      blocker: {
        code: "TargetMissing",
        category: "test",
        stepIndex: 0,
        sourceFingerprint: "0".repeat(64)
      }
    };
  }
};
const targetPageAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'combobox "To recipients"';
      },
      async evaluate(_pageFunction, options) {
        targetPageEvaluateCalls += 1;
        assert.deepEqual(options.scopeTarget, {
          strategy: "role",
          role: "combobox",
          name: "To recipients"
        });
        return {
          ok: false,
          blocker: {
            code: "TargetMissing",
            category: "test",
            stepIndex: 0,
            sourceFingerprint: "0".repeat(64)
          }
        };
      },
      locator() {
        return targetLocator;
      },
      getByRole() {
        return targetLocator;
      }
    },
    async url() {
      return "https://app.example.test/dashboard";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
await targetPageAdapter.evaluateTarget(
  {
    strategy: "role",
    role: "combobox",
    name: "To recipients"
  },
  () => {},
  {}
);
assert.equal(targetLocatorEvaluateCalls, 0);
assert.equal(targetPageEvaluateCalls, 1);

let navigationUrl = "https://app.example.test/dashboard";
let navigationClickCount = 0;
let navigationReadyCount = 0;
const navigationLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async getAttribute(name) {
    assert.equal(name, "href");
    return "/reports";
  },
  async click() {
    navigationClickCount += 1;
  }
};
const navigationAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'link "Reports"';
      },
      async waitForLoadState() {
        navigationReadyCount += 1;
      },
      async evaluate(_pageFunction, options) {
        navigationReadyCount += 1;
        if (options?.strategy === "href") return [0];
        return true;
      },
      locator() {
        return navigationLocator;
      },
      getByRole() {
        return navigationLocator;
      }
    },
    async url() {
      return navigationUrl;
    },
    async goto(url) {
      navigationUrl = url;
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
await navigationAdapter.performAction(
  {
    strategy: "href",
    path: "/reports",
    name: "Reports"
  },
  "navigate"
);
assert.equal(navigationUrl, "https://app.example.test/reports");
assert.equal(navigationClickCount, 0);
assert.equal(navigationReadyCount, 3);

const malformedNavigationAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'link "Reports"';
      },
      async evaluate() {
        return true;
      },
      locator() {
        return navigationLocator;
      }
    },
    async url() {
      return "https://app.example.test/dashboard";
    },
    async goto() {
      throw new Error("A malformed target index response must not navigate.");
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
await assert.rejects(
  malformedNavigationAdapter.performAction(
    {
      strategy: "href",
      path: "/reports",
      name: "Reports"
    },
    "navigate"
  ),
  /navigation target is unavailable/
);

let semanticNavigationClickCount = 0;
let semanticNavigationExpectationCount = 0;
const semanticNavigationLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {
    semanticNavigationClickCount += 1;
  }
};
const semanticNavigationAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return 'link "Home"';
      },
      async expectNavigation(action) {
        semanticNavigationExpectationCount += 1;
        await action();
      },
      async evaluate() {
        return true;
      },
      locator() {
        return semanticNavigationLocator;
      },
      getByRole() {
        return semanticNavigationLocator;
      }
    },
    async url() {
      return "https://app.example.test/reports";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
await semanticNavigationAdapter.performAction(
  {
    strategy: "role",
    role: "link",
    name: "Home"
  },
  "navigate"
);
assert.equal(semanticNavigationExpectationCount, 1);
assert.equal(semanticNavigationClickCount, 1);

let viewportNavigationUrl;
const viewportNavigationCandidates = [
  {
    async getAttribute() {
      return "/offscreen";
    },
    async isVisible() {
      return false;
    }
  },
  {
    async getAttribute() {
      return "/visible";
    },
    async isVisible() {
      return true;
    }
  }
];
const viewportNavigationLocator = {
  async count() {
    return viewportNavigationCandidates.length;
  },
  nth(index) {
    return viewportNavigationCandidates[index];
  }
};
const viewportNavigationAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async evaluate() {
        return true;
      },
      getByRole() {
        return viewportNavigationLocator;
      },
      async waitForLoadState() {}
    },
    async goto(url) {
      viewportNavigationUrl = url;
    },
    async url() {
      return "https://app.example.test/start";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
assert.equal(
  await viewportNavigationAdapter.targetCount({
    strategy: "role",
    role: "link",
    name: "Visible destination"
  }),
  1
);
assert.equal(
  await viewportNavigationAdapter.targetVisible({
    strategy: "role",
    role: "link",
    name: "Visible destination"
  }),
  true
);
let eventualTargetChecks = 0;
const eventualTargetLocator = {
  async count() {
    eventualTargetChecks += 1;
    return eventualTargetChecks >= 3 ? 1 : 0;
  },
  async isVisible() {
    return true;
  }
};
const eventualTargetAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      getByRole() {
        return eventualTargetLocator;
      }
    },
    async url() {
      return "https://app.example.test/start";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
assert.deepEqual(
  await eventualTargetAdapter.waitForTargetStatus(
    {
      strategy: "role",
      role: "button",
      name: "Ready after navigation"
    },
    { timeoutMs: 250, pollMs: 1 }
  ),
  { matchedCount: 1, visibleCount: 1 }
);
assert.ok(eventualTargetChecks >= 3);
await viewportNavigationAdapter.performAction(
  {
    strategy: "role",
    role: "link",
    name: "Visible destination"
  },
  "navigate"
);
assert.equal(viewportNavigationUrl, "https://app.example.test/visible");

let disclosureExpanded = false;
let disclosureWaitCount = 0;
const disclosureLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {
    disclosureExpanded = true;
  }
};
const disclosureAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return disclosureExpanded
          ? 'button "Details" [expanded]'
          : 'button "Details"';
      },
      async evaluate() {
        return "unchanged";
      },
      async waitForTimeout() {
        disclosureWaitCount += 1;
      },
      locator() {
        return disclosureLocator;
      },
      getByRole() {
        return disclosureLocator;
      }
    },
    async url() {
      return "https://app.example.test/dashboard";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
await disclosureAdapter.performAction(
  {
    strategy: "role",
    role: "button",
    name: "Details"
  },
  "disclose"
);
assert.equal(disclosureExpanded, true);
assert.equal(disclosureWaitCount, 0);

let timedOutDisclosureExpanded = false;
const timedOutDisclosureLocator = {
  async count() {
    return 1;
  },
  async isVisible() {
    return true;
  },
  async click() {
    timedOutDisclosureExpanded = true;
    throw new Error("actionability timeout");
  }
};
const timedOutDisclosureAdapter = createCodexBrowserAdapter({
  tab: {
    playwright: {
      async domSnapshot() {
        return timedOutDisclosureExpanded
          ? 'button "Filters" [expanded]'
          : 'button "Filters"';
      },
      async evaluate() {
        return timedOutDisclosureExpanded ? "expanded" : "collapsed";
      },
      async waitForTimeout() {},
      locator() {
        return timedOutDisclosureLocator;
      },
      getByRole() {
        return timedOutDisclosureLocator;
      }
    },
    async url() {
      return "https://app.example.test/dashboard";
    }
  },
  browserSurface: "iab",
  browserName: "Codex Browser",
  viewport: { width: 1280, height: 720 }
});
await timedOutDisclosureAdapter.performAction(
  {
    strategy: "role",
    role: "button",
    name: "Filters"
  },
  "disclose"
);
assert.equal(timedOutDisclosureExpanded, true);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    surfaces: ["iab", "chrome"],
    stepCount: 5,
    trustedInstalledHostAttested: Boolean(trustedPluginRoot),
    forgedHostRejected: true,
    hostValidationBoundToExactTab: true,
    mainWorldEvaluationFallback: false,
    approvedCdpFallbackVerified,
    approvedCdpCommandAllowlistVerified,
    approvedCdpNavigationRefreshVerified,
    deniedCdpCapabilityRejected,
    adaptiveCdpTimeoutFallbackVerified,
    sourceHostRequired: true,
    unverifiedHostPersisted: false,
    poisonedSnapshotPersisted: false,
    malformedEnvironmentNamed: true,
    malformedSceneNamed: true,
    malformedTerminalNamed: true,
    targetCategories: ["target-missing", "target-hidden", "target-duplicate"],
    queryAndFragmentPersisted: false,
    browserSessionValuesPersisted: false,
    sensitiveTextRequiresConsent: true,
    textOnlyRedactionRecorded: true,
    visiblePrivateContentRequiresConsent: true,
    visibleSessionAssetsRequireConsent: true,
    privateSessionAssetBundledLocally: true,
    mutationConfirmationEnforced: true,
    interruptedTemporaryFiles: 0,
    chunkedSemanticTransfer: true,
    compressedSemanticTransfer: true,
    deterministicHrefNavigation: true,
    semanticNavigationWait: true,
    capturedVisualReadiness: true,
    viewportTargetDisambiguation: true,
    delayedTargetReadiness: true,
    observedStateChangeWait: true,
    actionabilityTimeoutStateCheck: true,
    publicPageAssetBundled: true,
    partialPublicAssetBundleAccepted: true,
    publicTransformQueryRestricted: true,
    publicAssetApprovalUnion: true,
    avifPageAssetBundled: true,
    privatePageAssetRejected: true,
    isolatedRenderedIconBundled: true
  })}\n`
);
