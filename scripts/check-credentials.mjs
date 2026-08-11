import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCredentialPatternCoverage,
  findCredentialPattern
} from "./credential-patterns.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([
  ".firebase",
  ".git",
  ".showkit",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "playwright-report",
  "release",
  "test-results"
]);

async function collectFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const entryRelative = path.join(relative, entry.name);
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, entryRelative)));
    } else if (entry.isFile()) {
      files.push(entryRelative);
    }
  }
  return files;
}

function gitFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repositoryRoot,
      encoding: "utf8"
    }
  );
  if (result.status !== 0) return null;
  return result.stdout.split("\0").filter(Boolean);
}

assertCredentialPatternCoverage();
const files = (gitFiles() ?? (await collectFiles(repositoryRoot))).sort();
const findings = [];
for (const relativePath of files) {
  const filePath = path.join(repositoryRoot, relativePath);
  const fileStat = await lstat(filePath).catch(() => null);
  if (!fileStat?.isFile()) continue;
  const contents = await readFile(filePath);
  const pattern = findCredentialPattern(contents.toString("utf8"));
  if (pattern) findings.push({ path: relativePath, pattern });
}

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `Credential-shaped value found in source: ${finding.path} (${finding.pattern})\n`
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Credential scan passed for ${files.length} source files.\n`);
}
