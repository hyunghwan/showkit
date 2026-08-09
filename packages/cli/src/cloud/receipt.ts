import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import { sha256, writeFileAtomic, writeJsonAtomic } from "../core/json.js";
import { projectRoot, showkitPath } from "../core/project.js";
import type { HostedPublishResponse } from "./contracts.js";

const ReceiptSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    projectKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(16).max(128),
    status: z.enum(["pending", "published"]),
    updatedAt: z.string().datetime(),
    result: z
      .object({
        demoId: z.string(),
        publicId: z.string(),
        generation: z.number().int().positive(),
        version: z.string().regex(/^[a-f0-9]{64}$/),
        url: z.string().url(),
        dashboardUrl: z.string().url()
      })
      .strict()
      .optional()
  })
  .strict();

type Receipt = z.infer<typeof ReceiptSchema>;

function receiptPath(projectId: string): string {
  return showkitPath("cloud", "publications", `${sha256(projectId)}.json`);
}

function unsafeReceiptPath(): ShowKitError {
  return new ShowKitError({
    code: "CloudReceiptUnsafe",
    message: "The private publication receipt path is not a regular path inside this project. Nothing was published.",
    exitCode: EXIT_CODES.environment,
    recovery: "Remove the symlinked .showkit receipt path, then run publish again."
  });
}

async function ensurePrivateDirectory(directory: string, parentRealPath: string): Promise<string> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    const metadata = await lstat(directory);
    const resolved = await realpath(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      path.dirname(resolved) !== parentRealPath
    ) {
      throw unsafeReceiptPath();
    }
    await chmod(directory, 0o700);
    return resolved;
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw unsafeReceiptPath();
  }
}

async function ensureSafeFileOrMissing(filePath: string, parentRealPath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    const resolved = await realpath(filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      path.dirname(resolved) !== parentRealPath
    ) {
      throw unsafeReceiptPath();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ShowKitError) throw error;
    throw unsafeReceiptPath();
  }
}

async function ensureIgnoredAndPrivate(): Promise<void> {
  const rootRealPath = await realpath(projectRoot());
  const showkitDirectory = showkitPath();
  const showkitRealPath = await ensurePrivateDirectory(showkitDirectory, rootRealPath);
  const cloudDirectory = showkitPath("cloud");
  const cloudRealPath = await ensurePrivateDirectory(cloudDirectory, showkitRealPath);
  const publicationsDirectory = path.join(cloudDirectory, "publications");
  await ensurePrivateDirectory(publicationsDirectory, cloudRealPath);
  const ignorePath = showkitPath(".gitignore");
  await ensureSafeFileOrMissing(ignorePath, showkitRealPath);
  let ignore = "";
  try {
    ignore = await readFile(ignorePath, "utf8");
  } catch {
    // The project loader reports a missing project before this path is reached.
  }
  if (!ignore.split(/\r?\n/).includes("cloud/")) {
    const next = `${ignore.replace(/\s*$/, "\n")}cloud/\n`;
    await writeFileAtomic(ignorePath, next);
  }
  await ensureSafeFileOrMissing(ignorePath, showkitRealPath);
}

export async function pendingIdempotencyKey(options: {
  projectId: string;
  requestHash: string;
  create: () => string;
  now: string;
}): Promise<string> {
  await ensureIgnoredAndPrivate();
  const filePath = receiptPath(options.projectId);
  await ensureSafeFileOrMissing(filePath, await realpath(path.dirname(filePath)));
  try {
    const existing = ReceiptSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    if (existing.status === "pending" && existing.requestHash === options.requestHash) {
      return existing.idempotencyKey;
    }
  } catch {
    // Missing or invalid private state is replaced with a fresh pending receipt.
  }
  const idempotencyKey = options.create();
  const receipt: Receipt = {
    schemaVersion: "0.1",
    projectKey: sha256(options.projectId),
    requestHash: options.requestHash,
    idempotencyKey,
    status: "pending",
    updatedAt: options.now
  };
  await writeJsonAtomic(filePath, receipt, 0o600);
  return idempotencyKey;
}

export async function commitPublicationReceipt(options: {
  projectId: string;
  requestHash: string;
  idempotencyKey: string;
  result: HostedPublishResponse;
  now: string;
}): Promise<void> {
  await ensureIgnoredAndPrivate();
  const filePath = receiptPath(options.projectId);
  await ensureSafeFileOrMissing(filePath, await realpath(path.dirname(filePath)));
  const receipt: Receipt = {
    schemaVersion: "0.1",
    projectKey: sha256(options.projectId),
    requestHash: options.requestHash,
    idempotencyKey: options.idempotencyKey,
    status: "published",
    updatedAt: options.now,
    result: {
      demoId: options.result.demoId,
      publicId: options.result.publicId,
      generation: options.result.generation,
      version: options.result.version,
      url: options.result.url,
      dashboardUrl: options.result.dashboardUrl
    }
  };
  await writeJsonAtomic(filePath, receipt, 0o600);
}
