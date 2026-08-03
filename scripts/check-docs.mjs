import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const entrypoints = [
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "COMPATIBILITY.md",
  "CONTRIBUTING.md",
  "GETTING_STARTED.md",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "examples",
  "packages",
  "skills"
];
const ignoredDirectories = new Set([
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

async function collectMarkdown(candidate) {
  const absolute = path.join(root, candidate);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOTDIR") return candidate.endsWith(".md") ? [candidate] : [];
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = path.join(candidate, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdown(child)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

function localTargets(markdown) {
  const targets = [];
  const patterns = [
    /!?(?:\[[^\]]*\])\(([^)]+)\)/g,
    /<(?:a|img)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      let target = match[1].trim();
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      target = target.split(/\s+["']/u, 1)[0];
      if (
        !target ||
        target.startsWith("#") ||
        /^(?:https?:|mailto:|data:)/iu.test(target)
      ) {
        continue;
      }
      targets.push(decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]));
    }
  }
  return targets;
}

const markdownFiles = (
  await Promise.all(entrypoints.map((entrypoint) => collectMarkdown(entrypoint)))
).flat();
const failures = [];

for (const relativeFile of markdownFiles.sort()) {
  const markdown = await readFile(path.join(root, relativeFile), "utf8");
  for (const target of localTargets(markdown)) {
    if (path.isAbsolute(target)) {
      failures.push(`${relativeFile}: absolute local link ${target}`);
      continue;
    }
    const resolved = path.resolve(root, path.dirname(relativeFile), target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      failures.push(`${relativeFile}: link leaves the repository: ${target}`);
      continue;
    }
    try {
      await access(resolved);
    } catch {
      failures.push(`${relativeFile}: missing link target ${target}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${markdownFiles.length} Markdown files.\n`);
}
