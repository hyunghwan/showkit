<p align="center">
  <img src="assets/showkit-logo.png" alt="ShowKit logo" width="160">
</p>

<h1 align="center">ShowKit</h1>

<p align="center">Turn a product flow into a guided interactive HTML demo.</p>

<p align="center">
  <a href="https://github.com/hyunghwan/showkit/actions/workflows/ci.yml"><img src="https://github.com/hyunghwan/showkit/actions/workflows/ci.yml/badge.svg" alt="CI"></a> ·
  <a href="https://showkit.sqncs.com">Website</a> ·
  <a href="https://hyunghwan.github.io/showkit/">Live demos</a> ·
  <a href="GETTING_STARTED.md">Getting started</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="SUPPORT.md">Support</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="LICENSE">MIT License</a>
</p>

ShowKit is an open-source toolkit for coding agents. It preserves supported
HTML, text, styles, and local assets, then builds a portable demo with hotspots
and tooltips. The result is interactive HTML, not a screenshot tour.

> [!NOTE]
> The ShowKit CLI is published as `@showkit/cli`. The ShowKit skill and CLI are
> separate installs: adding the skill does not change project dependencies,
> and the skill asks before it adds the CLI to an existing project.

<p align="center">
  <a href="https://showkit.sqncs.com">
    <img src="assets/showkit-landing.png" alt="ShowKit website landing page" width="960">
  </a>
</p>

<p align="center"><em>Explore the Airbnb, Linear, and Stripe demos on the <a href="https://hyunghwan.github.io/showkit/">public demo gallery</a>.</em></p>

The [checked product-insights example](examples/product-insights/) uses only
synthetic content. The public repository's Pages workflow publishes a gallery
that presents the same three demos as the ShowKit website. Those published
demos stay on `showkit.sqncs.com`, so their captured third-party assets are not
vendored under this repository's MIT license.

## Quick start

### Install and create your first demo

Requirements: Node.js 22.12+ or 24.

In Codex or Claude Code, paste this once:

> Install the ShowKit skill (not the CLI): run
> `npx skills add hyunghwan/showkit --skill showkit --agent codex --agent claude-code --global --yes --copy`.
> Read and follow the installed `SKILL.md`, verify the skill, then ask me
> exactly: “What product URL or currently open product flow should I use?”
> After I answer, follow the skill to set up a compatible CLI in a new folder
> and create, check, and preview the local demo. Ask only for required
> approvals. Do not publish.

For Claude Cowork, open **Customize → Plugins**, add the
`hyunghwan/showkit` marketplace, and install **ShowKit**. Both routes install
instructions only; they do not install `@showkit/cli`, Playwright, or a browser
binary.

If the skill is already installed, open the product flow in Chrome and ask
naturally:

> Use ShowKit for this site. The flow is open in Chrome. Build and preview a
> checked local interactive HTML demo. Do not publish.

The command adds the skill, not the CLI. After you answer, the skill creates a
new output folder, pins a compatible `@showkit/cli`, chooses a supported source,
checks the demo, and opens the local preview. It asks before changing an
existing project, adding optional Playwright or a browser, or preserving private
visible content or private-session page images. Required visible images from an
exact requested public URL are localized without another prompt. If the current
tab cannot pass ShowKit's isolation check, the skill explains the supported
fallback once. A local preview is not published.

The portable skill is documented for Codex, ChatGPT, Claude Cowork, Claude
Code, and the Claude Desktop Code tab. Automated Skills CLI installation tests
cover Codex and Claude Code; Cowork uses the Claude plugin marketplace. Every
app browser route still has to pass its installed capability checks. A local
preview is not published.

For a guided first run and a clear explanation of each lifecycle state, read
[`GETTING_STARTED.md`](GETTING_STARTED.md).

### Try another prompt

From a checked-in app or static build:

> Use ShowKit's static-source route to create a local interactive demo of this
> onboarding flow. Use the number of steps the flow needs and report the result
> as source-derived.

From a repeatable Playwright flow:

> Use ShowKit to turn this Playwright flow into a checked interactive demo that
> we can regenerate in CI. Install the optional Playwright dependency only if it
> is missing and I approve the change.

To update an existing demo:

> Rebuild this ShowKit demo from the current product flow, compare it with the
> previous version, and report what changed. Keep the result local.

### Point to a hotspot target

If your browser or coding environment already has an element picker, use it to
select a product element and paste the copied context into your coding agent.
Then describe the tooltip and step behavior you want:

> Use this as the hotspot target. When a viewer selects it, advance to the next
> demo step and show: “Choose CSV or PDF to continue.”

The picker is optional. You can instead give the target's exact visible label,
such as “Export report.” ShowKit does not install or depend on a picker. Your
coding agent uses pasted HTML, styles, screenshots, selectors, or source
locations only as a temporary hint, then resolves one supported target from the
source flow. Do not paste picker output that contains passwords, tokens,
personal data, or other content you would not send to your coding agent.

## What you can build

- Product onboarding and feature walkthroughs
- Release previews and launch demos
- Sales and customer-success product tours
- Repeatable demos generated from Playwright flows
- Portable HTML demos for any static host
- Optional Markdown release notes from the same captured evidence

## Capture routes

| Source | Best for | Extra dependency |
| --- | --- | --- |
| Verified ChatGPT or Codex Browser/Chrome | A supported signed-in product page | None in the output project |
| Static source | A codebase or checked-in HTML/CSS build | None |
| Isolated Playwright | A temporary headed browser or repeatable CI flow | Optional `@playwright/test` |

Browser-session capture continues only after the installed host passes
ShowKit's isolated, read-only check. Claude's built-in browser route is not used
when that isolation cannot be verified. The skill chooses available bound
source when it represents the requested flow; otherwise it prepares a separate
temporary Playwright browser and asks only for the required install permission
and separate sign-in.

Choose the number of steps that explains the flow. Five steps may be useful in
an example, but ShowKit does not pad or truncate every demo to a fixed count.
The bounded browser-session route accepts 3–7 ordered states; static-source and
Playwright flows may be shorter or longer.

## What ShowKit keeps out

ShowKit does not persist cookies, headers, passwords, tokens, browser storage,
raw DOM, request or response bodies, or remote asset URLs. It stops before
saving detected private data, unsupported visual surfaces, unsafe remote
assets, or a full-scene screenshot fallback.

A blocked capture leaves secret-free diagnostics and does not replace the
previous demo. Passing ShowKit checks is not a security, compliance, or
accessibility certification. Read [`SECURITY.md`](SECURITY.md) for the complete
trust boundary.

## Output

ShowKit builds selectable, semantic HTML with local content-addressed assets,
DOM-anchored hotspots, tooltips, keyboard navigation, progress, Back, Next, and
Restart demo. A small `Powered by ShowKit` link sits below the interactive
player layers in the bottom-right and opens the ShowKit website in a new tab.
The same captured input produces the same artifact hash.

Generated files live under `.showkit/artifacts/<content-hash>/`. Copy the whole
directory to a static host when you are ready to publish it separately.

## Manual CLI use

Most people can let the skill handle this. For a project-authored workflow:

```bash
npm install -D @showkit/cli
npx showkit doctor --json
npx showkit init --json
```

Add Playwright only for an approved headed-browser or CI flow:

```bash
npm install -D @playwright/test
npx showkit doctor --capability playwright --browser-channel chrome --json
npx showkit capture ./demo.spec.ts --viewport 1280x720 --preflight --json
```

This checks installed Google Chrome. If it is unavailable, install bundled
Chromium and rerun doctor without `--browser-channel chrome`.

The package exposes the `showkit` command, typed contracts from
`@showkit/cli`, the optional `@showkit/cli/playwright` fixture, and generated
JSON Schemas. See [`packages/cli/README.md`](packages/cli/README.md) for the
package reference.

## Documentation

- [`GETTING_STARTED.md`](GETTING_STARTED.md): build and inspect a first local demo
- [`ARCHITECTURE.md`](ARCHITECTURE.md): understand the deterministic pipeline and trust boundary
- [`packages/cli/README.md`](packages/cli/README.md): CLI, package exports, schemas, and exit codes
- [`COMPATIBILITY.md`](COMPATIBILITY.md): supported Node.js, browser, skill, and schema versions
- [`SECURITY.md`](SECURITY.md): safe-use boundary and private vulnerability reporting
- [`SUPPORT.md`](SUPPORT.md): questions, bug reports, and useful diagnostics
- [`CHANGELOG.md`](CHANGELOG.md): release history

## Development

```bash
corepack pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm docs:check
pnpm check
pnpm build
pnpm test
```

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) before opening a pull request.

## License

ShowKit is available under the [MIT License](LICENSE). Dependency license
details are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
