# @showkit/cli

Build a guided interactive HTML demo from bound static source, a verified
browser session, or an isolated Playwright flow. ShowKit produces portable
semantic HTML and local assets; it does not host an LLM or require an account.

Requires Node.js 22.12+ or 24.

The CLI and portable skill are released separately. Installing this package
does not install or update the skill.

## Install

```bash
npm install -D @showkit/cli
npx showkit doctor --json
npx showkit init --json
```

`doctor` reports CLI readiness and each capture capability separately.
Installing the ShowKit skill does not install this package or update project
dependencies.

For a coding-agent workflow, paste this into Codex or Claude Code:

> Install the ShowKit skill (not the CLI): run
> `npx skills add hyunghwan/showkit --skill showkit --agent codex --agent claude-code --global --yes --copy`.
> Read and follow the installed `SKILL.md`, verify the skill, then ask me
> exactly: “What product URL or currently open product flow should I use?”
> After I answer, follow the skill to set up a compatible CLI in a new folder
> and create, check, and preview the local demo. Ask only for required
> approvals. Do not publish.

In Claude Cowork, add the `hyunghwan/showkit` marketplace from
**Customize → Plugins** and install **ShowKit**. The skill and plugin install
instructions only; they do not install this package.

## Commands

Commands write one JSON result to stdout. Human progress and recovery guidance
belong on stderr.

| Command | Result |
| --- | --- |
| `showkit doctor --json` | Report CLI, skill, host, project, and optional Playwright readiness |
| `showkit init --json` | Create the local `.showkit/` project structure |
| `showkit capture <demo.spec.ts> --viewport 1280x720 --preflight --json` | Verify Playwright discovers and loads the flow with the default capture contract without running its test or opening its configured browser |
| `showkit capture static <safe-envelope.json> --json` | Import a sanitized static-source envelope without Playwright |
| `showkit capture session <safe-envelope.json> --json` | Import a temporary browser envelope after host isolation succeeds |
| `showkit capture <demo.spec.ts> --viewport 1280x720 --project <name> --json` | Run one approved Playwright fixture project at the default capture viewport; omit `--project` when the config has one project |
| `showkit story apply <story.json> --json` | Check and immutably save demo content for the latest capture |
| `showkit validate --json` | Run evidence, player, and artifact checks |
| `showkit build web,markdown --json` | Build portable HTML and optional Markdown output |
| `showkit diff --base <artifact.json> --json` | Compare the latest artifact with an earlier manifest |
| `showkit diff --base <artifact.json> --check --json` | Fail when the latest built files differ from an earlier version |
| `showkit diff --base <artifact.json> --source <demo.spec.ts> --project <name> --check --json` | Replay the current Playwright source flow and fail when a demo step is out of date; omit `--project` to reuse the project stored in the earlier demo |
| `showkit preview --json` | Serve the latest artifact on `127.0.0.1` |
| `showkit publish --version <hash> --json` | Recheck the local publish gate, then publish that exact checked version to ShowKit's fixed first-party hosted service |

Use `showkit help` to return the command list as JSON.

The source freshness check runs the approved Playwright project with one worker
in a temporary directory. It writes no ShowKit capture, run, operation log, or
built demo. Its JSON reports each selected step as `fresh`, `reached`,
`failed`, or `skipped`, states that the previous demo did not change, and gives
a recovery action for each failed result. A step is `reached` when the source
flow reached it before a later failure but ShowKit could not complete the
comparison. Later steps are `skipped` because their page state is unknown.
By default it reuses the Playwright project stored in the earlier demo. Pass
`--project <name>` when that project was renamed or a different configured
project is the intended replacement.

This check still executes every Playwright step action against the selected
product environment. Use a fixture or test-safe account, and review any
mutating action before running it. “The previous demo did not change” describes
ShowKit's local files; it does not claim that source product actions are
read-only.

New Playwright captures default to 1280×720. Pass the same viewport to
preflight and capture. Use another `WIDTHxHEIGHT` value only for an exact
requested size or an existing demo, and set the Playwright flow to that same
fixed viewport.

## Capture routes

Static-source import is built in. A browser-session envelope is accepted only
after the installed OpenAI Browser or Chrome host passes ShowKit's isolated,
read-only execution check.

For CI replay or an explicitly approved temporary headed browser flow, add the
optional peer:

```bash
npm install -D @playwright/test
npx showkit doctor --capability playwright --browser-channel chrome --json
```

