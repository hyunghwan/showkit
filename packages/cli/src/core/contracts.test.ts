import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./json.js";
import {
  CaptureSourceSchema,
  SCHEMA_VERSION,
  SceneFontFaceSchema,
  StorySpecSchema,
  type CaptureSource
} from "./schemas.js";
import { createPlayerFiles } from "../player/assets.js";
import { createEvidenceGroundedStory } from "./story.js";
import { validateStory } from "./validate.js";

function captureFixture(): CaptureSource {
  return CaptureSourceSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    captureId: "capture-proof",
    source: {
      kind: "playwright-spec",
      specHash: "a".repeat(64),
      runtime: "playwright-test",
      runtimeVersion: "1.62.0",
      replayLevel: "ci-replayable"
    },
    fixtureHash: "b".repeat(64),
    browser: "chromium",
    fixture: {
      schemaVersion: SCHEMA_VERSION,
      id: "proof-flow",
      baseURL: "http://127.0.0.1:4173",
      startPath: "/example",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      timezoneId: "UTC",
      lifecycle: {
        setup: "playwright-fixture",
        teardown: "playwright-fixture"
      },
      auth: {
        storageState: "runtime-only-if-configured",
        persisted: false
      },
      debug: {
        screenshot: "off",
        traceBuildInput: false,
        video: "off"
      },
      steps: [
        {
          id: "create-workspace",
          title: "Create your first workspace",
          target: {
            strategy: "role",
            role: "button",
            name: "Create workspace"
          }
        }
      ]
    },
    viewport: { width: 1280, height: 720 },
    steps: [
      {
        id: "create-workspace",
        title: "Create your first workspace",
        scene: {
          html: '<div data-showkit-scene-root=""><button role="button" data-showkit-anchor="sk-create-workspace">Create workspace</button></div>',
          nodes: [
            {
              type: "element",
              tag: "div",
              attributes: { "data-showkit-scene-root": "" },
              styles: {},
              children: [
                {
                  type: "element",
                  tag: "button",
                  attributes: {
                    role: "button",
                    "data-showkit-anchor": "sk-create-workspace"
                  },
                  styles: {},
                  children: [{ type: "text", text: "Create workspace" }]
                }
              ]
            }
          ],
          viewport: { width: 1280, height: 720 },
          anchorId: "sk-create-workspace",
          target: {
            tag: "button",
            role: "button",
            name: "Create workspace",
            bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.08 }
          }
        },
        evidence: [{ id: "ev-create", text: "Create workspace" }],
        actionOutcome: { url: "http://127.0.0.1/example", title: "Example" }
      }
    ],
    terminalScene: {
      html: "<div data-showkit-scene-root=\"\"><h1>Workspace ready</h1></div>",
      nodes: [
        {
          type: "element",
          tag: "div",
          attributes: { "data-showkit-scene-root": "" },
          styles: {},
          children: [
            {
              type: "element",
              tag: "h1",
              attributes: {},
              styles: {},
              children: [{ type: "text", text: "Workspace ready" }]
            }
          ]
        }
      ],
      viewport: { width: 1280, height: 720 }
    },
    assets: [],
    redaction: {
      policyChecksPassed: true,
      excludedSurfaces: ["scripts"],
      fullSceneRasterCount: 0
    }
  });
}

