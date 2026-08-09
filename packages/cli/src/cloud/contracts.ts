import { z } from "zod";

export const HOSTED_SCHEMA_VERSION = "0.1" as const;
export const HOSTED_REQUEST_MAX_BYTES = 5 * 1024 * 1024;
export const HOSTED_REQUEST_WARNING_BYTES = 2 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const HostedIdentifierSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const ProjectIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/);
const PublicIdSchema = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const DemoIdSchema = z.string().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/);
const HostedPublicDemoUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return (
    url.origin === "https://demos.showkit.sqncs.com" &&
    /^\/d\/[0-9A-HJKMNP-TV-Z]{26}$/.test(url.pathname) &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}, "Invalid hosted demo URL");
const HostedDashboardUrlSchema = z.string().url().refine(
  (value): boolean => value === "https://app.showkit.sqncs.com/demos",
  "Invalid hosted dashboard URL"
);
const Base64Schema = z
  .string()
  .max(7_100_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0, "Invalid base64 length");

export const HostedFilePathSchema = z.string().regex(
  /^(?:index\.html|styles\.css|story\.js|player\.js|verification\.json|quality\.json|release-notes\.md|assets\/[a-f0-9]{64}\.(?:png|jpg|webp|avif|gif|svg|woff2))$/
);

export const HostedArtifactFileMetadataSchema = z
  .object({
    path: HostedFilePathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative().max(HOSTED_REQUEST_MAX_BYTES),
    mediaType: z.string().min(1).max(100)
  })
  .strict();

export const HostedArtifactFileSchema = HostedArtifactFileMetadataSchema.extend({
  encoding: z.literal("base64"),
  content: Base64Schema
}).strict();

export const HostedFreshnessBaselineSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            stepId: HostedIdentifierSchema,
            captureStepId: HostedIdentifierSchema,
            sourceIndex: z.number().int().nonnegative(),
            title: z.string().min(1).max(120),
            sceneHash: Sha256Schema,
            targetHash: Sha256Schema,
            evidenceIds: z.array(z.string().min(1)).min(1),
            evidenceHash: Sha256Schema,
            actionOutcomeHash: Sha256Schema
          })
          .strict()
      )
      .min(1),
    terminalSceneHash: Sha256Schema
  })
  .strict();

export const HostedArtifactMetadataSchema = z
  .object({
    version: Sha256Schema,
    sourceCaptureHash: Sha256Schema,
    storyHash: Sha256Schema,
    freshness: HostedFreshnessBaselineSchema.optional(),
    builderVersion: z.string().min(1).max(80),
    runtimeHash: Sha256Schema,
    files: z.array(HostedArtifactFileMetadataSchema).min(4).max(256),
    sanitization: z
      .object({
        policyChecksPassed: z.literal(true),
        fullSceneRasterCount: z.literal(0),
        remoteRequestCount: z.literal(0)
      })
      .strict(),
    publish: z.null()
  })
  .strict();

export const HostedPublishRequestSchema = z
  .object({
    schemaVersion: z.literal(HOSTED_SCHEMA_VERSION),
    projectId: ProjectIdSchema,
    title: z.string().trim().min(1).max(120),
    visibility: z.literal("unlisted"),
    artifact: HostedArtifactMetadataSchema,
    files: z.array(HostedArtifactFileSchema).min(4).max(256)
  })
  .strict();

export const HostedPublishResponseSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("published"),
    action: z.enum(["created", "updated", "unchanged"]),
    version: Sha256Schema,
    demoId: DemoIdSchema,
    publicId: PublicIdSchema,
    generation: z.number().int().positive(),
    url: HostedPublicDemoUrlSchema,
    dashboardUrl: HostedDashboardUrlSchema
  })
  .strict()
  .refine((value) => value.url.endsWith(`/d/${value.publicId}`), {
    message: "Hosted demo URL does not match its public ID",
    path: ["url"]
  });

