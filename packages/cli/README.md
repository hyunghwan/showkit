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
| `showkit capture <demo.spec.ts> --preflight --json` | Verify Playwright discovers and loads the flow without running its test or opening its configured browser |
| `showkit capture static <safe-envelope.json> --json` | Import a sanitized static-source envelope without Playwright |
| `showkit capture session <safe-envelope.json> --json` | Import a temporary browser envelope after host isolation succeeds |
| `showkit capture <demo.spec.ts> --json` | Run an approved Playwright fixture |
| `showkit story apply <story.json> --json` | Check and immutably save demo content for the latest capture |
| `showkit validate --json` | Run evidence, player, and artifact checks |
| `showkit build web,markdown --json` | Build portable HTML and optional Markdown output |
| `showkit diff --base <artifact.json> --json` | Compare the latest artifact with an earlier manifest |
| `showkit diff --base <artifact.json> --check --json` | Fail when the demo is out of date |
| `showkit preview --json` | Serve the latest artifact on `127.0.0.1` |
| `showkit publish --version <hash> --json` | Recheck the local publish gate; the current local-only release uploads nothing |

Use `showkit help` to return the command list as JSON.

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

## Package exports

- `@showkit/cli`: Zod schemas, TypeScript types, static and browser envelope
  helpers, the scene extractor, image crop helper, URL sanitizer, security
  checks, stable exit codes, and `ShowKitError`
- `@showkit/cli/playwright`: the optional `demo.step()` fixture for repeatable
  capture flows
- `@showkit/cli/schema/*.json`: generated JSON Schemas for capture, story,
  artifact, verification, quality, fixture, and compatibility contracts

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
