import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildDemo } from "./build/build.js";
import {
  HOSTED_REQUEST_WARNING_BYTES
} from "./hosted/contracts.js";
import {
  commitPublicationReceipt,
  pendingIdempotencyKey
} from "./hosted/receipt.js";
import { createHostedPublishRequest } from "./hosted/request.js";
import type { HostedPublishTransport } from "./hosted/transport.js";
import { commitCaptureEnvelope } from "./capture/session-import.js";
import { validateAgentBrowserCaptureEnvelope } from "./capture/session-envelope.js";
import { validateStaticCaptureEnvelope } from "./capture/static.js";
import { asShowKitError, EXIT_CODES, ShowKitError } from "./core/errors.js";
import {
  CaptureFailureDiagnosticSchema,
  compareCaptureFreshness,
  createBlockedFreshnessReport,
  validateCaptureStepProgress,
  type CaptureStepProgress
} from "./core/freshness.js";
import { contentHash, replaceDirectoryAtomic, sha256, writeJsonAtomic } from "./core/json.js";
import {
  initializeProject,
  loadLatestCapture,
  loadProject,
  loadStoryForCapture,
  pathExists,
  projectRoot,
  saveProject,
  showkitPath
} from "./core/project.js";
import {
  ArtifactManifestSchema,
  CaptureEnvelopeSchema,
  CaptureSourceSchema,
  QualityReportSchema,
  RunEnvelopeSchema,
  SCHEMA_VERSION,
  SkillCompatibilitySchema,
  StorySpecSchema,
  VerificationReportSchema,
  type CaptureSource
} from "./core/schemas.js";
import { containsConfiguredSensitiveText } from "./core/security.js";
import { createEvidenceGroundedStory } from "./core/story.js";
import { validateStory } from "./core/validate.js";
import { satisfiesVersionRange } from "./core/version.js";

const NODE_RANGE = ">=22.12 <25";
const PLAYWRIGHT_RANGE = ">=1.60.0 <2";
const CAPTURE_PROCESS_BUFFER_LIMIT = 10 * 1024 * 1024;
const DEFAULT_CAPTURE_VIEWPORT = { width: 1280, height: 720 } as const;

type BufferedProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

async function runBufferedProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
  }
): Promise<BufferedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceededBuffer = false;
    const collect = (
      chunks: Buffer[],
      chunk: Buffer,
      nextSize: number
    ): number => {
      if (exceededBuffer) return nextSize;
      const size = nextSize + chunk.byteLength;
      if (size > options.maxBuffer) {
        exceededBuffer = true;
        child.kill("SIGTERM");
        return size;
      }
      chunks.push(chunk);
      return size;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderrChunks, chunk, stderrBytes);
    });
    child.once("error", reject);
    child.once("close", (status) => {
      if (exceededBuffer) {
        reject(
          new ShowKitError({
            code: "DemoFixtureSetupFailed",
            message:
              "ShowKit stopped the source flow because its process output exceeded the safety limit. No captured page was saved.",
            exitCode: EXIT_CODES.validation,
            recovery:
              "Remove verbose logging from the source flow, then capture again."
          })
        );
        return;
      }
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8")
      });
    });
  });
}

function captureProgress(message: string): void {
  process.stderr.write(`[ShowKit] ${message}\n`);
}

async function dependencyUpgradeCommand(packageName: string, range: string): Promise<string> {
  if (await pathExists(path.join(projectRoot(), "pnpm-lock.yaml"))) {
    return `pnpm add -D ${packageName}@"${range}"`;
  }
  if (await pathExists(path.join(projectRoot(), "yarn.lock"))) {
    return `yarn add -D ${packageName}@"${range}"`;
  }
  return `npm install -D ${packageName}@"${range}"`;
}

type InstalledSkillCompatibility = {
  compatibility: ReturnType<typeof SkillCompatibilitySchema.parse>;
  path: string;
  scope: "project" | "global";
};

async function installedSkillCompatibility(): Promise<{
  entries: InstalledSkillCompatibility[];
  scope: "project" | "global" | "missing";
}> {
  const candidateGroups = [
    {
      scope: "project" as const,
      paths: [
        path.join(projectRoot(), ".agents", "skills", "showkit", "compatibility.json"),
        path.join(projectRoot(), ".claude", "skills", "showkit", "compatibility.json"),
        path.join(projectRoot(), ".codex", "skills", "showkit", "compatibility.json")
      ]
    },
    {
      scope: "global" as const,
      paths: [
        path.join(os.homedir(), ".agents", "skills", "showkit", "compatibility.json"),
        path.join(os.homedir(), ".claude", "skills", "showkit", "compatibility.json"),
        path.join(os.homedir(), ".codex", "skills", "showkit", "compatibility.json")
      ]
    }
  ];
  for (const group of candidateGroups) {
    const existing = [];
    for (const candidate of group.paths) {
      if (await pathExists(candidate)) existing.push(candidate);
    }
    if (existing.length === 0) continue;
    const entries: InstalledSkillCompatibility[] = [];
    for (const candidate of existing) {
      try {
        entries.push({
          compatibility: SkillCompatibilitySchema.parse(
            JSON.parse(await readFile(candidate, "utf8"))
          ),
          path: candidate,
          scope: group.scope
        });
      } catch {
        throw new ShowKitError({
          code: "DependencyMissing",
          message:
            `The ${group.scope} ShowKit skill has an invalid compatibility file.`,
          exitCode: EXIT_CODES.environment,
          recovery:
            group.scope === "project"
              ? "Run `npx skills update showkit --project --yes`, then run doctor again."
              : "Run `npx skills update showkit --global --yes`, then run doctor again."
        });
      }
    }
    return { entries, scope: group.scope };
  }
  return { entries: [], scope: "missing" };
}

export type CommandResult = Record<string, unknown> & {
  ok: true;
  operationId: string;
  status: string;
};

function operationId(): string {
  return `op-${randomUUID()}`;
}

function lifecycleRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function playwrightProjectArgument(args: string[]): string | undefined {
  if (!args.includes("--project")) return undefined;
  const value = argumentValue(args, "--project");
  if (
    !value ||
    value.startsWith("--") ||
    value.length > 120 ||
    containsConfiguredSensitiveText(value)
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message: "ShowKit could not identify one Playwright project.",
      exitCode: EXIT_CODES.environment,
      recovery:
        "Pass one safe configured project name with `--project <name>`."
    });
  }
  return value;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--json" || value === "--preflight" || value === "--report") continue;
    if (value.startsWith("--")) {
      if (!value.includes("=")) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function captureViewportArgument(
  args: string[],
  fallback: { width: number; height: number } = DEFAULT_CAPTURE_VIEWPORT
): { width: number; height: number } {
  const separated = args.includes("--viewport");
  const inline = args.find((value) => value.startsWith("--viewport="));
  const raw = separated
    ? argumentValue(args, "--viewport")
    : inline?.slice("--viewport=".length);
  if (!separated && inline === undefined) return { ...fallback };
  const match = typeof raw === "string"
    ? /^(\d{1,4})x(\d{1,4})$/i.exec(raw)
    : null;
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !match ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The capture viewport must use WIDTHxHEIGHT CSS pixels. No browser was opened and no captured page was saved.",
      exitCode: EXIT_CODES.validation,
      recovery:
        "Use `--viewport 1280x720`, or pass the exact requested or existing-demo viewport."
    });
  }
  return { width, height };
}

async function recordOperation(summary: {
  operationId: string;
  command: string;
  status: "ok" | "error";
  code?: string;
}): Promise<void> {
  if (!(await pathExists(showkitPath("project.json")))) return;
  await mkdir(showkitPath("logs"), { recursive: true });
  await appendFile(
    showkitPath("logs", "operations.ndjson"),
    `${JSON.stringify({ ...summary, recordedAt: new Date().toISOString() })}\n`
  );
}

