# Getting started

This guide takes you from a product flow to a checked local interactive HTML
demo. Nothing in this workflow publishes or uploads the result.

## Requirements

- Node.js 22.12+ or 24
- a coding agent that can use the ShowKit skill, or a project where you can
  install `@showkit/cli`
- public or synthetic content for a first run

Do not begin with credentials, customer data, private product captures, or an
authenticated flow that you are not allowed to reproduce.

## Release status

The ShowKit skill is available from the public repository, and
`@showkit/cli` is available from npm. Installing the skill does not install or
update the CLI. A GitHub source update and an npm package release remain
separate publication states.

## Use ShowKit with a coding agent

1. In Codex or Claude Code, paste this install-first request:

   > Install the ShowKit skill (not the CLI): run
   > `npx skills add hyunghwan/showkit --skill showkit --agent codex --agent claude-code --global --yes --copy`.
   > Read and follow the installed `SKILL.md`, verify the skill, then ask me
   > exactly: “What product URL or currently open product flow should I use?”
   > After I answer, follow the skill to set up a compatible CLI in a new folder
   > and create, check, and preview the local demo. Ask only for required
   > approvals. Do not publish.

   This installs the skill instructions. It does not install or update your
   project's dependencies. In Claude Cowork, open **Customize → Plugins**, add
   the `hyunghwan/showkit` marketplace, and install **ShowKit** instead. The
   Cowork plugin also installs instructions only.

2. Reply with the public or synthetic product URL, or say that the flow is open
   in Chrome. If the skill was already installed, this short request is enough:

   > Use ShowKit for this site. The flow is open in Chrome. Build and preview a
   > checked local interactive HTML demo. Do not publish.

3. Review the first preview. Confirm the default colors and local font stacks,
   and keep, change, or remove the default completion email link. Check every
   step, Back and Next navigation, keyboard focus, and the final Restart demo
   action.

The skill chooses a supported source and reports the local output path. It does
not ask you to compare capture implementations. If the current browser cannot
prove an isolated read-only page world, the skill uses granted bound source or
one separate non-persistent browser. It asks once before adding optional
Playwright or a browser and keeps the same temporary context from sign-in
through capture.
For an exact requested public URL, the temporary flow keeps required visible
images as verified local assets without another prompt. Signed-in or private
session images still require one confirmation. ShowKit does not save their
source URLs, cookies, headers, or browser storage. This supports public HTML
flows with semantic controls and safely reproducible local assets; visible
video, large canvas, maps, cross-origin frames, and other unsupported surfaces
still stop before capture instead of becoming screenshots.

## Use the CLI directly

Install and initialize ShowKit in a project:

```bash
npm install -D @showkit/cli
npx showkit doctor --json
npx showkit init --json
```

Then choose one source route:

```bash
# Import a sanitized envelope created from bound static source.
npx showkit capture static ./safe-envelope.json --json

# Or run a repeatable Playwright flow after installing the optional peer.
npm install -D @playwright/test
npx showkit doctor --capability playwright --browser-channel chrome --json
npx showkit capture ./demo.spec.ts --preflight --json
npx showkit capture ./demo.spec.ts --json
```

Complete the local lifecycle:

```bash
npx showkit validate --json
npx showkit build web,markdown --json
npx showkit preview --json
```

`preview` serves the latest built demo on `127.0.0.1`. Stop it with
<kbd>Control</kbd>+<kbd>C</kbd>. Copy the complete artifact directory to a
static host only after you have reviewed it and chosen to publish separately.

## Know what ShowKit proved

| State | What it means | What it does not mean |
| --- | --- | --- |
| Captured | Supported product states were sanitized and saved locally | The demo was built or approved |
| Built | Portable HTML and local assets were generated | The result passed every check |
| Checked | ShowKit's verification and player checks passed | Source content is secure, compliant, or WCAG conformant |
| Previewed | A local server displayed the built files | The demo is public |
| Published | You separately copied the reviewed files to a host | ShowKit uploaded them for you |

The current ShowKit release is local-only. `showkit publish` verifies the local
publish gate and then reports that Cloud publishing is unavailable; it uploads
nothing.

## Troubleshooting

- Exit code `2`: fix the reported input or validation rule and retry.
- Exit code `3`: install or select the dependency named in the recovery action.
- Exit code `4`: an external capability is unavailable; the output remains local.
- Exit code `70`: preserve the secret-free error code and open a bug report.

Run `npx showkit doctor --json` after changing Node.js, updating the skill, or
changing capture routes. See [`SUPPORT.md`](SUPPORT.md) before sharing logs or
reproductions.
