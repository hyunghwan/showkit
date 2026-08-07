import { z } from "zod";

export const SCHEMA_VERSION = "0.1" as const;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens.");

const HttpOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      value === url.origin &&
      url.username === "" &&
      url.password === ""
    );
  }, "Use an HTTP or HTTPS origin without credentials, path, query, or fragment.");

const SafePathSchema = z
  .string()
  .startsWith("/")
  .max(1024)
  .refine((value) => !/[?#]/.test(value), "Query strings and fragments are not allowed.");

const LocaleSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

const TimezoneIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^(?:UTC|GMT|Etc\/[A-Za-z0-9_+.-]{1,32}|[A-Za-z][A-Za-z0-9_+.-]{0,31}(?:\/[A-Za-z0-9_+.-]{1,32}){1,2})$/
  );

const CompletionDestinationSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol)) {
      return url.username === "" && url.password === "";
    }
    if (url.protocol !== "mailto:" || url.hash !== "") return false;
    if (/%0a|%0d|\r|\n/i.test(value)) return false;
    let recipient: string;
    try {
      recipient = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(recipient)) {
      return false;
    }
    for (const [key, content] of url.searchParams) {
      if (!["subject", "body"].includes(key)) return false;
      if (/[\r\n]/.test(content) || content.length > 500) return false;
    }
    return true;
  }, "Completion destinations must use HTTP, HTTPS, or a safe single-recipient mailto URL.");

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );
  return (
    0.2126 * channels[0]! +
    0.7152 * channels[1]! +
    0.0722 * channels[2]!
  );
}

export function colorContrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

export function inspectPlayerThemeContrast(theme: {
  accent: string;
  ink: string;
  paper: string;
}): {
  accentText: string;
  accentTextRatio: number;
  accentWhiteRatio: number;
  inkPaperRatio: number;
  inkWhiteRatio: number;
  paperWhiteRatio: number;
  passed: boolean;
} {
  const white = "#ffffff";
  const accentInkRatio = colorContrastRatio(theme.accent, theme.ink);
  const accentPaperRatio = colorContrastRatio(theme.accent, theme.paper);
  const accentText =
    accentInkRatio >= accentPaperRatio ? theme.ink : theme.paper;
  const accentTextRatio = Math.max(accentInkRatio, accentPaperRatio);
  const accentWhiteRatio = colorContrastRatio(theme.accent, white);
  const inkPaperRatio = colorContrastRatio(theme.ink, theme.paper);
  const inkWhiteRatio = colorContrastRatio(theme.ink, white);
  const paperWhiteRatio = colorContrastRatio(theme.paper, white);
  return {
    accentText,
    accentTextRatio,
    accentWhiteRatio,
    inkPaperRatio,
    inkWhiteRatio,
    paperWhiteRatio,
    passed:
      inkPaperRatio >= 4.5 &&
      inkWhiteRatio >= 4.5 &&
      accentWhiteRatio >= 3 &&
      accentTextRatio >= 4.5 &&
      paperWhiteRatio <= 1.4
  };
}

export const BoundsSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1)
}).strict();