describe("data contracts", () => {
  it("creates the same hash for objects with another key order", () => {
    expect(contentHash({ beta: 2, alpha: 1 })).toBe(contentHash({ alpha: 1, beta: 2 }));
    expect(canonicalJson({ beta: 2, alpha: 1 })).toBe('{\n  "alpha": 1,\n  "beta": 2\n}\n');
  });

  it("creates evidence-grounded linear demo content", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);

    expect(StorySpecSchema.parse(story).steps).toHaveLength(1);
    expect(story.steps[0]?.evidenceIds).toEqual(["ev-create"]);
    expect(story.player.chrome).toEqual({
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
    });
    expect(story.completion).toEqual({
      title: "Ready to create your demo?",
      body: "Email us to discuss an interactive HTML demo for your product.",
      actions: [
        {
          label: "Email us for a demo",
          href: "mailto:hello@sqncs.com?subject=ShowKit%20demo%20request",
          style: "primary"
        }
      ]
    });
    const reports = validateStory(capture, story);
    expect(reports.verification.passed).toBe(true);
    expect(reports.quality.checks).toContainEqual({
      name: "wcag-2.2-player-theme",
      passed: true,
      detail:
        "Player chrome colors meet ShowKit’s WCAG 2.2 AA contrast thresholds. Captured product content is not assessed by this check."
    });
  });

  it("accepts frame chrome and independent overlay positions", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    story.player.chrome = {
      mode: "frame",
      placements: {
        title: "center",
        goal: "right",
        stepCount: "bottom-left",
        progress: "top",
        back: "left",
        restart: "top-right",
        cta: "hidden"
      }
    };

    expect(StorySpecSchema.parse(story).player.chrome).toEqual(
      story.player.chrome
    );
    expect(() =>
      StorySpecSchema.parse({
        ...story,
        player: {
          chrome: {
            ...story.player.chrome,
            placements: {
              ...story.player.chrome.placements,
              title: "any-pixel"
            }
          }
        }
      })
    ).toThrow();
  });

  it("accepts safe brand tokens and tooltip-integrated controls", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    story.theme = {
      accent: "#126B5C",
      ink: "#102A25",
      paper: "#F4F0E8",
      fonts: {
        heading: '"Avenir Next", Avenir, sans-serif',
        body: '"IBM Plex Sans", sans-serif'
      }
    };

    const parsed = StorySpecSchema.parse(story);
    expect(parsed.theme).toEqual(story.theme);
    expect(parsed.player.chrome.placements.stepCount).toBe("tooltip");
    expect(() =>
      StorySpecSchema.parse({
        ...story,
        theme: {
          ...story.theme,
          fonts: {
            ...story.theme.fonts,
            body: "Brand Sans; background: url(https://example.com/font.woff2)"
          }
        }
      })
    ).toThrow();
  });

  it("rejects player themes that cannot meet the WCAG 2.2 contrast guard", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);

    expect(() =>
      StorySpecSchema.parse({
        ...story,
        theme: {
          ...story.theme,
          accent: "#F3EFE6"
        }
      })
    ).toThrow(/Accent must have at least 3:1 contrast/);
    expect(() =>
      StorySpecSchema.parse({
        ...story,
        theme: {
          ...story.theme,
          ink: "#777777"
        }
      })
    ).toThrow(/Ink/);
    expect(() =>
      StorySpecSchema.parse({
        ...story,
        theme: {
          ...story.theme,
          ink: "#FFFFFF",
          paper: "#17211B"
        }
      })
    ).toThrow(/light player surface/);
  });

  it("accepts constrained card, navigation, and completion options", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    story.welcome = {
      title: "Welcome to the workspace",
      body: "Explore the captured product flow.",
      actionLabel: "Explore workspace",
      backdrop: "heavy"
    };
    story.steps[0]!.tooltip.backdrop = "light";
    story.player.navigation = "hotspots";
    story.completion = {
      title: "Ready to get started?",
      body: "Choose the next step that works for you.",
      actions: [
        {
          label: "Get a demo",
          href: "https://example.com/demo",
          style: "primary"
        },
        {
          label: "Sign up",
          href: "https://example.com/signup",
          style: "secondary"
        }
      ]
    };

    const parsed = StorySpecSchema.parse(story);
    expect(parsed.welcome.backdrop).toBe("heavy");
    expect(parsed.steps[0]!.tooltip.backdrop).toBe("light");
    expect(parsed.player.navigation).toBe("hotspots");
    expect(parsed.completion?.actions).toHaveLength(2);
    expect(() =>
      StorySpecSchema.parse({
        ...story,
        completion: {
          ...story.completion,
          actions: [
            ...story.completion.actions,
            {
              label: "Contact sales",
              href: "https://example.com/contact",
              style: "secondary"
            }
          ]
        }
      })
    ).toThrow();
  });

  it("accepts a safe completion email and rejects mail header injection", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);

    expect(StorySpecSchema.parse(story).completion?.actions[0]?.href).toBe(
      "mailto:hello@sqncs.com?subject=ShowKit%20demo%20request"
    );
    expect(() =>
      StorySpecSchema.parse({
        ...story,
        completion: {
          ...story.completion,
          actions: [
            {
              label: "Email us",
              href: "mailto:hello@sqncs.com?subject=Demo%0D%0ABcc%3Aother%40example.com",
              style: "primary"
            }
          ]
        }
      })
    ).toThrow(/safe single-recipient mailto/);
  });

  it("rejects copy evidence that is out of date", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    story.steps[0]!.evidenceIds = ["ev-missing"];

    expect(() => validateStory(capture, story)).toThrowError(
      expect.objectContaining({
        code: "CopyEvidenceDrift",
        details: {
          stepId: "create-workspace",
          missingEvidenceIds: ["ev-missing"]
        }
      })
    );
  });

  it("reports the exact stale hotspot step and bounds", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    story.steps[0]!.anchorId = "sk-missing";

    expect(() => validateStory(capture, story)).toThrowError(
      expect.objectContaining({
        code: "HotspotAnchorDrift",
        details: expect.objectContaining({
          stepId: "create-workspace",
          anchorId: "sk-missing",
          expected: {
            anchorCount: 1,
            boundsInsideViewport: true
          }
        })
      })
    );
  });

  it("rejects executable or remote scene content", () => {
    const capture = captureFixture();
    capture.steps[0]!.scene.html += '<script src="https://example.com/app.js"></script>';
    const story = createEvidenceGroundedStory(capture);

    expect(() => validateStory(capture, story)).toThrowError(
      expect.objectContaining({ code: "StorySpecInvalid" })
    );
  });

  it("accepts sanitized SVG icons and local content-addressed CSS images", () => {
    const capture = captureFixture();
    const assetHash = "c".repeat(64);
    capture.assets = [
      {
        sha256: assetHash,
        mimeType: "image/png",
        byteLength: 68,
        path: `assets/${assetHash}.png`
      }
    ];
    const button = capture.steps[0]!.scene.nodes[0]!;
    if (button.type !== "element") throw new Error("Expected scene root.");
    const target = button.children[0]!;
    if (target.type !== "element") throw new Error("Expected target button.");
    target.styles["background-image"] =
      `url("./assets/${assetHash}.png")`;
    target.children.unshift({
      type: "element",
      tag: "svg",
      attributes: {
        "aria-hidden": "true",
        viewBox: "0 0 24 24",
        width: "24",
        height: "24"
      },
      styles: {},
      children: [
        {
          type: "element",
          tag: "path",
          attributes: {
            d: "M4 12h16",
            stroke: "#126b5c",
            "stroke-width": "2"
          },
          styles: {},
          children: []
        }
      ]
    });
    capture.steps[0]!.scene.html =
      `<div data-showkit-scene-root=""><button role="button" data-showkit-anchor="sk-create-workspace" style="background-image:url(&quot;./assets/${assetHash}.png&quot;)"><svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24"><path d="M4 12h16" stroke="#126b5c" stroke-width="2"></path></svg>Create workspace</button></div>`;

    expect(validateStory(capture, createEvidenceGroundedStory(capture)).verification.passed)
      .toBe(true);
  });

  it("keeps local WOFF2 font faces in the player payload", () => {
    const capture = captureFixture();
    const assetHash = "d".repeat(64);
    const fontFace = {
      family: "Captured Sans",
      style: "normal" as const,
      weight: "400",
      stretch: "normal",
      display: "block" as const,
      unicodeRange: "U+0000-00FF, U+4??",
      src: `./assets/${assetHash}.woff2`
    };
    capture.assets = [
      {
        sha256: assetHash,
        mimeType: "font/woff2",
        byteLength: 36,
        path: `assets/${assetHash}.woff2`
      }
    ];
    capture.steps[0]!.scene.fontFaces = [fontFace];
    capture.terminalScene.fontFaces = [fontFace];
    const story = createEvidenceGroundedStory(capture);
    const files = createPlayerFiles(capture, story);

    expect(validateStory(capture, story).verification.passed).toBe(true);
    expect(files["story.js"]).toContain(`./assets/${assetHash}.woff2`);
    expect(files["player.js"]).toContain("@font-face");
    expect(files["player.js"]).toContain("unicode-range");
    expect(files["player.js"]).toContain("document.fonts.ready");
  });

  it("rejects ambiguous or oversized font unicode ranges", () => {
    const fontFace = {
      family: "Captured Sans",
      style: "normal",
      weight: "400",
      stretch: "normal",
      display: "block",
      src: `./assets/${"d".repeat(64)}.woff2`
    };

    expect(
      SceneFontFaceSchema.parse({
        ...fontFace,
        unicodeRange: "U+0000-00FF, U+4??"
      }).unicodeRange
    ).toBe("U+0000-00FF, U+4??");
    expect(() =>
      SceneFontFaceSchema.parse({
        ...fontFace,
        unicodeRange: "U+0--0"
      })
    ).toThrow();
    expect(() =>
      SceneFontFaceSchema.parse({
        ...fontFace,
        unicodeRange: `U+${"-".repeat(4_000)}`
      })
    ).toThrow();
  });

  it("rejects unknown contract fields", () => {
    const capture = captureFixture();
    expect(() =>
      CaptureSourceSchema.parse({
        ...capture,
        unexpected: true
      })
    ).toThrow();
  });
});
