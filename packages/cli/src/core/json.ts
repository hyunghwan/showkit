import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]);
    return Object.fromEntries(entries);
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export async function writeFileAtomic(
  filePath: string,
  contents: string | Uint8Array,
  mode?: number
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, {
      flag: "wx",
      ...(mode === undefined ? {} : { mode })
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode?: number
): Promise<void> {
  await writeFileAtomic(filePath, canonicalJson(value), mode);
}

export async function replaceDirectoryAtomic(
  targetPath: string,
  writer: (temporaryPath: string) => Promise<void>
): Promise<void> {
  try {
    await access(targetPath);
    throw new Error(`Immutable directory already exists: ${targetPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await mkdir(temporaryPath, { recursive: true });

  try {
    await writer(temporaryPath);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}
