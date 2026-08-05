---
name: showkit
description: Create and check a guided HTML interactive demo when someone asks ShowKit to use a site open in Chrome, bound static source, or an isolated Playwright flow.
---

# ShowKit

Use this skill when a person asks to create, update, check, compare, or preview
an interactive product demo from an open page in a compatible ChatGPT, Codex,
Claude Cowork, or Claude Code app, a codebase or static build, or an isolated
Playwright flow. Short requests such as “Use ShowKit for this site; it is open
in Chrome” are sufficient; do not make the person name a capture architecture.

## Product boundary

- ShowKit creates guided HTML interactive demos with hotspots and tooltips.
- The ShowKit CLI does not call an LLM. You write demo copy from captured
  evidence.
- A browser-session capture is `session-captured`. It is not Playwright-verified
  or CI-replayable until it is promoted to a Playwright source flow.
- A static capture is `source-derived`. It is bound to project-relative source
  hashes and is not browser-verified.
- Do not promise capture for every website. Capture supported rendered HTML and
  CSS with local content-addressed assets. Stop on canvas, WebGL, DRM media,
  closed shadow roots, cross-origin frames, or another surface that cannot be
  reproduced safely as interactive HTML.
- Apply the same source-faithful visual fidelity contract to every supported
  site. Do not add site-specific capture rules or patch one generated demo.
- A local preview is not published.
- Do not run `showkit publish` unless the person explicitly asks to publish and
  confirms the destination and visibility.
- Do not replace unsupported HTML content with a screenshot.

## Marketer route

The person may be a marketer who wants a product demo without writing a
Playwright test. Let the host agent handle the CLI, choose a new empty output
folder when none was named, and ask only when source access, private-content
choice, or an external permission is actually required.

- Work out the safest route from available capabilities. Do not end with “How
  do you want to get this flow into the demo?” or ask the person to choose
  between browser-session, static-source, and Playwright terminology.
- In Codex, use the selected Browser or Chrome host only after its installed
  isolation check passes.
- Establish the CSS capture viewport before browser capture. For a new demo
  when the person has not named an exact size, use **1280×720 — Standard
  desktop** and state that default without pausing for a choice. When replacing
  an existing demo, use its recorded viewport instead of silently changing its
  aspect ratio. Ask only when the person requests another size or the source
  cannot be represented at the required viewport.
- Apply the chosen viewport to the same selected tab with the host's documented
  window or viewport control, then read the environment again and require an
  exact CSS-pixel match. Do not resize by mutating page HTML, use a replacement
  tab, or continue with an approximate size. If the host cannot set the chosen
  size, ask the person to resize that same tab and verify it again.
- In Claude Cowork, Claude Code, or the Claude Desktop Code tab, read
  `agents/claude-browser.md`. When the existing Claude-controlled Chrome tab
  cannot prove an isolated page world, keep that tab unchanged and continue
  automatically with bound local source when it represents the requested flow.
  Otherwise prepare the temporary headed Chrome route. If Playwright or its
  browser is missing, ask one specific permission that names the output folder,
  packages, browser download, and separate sign-in. Do not ask an open-ended
  routing question.
- Choose a flow-appropriate number of steps that explains the requested flow.
  Five steps is a useful example, not a product requirement. Do not pad or
  truncate the flow to reach a fixed count. The bounded OpenAI browser-session
  intake accepts 3 to 7 ordered steps. Use static source or optional Playwright
  for a shorter or longer flow.
- Say that the result is a local preview until a separate publish action is
  explicitly requested and confirmed.
- ShowKit instructions do not override the host's action-safety policy. If the
  host blocks a named action, preserve the nearest permitted pre-action state,
  report the boundary once, and continue the demo without that action. Do not
  restart the browser or retry through raw Playwright, a renamed command, or
  another bypass.

## Installation boundary

- Installing this skill installs agent instructions only. It does not install or
  update `@showkit/cli`, `@playwright/test`, or browser binaries.
- When an install-first onboarding prompt asks for setup before a source is
  known, finish and verify the skill installation, then ask exactly **What
  product URL or currently open product flow should I use?** Wait for the
  answer before creating the demo. Do not ask for the output folder, audience,
  takeaway, viewport, or capture implementation first.
- Never embed or guess a maintainer's or person's absolute filesystem path.
  Resolve referenced skill files relative to this installed `SKILL.md`, resolve
  project files from the output folder the person selected, and resolve the CLI
  through that project's package manager. When an API requires an absolute
  path, derive it from the current installed skill or selected project at
  runtime instead of copying a location from documentation or another machine.