export const DemoFixtureSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: IdentifierSchema,
    baseURL: z.string().url(),
    startPath: z.string().startsWith("/"),
    viewport: z
      .object({
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096)
      })
      .strict(),
    locale: LocaleSchema,
    timezoneId: TimezoneIdSchema,
    lifecycle: z.discriminatedUnion("setup", [
      z
        .object({
          setup: z.literal("playwright-fixture"),
          teardown: z.literal("playwright-fixture")
        })
        .strict(),
      z
        .object({
          setup: z.literal("agent-browser-session"),
          teardown: z.literal("agent-browser-session")
        })
        .strict(),
      z
        .object({
          setup: z.literal("static-source"),
          teardown: z.literal("static-source")
        })
        .strict()
    ]),
    auth: z.union([
      z
        .object({
          storageState: z.literal("runtime-only-if-configured"),
          persisted: z.literal(false)
        })
        .strict(),
      z
        .object({
          storageState: z.literal("not-used"),
          persisted: z.literal(false)
        })
        .strict()
    ]),
    debug: z
      .object({
        screenshot: z.literal("off"),
        traceBuildInput: z.literal(false),
        video: z.literal("off")
      })
      .strict(),
    steps: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            title: z.string().min(1).max(120),
            target: z.discriminatedUnion("strategy", [
              z
                .object({
                  strategy: z.literal("role"),
                  role: z.string().min(1).max(80),
                  name: z.string().min(1).max(180)
                })
                .strict(),
              z
                .object({
                  strategy: z.literal("test-id"),
                  testId: z.string().min(1).max(180),
                  name: z.string().min(1).max(180)
                })
                .strict(),
              z
                .object({
                  strategy: z.literal("href"),
                  path: SafePathSchema,
                  name: z.string().min(1).max(180)
                })
                .strict(),
              z
                .object({
                  strategy: z.literal("label"),
                  name: z.string().min(1).max(180)
                })
                .strict(),
              z
                .object({
                  strategy: z.literal("title"),
                  name: z.string().min(1).max(180)
                })
                .strict(),
              z
                .object({
                  strategy: z.literal("visible-text"),
                  name: z.string().min(1).max(180)
                })
                .strict()
            ]),
            actionKind: z
              .enum([
                "select",
                "navigate",
                "toggle",
                "disclose",
                "filter",
                "mutation-confirmed"
              ])
              .default("select")
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export const BrowserFlowRecipeSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: IdentifierSchema,
    host: z.enum(["codex", "chatgpt"]),
    browserSurface: z.enum(["iab", "chrome"]),
    adapterVersion: z.string().min(1).max(80),
    url: z
      .object({
        origin: HttpOriginSchema,
        path: SafePathSchema
      })
      .strict(),
    viewport: z
      .object({
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096)
      })
      .strict(),
    locale: LocaleSchema,
    timezoneId: TimezoneIdSchema,
    sensitiveTextRedaction: z
      .object({
        mode: z.literal("text-only"),
        consent: z.literal("confirmed"),
        regionCount: z.number().int().nonnegative().max(20)
      })
      .strict()
      .optional(),
    privateContent: z
      .object({
        mode: z.literal("visible-session"),
        consent: z.literal("confirmed")
      })
      .strict()
      .optional(),
    pageAssets: z
      .object({
        mode: z.literal("visible-session"),
        consent: z.literal("confirmed")
      })
      .strict()
      .optional(),
    steps: DemoFixtureSchema.shape.steps
  })
  .strict();

const SanitizedTagSchema = z.enum([
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

export type SanitizedNode =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "element";
      tag: z.infer<typeof SanitizedTagSchema>;
      attributes: Record<string, string>;
      styles: Record<string, string>;
      children: SanitizedNode[];
    };

export const SanitizedNodeSchema: z.ZodType<SanitizedNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("text"),
        text: z.string().max(100_000)
      })
      .strict(),
    z
      .object({
        type: z.literal("element"),
        tag: SanitizedTagSchema,
        attributes: z.record(z.string(), z.string()),
        styles: z.record(z.string(), z.string()),
        children: z.array(SanitizedNodeSchema)
      })
      .strict()
  ])
);

const LocalAssetMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/svg+xml",
  "font/woff2"
]);

export const SceneFontFaceSchema = z
  .object({
    family: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^{};@<>"'\\\r\n]+$/),
    style: z.enum(["normal", "italic", "oblique"]).default("normal"),
    weight: z
      .string()
      .regex(/^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/),
    stretch: z
      .string()
      .max(40)
      .regex(/^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}%)$/)
      .default("normal"),
    display: z.enum(["auto", "block", "swap", "fallback", "optional"]).default("block"),
    unicodeRange: z
      .string()
      .min(1)
      .max(4_000)
      .regex(/^U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?(?:\s*,\s*U\+[0-9A-F?*]{1,6}(?:\s*-\s*[0-9A-F?*]{1,6})?)*$/i)
      .optional(),
    src: z
      .string()
      .regex(/^\.\/assets\/[a-f0-9]{64}\.woff2$/)
  })
  .strict();