export async function doctorCommand(args: string[] = []): Promise<CommandResult> {
  const id = operationId();
  const require = createRequire(import.meta.url);
  const requestedCapability = argumentValue(args, "--capability");
  const supportedCapabilities = new Set([
    "static",
    "playwright",
    "openai-browser",
    "codex-browser",
    "claude-browser"
  ]);
  if (
    requestedCapability !== undefined &&
    !supportedCapabilities.has(requestedCapability)
  ) {
    throw new ShowKitError({
      code: "DependencyMissing",
      message: "ShowKit does not recognize the requested capability.",
      exitCode: EXIT_CODES.environment,
      recovery:
        "Use `showkit doctor --json` or choose static, openai-browser, codex-browser, claude-browser, or playwright."
    });
  }
  const playwrightRequired = requestedCapability === "playwright";
  const browserChannel = argumentValue(args, "--browser-channel") ?? "chromium";
  if (browserChannel !== "chromium" && browserChannel !== "chrome") {
    throw new ShowKitError({
      code: "DependencyMissing",
      message: "ShowKit does not recognize the requested Playwright browser channel.",
      exitCode: EXIT_CODES.environment,
      recovery:
        "Use `--browser-channel chromium` for bundled Chromium or `--browser-channel chrome` for installed Google Chrome."
    });
  }
  const cliPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };
  let playwrightVersion: string | undefined;
  let playwrightInstalled = false;
  let browserInstalled = false;
  let bundledChromiumInstalled = false;
  let systemChromeInstalled = false;
  try {
    const packagePath = require.resolve("@playwright/test/package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version: string };
    playwrightVersion = packageJson.version;
    playwrightInstalled = true;
    const { chromium } = await import("@playwright/test");
    if (browserChannel === "chrome") {
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      await browser.close();
      systemChromeInstalled = true;
    } else {
      const browserPath = chromium.executablePath();
      await access(browserPath);
      bundledChromiumInstalled = true;
    }
    browserInstalled = true;
  } catch {
    // Playwright is optional. Its explicit capability check fails below with a
    // recovery action when the package, version, or browser is unavailable.
  }
  const nodeSupported = satisfiesVersionRange(process.version, NODE_RANGE);
  const playwrightSupported =
    playwrightVersion !== undefined &&
    satisfiesVersionRange(playwrightVersion, PLAYWRIGHT_RANGE);
  const playwrightReady =
    playwrightInstalled && playwrightSupported && browserInstalled;
  if (!nodeSupported || (playwrightRequired && !playwrightReady)) {
    const playwrightRecovery = !playwrightInstalled
      ? "Install `@playwright/test` in this project, then install Chromium."
      : !playwrightSupported
        ? `Install \`@playwright/test@${PLAYWRIGHT_RANGE}\`. Detected ${playwrightVersion}.`
        : browserChannel === "chrome"
          ? "Install Google Chrome, or run `pnpm exec playwright install chromium` and retry without `--browser-channel chrome`."
          : "Run `pnpm exec playwright install chromium`.";
    throw new ShowKitError({
      code: "DependencyMissing",
      message: !nodeSupported
        ? "ShowKit found an unsupported Node.js version."
        : "ShowKit could not find a supported Playwright capture runtime.",
      exitCode: EXIT_CODES.environment,
      recovery: !nodeSupported
        ? `Use Node.js ${NODE_RANGE}. Detected ${process.version}.`
        : playwrightRecovery,
      details: {
        node: { detected: process.version, supported: NODE_RANGE },
        playwright: {
          detected: playwrightVersion ?? "not installed",
          supported: PLAYWRIGHT_RANGE,
          browserInstalled,
          browserChannel
        }
      }
    });
  }
  const skill = await installedSkillCompatibility();
  const incompatibleSkill = skill.entries.find(
    ({ compatibility }) =>
      !satisfiesVersionRange(cliPackage.version, compatibility.cli) ||
      !satisfiesVersionRange(process.version, compatibility.node) ||
      ((playwrightRequired || compatibility.playwrightRequired) &&
        (!playwrightVersion ||
          !satisfiesVersionRange(
            playwrightVersion,
            compatibility.playwright
          )))
  );
  if (incompatibleSkill) {
    const compatibility = incompatibleSkill.compatibility;
    const recovery = !satisfiesVersionRange(process.version, compatibility.node)
      ? `Use Node.js "${compatibility.node}". Detected ${process.version}.`
      : (playwrightRequired || compatibility.playwrightRequired) &&
          (!playwrightVersion ||
            !satisfiesVersionRange(
              playwrightVersion,
              compatibility.playwright
            ))
        ? await dependencyUpgradeCommand(
            "@playwright/test",
            compatibility.playwright
          )
        : await dependencyUpgradeCommand("@showkit/cli", compatibility.cli);
    throw new ShowKitError({
      code: "DependencyMissing",
      message: "The installed ShowKit skill and project runtime versions do not match.",
      exitCode: EXIT_CODES.environment,
      recovery,
      details: {
        scope: incompatibleSkill.scope,
        path: incompatibleSkill.path,
        cli: { detected: cliPackage.version, supported: compatibility.cli },
        playwright: {
          detected: playwrightVersion ?? "not installed",
          supported: compatibility.playwright,
          required: playwrightRequired || compatibility.playwrightRequired
        },
        node: { detected: process.version, supported: compatibility.node }
      }
    });
  }

  const projectInitialized = await pathExists(showkitPath("project.json"));
  const skillInstalled = skill.entries.length > 0;
  const skillRecovery =
    "For Codex or Claude Code, run `npx skills add hyunghwan/showkit --skill showkit --agent codex --agent claude-code --global --yes --copy`. For Claude Cowork, add the `hyunghwan/showkit` marketplace in Customize > Plugins and install ShowKit. Then start a new agent task.";
  const checks = {
    node: { passed: nodeSupported, version: process.version, supported: NODE_RANGE },
    staticSource: {
      passed: nodeSupported,
      available: nodeSupported,
      requiresPlaywright: false,
      replayLevel: "source-derived"
    },
    browserSession: {
      passed: false,
      available: false,
      requiresPlaywright: false,
      verification: "host-session-required",
      recovery:
        "Run the ShowKit host-isolation verification from the installed skill in the selected ChatGPT or Codex Browser or Chrome session."
    },
    claudeBrowser: {
      passed: playwrightReady,
      available: playwrightReady,
      verification: playwrightReady
        ? "playwright-isolated-world-ready"
        : "blocked-no-isolated-world",
      builtInChromeCapture: "blocked-no-isolated-world",
      assessedHostCapability: "javascript_tool-page-context",
      policy: "capability-gated",
      recovery:
        "Use static-source capture or optional Playwright with headed Chromium or Chrome until Claude exposes a host-validated isolated read-only page world."
    },
    playwright: {
      passed: playwrightReady,
      required: playwrightRequired,
      installed: playwrightInstalled,
      version: playwrightVersion ?? null,
      supported: PLAYWRIGHT_RANGE,
      available: playwrightReady
    },
    browser: {
      passed: browserInstalled,
      required: playwrightRequired,
      channel: browserChannel,
      installed: browserInstalled
    },
    chromium: {
      passed: bundledChromiumInstalled,
      required: playwrightRequired && browserChannel === "chromium",
      installed: bundledChromiumInstalled
    },
    chrome: {
      passed: systemChromeInstalled,
      required: playwrightRequired && browserChannel === "chrome",
      installed: systemChromeInstalled
    },
    skill: {
      passed: skillInstalled,
      installed: skillInstalled,
      compatible: skillInstalled,
      scope: skill.scope,
      paths: skill.entries.map((entry) => entry.path),
      hosts: [
        ...new Set(
          skill.entries.flatMap((entry) => entry.compatibility.hosts)
        )
      ],
      ...(skillInstalled ? {} : { recovery: skillRecovery })
    },
    project: { passed: projectInitialized, initialized: projectInitialized },
    video: { required: false, checked: false }
  };
  const capabilityStatus =
    requestedCapability === "static"
      ? "capture-ready"
      : requestedCapability === "playwright"
        ? "capture-ready"
        : requestedCapability === "openai-browser" ||
            requestedCapability === "codex-browser"
          ? "host-verification-required"
          : requestedCapability === "claude-browser"
            ? playwrightReady
              ? "fallback-ready"
              : "blocked"
            : "cli-ready";
  const result: CommandResult = {
    ok: true,
    operationId: id,
    status: capabilityStatus,
    cliVersion: cliPackage.version,
    requestedCapability: requestedCapability ?? null,
    readiness: {
      cli: nodeSupported,
      skill: skillInstalled,
      project: projectInitialized,
      capture: {
        static: nodeSupported,
        openaiBrowser: false,
        codexBrowser: false,
        claudeBrowser: playwrightReady,
        playwright: playwrightReady
      }
    },
    checks
  };
  if (args.includes("--report")) {
    const reportPath = showkitPath(
      "support",
      `doctor-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    const reportChecks = structuredClone(checks);
    reportChecks.skill.paths = reportChecks.skill.paths.map(
      () => "redacted"
    );
    await writeJsonAtomic(reportPath, {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      cliVersion: cliPackage.version,
      checks: reportChecks,
      telemetryEnabled: false,
      paths: "redacted"
    });
    result.supportReport = {
      path: reportPath,
      redacted: true
    };
  }
  await recordOperation({ operationId: id, command: "doctor", status: "ok" });
  return result;
}

export async function initCommand(): Promise<CommandResult> {
  const id = operationId();
  const { created, project } = await initializeProject();
  const result: CommandResult = {
    ok: true,
    operationId: id,
    status: created ? "created" : "unchanged",
    projectId: project.projectId,
    path: showkitPath()
  };
  await recordOperation({ operationId: id, command: "init", status: "ok" });
  return result;
}

async function captureFailure(
  output: string,
  diagnosticPath?: string
): Promise<ShowKitError> {
  const diagnostic = diagnosticPath
    ? await readFile(diagnosticPath, "utf8")
        .then((contents) =>
          CaptureFailureDiagnosticSchema.safeParse(JSON.parse(contents))
        )
        .then((result) => (result.success ? result.data : undefined))
        .catch(() => undefined)
    : undefined;
  const definitions: Record<
    string,
    {
      message: string;
      recovery: string;
      exitCode?: (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
    }
  > = {
    SensitiveDataDetected: {
      message: "Sensitive data was found. ShowKit did not save the captured page.",
      recovery: "Hide the data or update the capture rule, then try again."
    },
    UnsupportedSurface: {
      message: "ShowKit cannot capture this part of the page yet. No captured page was saved.",
      recovery: "Use supported HTML elements or remove this step."
    },
    CaptureSourceEmpty: {
      message: "This source flow has no demo steps. No captured page was saved.",
      recovery: "Add at least one `demo.step()`, then capture the flow again."
    },
    TargetMissing: {
      message: "ShowKit could not find this hotspot target. No captured page was saved.",
      recovery: "Use a target that matches one visible page element, then capture the flow again."
    },
    CaptureTooLarge: {
      message: "The captured product flow exceeds a safety size limit. No captured page was saved.",
      recovery: "Reduce the number or size of captured states and assets, then capture again."
    },
    DemoFixtureSetupFailed: {
      message:
        "The browser source flow does not match its capture setup. No captured page was saved.",
      recovery:
        "Run the Playwright flow directly, fix the failing setup, then try again.",
      exitCode: EXIT_CODES.environment
    },
    InternalError: {
      message:
        "ShowKit hit an internal capture error. No captured page was saved.",
      recovery:
        "Retry once, then report the failure without including private page content.",
      exitCode: EXIT_CODES.internal
    }
  };
  if (diagnostic) {
    const code = definitions[diagnostic.code]
      ? diagnostic.code
      : "InternalError";
    const defaultDefinition = definitions[code]!;
    const definition =
      code === "DemoFixtureSetupFailed" &&
      diagnostic.category?.startsWith("capture-viewport-")
        ? {
            message:
              "The Playwright viewport does not match the capture contract. No captured page was saved.",
            recovery:
              "Keep the fixed Playwright viewport equal to the capture contract. Use another `--viewport WIDTHxHEIGHT` only for an exact requested size or an existing demo."
          }
        : code === "DemoFixtureSetupFailed" &&
            diagnostic.category === "duplicate-step-id"
        ? {
            message:
              "The source flow uses the same demo step ID more than once. No captured page was saved.",
            recovery:
              "Give every `demo.step()` a different lowercase hyphenated ID, then capture again."
          }
        : code === "DemoFixtureSetupFailed" &&
            diagnostic.category === "multiple-playwright-flows"
        ? {
            message:
              "More than one Playwright test or project tried to produce this flow. No captured page was saved.",
            recovery:
              "Keep one test in the source file and pass `--project <name>` when the Playwright config defines multiple projects."
          }
        : code === "DemoFixtureSetupFailed" &&
            diagnostic.phase === "action"
          ? {
              message:
                "The source flow action stopped before capture finished. No captured page was saved.",
              recovery:
                "Run the Playwright flow directly and fix the failing action."
            }
          : defaultDefinition;
    const details = {
      ...(diagnostic.category ? { category: diagnostic.category } : {}),
      ...(diagnostic.expectedViewport && diagnostic.actualViewport
        ? {
            expectedViewport: diagnostic.expectedViewport,
            actualViewport: diagnostic.actualViewport
          }
        : {}),
      ...(diagnostic.stepProgress.length > 0
        ? { stepProgress: diagnostic.stepProgress }
        : {}),
      failurePhase: diagnostic.phase
    };
    return new ShowKitError({
      code,
      message: definition.message,
      recovery: definition.recovery,
      exitCode:
        code === "InternalError"
          ? EXIT_CODES.internal
          : diagnostic.exitCode,
      ...(Object.keys(details).length > 0 ? { details } : {})
    });
  }
  if (/No tests found/i.test(output)) {
    return new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "Playwright did not discover this source flow. No browser was opened and no captured page was saved.",
      recovery:
        "Rename the file to `*.spec.ts` or configure Playwright `testMatch` to include it, then run `showkit capture <spec> --viewport 1280x720 --preflight --json`."
    });
  }
  if (/ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|No "exports" main defined/i.test(output)) {
    return new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "Playwright could not load the ShowKit fixture in this project module format. No browser was opened and no captured page was saved.",
      recovery:
        "Update `@showkit/cli`, or use a new ESM output folder with `npm pkg set type=module`, then run `showkit capture <spec> --viewport 1280x720 --preflight --json`."
    });
  }
  return new ShowKitError({
    code: "DemoFixtureSetupFailed",
    message: "ShowKit could not run this source flow. No captured page was saved.",
    recovery: "Run the Playwright flow directly, fix the failing setup or action, then try again."
  });
}

function capturePerformanceFromOutput(output: string):
  | {
      htmlSceneCount: number;
      sceneExtractionMs: number;
      actionCount: number;
      actionMs: number;
      totalMs: number;
    }
  | undefined {
  const marker = "[SHOWKIT:CAPTURE_PERFORMANCE] ";
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate: string) => candidate.includes(marker));
  if (!line) return undefined;
  try {
    const value = JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as
      Record<string, unknown>;
    const keys = [
      "htmlSceneCount",
      "sceneExtractionMs",
      "actionCount",
      "actionMs",
      "totalMs"
    ] as const;
    if (
      !keys.every(
        (key) => typeof value[key] === "number" && Number.isFinite(value[key])
      )
    ) {
      return undefined;
    }
    return Object.fromEntries(keys.map((key) => [key, value[key]])) as {
      htmlSceneCount: number;
      sceneExtractionMs: number;
      actionCount: number;
      actionMs: number;
      totalMs: number;
    };
  } catch {
    return undefined;
  }
}

export async function captureCommand(args: string[]): Promise<CommandResult> {
  const id = operationId();
  const preflightOnly = args.includes("--preflight");
  const expectedViewport = captureViewportArgument(args);
  const requestedProject = playwrightProjectArgument(args);
  const [specArgument] = positionalArgs(args);
  if (!specArgument) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "ShowKit could not find the source flow.",
      recovery: "Pass a Playwright demo spec path to `showkit capture`."
    });
  }
  const specPath = path.resolve(process.cwd(), specArgument);
  if (!(await pathExists(specPath))) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "ShowKit could not find the source flow.",
      recovery: `Check the path \`${specArgument}\`, then run the capture command again.`
    });
  }
  const project = await loadProject();
  const runId = lifecycleRunId();
  const runDirectory = showkitPath("runs", runId);
  const startedAt = new Date().toISOString();
  const sourceHash = sha256(await readFile(specPath));
  let runCommitted = false;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "showkit-capture-"));
  const captureOutput = path.join(temporaryDirectory, "capture.json");
  const failureOutput = path.join(temporaryDirectory, "failure.json");
  const playwrightOutput = path.join(temporaryDirectory, "playwright");

  try {
    const require = createRequire(import.meta.url);
    let playwrightCli: string;
    try {
      playwrightCli = require.resolve("@playwright/test/cli");
    } catch {
      throw new ShowKitError({
        code: "DependencyMissing",
        message:
          "This source flow needs Playwright, but Playwright is not installed. No captured page was saved.",
        exitCode: EXIT_CODES.environment,
        recovery:
          "Install `@playwright/test`, then run `showkit doctor --capability playwright --json`."
      });
    }
    const projectArgs = requestedProject
      ? ["--project", requestedProject]
      : [];
    const playwrightArgs = preflightOnly
      ? [
          playwrightCli,
          "test",
          specPath,
          "--list",
          "--reporter=line",
          ...projectArgs
        ]
      : [
          playwrightCli,
          "test",
          specPath,
          "--reporter=line",
          "--workers=1",
          "--max-failures=1",
          "--output",
          playwrightOutput,
          ...projectArgs
        ];
    captureProgress(
      preflightOnly
        ? "Checking the source flow before opening a browser."
        : "Capturing the product flow in a local browser."
    );
    const progressStartedAt = Date.now();
    const progressTimer = preflightOnly
      ? undefined
      : setInterval(() => {
          const elapsedSeconds = Math.max(
            1,
            Math.round((Date.now() - progressStartedAt) / 1_000)
          );
          captureProgress(`Capture is still running (${elapsedSeconds}s).`);
        }, 10_000);
    progressTimer?.unref();
    let run: BufferedProcessResult;
    try {
      run = await runBufferedProcess(process.execPath, playwrightArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SHOWKIT_CAPTURE_OUTPUT: captureOutput,
          SHOWKIT_CAPTURE_DIAGNOSTIC_OUTPUT: failureOutput,
          SHOWKIT_EXPECTED_VIEWPORT: `${expectedViewport.width}x${expectedViewport.height}`
        },
        maxBuffer: CAPTURE_PROCESS_BUFFER_LIMIT
      });
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
    const commandOutput = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    if (run.status !== 0) {
      throw await captureFailure(commandOutput, failureOutput);
    }
    captureProgress(
      preflightOnly
        ? "The source flow is ready."
        : "The browser flow finished. Checking the captured files."
    );
    if (preflightOnly) {
      await recordOperation({
        operationId: id,
        command: "capture-preflight",
        status: "ok"
      });
      return {
        ok: true,
        operationId: id,
        status: "source-ready",
        sourceHash,
        browserLaunchRequested: false,
        expectedViewport
      };
    }
    const envelope = CaptureEnvelopeSchema.parse(
      JSON.parse(await readFile(captureOutput, "utf8"))
    );
    const capture = envelope.capture;
    const committed = await commitCaptureEnvelope({
      envelope,
      project,
      runId,
      startedAt
    });
    const capturePerformance = capturePerformanceFromOutput(commandOutput);
    runCommitted = true;
    await recordOperation({ operationId: id, command: "capture", status: "ok" });
    return {
      ok: true,
      operationId: id,
      status: "captured",
      runId,
      captureId: capture.captureId,
      stepCount: capture.steps.length,
      path: committed.path,
      sourceMode: capture.source.kind,
      replayLevel: capture.source.replayLevel,
      viewport: capture.viewport,
      ...(capture.source.kind === "playwright-spec" &&
      capture.source.projectName
        ? { playwrightProject: capture.source.projectName }
        : {}),
      policyChecksPassed: true,
      fullSceneRasterCount: 0,
      ...(capturePerformance ? { capturePerformance } : {})
    };
  } catch (error) {
    const showkitError = asShowKitError(error);
    if (!runCommitted && !(await pathExists(runDirectory))) {
      await replaceDirectoryAtomic(runDirectory, async (temporaryPath) => {
        await writeJsonAtomic(
          path.join(temporaryPath, "run.json"),
          RunEnvelopeSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            runId,
            command: "capture",
            state: "BLOCKED_DIAGNOSTIC",
            sourceHash,
            failure: { code: showkitError.code },
            startedAt,
            completedAt: new Date().toISOString()
          })
        );
        await writeJsonAtomic(path.join(temporaryPath, "diagnostics", "error.json"), {
          schemaVersion: SCHEMA_VERSION,
          code: showkitError.code,
          sourceHash
        });
      });
    }
    await recordOperation({
      operationId: id,
      command: "capture",
      status: "error",
      code: showkitError.code
    });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function captureSessionCommand(args: string[]): Promise<CommandResult> {
  const id = operationId();
  const [envelopeArgument] = positionalArgs(args);
  if (!envelopeArgument) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "ShowKit could not find the safe browser session envelope.",
      recovery: "Pass the temporary envelope path to `showkit capture session`."
    });
  }
  const envelopePath = path.resolve(process.cwd(), envelopeArgument);
  const temporaryRoot = await realpath(os.tmpdir());
  let envelopeRealPath: string;
  let fileStat;
  try {
    const linkStat = await lstat(envelopePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error("not a regular file");
    envelopeRealPath = await realpath(envelopePath);
    fileStat = await stat(envelopeRealPath);
  } catch {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "ShowKit could not open the safe browser session envelope.",
      recovery: "Capture the browser session again and pass its temporary envelope path."
    });
  }
  const relativeToTemporaryRoot = path.relative(temporaryRoot, envelopeRealPath);
  if (
    relativeToTemporaryRoot === "" ||
    relativeToTemporaryRoot.startsWith("..") ||
    path.isAbsolute(relativeToTemporaryRoot)
  ) {
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message:
        "The browser session envelope must be in the OS temporary directory.",
      exitCode: EXIT_CODES.environment,
      recovery: "Use the ShowKit browser adapter to create a new private temporary envelope."
    });
  }
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    await rm(envelopeRealPath, { force: true });
    throw new ShowKitError({
      code: "DemoFixtureSetupFailed",
      message: "The browser session envelope must use private mode 0600.",
      exitCode: EXIT_CODES.environment,
      recovery: "Use the ShowKit browser adapter to create a new private temporary envelope."
    });
  }

  const runId = lifecycleRunId();
  const runDirectory = showkitPath("runs", runId);
  const startedAt = new Date().toISOString();
  let sourceHash = sha256("unread-session-envelope");
  let committed = false;
  let projectLoaded = false;
  try {
    const project = await loadProject();
    projectLoaded = true;
    if (fileStat.size > 25 * 1024 * 1024) {
      throw new ShowKitError({
        code: "CaptureTooLarge",
        message: "The safe browser session envelope exceeds the 25 MB limit.",
        recovery: "Reduce the number or size of captured states and assets, then capture again."
      });
    }
    const bytes = await readFile(envelopeRealPath);
    sourceHash = sha256(bytes);
    let input: unknown;
    try {
      input = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message: "The safe browser session envelope is not valid JSON.",
        recovery: "Capture the browser session again with the current ShowKit skill."
      });
    }
    const sessionEnvelope = validateAgentBrowserCaptureEnvelope(input);
    if (Buffer.byteLength(JSON.stringify(sessionEnvelope)) > 25 * 1024 * 1024) {
      throw new ShowKitError({
        code: "CaptureTooLarge",
        message: "The safe browser session envelope exceeds the 25 MB limit.",
        recovery: "Reduce the number or size of captured states and assets, then capture again."
      });
    }
    const imported = await commitCaptureEnvelope({
      envelope: {
        capture: sessionEnvelope.capture,
        assetPayloads: sessionEnvelope.assetPayloads
      },
      project,
      runId,
      startedAt
    });
    committed = true;
    await recordOperation({
      operationId: id,
      command: "capture session",
      status: "ok"
    });
    return {
      ok: true,
      operationId: id,
      status: "captured",
      runId,
      captureId: sessionEnvelope.capture.captureId,
      sourceMode: "agent-browser-session",
      stepCount: sessionEnvelope.capture.steps.length,
      path: imported.path,
      policyChecksPassed: true,
      fullSceneRasterCount: 0,
      replayLevel: "session-captured"
    };
  } catch (error) {
    const showkitError = asShowKitError(error);
    if (projectLoaded && !committed && !(await pathExists(runDirectory))) {
      await replaceDirectoryAtomic(runDirectory, async (temporaryPath) => {
        await writeJsonAtomic(
          path.join(temporaryPath, "run.json"),
          RunEnvelopeSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            runId,
            command: "capture",
            state: "BLOCKED_DIAGNOSTIC",
            sourceHash,
            failure: { code: showkitError.code },
            startedAt,
            completedAt: new Date().toISOString()
          })
        );
        await writeJsonAtomic(path.join(temporaryPath, "diagnostics", "error.json"), {
          schemaVersion: SCHEMA_VERSION,
          code: showkitError.code,
          sourceHash
        });
      });
    }
    throw error;
  } finally {
    await rm(envelopeRealPath, { force: true });
  }
}