export const HostedDemoItemSchema = z
  .object({
    demoId: DemoIdSchema,
    title: z.string().min(1).max(120),
    status: z.literal("published"),
    visibility: z.literal("unlisted"),
    url: HostedPublicDemoUrlSchema,
    artifactHash: Sha256Schema,
    generation: z.number().int().positive(),
    updatedAt: z.string().datetime(),
    analytics: z
      .object({
        views: z.number().int().nonnegative().max(2_147_483_647),
        uniqueVisitors: z.number().int().nonnegative().max(10_000),
        uniqueSessions: z.number().int().nonnegative().max(50_000),
        lastViewedAt: z.string().datetime().nullable()
      })
      .strict()
  })
  .strict();

export const HostedUpgradeOfferSchema = z
  .object({
    planKey: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
    maxActiveDemos: z.number().int().positive().max(100),
    unitAmount: z.number().int().positive().max(1_000_000),
    currency: z.string().length(3).regex(/^[a-z]{3}$/),
    interval: z.literal("month")
  })
  .strict();

export const HostedEntitlementSchema = z
  .object({
    planKey: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
    maxActiveDemos: z.number().int().positive().max(100),
    activeDemoCount: z.number().int().nonnegative().max(100),
    canCreateDemo: z.boolean(),
    canUpgrade: z.boolean(),
    upgradeOffer: HostedUpgradeOfferSchema.nullable(),
    canManageBilling: z.boolean(),
    billingStatus: z.enum(["none", "active", "attention", "past_due", "canceled"])
  })
  .strict();

export const HostedDemoListResponseSchema = z
  .object({
    ok: z.literal(true),
    items: z.array(HostedDemoItemSchema).max(100),
    entitlement: HostedEntitlementSchema
  })
  .strict();

export const PublicDemoResolveRequestSchema = z
  .object({ publicId: PublicIdSchema })
  .strict();

export const PublicDemoViewRequestSchema = z
  .object({
    publicId: PublicIdSchema,
    visitorId: z.string().length(32).regex(/^[a-f0-9]{32}$/),
    sessionId: z.string().length(32).regex(/^[a-f0-9]{32}$/)
  })
  .strict();

export const PublicDemoResolveResponseSchema = z
  .object({
    ok: z.literal(true),
    title: z.string().min(1).max(120),
    generation: z.number().int().positive(),
    artifactHash: Sha256Schema,
    runtimeHash: Sha256Schema,
    files: z.array(HostedArtifactFileSchema).min(4).max(256)
  })
  .strict();

export const DeviceAuthorizationCreateResponseSchema = z
  .object({
    ok: z.literal(true),
    authorizationId: z.string().length(32).regex(/^[a-f0-9]+$/),
    deviceSecret: z.string().min(40).max(100),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url(),
    expiresIn: z.literal(600),
    interval: z.number().int().min(2).max(5)
  })
  .strict();

export const DeviceAuthorizationApproveRequestSchema = z
  .object({ deviceSecret: z.string().min(40).max(100) })
  .strict();

export const DeviceAuthorizationPollResponseSchema = z.discriminatedUnion("status", [
  z.object({ ok: z.literal(true), status: z.literal("pending") }).strict(),
  z.object({ ok: z.literal(true), status: z.literal("expired") }).strict(),
  z
    .object({
      ok: z.literal(true),
      status: z.literal("connected"),
      customToken: z.string().min(100).max(8192)
    })
    .strict()
]);

export const HostedUrlResponseSchema = z
  .object({ ok: z.literal(true), url: z.string().url() })
  .strict();

export const HostedUnpublishResponseSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("unpublished"),
    demoId: DemoIdSchema
  })
  .strict();

export const HostedApiErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(240),
        recovery: z.string().min(1).max(300),
        requestId: z.string().min(1).max(100)
      })
      .strict()
  })
  .strict();

export type HostedArtifactFile = z.infer<typeof HostedArtifactFileSchema>;
export type HostedPublishRequest = z.infer<typeof HostedPublishRequestSchema>;
export type HostedPublishResponse = z.infer<typeof HostedPublishResponseSchema>;
export type HostedDemoListResponse = z.infer<typeof HostedDemoListResponseSchema>;
export type PublicDemoResolveResponse = z.infer<typeof PublicDemoResolveResponseSchema>;
export type DeviceAuthorizationCreateResponse = z.infer<
  typeof DeviceAuthorizationCreateResponseSchema
>;
export type DeviceAuthorizationPollResponse = z.infer<
  typeof DeviceAuthorizationPollResponseSchema
>;
