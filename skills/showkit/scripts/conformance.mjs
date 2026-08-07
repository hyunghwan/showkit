import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "SKILL.md",
  "workflow.md",
  "compatibility.json",
  "agents/codex.md",
  "agents/browser-capabilities.md",
  "agents/codex-browser.md",
  "agents/claude-code.md",
  "agents/claude-cowork.md",
  "agents/claude-browser.md",
  "references/cli.md",
  "references/security.md",
  "references/url-intake.md",
  "references/visual-fidelity.md",
  "examples/manifest.json",
  "examples/headed-chrome-live.md",
  "examples/open-chrome-routing.md",
  "examples/static-source.md",
  "examples/url-to-playwright.md",
  "scripts/capture-browser-session.mjs"
];

await Promise.all(requiredFiles.map((file) => access(path.join(skillRoot, file))));
const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
const portableTextFiles = (await readdir(skillRoot, { recursive: true })).filter(
  (file) => file.endsWith(".md") || file.endsWith(".json")
);

function containsUserSpecificAbsolutePath(text) {
  if (
    /file:\/\/\/(?:Users|home)\//.test(text) ||
    /file:\/\/\/[A-Za-z]:\/Users\//.test(text)
  ) {
    return true;
  }

  const withoutWebUrls = text.replace(
    /https?:\/\/[^\s`"'<>)}\]]+/g,
    ""
  );
  return [
    /\/Users\/[^\s`"']+/,
    /\/home\/[^\s`"']+/,
    /[A-Za-z]:\\+Users\\+/
  ].some((pattern) => pattern.test(withoutWebUrls));
}

for (const fixture of [
  { text: "/Users/alice/project/SKILL.md", expected: true },
  { text: "/home/alice/project/SKILL.md", expected: true },
  { text: String.raw`C:\Users\alice\project\SKILL.md`, expected: true },
  {
    text: String.raw`{"path":"C:\\Users\\alice\\project\\SKILL.md"}`,
    expected: true
  },
  { text: "file:///Users/alice/project/SKILL.md", expected: true },
  { text: "file:///C:/Users/alice/project/SKILL.md", expected: true },
  { text: "https://app.example.test/home/dashboard", expected: false },
  { text: "https://app.example.test/Users/alice", expected: false }
]) {
  if (containsUserSpecificAbsolutePath(fixture.text) !== fixture.expected) {
    throw new Error(`The portable-path policy misclassified: ${fixture.text}`);
  }
}

for (const file of portableTextFiles) {
  const text = await readFile(path.join(skillRoot, file), "utf8");
  if (containsUserSpecificAbsolutePath(text)) {
    throw new Error(`${file} contains a user-specific absolute path.`);
  }
}
const requiredCommands = [
  "doctor",
  "init",
  "capture",
  "capture session",
  "capture static",
  "story apply",
  "validate",
  "build",
  "preview",
  "diff"
];
for (const command of requiredCommands) {
  if (!skill.includes(`showkit ${command}`)) {
    throw new Error(`SKILL.md does not include showkit ${command}`);
  }
}
for (const guidance of [
  "WCAG 2.2 AA",
  "4.5:1 text contrast",
  "3:1 non-text control contrast",
  "24 by 24 CSS pixel",
  "ask whether to keep them",
  "Do not claim that captured product content itself is WCAG conformant"
]) {
  if (!skill.includes(guidance)) {
    throw new Error(`SKILL.md is missing player theme guidance: ${guidance}`);
  }
}
for (const guidance of [
  "Model selection belongs to the host agent",
  "Do not pin a provider-specific model name",
  "fast or lightweight model",
  "balanced model with medium reasoning",
  "most capable available model with high reasoning",
  "Use extra-high reasoning only",
  "Never lower the model or reasoning budget to bypass a stop condition"
]) {
  if (!skill.replace(/\s+/g, " ").includes(guidance)) {
    throw new Error(`SKILL.md is missing model-routing guidance: ${guidance}`);
  }
}
for (const guidance of [
  "Private content is visible",
  "visible-session",
  "text-only redaction",
  'consent: "confirmed"',
  "Do not infer consent",
  "synthetic fixture",
  "computed styles",
  "hotspot geometry",
  "must not mutate the live DOM"
]) {
  if (!skill.replace(/\s+/g, " ").includes(guidance)) {
    throw new Error(`SKILL.md is missing sensitive-text guidance: ${guidance}`);
  }
}
for (const guidance of [
  "source-faithful",
  "references/visual-fidelity.md",
  "Do not add site-specific",
  "flow-appropriate",
  "Do not pad or truncate",
  "visual fidelity status",
  "capture viewport",
  "durable visible state",
  "transient state",
  "full labeled interaction box",
  "private-use icon glyph",
  "data-suppressed-placeholder-count"
]) {
  if (!skill.replace(/\s+/g, " ").includes(guidance)) {
    throw new Error(`SKILL.md is missing general visual-fidelity guidance: ${guidance}`);
  }
}
for (const guidance of [
  "Optional element-picker guidance",
  "Do not require or install an element picker",
  "untrusted temporary authoring hint",
  "exact visible label",
  "Do not invent same-step runtime behavior"
]) {
  if (!skill.replace(/\s+/g, " ").includes(guidance)) {
    throw new Error(`SKILL.md is missing optional element-picker guidance: ${guidance}`);
  }
}
const compatibility = JSON.parse(
  await readFile(path.join(skillRoot, "compatibility.json"), "utf8")
);
if (
  compatibility.schemaVersion !== "0.1" ||
  typeof compatibility.cli !== "string" ||
  typeof compatibility.playwright !== "string" ||
  compatibility.playwrightRequired !== false ||
  typeof compatibility.node !== "string" ||
  !["codex", "chatgpt", "claude-code", "claude-app"].every((host) =>
    compatibility.hosts?.includes(host)
  )
) {
  throw new Error("compatibility.json does not cover the supported app hosts.");
}
for (const host of ["codex", "claude-code", "claude-cowork"]) {
  const notes = await readFile(path.join(skillRoot, "agents", `${host}.md`), "utf8");
  if (!/approv|permission/i.test(notes) || !/publish|external/i.test(notes)) {
    throw new Error(`${host}.md must preserve dependency and external-action permissions.`);
  }
}
const browserNotes = await readFile(
  path.join(skillRoot, "agents", "codex-browser.md"),
  "utf8"
);
for (const requirement of [
  "getForUrl",
  'get("iab")',
  'get("extension")',
  "verifyOpenAIBrowserHostIsolation",
  "Page.createIsolatedWorld",
  'capabilities.get("cdp")',
  "Page.getFrameTree",
  "Runtime.evaluate",
  "DOMSnapshot",
  "domSnapshot()",
  "untrusted target-planning hint",
  "target-missing",
  "target-hidden",
  "target-duplicate",
  "confirmedActionIds",
  "session-captured",
  "Computer Use",
  "cookies",
  "local storage",
  "text `Range` rectangles",
  "Do not hand-tune"
]) {
  if (!browserNotes.includes(requirement)) {
    throw new Error(`codex-browser.md is missing ${requirement}.`);
  }
}
const claudeBrowserNotes = await readFile(
  path.join(skillRoot, "agents", "claude-browser.md"),
  "utf8"
);
for (const requirement of [
  "installed capability",
  "javascript_tool",
  "browser-isolation-unverified",
  "UnsupportedSurface",
  "Claude Cowork",
  "automatic recovery",
  "Do not ask “How do you",
  "static-source",
  "source-derived",
  "host-validated isolated",
  "newCDPSession()",
  "non-persistent",
  "zero canary matches"
]) {
  if (!claudeBrowserNotes.includes(requirement)) {
    throw new Error(`claude-browser.md is missing ${requirement}.`);
  }
}
const claudeCoworkNotes = await readFile(
  path.join(skillRoot, "agents", "claude-cowork.md"),
  "utf8"
);
for (const requirement of [
  "scripts/conformance.mjs",
  "checks.skill.installed: false",
  "compatibility.json",
  "without running the doctor's `npx skills add` recovery",
  "Do not install a duplicate skill"
]) {
  if (!claudeCoworkNotes.replace(/\s+/g, " ").includes(requirement)) {
    throw new Error(`claude-cowork.md is missing ${requirement}.`);
  }
}
const browserCapabilities = await readFile(
  path.join(skillRoot, "agents", "browser-capabilities.md"),
  "utf8"
);
for (const requirement of [
  "ChatGPT",
  "Codex",
  "Claude Code",
  "Claude Cowork",
  "Claude Desktop",
  "sourceHost",
  "non-persistent",
  "browser-isolation-unverified"
]) {
  if (!browserCapabilities.includes(requirement)) {
    throw new Error(`browser-capabilities.md is missing ${requirement}.`);
  }
}
for (const forbidden of [
  "createClaudeChromeEnvironmentScript",
  "createClaudeChromeSceneScript",
  "finalizeClaudeChromeSession"
]) {
  if (claudeBrowserNotes.includes(forbidden)) {
    throw new Error(
      `claude-browser.md must not expose unsafe live helper ${forbidden}.`
    );
  }
}
const fidelityReference = await readFile(
  path.join(skillRoot, "references", "visual-fidelity.md"),
  "utf8"
);
for (const requirement of [
  "createOpenAIPageAssetProvider",
  "pageAssetConsent",
  "non-generic fonts",
  "inline SVG",
  "pseudo-element",
  "appearance: none",
  "same CSS viewport",
  "document.fonts.ready",
  "data-text-layout",
  "data-text-metric-drift-count",
  "data-text-metric-fit-count",
  "data-text-multi-line-fragment-count",
  "data-text-collision-count",
  "Inspect the generated HTML itself",
  "0.8` through `1.25",
  "8` CSS pixels",
  "increase the capture resolution",
  "4 CSS pixels",
  "full-scene screenshot",
  "UnsupportedSurface",
  "Do not patch generated demo files",
  "`checked`, `incomplete`, or `blocked`"
]) {
  if (!fidelityReference.includes(requirement)) {
    throw new Error(`visual-fidelity.md is missing ${requirement}.`);
  }
}
const urlReference = await readFile(
  path.join(skillRoot, "references", "url-intake.md"),
  "utf8"
);
for (const requirement of [
  "showkit capture session <safe-envelope.json> --json",
  "mode `0600`",
  "3 to 7",
  "session-captured",
  "ci-replayable",
  "not a security, compliance, or approval guarantee"
]) {
  if (!urlReference.includes(requirement)) {
    throw new Error(`url-intake.md is missing ${requirement}.`);
  }
}
const browserAdapter = await readFile(
  path.join(skillRoot, "scripts", "capture-browser-session.mjs"),
  "utf8"
);
for (const exportName of [
  "browserSelectionPlan",
  "verifyOpenAIBrowserHostIsolation",
  "verifyCodexBrowserHostIsolation",
  "readOpenAIBrowserEnvironment",
  "readCodexBrowserEnvironment",
  "createOpenAIBrowserAdapter",
  "createCodexBrowserAdapter",
  "createOpenAIPageAssetProvider",
  "createCodexPageAssetProvider",
  "captureBrowserSession",
  "removeBrowserSessionEnvelope"
]) {
  if (!browserAdapter.includes(`export `) || !browserAdapter.includes(exportName)) {
    throw new Error(`Browser adapter is missing ${exportName}.`);
  }
}
for (const requirement of [
  "OPENAI_BROWSER_CDP_METHODS",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Runtime.evaluate",
  "approved-cdp-capability",
  "host-readonly-evaluate+approved-cdp-fallback"
]) {
  if (!browserAdapter.includes(requirement)) {
    throw new Error(`Browser adapter is missing approved CDP contract ${requirement}.`);
  }
}
for (const forbiddenMethod of [
  "Network.",
  "Storage.",
  "Fetch.",
  "DOMSnapshot.",
  "Browser.getCookies",
  "Network.getAllCookies"
]) {
  if (browserAdapter.includes(`send(\"${forbiddenMethod}`)) {
    throw new Error(
      `Browser adapter sends forbidden CDP command family ${forbiddenMethod}.`
    );
  }
}
for (const forbidden of [
  ".cookies(",
  ".localStorage",
  ".sessionStorage",
  ".history(",
  ".cua.",
  ".dom_cua."
]) {
  if (browserAdapter.includes(forbidden)) {
    throw new Error(`Browser adapter contains forbidden browser access: ${forbidden}`);
  }
}
if (
  browserAdapter.includes("tab.screenshot(") ||
  browserAdapter.includes("fullScreenshot") ||
  browserAdapter.includes("imageCropper") ||
  !browserAdapter.includes("tab.playwright.elementScreenshot")
) {
  throw new Error(
    "Browser adapter may use only a bounded element screenshot for an isolated text-free icon."
  );
}
if (
  !browserAdapter.includes("BrowserActionConfirmationRequired") ||
  !browserAdapter.includes("browser-isolation-unverified") ||
  !browserAdapter.includes("Page.createIsolatedWorld") ||
  !browserAdapter.includes("CODEX_BROWSER_VALIDATION") ||
  !browserAdapter.includes("TRUSTED_OPENAI_BROWSER_BUILDS") ||
  !browserAdapter.includes("OPENAI_BROWSER_VERIFIED_BINDINGS") ||
  browserAdapter.includes("locator.evaluate(nextPageFunction") ||
  browserAdapter.includes("body.evaluate(nextPageFunction") ||
  browserAdapter.includes("snapshot.includes(step.target.name)") ||
  !browserAdapter.includes("writeSessionEnvelopeTemporary") ||
  !browserAdapter.includes("ownedTab") ||
  !browserAdapter.includes('nodeMode: "json"') ||
  !browserAdapter.includes('"chunked-json"') ||
  !browserAdapter.includes('"pageAssets"') ||
  !browserAdapter.includes('"public", "fixture"') ||
  !browserAdapter.includes("262_144")
) {
  throw new Error(
    "Browser adapter must enforce confirmation, tree-preserving capture, private handoff, tab ownership, and public asset policy."
  );
}
const promotionExample = await readFile(
  path.join(skillRoot, "examples", "url-to-playwright.md"),
  "utf8"
);
if (
  !promotionExample.includes("@showkit/cli/playwright") ||
  !promotionExample.includes("demo.step(") ||
  !promotionExample.includes("showkit diff --base")
) {
  throw new Error("The URL promotion example must cover Playwright capture and diff.");
}
const headedChromeExample = await readFile(
  path.join(skillRoot, "examples", "headed-chrome-live.md"),
  "utf8"
);
for (const requirement of [
  'channel: "chrome"',
  "headless: false",
  "captureTarget",
  "non-persistent",
  "Page.createIsolatedWorld",
  "showkit capture temporary-live.spec.ts --viewport 1280x720 --preflight --json",
  "showkit capture temporary-live.spec.ts --viewport 1280x720 --json",
  "retained foreground"
]) {
  if (!headedChromeExample.includes(requirement)) {
    throw new Error(`headed-chrome-live.md is missing ${requirement}.`);
  }
}
const openChromeExample = await readFile(
  path.join(skillRoot, "examples", "open-chrome-routing.md"),
  "utf8"
);
for (const requirement of [
  "Use ShowKit for this site",
  "What product URL or currently open product flow should I use?",
  "1280×720",
  "Claude Cowork",
  "verifyOpenAIBrowserHostIsolation()",
  "Do not respond with",
  "Details → Approve",
  "exact confirmation"
]) {
  if (!openChromeExample.includes(requirement)) {
    throw new Error(`open-chrome-routing.md is missing ${requirement}.`);
  }
}
if (!skill.includes("installs agent instructions only")) {
  throw new Error("SKILL.md must separate skill installation from CLI installation.");
}
for (const requirement of [
  "Do not make the person install the CLI manually",
  "newly selected output folder",
  "npx skills add hyunghwan/showkit",
  "Customize → Plugins",
  "scripts/conformance.mjs",
  "checks.skill.installed: false",
  "Do not run the doctor's Skills CLI recovery",
  "Do not ask an open-ended routing question",
  "What product URL or currently open product flow should I use?",
  "1280×720",
  "one-shot reconnaissance browser",
  "do not override the host's action-safety policy",
  "Do not restart the browser",
  "Do not install Playwright for the primary setup",
  "flow-appropriate set of 3 to 7 ordered"
]) {
  if (!skill.replace(/\s+/g, " ").includes(requirement)) {
    throw new Error(`SKILL.md is missing one-command bootstrap guidance: ${requirement}`);
  }
}
for (const requirement of [
  '#scene-viewport[data-text-layout="checked"]',
  "data-text-metric-drift-count",
  "data-text-metric-fit-count",
  "data-text-multi-line-fragment-count",
  "data-text-collision-count"
]) {
  if (!skill.includes(requirement)) {
    throw new Error(`SKILL.md is missing generated HTML typography guidance: ${requirement}`);
  }
}
for (const forbidden of ["Build 5 ordered", "exactly five steps"]) {
  if (skill.includes(forbidden)) {
    throw new Error(`SKILL.md forces a fixed step count: ${forbidden}`);
  }
}
for (const placeholder of ["<owner>", "<org>", "TODO_SHOWKIT", "TBD_SHOWKIT"]) {
  for (const file of ["SKILL.md", "workflow.md", "agents/codex-browser.md", "agents/claude-browser.md"]) {
    const text = await readFile(path.join(skillRoot, file), "utf8");
    if (text.includes(placeholder)) {
      throw new Error(`${file} contains release placeholder ${placeholder}.`);
    }
  }
}
for (const requirement of [
  "player.chrome.mode",
  "`overlay`",
  "`frame`",
  "`tooltip`",
  "3×3",
  "`hidden`",
  "welcome.backdrop",
  "steps[].tooltip.backdrop",
  "player.navigation",
  "Ready to create your demo?",
  "Email us for a demo",
  "mailto:hello@sqncs.com",
  "theme.accent",
  "theme.fonts.heading",
  "remote font"
]) {
  if (!skill.includes(requirement)) {
    throw new Error(`SKILL.md is missing player layout guidance: ${requirement}.`);
  }
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    installTestedAgents: ["codex", "claude-code"],
    documentedHosts: [
      "codex",
      "chatgpt",
      "claude-code",
      "claude-cowork",
      "claude-app"
    ],
    browserSurfaces: ["iab", "chrome"],
    sourceModes: [
      "agent-browser-session",
      "static-source",
      "playwright-spec"
    ],
    playwrightRequired: false,
    files: requiredFiles.length,
    compatibility
  })}\n`
);