export async function captureStaticCommand(
  args: string[]
): Promise<CommandResult> {
  const id = operationId();
  const [envelopeArgument] = positionalArgs(args);
  if (!envelopeArgument) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "ShowKit could not find the static-source envelope.",
      recovery:
        "Pass a safe envelope path to `showkit capture static <safe-envelope.json> --json`."
    });
  }
  const envelopePath = path.resolve(process.cwd(), envelopeArgument);
  let fileStat;
  try {
    const linkStat = await lstat(envelopePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    fileStat = await stat(envelopePath);
  } catch {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message: "ShowKit could not open the static-source envelope.",
      recovery:
        "Regenerate the envelope, then pass its regular file path to `showkit capture static`."
    });
  }
  if (fileStat.size > 25 * 1024 * 1024) {
    throw new ShowKitError({
      code: "CaptureTooLarge",
      message: "The static-source envelope exceeds the 25 MB limit.",
      recovery:
        "Reduce the number or size of source-derived states and assets, then capture again."
    });
  }

  const runId = lifecycleRunId();
  const runDirectory = showkitPath("runs", runId);
  const startedAt = new Date().toISOString();
  let sourceHash = sha256("unread-static-source-envelope");
  let committed = false;
  let projectLoaded = false;
  try {
    const project = await loadProject();
    projectLoaded = true;
    const bytes = await readFile(envelopePath);
    sourceHash = sha256(bytes);
    let input: unknown;
    try {
      input = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "The static-source envelope is not valid JSON. The previous captured product flow has not changed.",
        recovery:
          "Regenerate the static-source envelope with the current ShowKit CLI."
      });
    }
    const envelope = validateStaticCaptureEnvelope(input);
    if (envelope.capture.source.kind !== "static-source") {
      throw new ShowKitError({
        code: "DemoFixtureSetupFailed",
        message:
          "The capture envelope is not a static-source capture. Nothing was imported.",
        recovery:
          "Regenerate the static-source envelope with the current ShowKit CLI."
      });
    }
    const sourceRoot = await realpath(projectRoot());
    for (const sourceFile of envelope.capture.source.sourceFiles) {
      const candidate = path.resolve(sourceRoot, sourceFile.path);
      const relative = path.relative(sourceRoot, candidate);
      if (
        relative === "" ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "A static-source file is outside the current project. Nothing was imported.",
          recovery:
            "Use project-relative source files inside the current ShowKit project."
        });
      }
      let sourceBytes: Buffer;
      try {
        const linkStat = await lstat(candidate);
        if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
          throw new Error("not a regular file");
        }
        const resolved = await realpath(candidate);
        const resolvedRelative = path.relative(sourceRoot, resolved);
        if (
          resolvedRelative.startsWith("..") ||
          path.isAbsolute(resolvedRelative)
        ) {
          throw new Error("outside project");
        }
        sourceBytes = await readFile(resolved);
      } catch {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "A bound static-source file is missing or unsafe. Nothing was imported.",
          recovery:
            "Restore the project-relative source file, then regenerate the envelope."
        });
      }
      if (sha256(sourceBytes) !== sourceFile.sha256) {
        throw new ShowKitError({
          code: "DemoFixtureSetupFailed",
          message:
            "A static-source file changed after the envelope was created. Nothing was imported.",
          recovery:
            "Regenerate the static-source envelope from the current source files."
        });
      }
    }
    const imported = await commitCaptureEnvelope({
      envelope,
      project,
      runId,
      startedAt
    });
    committed = true;
    await recordOperation({
      operationId: id,
      command: "capture static",
      status: "ok"
    });
    return {
      ok: true,
      operationId: id,
      status: "captured",
      runId,
      captureId: envelope.capture.captureId,
      sourceMode: "static-source",
      stepCount: envelope.capture.steps.length,
      path: imported.path,
      policyChecksPassed: true,
      fullSceneRasterCount: 0,
      replayLevel: "source-derived"
    };
  } catch (error) {
    const showkitError = asShowKitError(error);
    if (projectLoaded && !committed && !(await pathExists(runDirectory))) {
      await replaceDirectoryAtomic(runDirectory, async (temporaryPath) => {
        await writeJsonAtomic(
          path.join(temporaryPath, "run.json"),
          RunEnvelopeSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            runId,
            command: "capture",
            state: "BLOCKED_DIAGNOSTIC",
            sourceHash,
            failure: { code: showkitError.code },
            startedAt,
            completedAt: new Date().toISOString()
          })
        );
        await writeJsonAtomic(
          path.join(temporaryPath, "diagnostics", "error.json"),
          {
            schemaVersion: SCHEMA_VERSION,
            code: showkitError.code,
            sourceHash
          }
        );
      });
    }
    await recordOperation({
      operationId: id,
      command: "capture static",
      status: "error",
      code: showkitError.code
    });
    throw error;
  }
}