export const AssetReferenceSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: LocalAssetMimeTypeSchema,
    byteLength: z.number().int().positive().max(1_048_576),
    path: z
      .string()
      .regex(/^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg|woff2)$/)
  })
  .strict();

export const SceneSchema = z.object({
  html: z.string().min(1),
  nodes: z.array(SanitizedNodeSchema).min(1),
  fontFaces: z.array(SceneFontFaceSchema).max(32).optional(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).strict(),
  anchorId: z.string().min(1).optional(),
  target: z
    .object({
      tag: z.string().min(1),
      role: z.string().min(1).optional(),
      name: z.string().min(1),
      bounds: BoundsSchema
    })
    .strict()
    .optional()
}).strict();

export const CaptureStepSchema = z.object({
  id: IdentifierSchema,
  title: z.string().min(1).max(120),
  scene: SceneSchema,
  evidence: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(600)
      })
    )
    .min(1),
  actionOutcome: z.object({
    url: z.string().max(2048),
    title: z.string().max(300)
  }).strict()
}).strict();

export const PlaywrightCaptureSourceProvenanceSchema = z
  .object({
    kind: z.literal("playwright-spec"),
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
    runtime: z.literal("playwright-test"),
    runtimeVersion: z.string().min(1),
    projectName: z.string().min(1).max(120).optional(),
    replayLevel: z.literal("ci-replayable"),
    captureSecurity: z
      .object({
        provider: z.literal("playwright-cdp"),
        browserEngine: z.literal("chromium"),
        executionWorld: z.literal("chromium-cdp-isolated-readonly-v1")
      })
      .strict()
      .optional()
  })
  .strict();

export const AgentBrowserCaptureSourceProvenanceSchema = z
  .object({
    kind: z.literal("agent-browser-session"),
    recipeHash: z.string().regex(/^[a-f0-9]{64}$/),
    host: z.enum(["codex", "chatgpt"]),
    browserSurface: z.enum(["iab", "chrome"]),
    adapterVersion: z.string().min(1).max(80),
    sessionPersisted: z.literal(false),
    replayLevel: z.literal("session-captured")
  })
  .strict();

export const StaticCaptureSourceProvenanceSchema = z
  .object({
    kind: z.literal("static-source"),
    sourceFiles: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(500)
              .refine(
                (value) =>
                  !pathLikeAbsolute(value) &&
                  !value.split(/[\\/]/).includes(".."),
                "Use a project-relative source path without parent traversal."
              ),
            sha256: z.string().regex(/^[a-f0-9]{64}$/)
          })
          .strict()
      )
      .min(1)
      .max(100),
    generator: z.literal("showkit-static"),
    generatorVersion: z.string().min(1).max(80),
    replayLevel: z.literal("source-derived")
  })
  .strict();

