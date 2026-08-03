import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "packages", "cli", "package.json"), "utf8")
);

function argument(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const bootstrap = process.argv.includes("--bootstrap");
const badVersion = argument("--bad", packageJson.version);
const priorVersion = argument("--prior");
const fixedVersion = argument("--fixed");
const outputPath = path.resolve(
  argument("--output", path.join(repositoryRoot, "release", "rollback-plan.json"))
);
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!versionPattern.test(badVersion)) {
  throw new Error("Rollback drill versions must be exact semver values.");
}
if (bootstrap) {
  if (priorVersion !== null) {
    throw new Error(
      "A first-release rollback uses --bootstrap and --fixed, not --prior."
    );
  }
  if (!versionPattern.test(fixedVersion) || badVersion === fixedVersion) {
    throw new Error(
      "A first-release rollback requires a distinct exact --fixed version."
    );
  }
} else if (
  !versionPattern.test(priorVersion) ||
  badVersion === priorVersion ||
  fixedVersion !== null
) {
  throw new Error(
    "A later-release rollback requires a distinct exact --prior version."
  );
}

const packageName = packageJson.name;
const replacementVersion = bootstrap ? fixedVersion : priorVersion;
const deprecationMessage =
  `Use ${packageName}@${replacementVersion} while ${badVersion} is investigated.`;
const plan = {
  schemaVersion: "0.2",
  package: packageName,
  mode: bootstrap ? "first-release" : "known-good-rollback",
  dryRun: true,
  externalWritesPerformed: false,
  badVersion,
  priorVersion,
  fixedVersion,
  replacementVersion,
  invariant: "Published versions are never overwritten or deleted.",
  commands: {
    deprecateBad: `npm deprecate "${packageName}@${badVersion}" "${deprecationMessage}"`,
    restorePrior: bootstrap
      ? null
      : `npm deprecate "${packageName}@${priorVersion}" ""`,
    installReplacement: {
      pnpm: `pnpm add -D ${packageName}@${replacementVersion}`,
      npm: `npm install -D ${packageName}@${replacementVersion}`,
      yarn: `yarn add -D ${packageName}@${replacementVersion}`
    },
    verifyRegistry:
      `npm view "${packageName}@${badVersion}" version deprecated --json && ` +
      `npm view "${packageName}@${replacementVersion}" version deprecated --json`,
    verifyProject: "showkit doctor --json"
  },
  recoveryOrder: bootstrap
    ? [
        "Stop any remaining release job.",
        "Mark the first bad version with an actionable deprecation message.",
        `Publish ${fixedVersion} only after the full release gate passes.`,
        `Pin installation guidance to ${fixedVersion}.`,
        "Run doctor in a clean project."
      ]
    : [
        "Stop any remaining release job.",
        "Mark the bad version with an actionable deprecation message.",
        "Remove any deprecation from the prior known-good version.",
        "Pin installation guidance to the prior version.",
        "Run doctor in a clean project.",
        "Publish a new fixed version only after the full release gate passes."
      ]
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    status: "dry-run",
    externalWritesPerformed: false,
    output: outputPath,
    mode: plan.mode,
    badVersion,
    priorVersion,
    fixedVersion
  })}\n`
);
