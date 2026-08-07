import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const packageRoot = path.join(repositoryRoot, "packages", "cli");
const sourcePackage = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8")
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "showkit-package-smoke-")
);
const packDirectory = path.join(temporaryRoot, "pack");
const installDirectory = path.join(temporaryRoot, "install");
const temporaryHome = path.join(temporaryRoot, "home");
const copiedSkillRoot = path.join(
  temporaryHome,
  ".agents",
  "skills",
  "showkit"
);
const smokeEnvironment = {
  ...process.env,
  HOME: temporaryHome,
  USERPROFILE: temporaryHome,
  npm_config_cache: path.join(temporaryRoot, "npm-cache"),
  SHOWKIT_PROJECT_ROOT: installDirectory
};

function run(command, args, cwd = installDirectory) {
  return runExpecting(command, args, 0, cwd);
}

function runExpecting(
  command,
  args,
  expectedStatus,
  cwd = installDirectory
) {
  const result = spawnSync(command, args, {
    cwd,
    env: smokeEnvironment,
    encoding: "utf8"
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}.\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function scene(stepId, label, terminal = false) {
  const anchorId = `sk-${stepId}`;
  return {
    html: terminal
      ? `<main data-showkit-scene-root=""><h1>${label}</h1></main>`
      : `<main data-showkit-scene-root=""><button role="button" data-showkit-anchor="${anchorId}">${label}</button></main>`,
    nodes: [
      {
        type: "element",
        tag: "main",
        attributes: { "data-showkit-scene-root": "" },
        styles: {},
        children: terminal
          ? [
              {
                type: "element",
                tag: "h1",
                attributes: {},
                styles: {},
                children: [{ type: "text", text: label }]
              }
            ]
          : [
              {
                type: "element",
                tag: "button",
                attributes: {
                  role: "button",
                  "data-showkit-anchor": anchorId
                },
                styles: {},
                children: [{ type: "text", text: label }]
              }
            ]
      }
    ],
    viewport: { width: 1280, height: 720 },
    ...(terminal
      ? {}
      : {
          anchorId,
          target: {
            tag: "button",
            role: "button",
            name: label,
            bounds: {
              x: 0.1,
              y: 0.1,
              width: 0.2,
              height: 0.08
            }
          }
        })
  };
}

async function previewSmoke(cliPath) {
  const child = spawn(process.execPath, [cliPath, "preview", "--json"], {
    cwd: installDirectory,
    env: smokeEnvironment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Preview did not become ready.\n${stdout}\n${stderr}`
          )
        );
      }, 10_000);
      const poll = () => {
        const line = stdout.split("\n").find((candidate) => candidate.trim());
        if (line) {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (child.exitCode !== null) {
          clearTimeout(timeout);
          reject(
            new Error(
              `Preview exited ${child.exitCode}.\n${stdout}\n${stderr}`
            )
          );
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
    if (
      !result.ok ||
      result.status !== "ready" ||
      result.published !== false
    ) {
      throw new Error("Packed CLI preview returned an invalid status.");
    }
    const response = await fetch(result.url);
    const body = await response.text();
    if (!response.ok || !body.includes('id="scene-viewport"')) {
      throw new Error("Packed CLI preview did not serve the built demo.");
    }
    return result.url;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", resolve);
    });
  }
}

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(path.dirname(copiedSkillRoot), { recursive: true }),
    mkdir(temporaryHome, { recursive: true })
  ]);
  await cp(path.join(repositoryRoot, "skills", "showkit"), copiedSkillRoot, {
    recursive: true
  });
  const rootReadme = await readFile(
    path.join(repositoryRoot, "README.md"),
    "utf8"
  );
  const quickStartSection = rootReadme
    .split("## Quick start")[1]
    ?.split("## What you can build")[0] ?? "";
  const quickStartContract = quickStartSection
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const requirement of [
    "npx skills add hyunghwan/showkit",
    "Claude Cowork",
    "Customize → Plugins",
    "instructions only",
    "not the CLI",
    "Read and follow the installed `SKILL.md`",
    "What product URL or currently open product flow should I use?",
    "compatible CLI in a new folder",
    "required approvals",
    "Use ShowKit for this site",
    "flow is open in Chrome",
    "interactive HTML demo",
    "@showkit/cli",
    "new output folder",
    "existing project",
    "optional Playwright or a browser",
    "Do not publish",
    "opens the local preview",
    "A local preview is not published"
  ]) {
    if (!quickStartContract.includes(requirement)) {
      throw new Error(
        `README quick start is missing ${requirement}.`
      );
    }
  }
  for (const duplicatedSkillDetail of [
    "disposable reconnaissance browser script",
    "retained foreground process",
    "same context alive from the single sign-in through capture"
  ]) {
    if (quickStartContract.includes(duplicatedSkillDetail)) {
      throw new Error(
        `README quick start duplicates skill detail ${duplicatedSkillDetail}.`
      );
    }
  }

  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      packageRoot
    )
  );
  const packedFiles = new Set(
    packed[0].files.map((entry) => entry.path)
  );
  for (const required of [
    "LICENSE",
    "README.md",
    "dist/bin.js",
    "dist/index.js",
    "dist/playwright.js",
    "dist/schema/artifact-manifest.json",
    "dist/schema/freshness-report.json",
    "package.json"
  ]) {
    if (!packedFiles.has(required)) {
      throw new Error(`Packed CLI is missing ${required}.`);
    }
  }
  const forbiddenPackedFile = [...packedFiles].find(
    (entry) =>
      entry.startsWith("src/") ||
      entry.includes("test-results") ||
      entry.includes(".showkit") ||
      entry === "tsconfig.json"
  );
  if (forbiddenPackedFile) {
    throw new Error(
      `Packed CLI contains a source-only file: ${forbiddenPackedFile}.`
    );
  }

  const tarball = path.join(packDirectory, packed[0].filename);
  await writeFile(
    path.join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "showkit-clean-install-smoke",
        private: true,
        type: "module"
      },
      null,
      2
    )}\n`
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball
  ]);

  const cliPath = path.join(
    installDirectory,
    "node_modules",
    "@showkit",
    "cli",
    "dist",
    "bin.js"
  );
  const help = JSON.parse(
    run(process.execPath, [cliPath, "help", "--json"])
  );
  if (
    !help.ok ||
    !help.commands?.includes(
      "showkit capture static <safe-envelope.json> --json"
    )
  ) {
    throw new Error("Packed CLI help contract is incomplete.");
  }
  try {
    await access(
      path.join(
        installDirectory,
        "node_modules",
        "@playwright",
        "test",
        "package.json"
      )
    );
    throw new Error(
      "The primary clean install pulled in optional Playwright."
    );
  } catch (error) {
    if (
      error?.code !== "ENOENT" &&
      !String(error?.message).includes("pulled in optional Playwright")
    ) {
      throw error;
    }
    if (String(error?.message).includes("pulled in optional Playwright")) {
      throw error;
    }
  }

  const conformance = JSON.parse(
    run(process.execPath, [
      path.join(copiedSkillRoot, "scripts", "conformance.mjs")
    ])
  );
  if (!conformance.ok) {
    throw new Error("The copied ShowKit skill failed conformance.");
  }
  const doctor = JSON.parse(
    run(process.execPath, [cliPath, "doctor", "--json"])
  );
  if (
    !doctor.ok ||
    doctor.status !== "cli-ready" ||
    doctor.checks?.skill?.scope !== "global" ||
    doctor.checks?.skill?.passed !== true ||
    doctor.checks?.staticSource?.passed !== true ||
    doctor.checks?.browserSession?.passed !== false ||
    doctor.checks?.playwright?.installed !== false
  ) {
    throw new Error(
      "Packed CLI doctor did not report the clean environment truthfully."
    );
  }
  const unavailablePlaywrightDoctor = JSON.parse(
    runExpecting(
      process.execPath,
      [cliPath, "doctor", "--capability", "playwright", "--json"],
      3
    )
  );
  if (
    unavailablePlaywrightDoctor.error?.code !== "DependencyMissing" ||
    unavailablePlaywrightDoctor.error?.details?.playwright?.detected !==
      "not installed"
  ) {
    throw new Error(
      "Packed CLI did not fail the unavailable Playwright capability check truthfully."
    );
  }
  const initialized = JSON.parse(
    run(process.execPath, [cliPath, "init", "--json"])
  );
  if (!initialized.ok || initialized.status !== "created") {
    throw new Error("Packed CLI could not initialize a clean project.");
  }

  const copiedBridge = await import(
    `${pathToFileURL(
      path.join(
        copiedSkillRoot,
        "scripts",
        "capture-browser-session.mjs"
      )
    ).href}?smoke=${Date.now()}`
  );
  let browserUrl = "https://app.example.test/dashboard";
  const browserSteps = ["Overview", "Reports", "Settings"].map(
    (label, index) => ({
      id: `browser-step-${index + 1}`,
      title: `Open ${label}`,
      target: {
        strategy: "role",
        role: "button",
        name: label
      },
      actionKind: "select"
    })
  );
  const browserAdapter = {
    browserSurface: "iab",
    browserName: "Codex Browser smoke",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "UTC",
    authenticated: true,
    hasDomAccess: true,
    captureSecurity: {
      provider: "openai-browser",
      verified: true,
      executionWorld: "isolated-readonly-v1",
      pluginVersion: "smoke",
      implementationHash: "smoke"
    },
    async currentUrl() {
      return browserUrl;
    },
    async isAlive() {
      return true;
    },
    async domSnapshot() {
      return "untrusted planning-only snapshot";
    },
    async targetStatus() {
      return { matchedCount: 1, visibleCount: 1 };
    },
    async targetCount() {
      return 1;
    },
    async targetVisible() {
      return true;
    },
    async evaluateTarget(target, _pageFunction, options) {
      return {
        ok: true,
        scanOnly: false,
        html: scene(options.anchorId.slice(3), target.name).html,
        nodes: scene(options.anchorId.slice(3), target.name).nodes,
        viewport: { width: 1280, height: 720 },
        target: {
          tag: "button",
          role: "button",
          name: target.name,
          bounds: {
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.08
          }
        },
        evidenceTexts: [target.name],
        assetPayloads: [],
        fontFaces: [],
        excludedSurfaces: [
          "browser-storage",
          "network-data",
          "remote-assets"
        ]
      };
    },
    async performAction(_target, _actionKind) {
      browserUrl = "https://app.example.test/dashboard";
    },
    async evaluateTerminal() {
      const terminal = scene("terminal", "Dashboard ready", true);
      return {
        ok: true,
        scanOnly: false,
        ...terminal,
        evidenceTexts: [],
        assetPayloads: [],
        fontFaces: [],
        excludedSurfaces: [
          "browser-storage",
          "network-data",
          "remote-assets"
        ]
      };
    },
    async cleanup() {}
  };
  const browserCapture = await copiedBridge.captureBrowserSession({
    adapter: browserAdapter,
    sourceHost: "codex",
    expectedViewport: { width: 1280, height: 720 },
    url: browserUrl,
    id: "copied-skill-smoke",
    steps: browserSteps,
    projectRoot: installDirectory
  });
  const importedBrowserCapture = JSON.parse(
    run(process.execPath, [cliPath, ...browserCapture.importCommand.slice(1)])
  );
  if (
    importedBrowserCapture.sourceMode !== "agent-browser-session" ||
    importedBrowserCapture.replayLevel !== "session-captured"
  ) {
    throw new Error(
      "The copied skill did not resolve the project CLI browser-session path."
    );
  }

  const installedCli = await import(
    `${pathToFileURL(
      path.join(
        installDirectory,
        "node_modules",
        "@showkit",
        "cli",
        "dist",
        "index.js"
      )
    ).href}?smoke=${Date.now()}`
  );
  const fixturePath = path.join(installDirectory, "static-proof.html");
  const fixtureContents =
    '<main><button>Overview</button><button>Reports</button><button>Settings</button></main>\n';
  await writeFile(fixturePath, fixtureContents);
  const staticSteps = ["Overview", "Reports", "Settings"].map(
    (label, index) => {
      const id = `static-step-${index + 1}`;
      return {
        id,
        title: `Open ${label}`,
        target: {
          strategy: "role",
          role: "button",
          name: label
        },
        actionKind: "select",
        scene: scene(id, label),
        evidence: [{ id: `ev-${id}`, text: label }],
        actionOutcome: {
          url: "https://app.example.test/static-proof",
          title: label
        }
      };
    }
  );
  const staticEnvelope = installedCli.createStaticCaptureEnvelope({
    id: "static-clean-install",
    baseURL: "https://app.example.test",
    startPath: "/static-proof",
    viewport: { width: 1280, height: 720 },
    sourceFiles: [
      {
        path: "static-proof.html",
        sha256: sha256(fixtureContents)
      }
    ],
    generatorVersion: "0.1.0",
    steps: staticSteps,
    terminalScene: scene("terminal", "Static demo ready", true)
  });
  const staticEnvelopePath = path.join(
    installDirectory,
    "static-envelope.json"
  );
  await writeFile(
    staticEnvelopePath,
    `${JSON.stringify(staticEnvelope)}\n`
  );
  const staticCapture = JSON.parse(
    run(process.execPath, [
      cliPath,
      "capture",
      "static",
      staticEnvelopePath,
      "--json"
    ])
  );
  if (
    staticCapture.sourceMode !== "static-source" ||
    staticCapture.replayLevel !== "source-derived"
  ) {
    throw new Error(
      "The packed CLI did not complete Playwright-free static capture."
    );
  }
  const story = {
    schemaVersion: "0.1",
    id: "static-clean-install-story",
    sourceCaptureId: staticCapture.captureId,
    title: "Static source proof",
    audience: "ShowKit package smoke",
    goal: "Verify the Playwright-free local demo path.",
    steps: staticSteps.map((step) => ({
      id: `story-${step.id}`,
      captureStepId: step.id,
      anchorId: `sk-${step.id}`,
      tooltip: {
        title: step.title,
        body: `${step.target.name} is present in the bound static source.`,
        placement: "auto",
        backdrop: "off"
      },
      evidenceIds: [step.evidence[0].id],
      advance: "next"
    })),
    formats: ["web", "markdown"]
  };
  const storyPath = path.join(installDirectory, "story.json");
  await writeFile(storyPath, `${JSON.stringify(story)}\n`);
  const applied = JSON.parse(
    run(process.execPath, [
      cliPath,
      "story",
      "apply",
      storyPath,
      "--json"
    ])
  );
  const validated = JSON.parse(
    run(process.execPath, [cliPath, "validate", "--json"])
  );
  const built = JSON.parse(
    run(process.execPath, [
      cliPath,
      "build",
      "web,markdown",
      "--json"
    ])
  );
  if (!applied.ok || !validated.ok || !built.ok) {
    throw new Error(
      "The packed CLI did not complete the Playwright-free demo build."
    );
  }
  const previewUrl = await previewSmoke(cliPath);

  run(process.execPath, [
    "--input-type=module",
    "-e",
    'const root = await import("@showkit/cli"); if (!root.StorySpecSchema || !root.createStaticCaptureEnvelope) process.exit(1);'
  ]);
  for (const schema of [
    "artifact-manifest.json",
    "capture-source.json",
    "browser-flow-recipe.json",
    "demo-fixture.json",
    "freshness-report.json",
    "run-envelope.json",
    "session-capture-envelope.json",
    "skill-compatibility.json",
    "story-spec.json"
  ]) {
    await access(
      path.join(
        installDirectory,
        "node_modules",
        "@showkit",
        "cli",
        "dist",
        "schema",
        schema
      )
    );
  }
  const freshnessSchemaPath = path.join(
    installDirectory,
    "node_modules",
    "@showkit",
    "cli",
    "dist",
    "schema",
    "freshness-report.json"
  );
  const captureSourceSchema = JSON.parse(
    await readFile(
      path.join(
        installDirectory,
        "node_modules",
        "@showkit",
        "cli",
        "dist",
        "schema",
        "capture-source.json"
      ),
      "utf8"
    )
  );
  if (
    captureSourceSchema.properties?.steps?.uniqueItems !== true ||
    captureSourceSchema.properties?.steps?.["x-showkit-uniqueBy"] !== "id"
  ) {
    throw new Error(
      "Packed capture JSON Schema does not declare unique capture step IDs."
    );
  }
  const validateFreshnessSchema = new Ajv2020({ allErrors: true }).compile(
    JSON.parse(await readFile(freshnessSchemaPath, "utf8"))
  );
  const hash = "a".repeat(64);
  const freshReport = {
    schemaVersion: "0.1",
    status: "fresh",
    previousDemoChanged: false,
    baseVersion: hash,
    baseSourceHash: hash,
    currentSourceHash: hash,
    steps: [
      {
        stepId: "open-settings",
        title: "Open settings",
        state: "fresh",
        detail: "The step still matches the product."
      }
    ],
    completion: {
      state: "fresh",
      detail: "The final product state still matches the product."
    }
  };
  if (!validateFreshnessSchema(freshReport)) {
    throw new Error(
      `Packed freshness JSON Schema rejected a valid report: ${JSON.stringify(
        validateFreshnessSchema.errors
      )}`
    );
  }
  const invalidFreshnessReports = [
    {
      ...structuredClone(freshReport),
      status: "out-of-date"
    },
    {
      ...structuredClone(freshReport),
      status: "out-of-date",
      steps: [
        {
          stepId: "open-settings",
          title: "Open settings",
          state: "failed",
          code: "SourceSceneChanged",
          detail: "The source scene changed."
        }
      ]
    },
    {
      schemaVersion: "0.1",
      status: "blocked",
      previousDemoChanged: false,
      baseVersion: hash,
      baseSourceHash: hash,
      steps: [
        {
          stepId: "open-settings",
          title: "Open settings",
          state: "skipped",
          detail: "The step was not checked."
        }
      ],
      completion: {
        state: "skipped",
        detail: "The final state was not checked."
      }
    },
    {
      schemaVersion: "0.1",
      status: "blocked",
      previousDemoChanged: false,
      baseVersion: hash,
      baseSourceHash: hash,
      currentSourceHash: hash,
      steps: [
        {
          stepId: "open-settings",
          title: "Open settings",
          state: "failed",
          code: "DemoFixtureSetupFailed",
          detail: "The source flow stopped.",
          recovery: "Fix the flow."
        }
      ],
      completion: {
        state: "skipped",
        detail: "The final state was not checked."
      }
    }
  ];
  for (const invalidReport of invalidFreshnessReports) {
    if (validateFreshnessSchema(invalidReport)) {
      throw new Error(
        "Packed freshness JSON Schema accepted a contradictory report."
      );
    }
  }
  const packedPackage = JSON.parse(
    await readFile(
      path.join(
        installDirectory,
        "node_modules",
        "@showkit",
        "cli",
        "package.json"
      ),
      "utf8"
    )
  );
  if (
    packedPackage.name !== sourcePackage.name ||
    packedPackage.version !== sourcePackage.version
  ) {
    throw new Error(
      `Packed package identity changed: expected ${sourcePackage.name}@${sourcePackage.version}.`
    );
  }
  if (
    packedPackage.peerDependencies?.["@playwright/test"] !==
    ">=1.60.0 <2"
  ) {
    throw new Error("Packed Playwright peer range changed.");
  }
  if (
    packedPackage.peerDependenciesMeta?.["@playwright/test"]?.optional !==
    true
  ) {
    throw new Error("Packed Playwright peer must remain optional.");
  }
  await access(
    path.join(
      installDirectory,
      "node_modules",
      "@showkit",
      "cli",
      "LICENSE"
    )
  );

  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "@playwright/test@1.62.0"
  ]);
  const { chromium: workspaceChromium } = await import("@playwright/test");
  const workspaceBrowserExecutable = workspaceChromium.executablePath();
  const browserRevisionIndex = workspaceBrowserExecutable
    .split(path.sep)
    .findIndex((segment) => /^chromium-\d+$/.test(segment));
  if (browserRevisionIndex < 0) {
    throw new Error(
      "Could not locate the workspace Playwright browser cache for the available capability check."
    );
  }
  smokeEnvironment.PLAYWRIGHT_BROWSERS_PATH =
    workspaceBrowserExecutable
      .split(path.sep)
      .slice(0, browserRevisionIndex)
      .join(path.sep) || path.parse(workspaceBrowserExecutable).root;
  const availablePlaywrightDoctor = JSON.parse(
    run(process.execPath, [
      cliPath,
      "doctor",
      "--capability",
      "playwright",
      "--json"
    ])
  );
  if (
    availablePlaywrightDoctor.status !== "capture-ready" ||
    availablePlaywrightDoctor.checks?.playwright?.available !== true ||
    availablePlaywrightDoctor.checks?.chromium?.installed !== true
  ) {
    throw new Error(
      "Packed CLI did not pass the available Playwright capability check."
    );
  }
  run(process.execPath, [
    "--input-type=module",
    "-e",
    'const fixture = await import("@showkit/cli/playwright"); if (!fixture.test) process.exit(1);'
  ]);
  const consumerPackagePath = path.join(installDirectory, "package.json");
  await writeFile(
    consumerPackagePath,
    `${JSON.stringify(
      {
        name: "showkit-clean-install-smoke",
        private: true,
        type: "commonjs"
      },
      null,
      2
    )}\n`
  );
  const commonJsSpec = path.join(installDirectory, "commonjs.spec.ts");
  await writeFile(
    commonJsSpec,
    'import { test } from "@showkit/cli/playwright";\ntest("loads the fixture", async () => {});\n'
  );
  const commonJsPreflight = JSON.parse(
    run(process.execPath, [
      cliPath,
      "capture",
      commonJsSpec,
      "--preflight",
      "--json"
    ])
  );
  if (
    commonJsPreflight.status !== "source-ready" ||
    commonJsPreflight.browserLaunchRequested !== false
  ) {
    throw new Error("Packed CLI did not preflight a CommonJS Playwright consumer.");
  }
  const undiscoverableSource = path.join(
    installDirectory,
    "temporary-live.demo.ts"
  );
  await writeFile(
    undiscoverableSource,
    'import { test } from "@showkit/cli/playwright";\ntest("is intentionally undiscoverable", async () => {});\n'
  );
  const undiscoverablePreflight = JSON.parse(
    runExpecting(
      process.execPath,
      [
        cliPath,
        "capture",
        undiscoverableSource,
        "--preflight",
        "--json"
      ],
      2
    )
  );
  if (
    undiscoverablePreflight.error?.code !== "DemoFixtureSetupFailed" ||
    !undiscoverablePreflight.error?.recovery?.includes("*.spec.ts")
  ) {
    throw new Error(
      `Packed CLI did not explain how to recover from an undiscoverable Playwright source. ${JSON.stringify(undiscoverablePreflight)}`
    );
  }
  run(process.execPath, [
    "-e",
    'const fixture = require("@showkit/cli/playwright"); if (!fixture.test) process.exit(1);'
  ]);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      package: `${packedPackage.name}@${packedPackage.version}`,
      tarball,
      cleanHome: true,
      copiedSkill: true,
      readmeQuickStartContractChecked: true,
      localEquivalentLifecycleCompleted: true,
      commands: [
        "help",
        "doctor",
        "init",
        "capture preflight",
        "capture session",
        "capture static",
        "story apply",
        "validate",
        "build",
        "preview"
      ],
      previewUrl,
      exports: [".", "./playwright", "./schema/*"],
      playwrightCapabilityChecks: ["unavailable", "available"],
      playwrightRequiredForPrimaryInstall: false
    })}\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