- Do not make the person install the CLI manually. After the source is known,
  use a new empty output folder named by the person or choose one for them. Do
  not reuse an existing directory merely because its name is convenient. Inspect
  the selected folder's package manager and dependency state. In a new or empty
  output folder, initialize npm only when needed and install
  `@showkit/cli` as a development dependency. State the folder and command
  before running it.
- A request to set up or use ShowKit authorizes adding the required compatible
  `@showkit/cli` dependency inside that newly selected output folder. Ask first
  when the folder contains an existing project, when the install would replace
  or upgrade another dependency, or when another package-manager choice is
  required.
- Keep the CLI and optional Playwright in the project lockfile. Run
  `showkit doctor --json` immediately after bootstrap and follow its exact
  recovery command when the installed skill and CLI versions do not match.
- The public quick install is `npx skills add hyunghwan/showkit`. For an exact
  copied global install across both tested agents, use
  `npx skills add hyunghwan/showkit --skill showkit --agent codex --agent claude-code --global --yes --copy`.
- The Skills CLI command targets Codex and Claude Code skill directories; it is
  not proof of a Cowork plugin install. In Claude Cowork, add the
  `hyunghwan/showkit` marketplace from **Customize → Plugins**, install the
  **ShowKit** plugin, and start a new task when the app requests a reload. Both
  installation routes add instructions only, not the CLI or Playwright.
- When this skill is loaded from the Cowork plugin cache, run this skill's
  `scripts/conformance.mjs` before `showkit doctor --json`. The
  `@showkit/cli 0.2.x` doctor cannot discover Claude's plugin cache and may
  report `checks.skill.installed: false`. If conformance passes and
  `doctor.cliVersion` satisfies this skill's `compatibility.json`, report the
  skill as loaded by Cowork and continue. Do not run the doctor's Skills CLI
  recovery or install a duplicate skill. Keep every other doctor failure and
  compatibility mismatch blocking.
- For team-versioned instructions, use the same command without `--global`.
- Do not install Playwright for the primary setup. Explain why it is needed and
  ask before adding `@playwright/test` or a browser binary for an optional
  headed-browser or CI route.

## Model and reasoning budget

Model selection belongs to the host agent; ShowKit itself never calls an LLM.
Do not pin a provider-specific model name or use the largest model and highest
reasoning setting for every step. Honor an explicit model request and the
host's safety policy. If the host cannot choose models per task, use its default
without blocking the workflow.

- Use a fast or lightweight model with low to medium reasoning for mechanical,
  reversible work: locating files, checking installed versions, running exact
  CLI commands, formatting known data, and rerunning deterministic checks.
- Use a balanced model with medium reasoning for the normal ShowKit workflow:
  source routing with clear evidence, evidence-bound demo copy, routine code or
  theme changes, and preview review against an established acceptance budget.
- Escalate to the most capable available model with high reasoning only for
  security or privacy decisions, ambiguous or conflicting evidence, architecture
  changes, unexplained fidelity failures, or recovery after a smaller model has
  failed. Use extra-high reasoning only when that complexity remains material.
- Return to a faster tier once the uncertain decision is resolved. Never lower
  the model or reasoning budget to bypass a stop condition, consent prompt,
  security check, or required human confirmation.

## Route the source

- Read `agents/browser-capabilities.md` first and route by verified capability,
  not only by the app name.
- Treat “ShowKit this site”, “use the page open in Chrome”, and equivalent short
  requests as authorization to inspect already granted capabilities, select a
  new output folder, install the compatible ShowKit CLI there, and build a local
  preview. They are not authorization to publish, expose private content,
  perform a state-changing action, or install optional Playwright.
- When the person gives an HTTP or HTTPS URL and ChatGPT or Codex has Browser
  or Chrome,
  read `agents/codex-browser.md` and `references/url-intake.md`, then use the
  verified OpenAI browser workflow in `workflow.md`.
- When a codebase or static build is available, use the static-source workflow.
- Claude built-in Chrome extraction is unavailable whenever the installed
  capability runs in page context and does not provide a host-validated
  isolated page world. Read `agents/claude-browser.md`, preserve the
  `UnsupportedSurface` diagnostic, and immediately run its automatic recovery
  order instead of returning an open-ended choice.
- In Claude Cowork, Claude Code, the Claude Desktop Code tab, or another
  terminal-capable host, use the optional codebase-free headed Chrome flow in
  `examples/headed-chrome-live.md` when no available bound source represents
  the requested live flow and the person approves Playwright. The fresh
  non-persistent context requires one sign-in in that temporary window and
  never copies an existing browser profile. Use one run-owned browser context
  from the sign-in readiness gate through the final captured step. Do not open
  a one-shot reconnaissance browser, close it, and relaunch another context.