function pathLikeAbsolute(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export const CaptureSourceProvenanceSchema = z.discriminatedUnion("kind", [
  PlaywrightCaptureSourceProvenanceSchema,
  AgentBrowserCaptureSourceProvenanceSchema,
  StaticCaptureSourceProvenanceSchema
]);

export const CaptureSourceSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  captureId: z.string().min(1),
  source: CaptureSourceProvenanceSchema,
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  browser: z.string().min(1),
  fixture: DemoFixtureSchema,
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).strict(),
  steps: z.array(CaptureStepSchema).min(1),
  terminalScene: SceneSchema,
  assets: z.array(AssetReferenceSchema),
  redaction: z.object({
    policyChecksPassed: z.literal(true),
    excludedSurfaces: z.array(z.string()),
    fullSceneRasterCount: z.literal(0),
    sensitiveText: z
      .object({
        mode: z.enum(["blocked-by-default", "text-only"]),
        redactedTextNodeCount: z.number().int().nonnegative(),
        redactedAttributeCount: z.number().int().nonnegative(),
        regionCount: z.number().int().nonnegative().max(20)
      })
      .strict()
      .optional(),
    privateContent: z
      .object({
        mode: z.literal("visible-session"),
        consent: z.literal("confirmed"),
        localOnly: z.literal(true),
        hiddenValuesExcluded: z.literal(true)
      })
      .strict()
      .optional(),
    pageAssets: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("public-page"),
            consent: z.literal("requested"),
            localOnly: z.literal(true),
            assetCount: z.number().int().nonnegative()
          })
          .strict(),
        z
          .object({
            mode: z.literal("visible-session"),
            consent: z.literal("confirmed"),
            localOnly: z.literal(true),
            assetCount: z.number().int().nonnegative()
          })
          .strict()
      ])
      .optional()
  }).strict()
}).strict().superRefine((capture, context) => {
  const seenStepIds = new Set<string>();
  for (const [index, step] of capture.steps.entries()) {
    if (seenStepIds.has(step.id)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: "Capture step IDs must be unique."
      });
    }
    seenStepIds.add(step.id);
  }
});

export const AgentBrowserDemoFixtureSchema = DemoFixtureSchema.extend({
  lifecycle: z
    .object({
      setup: z.literal("agent-browser-session"),
      teardown: z.literal("agent-browser-session")
    })
    .strict()
}).strict();

export const AgentBrowserCaptureSourceSchema = CaptureSourceSchema.safeExtend({
  source: AgentBrowserCaptureSourceProvenanceSchema,
  fixture: AgentBrowserDemoFixtureSchema
}).strict();

export const StaticDemoFixtureSchema = DemoFixtureSchema.extend({
  lifecycle: z
    .object({
      setup: z.literal("static-source"),
      teardown: z.literal("static-source")
    })
    .strict(),
  auth: z
    .object({
      storageState: z.literal("not-used"),
      persisted: z.literal(false)
    })
    .strict()
}).strict();

export const StaticCaptureSourceSchema = CaptureSourceSchema.safeExtend({
  source: StaticCaptureSourceProvenanceSchema,
  fixture: StaticDemoFixtureSchema
}).strict();

export const AssetPayloadSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: LocalAssetMimeTypeSchema,
    byteLength: z.number().int().positive().max(1_048_576),
    base64: z.string().min(1)
  })
  .strict();

export const CaptureEnvelopeSchema = z
  .object({
    capture: CaptureSourceSchema,
    assetPayloads: z.array(AssetPayloadSchema).max(64)
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      envelope.assetPayloads.reduce(
        (total, payload) => total + payload.byteLength,
        0
      ) > 20 * 1024 * 1024
    ) {
      context.addIssue({
        code: "custom",
        path: ["assetPayloads"],
        message: "Captured asset payloads exceed the 20 MB aggregate limit."
      });
    }
  });

export const SessionCaptureEnvelopeSchema = z
  .object({
    recipe: BrowserFlowRecipeSchema,
    capture: AgentBrowserCaptureSourceSchema,
    assetPayloads: z.array(AssetPayloadSchema).max(64)
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      envelope.assetPayloads.reduce(
        (total, payload) => total + payload.byteLength,
        0
      ) > 20 * 1024 * 1024
    ) {
      context.addIssue({
        code: "custom",
        path: ["assetPayloads"],
        message: "Captured asset payloads exceed the 20 MB aggregate limit."
      });
    }
  });

const RunBaseSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: z.string().min(1),
    command: z.enum(["capture", "story-apply", "validate", "build", "publish"]),
    startedAt: z.string().datetime(),
  })
  .strict();

