import { readFile, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createAgentBrowserCaptureEnvelope,
  validateAgentBrowserCaptureEnvelope,
  writeSessionEnvelopeTemporary
} from "../capture/session-envelope.js";
import {
  createStaticCaptureEnvelope,
  validateStaticCaptureEnvelope
} from "../capture/static.js";
import {
  BrowserFlowRecipeSchema,
  SCHEMA_VERSION,
  type BrowserFlowRecipe,
  type CaptureStep,
  type Scene
} from "./schemas.js";
import { sanitizePageUrl } from "./url.js";

function proofRecipe(): BrowserFlowRecipe {
  return BrowserFlowRecipeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: "signed-in-proof",
    host: "codex",
    browserSurface: "iab",
    adapterVersion: "0.1.0",
    url: {
      origin: "https://app.example.test",
      path: "/settings"
    },
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    steps: [
      {
        id: "open-members",
        title: "Open members",
        target: {
          strategy: "role",
          role: "button",
          name: "Members"
        },
        actionKind: "navigate"
      }
    ]
  });
}

function proofScene(target = true): Scene {
  return {
    html: target
      ? '<main data-showkit-scene-root=""><button role="button" data-showkit-anchor="sk-open-members">Members</button></main>'
      : '<main data-showkit-scene-root=""><h1>Members</h1></main>',
    nodes: [
      {
        type: "element",
        tag: "main",
        attributes: { "data-showkit-scene-root": "" },
        styles: {},
        children: target
          ? [
              {
                type: "element",
                tag: "button",
                attributes: {
                  role: "button",
                  "data-showkit-anchor": "sk-open-members"
                },
                styles: {},
                children: [{ type: "text", text: "Members" }]
              }
            ]
          : [
              {
                type: "element",
                tag: "h1",
                attributes: {},
                styles: {},
                children: [{ type: "text", text: "Members" }]
              }
            ]
      }
    ],
    viewport: { width: 1280, height: 720 },
    ...(target
      ? {
          anchorId: "sk-open-members",
          target: {
            tag: "button",
            role: "button",
            name: "Members",
            bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 }
          }
        }
      : {})
  };
}

function proofStep(): CaptureStep {
  return {
    id: "open-members",
    title: "Open members",
    scene: proofScene(),
    evidence: [{ id: "ev-members", text: "Members" }],
    actionOutcome: {
      url: "https://app.example.test/members",
      title: "Members"
    }
  };
}