export async function storyApplyCommand(args: string[]): Promise<CommandResult> {
  const id = operationId();
  const startedAt = new Date().toISOString();
  const [storyArgument] = positionalArgs(args);
  if (!storyArgument) {
    throw new ShowKitError({
      code: "StorySpecInvalid",
      message: "ShowKit could not find the demo content file.",
      recovery: "Pass a StorySpec JSON path to `showkit story apply`."
    });
  }
  const storyPath = path.resolve(process.cwd(), storyArgument);
  let input: unknown;
  try {
    input = JSON.parse(await readFile(storyPath, "utf8"));
  } catch {
    throw new ShowKitError({
      code: "StorySpecInvalid",
      message: "Demo content could not be checked. The saved version has not changed.",
      recovery: "Fix the StorySpec JSON errors, then apply the file again.",
      details: {
        issues: [{ pointer: "", rule: "The file must contain valid JSON." }]
      }
    });
  }
  const parsedStory = StorySpecSchema.safeParse(input);
  if (!parsedStory.success) {
    throw new ShowKitError({
      code: "StorySpecInvalid",
      message: "Demo content could not be checked. The saved version has not changed.",
      recovery: "Fix the reported StorySpec rules, then apply the file again.",
      details: {
        issues: parsedStory.error.issues.map((issue) => ({
          pointer: `/${issue.path
            .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
            .join("/")}`,
          rule: issue.message
        }))
      }
    });
  }
  const story = parsedStory.data;
  const { capture } = await loadLatestCapture();
  const { verification } = validateStory(capture, story);
  const project = await loadProject();
  const storyVersion = contentHash(story);
  const storyDirectory = showkitPath("stories", story.id, storyVersion);
  const persistedStoryPath = path.join(storyDirectory, "story.json");
  const reused = await pathExists(persistedStoryPath);
  if (!reused) {
    await replaceDirectoryAtomic(storyDirectory, async (temporaryPath) => {
      await writeJsonAtomic(path.join(temporaryPath, "story.json"), story);
    });
  } else {
    StorySpecSchema.parse(JSON.parse(await readFile(persistedStoryPath, "utf8")));
  }
  const runId = lifecycleRunId();
  await replaceDirectoryAtomic(showkitPath("runs", runId), async (temporaryPath) => {
    await writeJsonAtomic(
      path.join(temporaryPath, "run.json"),
      RunEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId,
        command: "story-apply",
        state: "VALIDATED",
        captureId: capture.captureId,
        storyId: story.id,
        storyVersion,
        startedAt,
        completedAt: new Date().toISOString()
      })
    );
    await writeJsonAtomic(path.join(temporaryPath, "verification.json"), verification);
  });
  await saveProject({
    ...project,
    latestStoryId: story.id,
    latestStoryVersion: storyVersion
  });
  await recordOperation({ operationId: id, command: "story apply", status: "ok" });
  return {
    ok: true,
    operationId: id,
    status: "applied",
    runId,
    storyId: story.id,
    version: storyVersion,
    sourceCaptureId: story.sourceCaptureId,
    path: persistedStoryPath,
    reused
  };
}