export const RunEnvelopeSchema = z.discriminatedUnion("state", [
  RunBaseSchema.extend({
    state: z.literal("STARTED")
  }).strict(),
  RunBaseSchema.extend({
    state: z.literal("BLOCKED_DIAGNOSTIC"),
    completedAt: z.string().datetime(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    failure: z
      .object({
        code: z.string().min(1)
      })
      .strict()
  }).strict(),
  RunBaseSchema.extend({
    state: z.literal("CAPTURED"),
    completedAt: z.string().datetime(),
    captureId: z.string().min(1)
  }).strict(),
  RunBaseSchema.extend({
    state: z.literal("VALIDATED"),
    completedAt: z.string().datetime(),
    captureId: z.string().min(1),
    storyId: z.string().min(1),
    storyVersion: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  RunBaseSchema.extend({
    state: z.literal("BUILT"),
    completedAt: z.string().datetime(),
    captureId: z.string().min(1),
    storyId: z.string().min(1),
    storyVersion: z.string().regex(/^[a-f0-9]{64}$/),
    artifactVersion: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  RunBaseSchema.extend({
    state: z.literal("PUBLISHED"),
    completedAt: z.string().datetime(),
    captureId: z.string().min(1),
    storyId: z.string().min(1),
    storyVersion: z.string().regex(/^[a-f0-9]{64}$/),
    artifactVersion: z.string().regex(/^[a-f0-9]{64}$/),
    remoteVersionId: z.string().min(1)
  }).strict()
]);

export const SkillCompatibilitySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    cli: z.string().min(1),
    playwright: z.string().min(1),
    playwrightRequired: z.boolean().default(false),
    node: z.string().min(1),
    hosts: z
      .array(z.enum(["codex", "chatgpt", "claude-code", "claude-app"]))
      .min(1)
  })
  .strict();

const PlayerBackdropSchema = z.enum(["off", "light", "medium", "heavy"]);

export const StoryStepSchema = z.object({
  id: IdentifierSchema,
  captureStepId: IdentifierSchema,
  anchorId: z.string().min(1),
  tooltip: z.object({
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(240),
    placement: z.enum(["auto", "top", "right", "bottom", "left"]).default("auto"),
    backdrop: PlayerBackdropSchema.default("off")
  }).strict(),
  evidenceIds: z.array(z.string().min(1)).min(1),
  advance: z.enum(["hotspot", "next"]).default("hotspot")
}).strict();

const PlayerChromePositionSchema = z.enum([
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
  "hidden"
]);

const PlayerChromeTooltipPositionSchema = z.enum([
  ...PlayerChromePositionSchema.options,
  "tooltip"
]);

const PlayerChromePlacementsSchema = z
  .object({
    title: PlayerChromePositionSchema.default("hidden"),
    goal: PlayerChromePositionSchema.default("hidden"),
    stepCount: PlayerChromeTooltipPositionSchema.default("tooltip"),
    progress: PlayerChromeTooltipPositionSchema.default("tooltip"),
    back: PlayerChromeTooltipPositionSchema.default("tooltip"),
    restart: PlayerChromeTooltipPositionSchema.default("tooltip"),
    cta: PlayerChromeTooltipPositionSchema.default("tooltip")
  })
  .strict()
  .default({
    title: "hidden",
    goal: "hidden",
    stepCount: "tooltip",
    progress: "tooltip",
    back: "tooltip",
    restart: "tooltip",
    cta: "tooltip"
  });

export const PlayerChromeSchema = z
  .object({
    mode: z.enum(["overlay", "frame"]).default("overlay"),
    placements: PlayerChromePlacementsSchema
  })
  .strict()
  .default({
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

export const StorySpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdentifierSchema,
  sourceCaptureId: z.string().min(1),
  title: z.string().min(1).max(120),
  audience: z.string().min(1).max(120),
  goal: z.string().min(1).max(240),
  locale: LocaleSchema.default("en-US"),
  welcome: z
    .object({
      title: z.string().min(1).max(80),
      body: z.string().min(1).max(240),
      actionLabel: z.string().min(1).max(80),
      backdrop: PlayerBackdropSchema.default("heavy")
    })
    .strict()
    .default({
      title: "Welcome to this interactive demo",
      body: "Explore the captured product flow at your own pace.",
      actionLabel: "Explore demo",
      backdrop: "heavy"
    }),
  steps: z.array(StoryStepSchema).min(1),
  theme: z
    .object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      ink: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      paper: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      fonts: z
        .object({
          heading: z
            .string()
            .min(1)
            .max(160)
            .regex(/^[a-zA-Z0-9 ,"'-]+$/),
          body: z
            .string()
            .min(1)
            .max(160)
            .regex(/^[a-zA-Z0-9 ,"'-]+$/)
        })
        .strict()
        .default({
          heading: '"Avenir Next", Avenir, "Gill Sans", sans-serif',
          body: '"Avenir Next", Avenir, "Gill Sans", sans-serif'
        })
    })
    .strict()
    .superRefine((theme, context) => {
      const contrast = inspectPlayerThemeContrast(theme);
      if (contrast.inkPaperRatio < 4.5) {
        context.addIssue({
          code: "custom",
          path: ["ink"],
          message:
            "Ink and paper must have at least 4.5:1 contrast for WCAG 2.2 AA text."
        });
      }
      if (contrast.inkWhiteRatio < 4.5) {
        context.addIssue({
          code: "custom",
          path: ["ink"],
          message:
            "Ink must have at least 4.5:1 contrast against the player’s white surfaces."
        });
      }
      if (contrast.accentWhiteRatio < 3) {
        context.addIssue({
          code: "custom",
          path: ["accent"],
          message:
            "Accent must have at least 3:1 contrast against white for WCAG 2.2 AA non-text controls."
        });
      }
      if (contrast.accentTextRatio < 4.5) {
        context.addIssue({
          code: "custom",
          path: ["accent"],
          message:
            "Accent must support either ink or paper text at 4.5:1 contrast."
        });
      }
      if (contrast.paperWhiteRatio > 1.4) {
        context.addIssue({
          code: "custom",
          path: ["paper"],
          message:
            "ShowKit v1 requires paper to remain a light player surface."
        });
      }
    })
    .default({
      accent: "#ff5a36",
      ink: "#17211b",
      paper: "#f3efe6",
      fonts: {
        heading: '"Avenir Next", Avenir, "Gill Sans", sans-serif',
        body: '"Avenir Next", Avenir, "Gill Sans", sans-serif'
      }
    }),
  player: z
    .object({
      chrome: PlayerChromeSchema,
      navigation: z.enum(["controls", "hotspots"]).default("controls")
    })
    .strict()
    .default({
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
    }),
  cta: z
    .object({
      label: z.string().min(1).max(80),
      href: z
        .string()
        .url()
        .refine((value) => ["https:", "http:"].includes(new URL(value).protocol), {
          message: "CTA URLs must use HTTP or HTTPS."
        })
    })
    .strict()
    .optional(),
  completion: z
    .object({
      title: z.string().min(1).max(80).default("Ready to create your demo?"),
      body: z
        .string()
        .min(1)
        .max(240)
        .default("Email us to discuss an interactive HTML demo for your product."),
      actions: z
        .array(
          z
            .object({
              label: z.string().min(1).max(80).default("Email us for a demo"),
              href: CompletionDestinationSchema,
              style: z.enum(["primary", "secondary"]).default("primary")
            })
            .strict()
        )
        .min(1)
        .max(2)
    })
    .strict()
    .optional(),
  formats: z.array(z.enum(["web", "markdown"])).min(1).default(["web"])
}).strict();

export const VerificationReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  passed: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      detail: z.string()
    }).strict()
  )
}).strict();

