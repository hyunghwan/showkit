import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryHome = await mkdtemp(
  path.join(os.tmpdir(), "showkit-global-skill-home-")
);
const skillEnvironment = {
  ...process.env,
  HOME: temporaryHome,
  USERPROFILE: temporaryHome,
  XDG_CONFIG_HOME: path.join(temporaryHome, ".config")
};

function run(args, expectedExitCode = 0) {
  const result = spawnSync("npx", ["--yes", "skills", ...args], {
    cwd: repositoryRoot,
    env: skillEnvironment,
    encoding: "utf8"
  });
  if (result.status !== expectedExitCode) {
    throw new Error(
      `npx skills ${args.join(" ")} exited ${result.status}.\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue across host-specific global locations.
    }
  }
  return undefined;
}

let installed = false;
try {
  const discovery = run(["add", repositoryRoot, "--list"]);
  if (!discovery.includes("showkit")) {
    throw new Error("The repository list did not discover ShowKit.");
  }
  run([
    "add",
    repositoryRoot,
    "--skill",
    "showkit",
    "--agent",
    "codex",
    "--agent",
    "claude-code",
    "--global",
    "--yes",
    "--copy"
  ]);
  installed = true;

  const installedSkill = await firstExisting([
    path.join(temporaryHome, ".agents", "skills", "showkit", "SKILL.md"),
    path.join(temporaryHome, ".codex", "skills", "showkit", "SKILL.md"),
    path.join(temporaryHome, ".claude", "skills", "showkit", "SKILL.md")
  ]);
  if (!installedSkill) {
    throw new Error("ShowKit was not installed into a supported global skill directory.");
  }

  const listed = JSON.parse(run(["list", "--global", "--json"]));
  if (!JSON.stringify(listed).includes("showkit")) {
    throw new Error("Global skill list did not include ShowKit.");
  }
  run(["update", "showkit", "--global", "--yes"]);
  run(["remove", "showkit", "--global", "--yes"]);
  installed = false;
  const removed = JSON.parse(run(["list", "--global", "--json"]));
  if (JSON.stringify(removed).includes("showkit")) {
    throw new Error("ShowKit remained globally installed after removal.");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      scope: "global",
      installedAgents: ["codex", "claude-code"],
      documentedHosts: [
        "codex",
        "chatgpt",
        "claude-code",
        "claude-app"
      ],
      lifecycle: ["discover", "install", "list", "update", "remove"]
    })}\n`
  );
} finally {
  try {
    if (installed) {
      run(["remove", "showkit", "--global", "--yes"]);
    }
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}