export async function validateCommand(): Promise<CommandResult> {
  const id = operationId();
  const { capture, runId } = await loadLatestCapture();
  const story = (await loadStoryForCapture(capture)) ?? createEvidenceGroundedStory(capture);
  const { verification, quality } = validateStory(capture, story);
  await recordOperation({ operationId: id, command: "validate", status: "ok" });
  return {
    ok: true,
    operationId: id,
    status: "checked",
    runId,
    storyId: story.id,
    verification,
    quality
  };
}

export async function buildCommand(): Promise<CommandResult> {
  const id = operationId();
  const startedAt = new Date().toISOString();
  const { capture, runId } = await loadLatestCapture();
  const story = (await loadStoryForCapture(capture)) ?? createEvidenceGroundedStory(capture);
  const storyVersion = contentHash(story);
  const buildRunId = lifecycleRunId();
  const buildRunDirectory = showkitPath("runs", buildRunId);
  const sourceHash = contentHash({
    captureId: capture.captureId,
    storyId: story.id,
    storyVersion
  });
  try {
    const { verification } = validateStory(capture, story);
    const { manifest, directory, reused } = await buildDemo(
      capture,
      story,
      showkitPath("runs", runId)
    );
    await replaceDirectoryAtomic(buildRunDirectory, async (temporaryPath) => {
      await writeJsonAtomic(
        path.join(temporaryPath, "run.json"),
        RunEnvelopeSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          runId: buildRunId,
          command: "build",
          state: "BUILT",
          captureId: capture.captureId,
          storyId: story.id,
          storyVersion,
          artifactVersion: manifest.version,
          startedAt,
          completedAt: new Date().toISOString()
        })
      );
      await writeJsonAtomic(path.join(temporaryPath, "verification.json"), verification);
    });
    const project = await loadProject();
    await saveProject({ ...project, latestArtifactVersion: manifest.version });
    await recordOperation({ operationId: id, command: "build", status: "ok" });
    return {
      ok: true,
      operationId: id,
      status: reused ? "unchanged" : "built",
      runId: buildRunId,
      version: manifest.version,
      storyId: story.id,
      storyVersion,
      path: directory,
      files: manifest.files
    };
  } catch (error) {
    const showkitError = asShowKitError(error);
    if (!(await pathExists(buildRunDirectory))) {
      await replaceDirectoryAtomic(buildRunDirectory, async (temporaryPath) => {
        await writeJsonAtomic(
          path.join(temporaryPath, "run.json"),
          RunEnvelopeSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            runId: buildRunId,
            command: "build",
            state: "BLOCKED_DIAGNOSTIC",
            sourceHash,
            failure: { code: showkitError.code },
            startedAt,
            completedAt: new Date().toISOString()
          })
        );
        await writeJsonAtomic(path.join(temporaryPath, "diagnostics", "error.json"), {
          schemaVersion: SCHEMA_VERSION,
          code: showkitError.code,
          sourceHash
        });
      });
    }
    throw error;
  }
}