- Use Playwright for that explicitly approved live flow, repeatable CI capture,
  or an existing trusted project-authored flow.
- Do not use Computer Use, screenshots, browser history, or a copied browser
  profile as a capture source.

## Required static-source workflow

1. Read `workflow.md`, `references/security.md`, and
   `references/visual-fidelity.md`.
2. Run `showkit doctor --capability static --json`.
3. Initialize the local project with `showkit init --json` when needed.
4. Build a safe semantic envelope with
   `createStaticCaptureEnvelope()`. Bind every input to its current
   project-relative path and SHA-256. Do not include raw source, secrets, remote
   URLs, scripts, or a full-scene raster in the envelope.
5. Run `showkit capture static <safe-envelope.json> --json`.
6. Report `sourceMode: "static-source"` and
   `replayLevel: "source-derived"`. Do not call the result browser-verified.
7. Create evidence-grounded demo content, run `showkit story apply`,
   `showkit validate`, `showkit build web,markdown`, and
   `showkit preview --json`.
8. Compare the preview with the intended rendered source before reporting
   visual fidelity as `checked`. Otherwise report `incomplete`.
9. Apply the same constrained theme, player, completion-card, accessibility,
   and publish boundaries below.

## Optional isolated Playwright workflow

1. Read `workflow.md`, `references/security.md`, and
   `references/visual-fidelity.md`.
2. For a codebase-free live page with installed Google Chrome, run
   `showkit doctor --capability playwright --browser-channel chrome --json`.
   For a project-authored CI flow that uses bundled Chromium, run
   `showkit doctor --capability playwright --json`.
3. If the project is not initialized, tell the person that `showkit init --json`
   creates local `.showkit/` files, then run it.
4. Reuse or create a Playwright spec that imports
   `@showkit/cli/playwright`, wraps product actions in `demo.step()`, and gives
   each step both its Playwright `target` and a serializable `captureTarget`.
   For a codebase-free live page, follow `examples/headed-chrome-live.md`.
5. Run `showkit capture <demo.spec.ts> --preflight --json` and require
   `status: "source-ready"` before opening a temporary browser.
6. Run `showkit capture <demo.spec.ts> --json` as a retained foreground
   process. For a live sign-in gate, keep the same process and context alive
   until capture finishes.
7. Read only the saved CaptureSource evidence needed to write the StorySpec. Do
   not inspect browser storage, headers, cookies, or raw product data.
8. Keep tooltip claims within captured visible text and action outcomes.
9. Default `player.chrome.mode` to `overlay` and fill the embed container.
   Start with `welcome.backdrop: "heavy"`. Keep step count and progress in
   `tooltip`, attach progress to the card's top edge, set
   `player.navigation: "controls"`, and show Back and Next during the tour.
   Show Restart demo only on the final card. Keep title and goal `hidden`. Use
   `frame` only when the person asks for separate compact rows. A requested
   optional control may move to a supported 3×3 slot or be `hidden`.
10. Limit card backdrop values to `off`, `light`, `medium`, or `heavy`. Set the
   welcome value in `welcome.backdrop` and each step value in
   `steps[].tooltip.backdrop`. A step backdrop must use a target spotlight: keep
   the current semantic target and its focus indicator fully visible while the
   rest of the HTML scene is dimmed. The welcome card has no target and may dim
   the full scene. Use `player.navigation: "hotspots"` only when the person
   wants Back and Next hidden.
11. Before the first StorySpec apply, show the exact theme defaults and ask whether to keep them
    or provide brand colors and local font stacks. The
    defaults are accent `#ff5a36`, ink `#17211b`, paper `#f3efe6`, and
    `"Avenir Next", Avenir, "Gill Sans", sans-serif` for heading and body.
    When the person requests brand styling, set `theme.accent`, `theme.ink`, and
    `theme.paper` with 6-digit hex colors. Set `theme.fonts.heading` and
    `theme.fonts.body` to safe local font stacks with fallbacks. Do not add a
    remote font URL, `@import`, or a runtime font request.
12. Require every player theme to pass ShowKit's WCAG 2.2 AA player checks:
    4.5:1 text contrast, 3:1 non-text control contrast, a two-color visible
    focus indicator, and 24 by 24 CSS pixel minimum control targets. If a
    requested theme fails, keep the previous demo unchanged, name the failed
    color pair, and ask for another color. Do not claim that captured product content itself is WCAG conformant.