The browser-channel command verifies installed Google Chrome without requiring
a bundled Chromium download. Omit `--browser-channel chrome` and run
`npx playwright install chromium` when system Chrome is unavailable. Before a
person signs in to a temporary browser, run capture once with `--preflight` so
file discovery and module loading fail before the real test run.

Supported Playwright versions are `>=1.60.0 <2`. ShowKit uses public fixture,
page, and locator APIs; trace internals are never build input.

When an exact requested public page needs a visible remote image, the first
`demo.step()` accepts
`pageAssetConsent: { mode: "public-page", consent: "requested" }`. No separate
image prompt is needed in a fresh, signed-out context. A private or signed-in
flow instead requires explicit consent and uses
`pageAssetConsent: { mode: "visible-session", consent: "confirmed" }`. ShowKit
uses a fresh public-network request with no cookies, authorization, or referrer,
rejects local and private addresses, verifies the bytes, and stores only
content-addressed local assets. It does not save the source asset URL. Public
CSS may be read transiently, up to 4 MB in aggregate, to locate a required
visible WOFF2 font; the CSS is never captured. A static complex SVG sprite may
be rendered only as the exact bounded background layer in a network-blocked,
JavaScript-disabled context; its source bytes are not saved. Missing or invalid
critical assets still stop the capture. A confirmed visible-session capture has
one text-font exception: when exact loaded font bytes remain unavailable,
ShowKit may use its fixed system font stack only when fixed non-page Latin,
Korean, and CJK metric samples remain within `0.8` through `1.25` on both axes.
Icon fonts and out-of-range text fonts still stop the capture. If an observed
public WOFF2 filename is opaque, ShowKit compares fixed non-page text metrics in
a separate network-blocked context and accepts only one unique content-hash
match.
Playwright capture removes only unresolved non-interactive decoration by
default and records that exclusion. Set `remoteAssetPolicy: "strict"` on the
first `demo.step()` when every visible decorative asset must be reproduced;
outside the bounded text-font exception above, targets, controls, and
layout-critical assets always remain fail-closed.

Give `captureTarget.name` the exact accessible name when it is known. If the
name is omitted, ShowKit may recover it from bounded semantic sources on the
same target and then verify the exact Playwright identity. If no bounded name
can be verified, capture stops with `capture-target-name-required` and asks for
the exact name instead of using a site-specific selector or visible-text
workaround.

## Package exports

- `@showkit/cli`: Zod schemas, TypeScript types, static and browser envelope
  helpers, the scene extractor, image crop helper, URL sanitizer, security
  checks, stable exit codes, and `ShowKitError`
- `@showkit/cli/playwright`: the optional `demo.step()` fixture for repeatable
  capture flows
- `@showkit/cli/schema/*.json`: generated JSON Schemas for capture, story,
  artifact, verification, quality, freshness, fixture, and compatibility
  contracts

The Zod schemas are the runtime source of truth. Readers reject unknown fields
and unsupported schema versions.

## Output

`showkit init` creates `.showkit/` in the current project. Captures, demo
content, and artifacts are immutable. Publishable files live in:

```text
.showkit/artifacts/<content-hash>/
```

A built artifact contains semantic HTML, local content-addressed assets, an
artifact manifest, and verification and quality reports. The same captured
input and demo content produce the same artifact hash.

The default player fills its embed container, starts with a welcome card,
keeps step progress on the tooltip's top edge, shows Back and Next during the
tour, and shows Restart demo only on the final card. A small bottom-right
`Powered by ShowKit` link opens the ShowKit website in a new tab and stays
below hotspots, tooltips, controls, and the welcome layer. Theme values must
pass the player's WCAG 2.2 AA contrast checks. These checks cover ShowKit
player chrome, not the accessibility of captured product content.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Input or validation failure |
| `3` | Environment or dependency failure |
| `4` | External capability failure |
| `70` | Unexpected internal failure |

Expected failures include a named error and a specific recovery action. A
blocked capture leaves no captured product flow, HTML derivative, screenshot,
or asset; only secret-free diagnostics may remain.

See the repository
[getting-started guide](https://github.com/hyunghwan/showkit/blob/main/GETTING_STARTED.md),
[compatibility policy](https://github.com/hyunghwan/showkit/blob/main/COMPATIBILITY.md),
and [security policy](https://github.com/hyunghwan/showkit/blob/main/SECURITY.md).