async function replayPlaywrightSource(
  specArgument: string,
  expectedViewport: { width: number; height: number },
  projectName?: string
): Promise<{
  capture: CaptureSource;
  specHash: string;
  capturePerformance?: ReturnType<typeof capturePerformanceFromOutput>;
}> {
  const specPath = path.resolve(process.cwd(), specArgument);
  if (!(await pathExists(specPath))) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message:
        "ShowKit could not find the source flow. Your previous demo has not changed.",
      recovery: `Check the path \`${specArgument}\`, then run the demo check again.`
    });
  }
  const require = createRequire(import.meta.url);
  let playwrightCli: string;
  try {
    playwrightCli = require.resolve("@playwright/test/cli");
  } catch {
    throw new ShowKitError({
      code: "DependencyMissing",
      message:
        "This demo check needs Playwright, but Playwright is not installed. Your previous demo has not changed.",
      exitCode: EXIT_CODES.environment,
      recovery:
        "Install `@playwright/test`, then run `showkit doctor --capability playwright --json`."
    });
  }
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "showkit-freshness-")
  );
  const captureOutput = path.join(temporaryDirectory, "capture.json");
  const failureOutput = path.join(temporaryDirectory, "failure.json");
  const playwrightOutput = path.join(temporaryDirectory, "playwright");
  try {
    captureProgress("Checking the current product flow against the earlier demo.");
    const progressStartedAt = Date.now();
    const progressTimer = setInterval(() => {
      const elapsedSeconds = Math.max(
        1,
        Math.round((Date.now() - progressStartedAt) / 1_000)
      );
      captureProgress(`Demo check is still running (${elapsedSeconds}s).`);
    }, 10_000);
    progressTimer.unref();
    let run: BufferedProcessResult;
    try {
      run = await runBufferedProcess(
        process.execPath,
        [
          playwrightCli,
          "test",
          specPath,
          "--reporter=line",
          "--workers=1",
          "--max-failures=1",
          "--output",
          playwrightOutput,
          ...(projectName ? ["--project", projectName] : [])
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SHOWKIT_CAPTURE_OUTPUT: captureOutput,
            SHOWKIT_CAPTURE_OUTPUT_KIND: "freshness",
            SHOWKIT_CAPTURE_DIAGNOSTIC_OUTPUT: failureOutput,
            SHOWKIT_EXPECTED_VIEWPORT: `${expectedViewport.width}x${expectedViewport.height}`
          },
          maxBuffer: CAPTURE_PROCESS_BUFFER_LIMIT
        }
      );
    } finally {
      clearInterval(progressTimer);
    }
    const commandOutput = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    if (run.status !== 0) {
      throw await captureFailure(commandOutput, failureOutput);
    }
    const capture = CaptureSourceSchema.parse(
      JSON.parse(await readFile(captureOutput, "utf8"))
    );
    return {
      capture,
      specHash: sha256(await readFile(specPath)),
      capturePerformance: capturePerformanceFromOutput(commandOutput)
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readArtifactBase(args: string[]) {
  const baseArgument = argumentValue(args, "--base");
  if (!baseArgument || baseArgument.startsWith("--")) {
    throw new ShowKitError({
      code: "ArtifactBaseMissing",
      message: "ShowKit could not find the earlier demo version.",
      recovery: "Pass an artifact manifest path with `--base <manifest>`."
    });
  }
  const basePath = path.resolve(process.cwd(), baseArgument);
  let contents: string;
  try {
    contents = await readFile(basePath, "utf8");
  } catch {
    throw new ShowKitError({
      code: "ArtifactBaseMissing",
      message: "ShowKit could not read the earlier demo version.",
      recovery: `Check the path \`${baseArgument}\`, then run the demo check again.`
    });
  }
  try {
    return ArtifactManifestSchema.parse(JSON.parse(contents));
  } catch {
    throw new ShowKitError({
      code: "ArtifactBaseInvalid",
      message: "The earlier demo manifest is not valid.",
      recovery:
        "Pass an unchanged `artifact.json` produced by ShowKit, then run the demo check again."
    });
  }
}

export async function diffCommand(args: string[]): Promise<CommandResult> {
  const id = operationId();
  const base = await readArtifactBase(args);
  const sourceRequested = args.includes("--source");
  const sourceArgument = argumentValue(args, "--source");
  if (
    sourceRequested &&
    (!sourceArgument || sourceArgument.startsWith("--"))
  ) {
    throw new ShowKitError({
      code: "CaptureSourceMissing",
      message:
        "ShowKit could not find the source flow. Your previous demo has not changed.",
      recovery:
        "Pass a Playwright demo spec path with `--source <demo.spec.ts>`, then run the demo check again."
    });
  }
  if (sourceArgument) {
    const requestedProject = playwrightProjectArgument(args);
    if (base.source.kind !== "playwright-spec" || base.replayLevel !== "ci-replayable") {
      throw new ShowKitError({
        code: "FreshnessSourceUnsupported",
        message:
          "This demo version was not created from a CI-replayable source flow. Your previous demo has not changed.",
        recovery:
          "Promote the demo to an approved Playwright source flow, then build a new baseline."
      });
    }
    if (!base.freshness) {
      throw new ShowKitError({
        code: "FreshnessBaselineMissing",
        message:
          "This demo version does not include step freshness details. Your previous demo has not changed.",
        recovery:
          "Build the demo once with the current ShowKit version, then run the source check again."
      });
    }
    const expectedViewport = captureViewportArgument(
      args,
      base.environment.viewport
    );
    const replayProject = requestedProject ?? base.source.projectName;
    let replay: Awaited<ReturnType<typeof replayPlaywrightSource>>;
    try {
      replay = await replayPlaywrightSource(
        sourceArgument,
        expectedViewport,
        replayProject
      );
    } catch (error) {
      const showkitError = asShowKitError(error);
      const parsedProgress = Array.isArray(showkitError.details?.stepProgress)
        ? (showkitError.details.stepProgress as CaptureStepProgress[])
        : [];
      const stepProgress = validateCaptureStepProgress(
        parsedProgress,
        base.freshness
      );
      const failedProgress = [...stepProgress]
        .reverse()
        .find((step) => step.state === "failed");
      const failedBaselineStep = failedProgress
        ? base.freshness.steps.find(
            (step) => step.captureStepId === failedProgress.stepId
          )
        : undefined;
      const failureMessage = failedBaselineStep
        ? `The source flow stopped while checking “${failedBaselineStep.title}”. Your previous demo has not changed.`
        : showkitError.message.includes("previous demo")
          ? showkitError.message
          : `${showkitError.message} Your previous demo has not changed.`;
      const failureRecovery =
        failedBaselineStep && failedProgress?.phase === "action"
          ? `Fix the action for step \`${failedBaselineStep.captureStepId}\`, then run the source flow again.`
          : showkitError.recovery;
      const freshness = createBlockedFreshnessReport({
        baseline: base.freshness,
        baseVersion: base.version,
        baseSourceHash: base.sourceCaptureHash,
        progress: stepProgress,
        failure: {
          code: showkitError.code,
          message: failureMessage,
          recovery: failureRecovery
        }
      });
      const safeDetails = { ...(showkitError.details ?? {}) };
      delete safeDetails.stepProgress;
      throw new ShowKitError({
        code: showkitError.code,
        message: failureMessage,
        recovery: failureRecovery,
        exitCode: showkitError.exitCode,
        details: {
          ...safeDetails,
          ...(stepProgress.length > 0 ? { stepProgress } : {}),
          freshness
        }
      });
    }
    const freshness = compareCaptureFreshness({
      baseline: base.freshness,
      baseVersion: base.version,
      baseSourceHash: base.sourceCaptureHash,
      currentCapture: replay.capture
    });
    if (args.includes("--check") && freshness.status !== "fresh") {
      throw new ShowKitError({
        code: "ArtifactDriftDetected",
        message: "This demo is out of date. Your previous demo has not changed.",
        recovery:
          "Review the failed steps, then capture and approve the updated demo.",
        details: { freshness }
      });
    }
    return {
      ok: true,
      operationId: id,
      status: freshness.status === "fresh" ? "fresh" : "out-of-date",
      sourceMode: "playwright-spec",
      ...(replayProject
        ? { playwrightProject: replayProject }
        : {}),
      expectedViewport,
      specHash: replay.specHash,
      ...(replay.capturePerformance
        ? { capturePerformance: replay.capturePerformance }
        : {}),
      freshness
    };
  }
  const project = await loadProject();
  if (!project.latestArtifactVersion) {
    throw new ShowKitError({
      code: "ArtifactBuildMissing",
      message: "No built demo is available to compare.",
      recovery: "Run `showkit build web,markdown --json` first."
    });
  }
  const current = ArtifactManifestSchema.parse(
    JSON.parse(
      await readFile(showkitPath("artifacts", project.latestArtifactVersion, "artifact.json"), "utf8")
    )
  );
  const changedFiles = [
    ...new Set([
      ...current.files.map((file) => file.path),
      ...base.files.map((file) => file.path)
    ])
  ].filter((filePath) => {
    const currentHash = current.files.find((file) => file.path === filePath)?.sha256;
    const baseHash = base.files.find((file) => file.path === filePath)?.sha256;
    return currentHash !== baseHash;
  });
  const drift = {
    baseVersion: base.version,
    currentVersion: current.version,
    sourceChanged: base.sourceCaptureHash !== current.sourceCaptureHash,
    storyChanged: base.storyHash !== current.storyHash,
    changedFiles
  };
  if (args.includes("--check") && changedFiles.length > 0) {
    throw new ShowKitError({
      code: "ArtifactDriftDetected",
      message: "The demo is out of date. Existing demo files have not changed.",
      recovery: "Review the changed files, then rebuild and approve the updated demo.",
      details: drift
    });
  }
  await recordOperation({ operationId: id, command: "diff", status: "ok" });
  return {
    ok: true,
    operationId: id,
    status: changedFiles.length === 0 ? "unchanged" : "changed",
    ...drift
  };
}

function publishBlocked(
  message: string,
  recovery: string,
  details?: Record<string, unknown>
): ShowKitError {
  return new ShowKitError({
    code: "ArtifactPublishBlocked",
    message: `${message} Nothing was uploaded or published.`,
    recovery,
    ...(details ? { details } : {})
  });
}

export async function publishCommand(
  args: string[],
  transport?: HostedPublishTransport
): Promise<CommandResult> {
  const id = operationId();
  const version = argumentValue(args, "--version");
  if (!version || !/^[a-f0-9]{64}$/.test(version)) {
    throw publishBlocked(
      "ShowKit could not identify a built demo version.",
      "Pass `--version <artifact-hash>` from a successful build."
    );
  }
  const directory = showkitPath("artifacts", version);
  let manifest;
  try {
    manifest = ArtifactManifestSchema.parse(
      JSON.parse(await readFile(path.join(directory, "artifact.json"), "utf8"))
    );
  } catch {
    throw publishBlocked(
      "The requested built demo is missing or invalid.",
      "Build the demo again, then use the returned version hash."
    );
  }
  if (
    manifest.version !== version ||
    manifest.state !== "BUILT" ||
    manifest.publish !== null ||
    !manifest.sanitization.policyChecksPassed ||
    manifest.sanitization.fullSceneRasterCount !== 0 ||
    manifest.sanitization.remoteRequestCount !== 0
  ) {
    throw publishBlocked(
      "The requested demo has not passed the local publish gate.",
      "Run `showkit validate --json` and rebuild the demo.",
      { version }
    );
  }

  let verification;
  let quality;
  try {
    verification = VerificationReportSchema.parse(
      JSON.parse(await readFile(path.join(directory, manifest.reports.verification), "utf8"))
    );
    quality = QualityReportSchema.parse(
      JSON.parse(await readFile(path.join(directory, manifest.reports.quality), "utf8"))
    );
  } catch {
    throw publishBlocked(
      "The demo verification or quality report is missing or invalid.",
      "Run `showkit validate --json` and rebuild the demo."
    );
  }
  if (!verification.passed || !quality.passed) {
    throw publishBlocked(
      "The demo verification or quality report contains a failed check.",
      "Fix the failed checks and rebuild the demo.",
      {
        failedVerificationChecks: verification.checks
          .filter((check) => !check.passed)
          .map((check) => check.name),
        failedQualityChecks: quality.checks
          .filter((check) => !check.passed)
          .map((check) => check.name)
      }
    );
  }

  const secretPatterns = [
    /SHOWKIT_SECRET_CANARY_[A-Z0-9_-]+/i,
    /\b(?:api|access|auth|secret)[_-]?(?:key|token)\s*[:=]\s*[^\s]+/i,
    /\bsk-[A-Za-z0-9]{16,}\b/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/,
    /\bwhsec_[A-Za-z0-9]{12,}\b/,
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/
  ];
  const contentsByPath = new Map<string, Buffer>();
  let artifactRoot: string;
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("unsafe artifact directory");
    }
    artifactRoot = await realpath(directory);
  } catch {
    throw publishBlocked(
      "The built demo version is not a regular artifact directory.",
      "Rebuild the demo before publishing."
    );
  }
  for (const file of manifest.files) {
    const filePath = path.resolve(directory, file.path);
    if (!filePath.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      throw publishBlocked(
        "A demo file path leaves the built demo directory.",
        "Rebuild the demo from a valid StorySpec."
      );
    }
    try {
      const fileStat = await lstat(filePath);
      const resolvedFile = await realpath(filePath);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        !resolvedFile.startsWith(`${artifactRoot}${path.sep}`)
      ) {
        throw new Error("unsafe artifact file");
      }
    } catch {
      throw publishBlocked(
        `The built demo file \`${file.path}\` is not a regular file inside the artifact.`,
        "Rebuild the demo before publishing."
      );
    }
    let contents: Buffer;
    try {
      contents = await readFile(filePath);
    } catch {
      throw publishBlocked(
        `The built demo file \`${file.path}\` is missing.`,
        "Rebuild the demo before publishing."
      );
    }
    if (contents.byteLength !== file.bytes || sha256(contents) !== file.sha256) {
      throw publishBlocked(
        `The built demo file \`${file.path}\` failed its integrity check.`,
        "Rebuild the demo before publishing."
      );
    }
    if (
      /^(?:text\/|application\/json|text\/javascript)/.test(file.mediaType) &&
      secretPatterns.some((pattern) => pattern.test(contents.toString("utf8")))
    ) {
      throw publishBlocked(
        `The built demo file \`${file.path}\` contains sensitive-looking content.`,
        "Remove the sensitive value from the product state, capture again, and rebuild."
      );
    }
    contentsByPath.set(file.path, contents);
  }

  if (!transport) {
    throw new ShowKitError({
      code: "HostedFeatureUnavailable",
      message:
        "This demo passed the local publish gate, but this CLI invocation has no hosted publish transport. Nothing was uploaded or published.",
      exitCode: EXIT_CODES.external,
      recovery:
        "Run publish through the project's installed ShowKit CLI, or keep using the portable local files on a static host you control."
    });
  }

  const project = await loadProject();
  let prepared;
  try {
    prepared = createHostedPublishRequest({
      projectId: project.projectId,
      manifest,
      contents: contentsByPath
    });
  } catch (error) {
    throw publishBlocked(
      error instanceof Error ? error.message : "The hosted demo request is invalid.",
      "Rebuild the checked demo before publishing."
    );
  }
  const mib = (prepared.bytes / (1024 * 1024)).toFixed(1);
  captureProgress(`Checked demo · ${manifest.files.length} files · ${mib} MiB`);
  if (prepared.bytes > HOSTED_REQUEST_WARNING_BYTES) {
    captureProgress("This hosted demo is above the 2 MiB warning threshold.");
  }
  captureProgress(`Publishing the checked version to ${transport.destination}`);

  const requestHash = contentHash(prepared.request);
  let idempotencyKey: string;
  try {
    idempotencyKey = await pendingIdempotencyKey({
      projectId: project.projectId,
      requestHash,
      create: randomUUID,
      now: new Date().toISOString()
    });
  } catch {
    throw new ShowKitError({
      code: "HostedReceiptUnavailable",
      message: "ShowKit could not save the private pending publish receipt. Nothing was uploaded or published.",
      exitCode: EXIT_CODES.environment,
      recovery: "Check permissions for the local .showkit directory, then publish again."
    });
  }
  const result = await transport.publish({
    request: prepared.request,
    json: prepared.json,
    idempotencyKey
  });
  try {
    await commitPublicationReceipt({
      projectId: project.projectId,
      requestHash,
      idempotencyKey,
      result,
      now: new Date().toISOString()
    });
  } catch {
    captureProgress(
      "Published, but the private local receipt could not be updated. Keep the returned URL."
    );
  }
  await recordOperation({ operationId: id, command: "publish", status: "ok" });
  return { ...result, operationId: id };
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8"
  };
  return (
    contentTypes[extension] ?? "application/octet-stream"
  );
}