13. Run `showkit story apply <story.json> --json`.
14. Run `showkit validate --json`.
15. Run `showkit build web,markdown --json`.
16. Run `showkit preview --json`, state that the URL is local and not
    published, then apply the general visual-fidelity contract at the capture
    viewport and once at a resized preview. Do not patch a generated scene to
    make the comparison pass.
17. Present the first local preview with its current backdrop, navigation,
    theme, and completion-card settings. Ask whether the person wants to change
    only those settings. Do not offer arbitrary radius, shadow, spacing,
    animation, or layout controls.
18. Include the default centered completion lead card with title **Ready to create your demo?**,
    body **Email us to discuss an interactive HTML demo
    for your product.**, action **Email us for a demo**, and destination
    `mailto:hello@sqncs.com?subject=ShowKit%20demo%20request`. With the first
    preview, ask whether to keep, change, or remove it. When changing it, ask
    for 1 or 2 button labels and their exact HTTP, HTTPS, or safe
    single-recipient `mailto:` destinations. Do not invent a Google Form,
    HubSpot form, signup page, or sales URL.
19. When an earlier manifest is available, run
   `showkit diff --base <artifact.json> --json`.

## Verified OpenAI app browser workflow

1. Read `agents/codex-browser.md`, `references/url-intake.md`,
   `references/security.md`, and `references/visual-fidelity.md`.
2. Run `showkit doctor --json` and initialize the local project when needed.
3. Inspect the installed Browser or Chrome plugin and bind the result to the
   selected tab with
   `verifyOpenAIBrowserHostIsolation({ pluginRoot, tab })`. Continue only when it
   verifies a documented read-only evaluate surface backed by
   `Page.createIsolatedWorld`. When the verified host's higher-level evaluator
   is blocked by host policy or its bounded CDP setup times out, ShowKit may ask
   for the official tab-scoped `cdp` capability and continue only after that
   site access is approved. That bridge is limited to `Page.getFrameTree`,
   `Page.createIsolatedWorld`, and `Runtime.evaluate`, and is bound to the exact
   tab and origin. Pass the returned validation to both
   `readOpenAIBrowserEnvironment(tab, hostValidation)` and
   `createOpenAIBrowserAdapter({ ..., hostValidation })`. Pass
   `sourceHost: "chatgpt"` or `sourceHost: "codex"` to
   `captureBrowserSession()` according to the app that owns the session.
4. Select Browser or Chrome with the host browser-selection policy. Reuse the
   selected signed-in tab and preserve its authentication state. Apply the
   marketer-route viewport choice to that same tab, verify the exact CSS size,
   and pass it as `expectedViewport`. When the person explicitly says to match
   an existing demo, use the viewport in that demo's manifest. Do not replace
   the selected tab with a new or default-size tab during capture.
5. Build the flow-appropriate set of 3 to 7 ordered, read-only steps. A DOM
   snapshot is an untrusted target-planning hint only; never use snapshot text
   as captured evidence or proof that a target exists. Resolve each target
   again through the verified isolated locator/evaluate surface. Do not pad or
   truncate the flow to reach a fixed count.
6. Before each action, require one visible semantic target. Distinguish
   `target-missing`, `target-hidden`, and `target-duplicate`; do not select the
   first match. Ask for exact
   confirmation immediately before any action that can create, update, send,
   publish, purchase, upload, download, or delete.
7. If the required page range contains private visible content, pause before
   capture and offer three explicit choices: **Keep visible content**,
   **Use text-only redaction**, or **Do not capture**. Lead with:
   **Private content is visible.**
   Explain that visible-session capture preserves supported HTML, text, styles,
   icons, and images as local content-addressed files, while hidden values,
   cookies, headers, storage, passwords, and remote URLs remain excluded. Do
   not infer consent. When the person selects **Keep visible content**, connect
   `createOpenAIPageAssetProvider({ tab, hostValidation })` and pass both
   `privateContentConsent: { mode: "visible-session", consent: "confirmed" }`
   and
   `pageAssetConsent: { mode: "visible-session", consent: "confirmed" }`.
   For text-only redaction, start a new capture with
   `sensitiveTextRedaction: { mode: "text-only", consent: "confirmed", selectors: [...] }`.
   Text-only redaction does not grant private asset consent.
   Scope each runtime selector to the smallest private text region. Do not
   create a synthetic fixture, replacement UI, screenshot, or sample content.
