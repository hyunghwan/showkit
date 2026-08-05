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

const packageJson = JSON.parse(
  await readFile(path.join(root, "packages", "cli", "package.json"), "utf8")
);
const claudeMarketplace = JSON.parse(
  await readFile(
    path.join(root, ".claude-plugin", "marketplace.json"),
    "utf8"
  )
);
const showkitPlugin = claudeMarketplace.plugins?.find(
  (plugin) => plugin.name === "showkit"
);
if (
  claudeMarketplace.name !== "showkit" ||
  showkitPlugin?.source !== "./" ||
  showkitPlugin?.strict !== false ||
  !showkitPlugin?.skills?.includes("./skills/showkit")
) {
  failures.push(
    ".claude-plugin/marketplace.json: ShowKit Cowork plugin must expose ./skills/showkit"
  );
}
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
if (!versionMatch) {
  failures.push(
    `packages/cli/package.json: release version must be exact semver, received ${JSON.stringify(packageJson.version)}`
  );
} else {
  const major = Number(versionMatch[1]);
  const minor = Number(versionMatch[2]);
  const nextMinor = `${major}.${minor + 1}.0`;
  const expectedSkillRange = `>=${packageJson.version} <${nextMinor}`;
  const expectedSupportWindow = `ShowKit \`${major}.${minor}.x\``;
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    !new RegExp(
      `^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`,
      "m"
    ).test(changelog)
  ) {
    failures.push(
      `CHANGELOG.md: missing release heading for ${packageJson.version}`
    );
  }

  const skillCompatibility = JSON.parse(
    await readFile(
      path.join(root, "skills", "showkit", "compatibility.json"),
      "utf8"
    )
  );
  if (skillCompatibility.cli !== expectedSkillRange) {
    failures.push(
      `skills/showkit/compatibility.json: expected cli range ${expectedSkillRange}, received ${JSON.stringify(skillCompatibility.cli)}`
    );
  }

  for (const relativeFile of [
    "COMPATIBILITY.md",
    "SECURITY.md",
    "SUPPORT.md"
  ]) {
    const markdown = await readFile(path.join(root, relativeFile), "utf8");
    if (!markdown.includes(expectedSupportWindow)) {
      failures.push(
        `${relativeFile}: missing support window ${expectedSupportWindow}`
      );
    }
  }
}

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
