# Compatibility

ShowKit `0.2.x` is the current declared compatibility window. Readers reject
unknown fields, and any future incompatible schema version must ship with an
explicit reader migration before the supported range changes.

| Surface | Supported range |
|---|---|
| Node.js | `>=22 <25`; release CI tests 22 and 24 |
| OpenAI Browser or Chrome live capture | Codex or ChatGPT host must pass the installed isolated read-only world check |
| Built-in Claude browser live capture | Blocked when an isolated read-only page world cannot be verified; use static source or approved isolated Playwright |
| Static-source capture | Built into `@showkit/cli`; Playwright is not required |
| `@playwright/test` | Optional trusted CI replay, `>=1.60.0 <2` |
| ShowKit skill | `@showkit/cli >=0.2.0 <0.3.0` |
| Capture and StorySpec schema | `0.1` |
| Player browsers | Current Playwright Chromium, Firefox, and WebKit in release checks |

Run `showkit doctor --json` after installing or updating the skill. It reports
`cli-ready`, skill scope, project initialization, and each capture path
separately. Run `showkit doctor --capability playwright --json` only for the
optional Playwright route. A mismatch returns exit code `3`, detected and
supported versions, and an exact recovery command. Updating the skill never
updates project dependencies.

## Host verification

OpenAI Browser and Chrome capture is enabled only after the installed host
passes ShowKit's isolated, read-only verification. Every installed host is
checked again rather than inheriting a result from another build. Claude's
built-in browser route remains blocked when it cannot expose an equivalent
host-validated isolated world; use static source or the separate Playwright
route instead.

The CI compatibility matrix covers Node.js 22 and 24 on Linux, macOS, and
Windows. The release browser gate covers the Playwright-managed Chromium,
Firefox, and WebKit versions installed from the lockfile.