export const QualityReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  passed: z.boolean(),
  fullSceneRasterCount: z.literal(0),
  remoteRequestCount: z.literal(0),
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      detail: z.string()
    }).strict()
  )
}).strict();

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const FreshnessBaselineSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            stepId: IdentifierSchema,
            captureStepId: IdentifierSchema,
            sourceIndex: z.number().int().nonnegative(),
            title: z.string().min(1).max(120),
            sceneHash: ContentHashSchema,
            targetHash: ContentHashSchema,
            evidenceIds: z.array(z.string().min(1)).min(1),
            evidenceHash: ContentHashSchema,
            actionOutcomeHash: ContentHashSchema
          })
          .strict()
      )
      .min(1),
    terminalSceneHash: ContentHashSchema
  })
  .strict();

const FreshnessDetailSchema = z.string().min(1).max(600);
const FreshnessCodeSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/);

const FreshnessFreshResultSchema = z
  .object({
    state: z.literal("fresh"),
    detail: FreshnessDetailSchema
  })
  .strict();

const FreshnessReachedResultSchema = z
  .object({
    state: z.literal("reached"),
    detail: FreshnessDetailSchema
  })
  .strict();

const FreshnessFailedResultSchema = z
  .object({
    state: z.literal("failed"),
    code: FreshnessCodeSchema,
    detail: FreshnessDetailSchema,
    recovery: z.string().min(1).max(600)
  })
  .strict();