describe("URL intake contracts", () => {
  it("accepts only HTTP(S) URLs and removes query and fragment data", () => {
    expect(
      sanitizePageUrl(
        "https://app.example.test/settings?token=never-persist#private"
      )
    ).toEqual({
      origin: "https://app.example.test",
      path: "/settings",
      value: "https://app.example.test/settings"
    });
    expect(() => sanitizePageUrl("file:///tmp/private.html")).toThrowError(
      expect.objectContaining({ code: "PageUrlInvalid" })
    );
    expect(() =>
      sanitizePageUrl("https://user:password@app.example.test/settings")
    ).toThrowError(expect.objectContaining({ code: "PageUrlInvalid" }));
  });

  it("creates a deterministic session capture with explicit replay provenance", () => {
    const input = {
      recipe: proofRecipe(),
      browser: "chromium",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: ["scripts", "browser-storage", "network-data"]
    };
    const first = createAgentBrowserCaptureEnvelope(input);
    const second = createAgentBrowserCaptureEnvelope(input);
    expect(first.capture.captureId).toBe(second.capture.captureId);
    expect(first.capture.source).toEqual(
      expect.objectContaining({
        kind: "agent-browser-session",
        sessionPersisted: false,
        replayLevel: "session-captured"
      })
    );
    expect(first.capture.fixture.lifecycle).toEqual({
      setup: "agent-browser-session",
      teardown: "agent-browser-session"
    });
    expect(first.capture.redaction.sensitiveText).toEqual({
      mode: "blocked-by-default",
      redactedTextNodeCount: 0,
      redactedAttributeCount: 0,
      regionCount: 0
    });
  });

  it("creates a deterministic Playwright-free static-source capture", () => {
    const capturedStep = proofStep();
    const input = {
      id: "static-proof",
      baseURL: "https://app.example.test",
      startPath: "/settings",
      viewport: { width: 1280, height: 720 },
      sourceFiles: [
        {
          path: "fixtures/static-proof.html",
          sha256: "a".repeat(64)
        }
      ],
      generatorVersion: "0.1.0",
      steps: [
        {
          id: capturedStep.id,
          title: capturedStep.title,
          target: {
            strategy: "role" as const,
            role: "button",
            name: "Members"
          },
          actionKind: "navigate" as const,
          scene: capturedStep.scene,
          evidence: capturedStep.evidence,
          actionOutcome: capturedStep.actionOutcome
        }
      ],
      terminalScene: proofScene(false)
    };
    const first = createStaticCaptureEnvelope(input);
    const second = createStaticCaptureEnvelope(input);
    expect(first.capture.captureId).toBe(second.capture.captureId);
    expect(first.capture.source).toEqual(
      expect.objectContaining({
        kind: "static-source",
        generator: "showkit-static",
        replayLevel: "source-derived"
      })
    );
    expect(first.capture.fixture.lifecycle).toEqual({
      setup: "static-source",
      teardown: "static-source"
    });
    expect(first.capture.fixture.auth).toEqual({
      storageState: "not-used",
      persisted: false
    });
    expect(validateStaticCaptureEnvelope(first)).toEqual(first);
  });

  it("rejects an aggregate asset payload over 20 MB before persistence", () => {
    const capturedStep = proofStep();
    const envelope = createStaticCaptureEnvelope({
      id: "static-payload-bound",
      baseURL: "https://app.example.test",
      startPath: "/settings",
      viewport: { width: 1280, height: 720 },
      sourceFiles: [
        {
          path: "fixtures/static-proof.html",
          sha256: "b".repeat(64)
        }
      ],
      generatorVersion: "0.1.0",
      steps: [
        {
          id: capturedStep.id,
          title: capturedStep.title,
          target: {
            strategy: "role",
            role: "button",
            name: "Members"
          },
          actionKind: "navigate",
          scene: capturedStep.scene,
          evidence: capturedStep.evidence,
          actionOutcome: capturedStep.actionOutcome
        }
      ],
      terminalScene: proofScene(false)
    });
    const oversized = structuredClone(envelope);
    oversized.assetPayloads = Array.from({ length: 21 }, (_, index) => ({
      sha256: index.toString(16).padStart(64, "0"),
      mimeType: "image/png" as const,
      byteLength: 1_048_576,
      base64: "AA=="
    }));
    expect(() => validateStaticCaptureEnvelope(oversized)).toThrowError(
      expect.objectContaining({ code: "DemoFixtureSetupFailed" })
    );
  });

  it("keeps a visible URL as selectable text without allowing a remote request", () => {
    const step = proofStep();
    const root = step.scene.nodes[0]!;
    if (root.type !== "element") throw new Error("Expected scene root.");
    root.children.push({
      type: "element",
      tag: "p",
      attributes: {},
      styles: {},
      children: [
        {
          type: "text",
          text: "Read https://docs.example.test/guide"
        }
      ]
    });
    step.scene.html =
      '<main data-showkit-scene-root=""><button role="button" data-showkit-anchor="sk-open-members">Members</button><p>Read https://docs.example.test/guide</p></main>';

    const envelope = createAgentBrowserCaptureEnvelope({
      recipe: proofRecipe(),
      browser: "chromium",
      steps: [step],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: ["network-data", "remote-assets"]
    });

    expect(envelope.capture.steps[0]!.scene.html).toContain(
      "https://docs.example.test/guide"
    );
    expect(
      JSON.stringify(envelope.capture.steps[0]!.scene.nodes)
    ).not.toContain('"href"');
  });

  it("accepts only an explicitly confirmed text-only redaction recipe", () => {
    const recipe = proofRecipe();
    expect(
      BrowserFlowRecipeSchema.parse({
        ...recipe,
        sensitiveTextRedaction: {
          mode: "text-only",
          consent: "confirmed",
          regionCount: 2
        }
      }).sensitiveTextRedaction
    ).toEqual({
      mode: "text-only",
      consent: "confirmed",
      regionCount: 2
    });
    expect(() =>
      BrowserFlowRecipeSchema.parse({
        ...recipe,
        sensitiveTextRedaction: {
          mode: "text-only",
          consent: "inferred",
          regionCount: 2
        }
      })
    ).toThrow();
  });

  it("records ChatGPT as a verified OpenAI browser source host", () => {
    const recipe = BrowserFlowRecipeSchema.parse({
      ...proofRecipe(),
      host: "chatgpt",
      browserSurface: "chrome"
    });
    const envelope = createAgentBrowserCaptureEnvelope({
      recipe,
      browser: "Google Chrome",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: []
    });
    expect(envelope.capture.source).toEqual(
      expect.objectContaining({
        kind: "agent-browser-session",
        host: "chatgpt",
        browserSurface: "chrome"
      })
    );
  });

  it("rejects page-controlled locale and timezone metadata", () => {
    expect(() =>
      BrowserFlowRecipeSchema.parse({
        ...proofRecipe(),
        locale: "SHOWKIT_HOSTILE_LOCALE"
      })
    ).toThrow();
    expect(() =>
      BrowserFlowRecipeSchema.parse({
        ...proofRecipe(),
        timezoneId: "SHOWKIT/HOSTILE/TIME/ZONE"
      })
    ).toThrow();
  });

  it("records explicit consent for visible private session assets", () => {
    const recipe = BrowserFlowRecipeSchema.parse({
      ...proofRecipe(),
      pageAssets: {
        mode: "visible-session",
        consent: "confirmed"
      }
    });
    const envelope = createAgentBrowserCaptureEnvelope({
      recipe,
      browser: "chromium",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: []
    });
    expect(envelope.capture.redaction.pageAssets).toEqual({
      mode: "visible-session",
      consent: "confirmed",
      localOnly: true,
      assetCount: 0
    });
    expect(() =>
      BrowserFlowRecipeSchema.parse({
        ...proofRecipe(),
        pageAssets: {
          mode: "visible-session",
          consent: "inferred"
        }
      })
    ).toThrow();
  });

  it("rejects query data or a recipe mismatch during import validation", () => {
    const envelope = createAgentBrowserCaptureEnvelope({
      recipe: proofRecipe(),
      browser: "chromium",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: []
    });
    const queryEnvelope = structuredClone(envelope);
    queryEnvelope.capture.steps[0]!.actionOutcome.url =
      "https://app.example.test/members?token=never-persist";
    expect(() => validateAgentBrowserCaptureEnvelope(queryEnvelope)).toThrowError(
      expect.objectContaining({ code: "PageUrlInvalid" })
    );

    const recipeMismatch = structuredClone(envelope);
    recipeMismatch.recipe.adapterVersion = "0.1.1";
    expect(() => validateAgentBrowserCaptureEnvelope(recipeMismatch)).toThrowError(
      expect.objectContaining({ code: "DemoFixtureSetupFailed" })
    );

    const redactionMismatch = structuredClone(envelope);
    redactionMismatch.capture.redaction.sensitiveText = {
      mode: "text-only",
      redactedTextNodeCount: 1,
      redactedAttributeCount: 0,
      regionCount: 1
    };
    expect(() =>
      validateAgentBrowserCaptureEnvelope(redactionMismatch)
    ).toThrowError(
      expect.objectContaining({ code: "DemoFixtureSetupFailed" })
    );

    const consented = createAgentBrowserCaptureEnvelope({
      recipe: BrowserFlowRecipeSchema.parse({
        ...proofRecipe(),
        pageAssets: {
          mode: "visible-session",
          consent: "confirmed"
        }
      }),
      browser: "chromium",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: []
    });
    const assetConsentMismatch = structuredClone(consented);
    assetConsentMismatch.capture.redaction.pageAssets!.assetCount = 1;
    expect(() =>
      validateAgentBrowserCaptureEnvelope(assetConsentMismatch)
    ).toThrowError(
      expect.objectContaining({ code: "DemoFixtureSetupFailed" })
    );
  });

  it("rechecks browser session content before persistence", () => {
    const envelope = createAgentBrowserCaptureEnvelope({
      recipe: proofRecipe(),
      browser: "chromium",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: []
    });
    const sensitive = structuredClone(envelope);
    sensitive.capture.steps[0]!.evidence[0]!.text =
      "SHOWKIT_SECRET_CANARY_TAMPERED_SESSION";
    expect(() => validateAgentBrowserCaptureEnvelope(sensitive)).toThrowError(
      expect.objectContaining({ code: "SensitiveDataDetected" })
    );

    const executable = structuredClone(envelope);
    executable.capture.terminalScene.html +=
      '<script src="https://remote.example.test/app.js"></script>';
    expect(() => validateAgentBrowserCaptureEnvelope(executable)).toThrowError(
      expect.objectContaining({ code: "UnsupportedSurface" })
    );
  });

  it("writes only a private temporary envelope", async () => {
    const envelope = createAgentBrowserCaptureEnvelope({
      recipe: proofRecipe(),
      browser: "chromium",
      steps: [proofStep()],
      terminalScene: proofScene(false),
      assetPayloads: [],
      excludedSurfaces: []
    });
    const filePath = await writeSessionEnvelopeTemporary(envelope);
    try {
      const fileStat = await stat(filePath);
      if (process.platform !== "win32") {
        expect(fileStat.mode & 0o777).toBe(0o600);
      }
      expect(
        validateAgentBrowserCaptureEnvelope(
          JSON.parse(await readFile(filePath, "utf8"))
        ).capture.captureId
      ).toBe(envelope.capture.captureId);
    } finally {
      await rm(filePath, { force: true });
    }
  });
});