async function listen(server: Server, preferredPort: number): Promise<number> {
  for (let port = preferredPort; port <= preferredPort + 10; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const onError = (): void => {
        server.off("listening", onListening);
        resolve(false);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new ShowKitError({
    code: "PortUnavailable",
    message: "ShowKit could not open a local preview port.",
    exitCode: EXIT_CODES.environment,
    recovery: `Try \`showkit preview --port ${preferredPort + 11} --json\`.`
  });
}

export async function previewCommand(args: string[]): Promise<void> {
  const id = operationId();
  const project = await loadProject();
  if (!project.latestArtifactVersion) {
    throw new ShowKitError({
      code: "ArtifactBuildMissing",
      message: "No built demo is available for a local preview.",
      recovery: "Run `showkit build web,markdown --json` first."
    });
  }
  const directory = showkitPath("artifacts", project.latestArtifactVersion);
  const manifest = ArtifactManifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, "artifact.json"), "utf8"))
  );
  const mediaTypes = new Map(manifest.files.map((file) => [file.path, file.mediaType]));
  const preferredPort = Number(argumentValue(args, "--port") ?? "4174");
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const filePath = path.resolve(directory, relativePath);
      if (!filePath.startsWith(`${path.resolve(directory)}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Content-Type": mediaTypes.get(relativePath) ?? contentType(filePath),
        "Content-Length": fileStat.size,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  const port = await listen(server, preferredPort);
  await recordOperation({ operationId: id, command: "preview", status: "ok" });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      operationId: id,
      status: "ready",
      url: `http://127.0.0.1:${port}`,
      visibility: "local",
      published: false,
      version: project.latestArtifactVersion
    })}\n`
  );

  const close = (): void => {
    server.close(() => process.exit(EXIT_CODES.success));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>(() => undefined);
}

export function helpCommand(): CommandResult {
  return {
    ok: true,
    operationId: operationId(),
    status: "help",
    commands: [
      "showkit doctor --json",
      "showkit init --json",
      "showkit capture <demo.spec.ts> --viewport 1280x720 --preflight --json",
      "showkit capture <demo.spec.ts> --viewport 1280x720 [--project <name>] --json",
      "showkit capture session <safe-envelope.json> --json",
      "showkit capture static <safe-envelope.json> --json",
      "showkit story apply <story.json> --json",
      "showkit validate --json",
      "showkit build web,markdown --json",
      "showkit diff --base <artifact.json> --json",
      "showkit diff --base <artifact.json> --check --json",
      "showkit diff --base <artifact.json> --source <demo.spec.ts> [--project <name>] --check --json",
      "showkit preview --json",
      "showkit publish --version <hash> --json"
    ]
  };
}

export type CommandDependencies = {
  hostedPublish?: HostedPublishTransport;
};

export async function runCommand(
  argv: string[],
  dependencies: CommandDependencies = {}
): Promise<CommandResult | undefined> {
  const [command, subcommand] = argv;
  switch (command) {
    case "doctor":
      return doctorCommand(argv.slice(1));
    case "init":
      return initCommand();
    case "capture":
      if (subcommand === "session") return captureSessionCommand(argv.slice(2));
      if (subcommand === "static") return captureStaticCommand(argv.slice(2));
      return captureCommand(argv.slice(1));
    case "story":
      if (subcommand === "apply") return storyApplyCommand(argv.slice(2));
      return helpCommand();
    case "validate":
      return validateCommand();
    case "build":
      return buildCommand();
    case "diff":
      return diffCommand(argv.slice(1));
    case "preview":
      await previewCommand(argv.slice(1));
      return undefined;
    case "publish":
      return publishCommand(argv.slice(1), dependencies.hostedPublish);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return helpCommand();
    default:
      throw new ShowKitError({
        code: "CommandUnknown",
        message: `ShowKit does not recognize the \`${command}\` command.`,
        recovery: "Run `showkit help` to view the available commands."
      });
  }
}

export async function recordFailedCommand(
  id: string,
  command: string,
  code: string
): Promise<void> {
  await recordOperation({ operationId: id, command, status: "error", code });
}