const FreshnessSkippedResultSchema = z
  .object({
    state: z.literal("skipped"),
    detail: FreshnessDetailSchema
  })
  .strict();

const freshnessStep = <T extends z.ZodRawShape>(result: z.ZodObject<T>) =>
  result.extend({
    stepId: IdentifierSchema,
    title: z.string().min(1).max(120)
  }).strict();

const FreshnessFreshStepSchema = freshnessStep(FreshnessFreshResultSchema);
const FreshnessReachedStepSchema = freshnessStep(FreshnessReachedResultSchema);
const FreshnessFailedStepSchema = freshnessStep(FreshnessFailedResultSchema);
const FreshnessSkippedStepSchema = freshnessStep(FreshnessSkippedResultSchema);
const FreshnessCompletedStepSchema = z.discriminatedUnion("state", [
  FreshnessFreshStepSchema,
  FreshnessFailedStepSchema
]);
const FreshnessBlockedStepSchema = z.discriminatedUnion("state", [
  FreshnessReachedStepSchema,
  FreshnessFailedStepSchema,
  FreshnessSkippedStepSchema
]);

const FreshnessSourceFailureSchema = FreshnessFailedResultSchema.extend({
  captureStepId: IdentifierSchema.optional(),
  phase: z.enum(["setup", "capture", "action", "outcome", "finalize"])
}).strict();

const FreshnessReportIdentityShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  previousDemoChanged: z.literal(false),
  baseVersion: ContentHashSchema,
  baseSourceHash: ContentHashSchema
} satisfies z.ZodRawShape;

const FreshnessFreshReportSchema = z
  .object({
    ...FreshnessReportIdentityShape,
    status: z.literal("fresh"),
    currentSourceHash: ContentHashSchema,
    steps: z.array(FreshnessFreshStepSchema).min(1),
    completion: FreshnessFreshResultSchema
  })
  .strict();

const FreshnessOutOfDateReportSchema = z
  .object({
    ...FreshnessReportIdentityShape,
    status: z.literal("out-of-date"),
    currentSourceHash: ContentHashSchema,
    steps: z.array(FreshnessCompletedStepSchema).min(1),
    completion: z.discriminatedUnion("state", [
      FreshnessFreshResultSchema,
      FreshnessFailedResultSchema
    ])
  })
  .strict()
  .refine(
    (report) =>
      report.completion.state === "failed" ||
      report.steps.some((step) => step.state === "failed"),
    {
      path: ["status"],
      message: "An out-of-date report must identify a failed result."
    }
  );

