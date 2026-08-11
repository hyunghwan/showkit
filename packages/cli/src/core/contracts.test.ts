import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash, sha256 } from "./json.js";
import {
  CaptureSourceSchema,
  FreshnessReportSchema,
  SCHEMA_VERSION,
  SceneFontFaceSchema,
  StorySpecSchema,
  type CaptureSource
} from "./schemas.js";
import { createPlayerFiles } from "../player/assets.js";
import {
  CaptureStepProgressSchema,
  compareCaptureFreshness,
  createBlockedFreshnessReport,
  createFreshnessBaseline,
  validateCaptureStepProgress
} from "./freshness.js";
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
    expect(story.welcome).toBeUndefined();
    expect(story.player.camera).toBe("fit");
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
    expect(parsed.welcome?.backdrop).toBe("heavy");
    expect(parsed.steps[0]!.tooltip.backdrop).toBe("light");
    expect(parsed.player.navigation).toBe("hotspots");
    expect(parsed.player.camera).toBe("fit");
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

  it("keeps the cover optional and focus zoom opt-in", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);

    const defaultStory = StorySpecSchema.parse(story);
    expect(defaultStory.welcome).toBeUndefined();
    expect(defaultStory.player.camera).toBe("fit");

    const focusedStory = StorySpecSchema.parse({
      ...story,
      welcome: {
        title: "Welcome to the workspace",
        body: "Explore the captured product flow.",
        actionLabel: "Explore workspace",
        backdrop: "heavy"
      },
      player: {
        ...story.player,
        camera: "focus"
      }
    });
    expect(focusedStory.welcome?.title).toBe("Welcome to the workspace");
    expect(focusedStory.player.camera).toBe("focus");

    expect(() =>
      StorySpecSchema.parse({
        ...story,
        player: {
          ...story.player,
          camera: "cinematic"
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

  it("checks current source steps against the built demo baseline", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    const baseline = createFreshnessBaseline(capture, story);
    const baseVersion = "d".repeat(64);
    const baseSourceHash = contentHash(capture);

    const fresh = compareCaptureFreshness({
      baseline,
      baseVersion,
      baseSourceHash,
      currentCapture: capture
    });
    expect(fresh).toEqual(
      expect.objectContaining({
        status: "fresh",
        previousDemoChanged: false,
        currentSourceHash: baseSourceHash
      })
    );

    const metadataOnlyChange = structuredClone(capture);
    if (metadataOnlyChange.source.kind !== "playwright-spec") {
      throw new Error("Expected a Playwright capture.");
    }
    metadataOnlyChange.source.specHash = "e".repeat(64);
    const metadataReport = compareCaptureFreshness({
      baseline,
      baseVersion,
      baseSourceHash,
      currentCapture: metadataOnlyChange
    });
    expect(metadataReport.status).toBe("fresh");
    expect(metadataReport.currentSourceHash).not.toBe(baseSourceHash);

    const evidenceChange = structuredClone(capture);
    evidenceChange.steps[0]!.evidence[0]!.text = "Create another workspace";
    const stale = compareCaptureFreshness({
      baseline,
      baseVersion,
      baseSourceHash,
      currentCapture: evidenceChange
    });
    expect(stale.status).toBe("out-of-date");
    expect(stale.steps[0]).toEqual(
      expect.objectContaining({
        stepId: "create-workspace",
        state: "failed",
        code: "CopyEvidenceDrift",
        recovery: "Update the tooltip or capture the flow again."
      })
    );
    const incompleteFailure = structuredClone(stale);
    delete incompleteFailure.steps[0]!.recovery;
    expect(FreshnessReportSchema.safeParse(incompleteFailure).success).toBe(
      false
    );
  });

  it("names every structural source-freshness mismatch", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    const baseline = createFreshnessBaseline(capture, story);
    const options = {
      baseline,
      baseVersion: "d".repeat(64),
      baseSourceHash: contentHash(capture)
    };
    const cases: Array<{
      code: string;
      change: (candidate: CaptureSource) => void;
    }> = [
      {
        code: "SourceStepMissing",
        change: (candidate) => {
          candidate.steps = [];
        }
      },
      {
        code: "SourceStepOrderChanged",
        change: (candidate) => {
          const inserted = structuredClone(candidate.steps[0]!);
          inserted.id = "earlier-step";
          candidate.steps.unshift(inserted);
        }
      },
      {
        code: "HotspotAnchorDrift",
        change: (candidate) => {
          candidate.steps[0]!.scene.target!.bounds.x += 1;
        }
      },
      {
        code: "SourceOutcomeChanged",
        change: (candidate) => {
          candidate.steps[0]!.actionOutcome.title = "Workspace created";
        }
      },
      {
        code: "SourceSceneChanged",
        change: (candidate) => {
          candidate.steps[0]!.scene.html += "<!-- changed -->";
        }
      },
      {
        code: "SourceCompletionChanged",
        change: (candidate) => {
          candidate.terminalScene.html += "<!-- changed -->";
        }
      }
    ];

    for (const entry of cases) {
      const currentCapture = structuredClone(capture);
      entry.change(currentCapture);
      const report = compareCaptureFreshness({
        ...options,
        currentCapture
      });
      const failures = [...report.steps, report.completion].filter(
        (result) => result.state === "failed"
      );
      expect(failures).toEqual([
        expect.objectContaining({ code: entry.code, recovery: expect.any(String) })
      ]);
    }
  });

  it("fails baseline construction when a selected step or evidence item is missing", () => {
    const capture = captureFixture();
    const missingStepStory = createEvidenceGroundedStory(capture);
    missingStepStory.steps[0]!.captureStepId = "missing-step";
    expect(() => createFreshnessBaseline(capture, missingStepStory)).toThrowError(
      expect.objectContaining({ code: "ArtifactBuildFailed" })
    );

    const missingEvidenceStory = createEvidenceGroundedStory(capture);
    missingEvidenceStory.steps[0]!.evidenceIds = ["missing-evidence"];
    expect(() =>
      createFreshnessBaseline(capture, missingEvidenceStory)
    ).toThrowError(expect.objectContaining({ code: "ArtifactBuildFailed" }));
  });

  it("rejects duplicate capture step IDs before freshness indexing", () => {
    const capture = captureFixture();
    const duplicate = structuredClone(capture.steps[0]!);
    duplicate.title = "Duplicate workspace step";
    duplicate.scene.html += "<!-- duplicate state -->";
    capture.steps.push(duplicate);

    const parsed = CaptureSourceSchema.safeParse(capture);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["steps", 1, "id"],
            message: "Capture step IDs must be unique."
          })
        ])
      );
    }
  });

  it("rejects captured scroll ranges that cannot contain their viewport", () => {
    const capture = captureFixture();
    capture.steps[0]!.scene.scroll = {
      x: 1,
      y: 0,
      width: 1280,
      height: 720
    };

    const parsed = CaptureSourceSchema.safeParse(capture);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["steps", 0, "scene", "scroll", "x"],
            message:
              "Scene horizontal scroll offset must stay inside the captured range."
          })
        ])
      );
    }
  });

  it("marks later demo steps skipped when the source flow stops", () => {
    const capture = captureFixture();
    const first = capture.steps[0]!;
    capture.steps = [
      first,
      {
        ...structuredClone(first),
        id: "invite-team",
        title: "Invite a teammate",
        evidence: [{ id: "ev-invite", text: "Invite teammate" }]
      },
      {
        ...structuredClone(first),
        id: "review-report",
        title: "Review the report",
        evidence: [{ id: "ev-review", text: "Review report" }]
      }
    ];
    const story = createEvidenceGroundedStory(capture);
    const baseline = createFreshnessBaseline(capture, story);
    const blocked = createBlockedFreshnessReport({
      baseline,
      baseVersion: "f".repeat(64),
      baseSourceHash: contentHash(capture),
      progress: [
        {
          stepId: "create-workspace",
          title: "Create your first workspace",
          stepIndex: 0,
          state: "reached",
          phase: "outcome"
        },
        {
          stepId: "invite-team",
          title: "Invite a teammate",
          stepIndex: 1,
          state: "failed",
          phase: "action"
        }
      ],
      failure: {
        code: "DemoFixtureSetupFailed",
        message: "The source flow stopped at “Invite a teammate”.",
        recovery: "Fix the action, then run the source flow again."
      }
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.previousDemoChanged).toBe(false);
    expect(blocked.steps.map((step) => step.state)).toEqual([
      "reached",
      "failed",
      "skipped"
    ]);
    expect(blocked.completion.state).toBe("skipped");
  });

  it("keeps unselected and terminal source failures outside selected step IDs", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    const baseline = createFreshnessBaseline(capture, story);
    const progress = validateCaptureStepProgress(
      [
        {
          stepId: "create-workspace",
          title: "Create your first workspace",
          stepIndex: 0,
          state: "reached",
          phase: "outcome"
        },
        {
          stepId: "unselected-source-step",
          title: "Unselected source step",
          stepIndex: 1,
          state: "failed",
          phase: "action"
        }
      ],
      baseline
    );
    const blocked = createBlockedFreshnessReport({
      baseline,
      baseVersion: "f".repeat(64),
      baseSourceHash: contentHash(capture),
      progress,
      failure: {
        code: "DemoFixtureSetupFailed",
        message: "The source flow stopped.",
        recovery: "Fix the source flow."
      }
    });
    expect(blocked.steps).toHaveLength(1);
    expect(blocked.steps[0]).toEqual(
      expect.objectContaining({ stepId: "create-workspace", state: "reached" })
    );
    expect(blocked.sourceFailure).toEqual(
      expect.objectContaining({
        state: "failed",
        captureStepId: "unselected-source-step",
        phase: "action"
      })
    );

    const terminalFailure = createBlockedFreshnessReport({
      baseline,
      baseVersion: "f".repeat(64),
      baseSourceHash: contentHash(capture),
      progress: progress.slice(0, 1),
      failure: {
        code: "InternalError",
        message: "The terminal state could not be checked.",
        recovery: "Retry the source flow."
      }
    });
    expect(terminalFailure.completion).toEqual(
      expect.objectContaining({ state: "failed", code: "InternalError" })
    );
    expect(terminalFailure).not.toHaveProperty("sourceFailure");
  });

  it("rejects contradictory reports and untrusted progress shapes", () => {
    const capture = captureFixture();
    const story = createEvidenceGroundedStory(capture);
    const baseline = createFreshnessBaseline(capture, story);
    const fresh = compareCaptureFreshness({
      baseline,
      baseVersion: "d".repeat(64),
      baseSourceHash: contentHash(capture),
      currentCapture: capture
    });
    const outOfDateWithoutFailure = {
      ...structuredClone(fresh),
      status: "out-of-date"
    };
    expect(
      FreshnessReportSchema.safeParse(outOfDateWithoutFailure).success
    ).toBe(false);

    const blockedWithoutFailure = {
      schemaVersion: SCHEMA_VERSION,
      status: "blocked",
      previousDemoChanged: false,
      baseVersion: "d".repeat(64),
      baseSourceHash: "e".repeat(64),
      steps: [
        {
          stepId: "create-workspace",
          title: "Create your first workspace",
          state: "skipped",
          detail: "The step was not checked."
        }
      ],
      completion: {
        state: "skipped",
        detail: "The final state was not checked."
      }
    };
    expect(FreshnessReportSchema.safeParse(blockedWithoutFailure).success).toBe(
      false
    );
    expect(
      FreshnessReportSchema.safeParse({
        ...blockedWithoutFailure,
        currentSourceHash: "f".repeat(64),
        sourceFailure: {
          state: "failed",
          code: "DemoFixtureSetupFailed",
          detail: "The flow stopped.",
          recovery: "Fix the flow.",
          phase: "setup"
        }
      }).success
    ).toBe(false);
    expect(
      CaptureStepProgressSchema.safeParse({
        stepId: "create-workspace",
        title: "Create your first workspace",
        stepIndex: 0,
        state: "reached",
        phase: "outcome",
        injected: "not-public"
      }).success
    ).toBe(false);
    expect(
      validateCaptureStepProgress(
        [
          {
            stepId: "create-workspace",
            title: "Create your first workspace",
            stepIndex: 1,
            state: "failed",
            phase: "action"
          }
        ],
        baseline
      )
    ).toEqual([]);
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

  it("namespaces player asset revisions away from legacy content-only cache keys", () => {
    const capture = captureFixture();
    const files = createPlayerFiles(capture, createEvidenceGroundedStory(capture));
    const revision = files["index.html"].match(/styles\.css\?v=([a-f0-9]{16})/)?.[1];
    const legacyRevision = sha256(
      [files["styles.css"], files["player.js"], files["story.js"]].join("\u0000")
    ).slice(0, 16);

    expect(revision).toBeDefined();
    expect(revision).not.toBe(legacyRevision);
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
