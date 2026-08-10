# Compatibility

ShowKit `0.2.x` is the current declared compatibility window. Readers reject
unknown fields, and any future incompatible schema version must ship with an
explicit reader migration before the supported range changes.

| Surface | Supported range |
|---|---|
| Node.js | `>=22.12 <25`; release CI tests current 22.x and 24.x |
| OpenAI Browser or Chrome live capture | Codex or ChatGPT host must pass the installed isolated read-only world check |
| Claude Cowork and Claude Code | Skill supported; existing Claude-controlled tab capture remains blocked when an isolated page world cannot be verified, then routes automatically to bound source or approved isolated Playwright |
| Static-source capture | Built into `@showkit/cli`; Playwright is not required |
| `@playwright/test` | Optional trusted CI replay, `>=1.60.0 <2` |
| Public web capture | Fresh signed-out HTTP or HTTPS pages with supported semantic HTML, localizable visible images, static SVG backgrounds, and WOFF2 fonts; video, large canvas, maps, cross-origin frames, and closed or interactive shadow surfaces remain fail-closed |
| ShowKit skill | `@showkit/cli >=0.2.10 <0.3.0` |
| Capture and StorySpec schema | `0.1` |
| Player browsers | Current Playwright Chromium, Firefox, and WebKit in release checks |

Within the `0.2.x` skill compatibility file, Claude Cowork uses the existing
`claude-app` host identifier. Keeping that identifier lets an updated skill
work with already released `@showkit/cli@0.2.x` readers.
The `0.2.x` CLI does not search Claude's plugin cache, so a Cowork-loaded
skill runs its bundled conformance check and compares the reported CLI version
before continuing; it does not duplicate the skill into a Claude Code
directory.

Run `showkit doctor --json` after installing or updating the skill. It reports
`cli-ready`, skill scope, project initialization, and each capture path
separately. Run `showkit doctor --capability playwright --json` only for the
optional bundled-Chromium route, or add `--browser-channel chrome` to verify
installed Google Chrome without downloading bundled Chromium. Run
`showkit capture <demo.spec.ts> --viewport 1280x720 --preflight --json` before a person signs in;
this checks file discovery and module loading without running the test. A
mismatch returns exit code `3`, detected and supported versions, and an exact
recovery command. Updating the skill never updates project dependencies.

## Host verification

OpenAI Browser and Chrome capture is enabled only after the installed host
passes ShowKit's isolated, read-only verification. Every installed host is
checked again rather than inheriting a result from another build. Claude's
built-in browser route remains blocked when it cannot expose an equivalent
host-validated isolated world. The installed skill does not ask the person to
choose a capture implementation: it uses available bound source when that
represents the requested flow, or prepares the separate Playwright route and
asks only for the required dependency and sign-in permission.

The CI compatibility matrix covers current Node.js 22.x and 24.x on Linux, macOS, and
Windows. The release browser gate covers the Playwright-managed Chromium,
Firefox, and WebKit versions installed from the lockfile.
