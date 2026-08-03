import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "packages", "cli", "dist", "bin.js");
const temporaryProject = await mkdtemp(path.join(os.tmpdir(), "showkit-skill-lifecycle-"));
const temporarySource = await mkdtemp(path.join(os.tmpdir(), "showkit-skill-source-"));
const temporaryRemoteRoot = await mkdtemp(path.join(os.tmpdir(), "showkit-skill-remote-"));
const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "showkit-skill-home-"));
const temporaryRemote = path.join(temporaryRemoteRoot, "showkit.git");
await cp(
  path.join(repositoryRoot, "skills"),
  path.join(temporarySource, "skills"),
  { recursive: true }
);

function run(
  command,
  args,
  options = {}
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? temporaryProject,
    env: {
      ...process.env,
      ...(options.environment ?? {})
    },
    encoding: "utf8"
  });
  const expectedExitCode = options.expectedExitCode ?? 0;
  if (result.status !== expectedExitCode) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}.\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported host location.
    }
  }
  return undefined;
}

try {
  run("git", ["init"], { cwd: temporarySource });
  run("git", ["add", "skills"], { cwd: temporarySource });
  run(
    "git",
    [
      "-c",
      "user.name=ShowKit Test",
      "-c",
      "user.email=showkit-test@example.invalid",
      "commit",
      "-m",
      "Initial skill"
    ],
    { cwd: temporarySource }
  );
  run("git", ["init", "--bare", temporaryRemote], { cwd: temporaryRemoteRoot });
  run("git", ["remote", "add", "origin", temporaryRemote], { cwd: temporarySource });
  run("git", ["push", "-u", "origin", "HEAD:master"], { cwd: temporarySource });
  const skillSource = pathToFileURL(temporaryRemote).href;
  const discovery = run("npx", ["--yes", "skills", "add", skillSource, "--list"]);
  if (!discovery.includes("showkit")) {
    throw new Error("Skills CLI did not discover the ShowKit skill.");
  }

  run("npx", [
    "--yes",
    "skills",
    "add",
    skillSource,
    "--skill",
    "showkit",
    "--agent",
    "codex",
    "--agent",
    "claude-code",
    "--yes",
    "--copy"
  ]);
  const installedSkill = await firstExisting([
    path.join(temporaryProject, ".agents", "skills", "showkit", "SKILL.md"),
    path.join(temporaryProject, ".codex", "skills", "showkit", "SKILL.md"),
    path.join(temporaryProject, ".claude", "skills", "showkit", "SKILL.md")
  ]);
  if (!installedSkill) {
    throw new Error("ShowKit was not installed into a supported project skill directory.");
  }
  const installedRoot = path.dirname(installedSkill);
  const conformance = JSON.parse(
    run(process.execPath, [path.join(installedRoot, "scripts", "conformance.mjs")]).trim()
  );
  if (
    !conformance.ok ||
    conformance.installTestedAgents?.join(",") !==
      "codex,claude-code" ||
    conformance.documentedHosts?.length !== 4
  ) {
    throw new Error("Installed skill conformance failed.");
  }

  const list = JSON.parse(
    run("npx", ["--yes", "skills", "list", "--json"])
  );
  if (!JSON.stringify(list).includes("showkit")) {
    throw new Error("Project skill list did not include ShowKit.");
  }

  const doctorEnvironment = {
    SHOWKIT_PROJECT_ROOT: temporaryProject,
    HOME: temporaryHome,
    USERPROFILE: temporaryHome
  };
  const readyDoctor = JSON.parse(
    run(process.execPath, [cliPath, "doctor", "--json"], {
      environment: doctorEnvironment
    }).trim()
  );
  if (!readyDoctor.checks?.skill?.compatible) {
    throw new Error("Doctor did not accept the installed skill compatibility range.");
  }

  const compatibilityPath = path.join(installedRoot, "compatibility.json");
  const originalCompatibility = await readFile(compatibilityPath, "utf8");
  const incompatible = JSON.parse(originalCompatibility);
  incompatible.cli = ">=9 <10";
  const globalSkillRoot = path.join(
    temporaryHome,
    ".agents",
    "skills",
    "showkit"
  );
  await mkdir(globalSkillRoot, { recursive: true });
  await writeFile(
    path.join(globalSkillRoot, "compatibility.json"),
    `${JSON.stringify(incompatible, null, 2)}\n`
  );
  const projectPrecedenceDoctor = JSON.parse(
    run(process.execPath, [cliPath, "doctor", "--json"], {
      environment: doctorEnvironment
    }).trim()
  );
  if (
    projectPrecedenceDoctor.checks?.skill?.scope !== "project" ||
    !projectPrecedenceDoctor.checks?.skill?.compatible
  ) {
    throw new Error(
      "Doctor did not prefer the compatible project skill over a stale global skill."
    );
  }

  const mismatchSkillRoot = path.join(
    temporaryProject,
    ".codex",
    "skills",
    "showkit"
  );
  await mkdir(mismatchSkillRoot, { recursive: true });
  await writeFile(
    path.join(mismatchSkillRoot, "compatibility.json"),
    `${JSON.stringify(incompatible, null, 2)}\n`
  );
  const mismatchDoctor = JSON.parse(
    run(process.execPath, [cliPath, "doctor", "--json"], {
      environment: doctorEnvironment,
      expectedExitCode: 3
    }).trim()
  );
  if (
    mismatchDoctor.error?.code !== "DependencyMissing" ||
    !mismatchDoctor.error?.recovery?.includes("@showkit/cli")
  ) {
    throw new Error("Doctor did not return an exact CLI mismatch recovery command.");
  }
  await rm(mismatchSkillRoot, { recursive: true, force: true });

  const updatedSourceCompatibility = JSON.parse(originalCompatibility);
  updatedSourceCompatibility.cli = ">=0.1.0 <0.3.0";
  await writeFile(
    path.join(temporarySource, "skills", "showkit", "compatibility.json"),
    `${JSON.stringify(updatedSourceCompatibility, null, 2)}\n`
  );
  run("git", ["add", "skills/showkit/compatibility.json"], { cwd: temporarySource });
  run(
    "git",
    [
      "-c",
      "user.name=ShowKit Test",
      "-c",
      "user.email=showkit-test@example.invalid",
      "commit",
      "-m",
      "Update compatibility"
    ],
    { cwd: temporarySource }
  );
  run("git", ["push", "origin", "HEAD:master"], { cwd: temporarySource });
  const updateOutput = run("npx", [
    "--yes",
    "skills",
    "update",
    "showkit",
    "--project",
    "--yes"
  ]);
  const compatibilityAfterUpdate = JSON.parse(
    await readFile(compatibilityPath, "utf8")
  );
  if (compatibilityAfterUpdate.cli !== ">=0.1.0 <0.3.0") {
    throw new Error(`Skills CLI did not refresh the installed copy.\n${updateOutput}`);
  }
  const updatedDoctor = JSON.parse(
    run(process.execPath, [cliPath, "doctor", "--json"], {
      environment: doctorEnvironment
    }).trim()
  );
  if (!updatedDoctor.checks?.skill?.compatible) {
    throw new Error("Skill update did not restore CLI compatibility.");
  }

  const removeOutput = run("npx", [
    "--yes",
    "skills",
    "remove",
    "--all",
    "--yes"
  ]);
  const removedList = JSON.parse(
    run("npx", ["--yes", "skills", "list", "--json"])
  );
  if (JSON.stringify(removedList).includes("showkit")) {
    throw new Error(
      `ShowKit remained in the project skill list after removal.\n${removeOutput}\n${JSON.stringify(removedList, null, 2)}`
    );
  }
  await writeFile(
    path.join(globalSkillRoot, "compatibility.json"),
    "{ invalid compatibility\n"
  );
  const globalMismatchDoctor = JSON.parse(
    run(process.execPath, [cliPath, "doctor", "--json"], {
      environment: doctorEnvironment,
      expectedExitCode: 3
    }).trim()
  );
  if (
    globalMismatchDoctor.error?.code !== "DependencyMissing" ||
    !globalMismatchDoctor.error?.recovery?.includes("--global")
  ) {
    throw new Error(
      `Doctor did not return a global-scope recovery command for the remaining global skill.\n${JSON.stringify(globalMismatchDoctor, null, 2)}`
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      scope: "project",
      installedAgents: ["codex", "claude-code"],
      documentedHosts: [
        "codex",
        "chatgpt",
        "claude-code",
        "claude-app"
      ],
      lifecycle: [
        "discover",
        "install",
        "list",
        "project-precedence",
        "mismatch",
        "update",
        "remove",
        "global-recovery"
      ]
    })}\n`
  );
} finally {
  await Promise.all([
    rm(temporaryProject, { recursive: true, force: true }),
    rm(temporarySource, { recursive: true, force: true }),
    rm(temporaryRemoteRoot, { recursive: true, force: true }),
    rm(temporaryHome, { recursive: true, force: true })
  ]);
}