const FreshnessBlockedReportSchema = z
  .object({
    ...FreshnessReportIdentityShape,
    status: z.literal("blocked"),
    steps: z.array(FreshnessBlockedStepSchema).min(1),
    completion: z.discriminatedUnion("state", [
      FreshnessSkippedResultSchema,
      FreshnessFailedResultSchema
    ]),
    sourceFailure: FreshnessSourceFailureSchema.optional()
  })
  .strict()
  .refine(
    (report) =>
      report.completion.state === "failed" ||
      report.steps.some((step) => step.state === "failed") ||
      report.sourceFailure?.state === "failed",
    {
      path: ["status"],
      message: "A blocked report must identify where the source flow failed."
    }
  );

export const FreshnessReportSchema = z.union([
  FreshnessFreshReportSchema,
  FreshnessOutOfDateReportSchema,
  FreshnessBlockedReportSchema
]);

export const ArtifactManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  state: z.literal("BUILT"),
  version: z.string().length(64),
  sourceCaptureHash: z.string().length(64),
  storyHash: z.string().length(64),
  freshness: FreshnessBaselineSchema.optional(),
  builderVersion: z.string(),
  source: CaptureSourceProvenanceSchema,
  replayLevel: z.enum([
    "ci-replayable",
    "session-captured",
    "source-derived"
  ]),
  dependencies: z
    .object({
      node: z
        .object({
          supported: z.literal(">=22.12 <25")
        })
        .strict(),
      playwright: z
        .object({
          capturedWith: z.string().min(1).optional(),
          supported: z.literal(">=1.60.0 <2")
        })
        .strict(),
      captureRuntime: z
        .object({
          kind: z.enum([
            "playwright-test",
            "agent-browser-adapter",
            "static-source"
          ]),
          version: z.string().min(1)
        })
        .strict()
    })
    .strict(),
  environment: z
    .object({
      browser: z.string().min(1),
      viewport: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  reports: z
    .object({
      verification: z.literal("verification.json"),
      quality: z.literal("quality.json")
    })
    .strict(),
  buildMetadata: z
    .object({
      createdAt: z.string().datetime(),
      sourceDateEpoch: z.string().regex(/^\d+$/).optional()
    })
    .strict(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      mediaType: z.string().min(1)
    }).strict()
  ),
  sanitization: z.object({
    policyChecksPassed: z.literal(true),
    fullSceneRasterCount: z.literal(0),
    remoteRequestCount: z.literal(0)
  }).strict(),
  provenance: z
    .object({
      assets: z.array(
        z
          .object({
            path: z
              .string()
              .regex(/^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg|woff2)$/),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            mimeType: LocalAssetMimeTypeSchema,
            origin: z.literal("captured-product-flow")
          })
          .strict()
      )
    })
    .strict(),
  publish: z.null()
}).strict();

export type Bounds = z.infer<typeof BoundsSchema>;
export type DemoFixture = z.infer<typeof DemoFixtureSchema>;
export type BrowserFlowRecipe = z.infer<typeof BrowserFlowRecipeSchema>;
export type AssetReference = z.infer<typeof AssetReferenceSchema>;
export type AssetPayload = z.infer<typeof AssetPayloadSchema>;
export type SceneFontFace = z.infer<typeof SceneFontFaceSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type CaptureStep = z.infer<typeof CaptureStepSchema>;
export type CaptureSourceProvenance = z.infer<typeof CaptureSourceProvenanceSchema>;
export type CaptureSource = z.infer<typeof CaptureSourceSchema>;
export type CaptureEnvelope = z.infer<typeof CaptureEnvelopeSchema>;
export type SessionCaptureEnvelope = z.infer<typeof SessionCaptureEnvelopeSchema>;
export type RunEnvelope = z.infer<typeof RunEnvelopeSchema>;
export type SkillCompatibility = z.infer<typeof SkillCompatibilitySchema>;
export type PlayerChrome = z.infer<typeof PlayerChromeSchema>;
export type StoryStep = z.infer<typeof StoryStepSchema>;
export type StorySpec = z.infer<typeof StorySpecSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
export type FreshnessBaseline = z.infer<typeof FreshnessBaselineSchema>;
export type FreshnessReport = z.infer<typeof FreshnessReportSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
