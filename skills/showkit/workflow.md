# ShowKit workflow

When the selected output folder does not have a compatible `@showkit/cli`,
bootstrap it through the installation boundary in `SKILL.md`. Do not hand the
person a separate CLI setup task. Keep the installed version in the output
folder's lockfile, then run `showkit doctor --json` before choosing a capture
route. Playwright remains optional and requires separate approval.

The CLI writes machine-readable JSON to stdout and progress for people to
stderr. Treat a nonzero exit code as blocked even when a previous local demo
still exists.

`showkit doctor --json` reports `cli-ready` separately from capture readiness.
Do not turn an installed CLI, installed skill, initialized project, or open
browser into a stronger readiness claim.

## Verified OpenAI app browser session

Use this route only after the installed Browser or Chrome host and exact
selected tab pass
`verifyOpenAIBrowserHostIsolation({ pluginRoot, tab })`.

```text
showkit doctor --json
showkit init --json
<verified OpenAI app adapter creates a mode 0600 OS temporary envelope>
showkit capture session <safe-envelope.json> --json
showkit story apply <story.json> --json
showkit validate --json
showkit build web,markdown --json
showkit preview --json
```

Pass the returned host validation to
`readOpenAIBrowserEnvironment(tab, hostValidation)` and
`createOpenAIBrowserAdapter({ ..., hostValidation })`. Pass the app owner as
`sourceHost: "chatgpt"` or `sourceHost: "codex"` to
`captureBrowserSession()`. The host must document a
read-only evaluate surface and implement `Page.createIsolatedWorld` with a
host-owned read-only wrapper.

The browser host selects and operates the tab. The ShowKit CLI validates and
imports only the safe temporary envelope. It never reads cookies, headers,
passwords, browser storage, request bodies, response bodies, or raw DOM.

A `domSnapshot()` is an untrusted target-planning hint only. Re-resolve every
target through the isolated locator/evaluate surface. Require one visible
semantic match and classify missing, hidden, and duplicate targets separately.
Never persist snapshot text or use it as tooltip evidence.

Choose the number of read-only steps that explains the requested flow. Do not
pad or truncate a flow to reach five steps. The bounded OpenAI browser-session
intake accepts 3 to 7 ordered steps. Use static source or optional Playwright
when the flow needs a shorter or longer sequence.
Stop for exact confirmation before an external create, update, send, publish,
purchase, upload, download, permission, security, legal, or delete action.

Private visible content is a separate confirmation. Offer **Keep visible
content**, **Use text-only redaction**, or **Do not capture**. Do not infer
consent. When the person keeps visible content, connect
`createOpenAIPageAssetProvider({ tab })` and pass both confirmed
`privateContentConsent` and `pageAssetConsent`. Text-only redaction does not
grant private asset consent.

After import, report `sourceMode: "agent-browser-session"` and
`replayLevel: "session-captured"`. Do not call it Playwright-verified or
CI-replayable.

## Static source without Playwright

Use this route for a codebase or checked-in static build:

```text
showkit doctor --capability static --json
showkit init --json
<agent creates a sanitized envelope bound to project-relative source hashes>
showkit capture static <safe-envelope.json> --json
showkit story apply <story.json> --json
showkit validate --json
showkit build web,markdown --json
showkit preview --json
```

Create the envelope with `createStaticCaptureEnvelope()`. Include only
sanitized semantic scenes, evidence, geometry, approved local assets, and a
unique sorted inventory of project-relative source paths and SHA-256 values.
The CLI re-hashes every regular non-symlink source file before atomic import.

Report `sourceMode: "static-source"` and `replayLevel: "source-derived"`.
This proves which source files were bound; it does not prove that a browser
render matches. Compare the local preview with the intended rendered source
before reporting visual fidelity as `checked`. Otherwise report `incomplete`.

## Claude app browser routing

When Claude's installed built-in Chrome capability exposes only a page-context
`javascript_tool`, return
`UnsupportedSurface` with `browser-isolation-unverified`. Its
`javascript_tool` contract does not provide a host-validated isolated page
world. Do not run the extractor, environment script, scene script, or finalizer
in the page's main JavaScript realm. Save nothing and keep the previous demo
unchanged.

Offer static source or, when terminal and file access are available, the
codebase-free headed Chrome route in `examples/headed-chrome-live.md`. That
route uses public Playwright APIs, a fresh non-persistent context, and
`Page.createIsolatedWorld`; it does not use Claude's page-context
`javascript_tool` for extraction. Do not install Playwright without permission.

## Optional isolated Playwright capture

Use this when the person explicitly approves the codebase-free headed Chrome
flow, wants repeatable CI capture, or selects an existing trusted
project-authored flow:

```text
showkit doctor --capability playwright --json
showkit init --json
showkit capture <demo.spec.ts> --json
showkit story apply <story.json> --json
showkit validate --json
showkit build web,markdown --json
showkit preview --json
```

Use `@showkit/cli/playwright`, not Playwright trace internals:

```ts
import { test } from "@showkit/cli/playwright";

test("captures onboarding", async ({ page, demo }) => {
  const target = page.getByRole("button", { name: "Create workspace" });
  await demo.step({
    id: "create-workspace",
    title: "Create your first workspace",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Create workspace"
    },
    action: () => target.click()
  });
});
```

The `target` performs the Playwright action. ShowKit resolves the serializable
`captureTarget` again inside its Chromium CDP isolated world before the action.
Both must match one visible semantic element. Each tooltip must cite the
evidence IDs captured for that step. Report this route as `ci-replayable`.

## Shared completion

After a supported capture:

1. Write demo content only from captured evidence.
2. Apply the constrained theme, player chrome, backdrop, navigation, and
   completion-card choices in `SKILL.md`.
3. Run `story apply`, `validate`, `build`, and local `preview`.
4. Compare the source and preview at the capture viewport and once after
   resizing. Report visual fidelity as `checked`, `incomplete`, or `blocked`.
5. Keep captured, built, checked, previewed, and published states distinct.
6. Publish only after a separate explicit request and destination confirmation.

A local preview is not published. Passing ShowKit checks is not a security,
compliance, or approval guarantee.