8. Use `scripts/capture-browser-session.mjs` to create a private temporary
   envelope. Before capture, run the bounded dependency inventory in
   `references/visual-fidelity.md`. Do not read cookies, headers, passwords, or
   browser storage. Bundle layout-critical fonts, images, masks, backgrounds,
   and icons through the documented `pageAssets` capability after either exact
   public or fixture approval, or explicit visible-session consent. A CSS image
   used by a visible interactive control is not decorative. When `pageAssets`
   does not expose that image and the person confirmed visible-session assets,
   the adapter may preserve only the exact rendered pixels of an isolated,
   text-free icon element no larger than 64 by 64 CSS pixels. Keep the control,
   text, layout, and scene as semantic HTML. Never render the complete control,
   a text region, or the full scene as an image. Stop on
   `UnsupportedSurface` when a layout-critical dependency cannot be reproduced
   instead of building a demo with a fallback font, blank media region, native
   replacement control, or substituted icon.
9. Run `showkit capture session <safe-envelope.json> --json`. The CLI deletes
   the temporary envelope on success or failure.
10. Create evidence-grounded demo content. Default `player.chrome.mode` to
   `overlay`, fill the embed container, start with a heavy welcome backdrop,
   keep step count and progress in `tooltip`, set
   `player.navigation: "controls"`, and keep title and goal `hidden` unless
   requested. Show Restart demo only on the final card.
11. Run
   `showkit story apply <story.json> --json`.
12. Run `showkit validate --json`, `showkit build web,markdown --json`, and
   `showkit preview --json`.
13. Apply `references/visual-fidelity.md` to the live source and local preview
    at the same CSS viewport and product state. Check task text and wrapping,
    primary layout, layout-critical assets, typography, control affordances,
    hotspot and internal control geometry, the complete capture-aspect scene,
    player-card clearance from every visible dialog, alert dialog, menu,
    listbox, or tooltip, and one resized preview. Use the stated 4 CSS pixel
    geometry budget. The current hotspot target must remain undimmed inside the
    step backdrop spotlight. A player card that overlaps a prominent captured
    component is a failed preview, including on the completion state. Follow
    the generic recovery ladder once. Do not hand-tune generated CSS, patch
    captured HTML, or add a site-specific rule. Report the visual fidelity
    status as `checked`, `incomplete`, or `blocked`; do not claim fidelity while
    a material difference remains.
14. State that the result was captured from a signed-in browser session, the
    preview is local, and it is not published.
15. Present the same constrained first-preview review: backdrop strength,
    controls or hotspots navigation, safe theme tokens, and an optional
    1- or 2-link completion card. Ask for exact destinations before adding lead
    actions.

## Stop conditions

- Pause on `SensitiveDataDetected`. State that ShowKit did not save the captured
  page and the previous demo has not changed. Ask the exact text-only redaction
  confirmation above. Continue only after an explicit yes. Otherwise stop.
- Text-only redaction changes only captured text nodes and textual accessibility
  attributes. It must preserve the supported element tree, computed styles,
  and hotspot geometry and must not mutate the live DOM. Passwords remain a
  stop condition.
- Stop on `UnsupportedSurface`. Do not create a screenshot fallback.
- Stop on `UnsupportedSurface` with `browser-isolation-unverified` before
  evaluating or saving a live page. Do not accept a page-provided capability
  claim or fall back to a main-world script.
- If the official Chrome `cdp` capability is needed, continue only after the
  host's exact-site approval. If it is absent, denied, or the selected tab
  leaves the approved origin, save nothing and start again from a supported
  tab. Never request or send `Network`, `Storage`, `Fetch`, cookie, or raw DOM
  snapshot commands.
- Stop on `BrowserAuthenticationRequired`. Ask the person to sign in in the
  selected browser and tell you when it is ready.
- Stop on `BrowserTargetAmbiguous`. Use the isolated target result to name
  `target-missing`, `target-hidden`, or `target-duplicate`, then narrow the
  target. Do not trust snapshot text or select the first match.
- Stop on `BrowserActionConfirmationRequired`. Do not perform the action without
  exact approval.
- Stop on `BrowserSessionInterrupted`. Keep the previous local demo unchanged
  and start a new capture from the selected tab.
- Stop on `HotspotAnchorDrift` or `CopyEvidenceDrift`. Capture the flow again or
  update only the affected demo content.
- Stop when the source-faithful acceptance budget still fails after the generic
  recovery ladder. Keep the previous demo unchanged and return
  `UnsupportedSurface`; do not add a site-specific workaround.
- Stop before any dependency installation, external network action, or publish
  action that the person did not authorize.

## Output

Report CLI readiness and capture readiness separately, then report the source
mode, replay level, captured step count, check result, visual fidelity status,
capture viewport, demo version, local output path, and local preview URL. Keep
captured, built, checked, previewed, and published states distinct.
