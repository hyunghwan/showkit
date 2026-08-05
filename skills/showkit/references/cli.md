# CLI contract

| Command | Effect |
|---|---|
| `showkit doctor --json` | Reports CLI, skill, project, and capture readiness separately without requiring Playwright |
| `showkit doctor --capability static --json` | Checks the Playwright-free static-source capability |
| `showkit doctor --capability openai-browser --json` | Reports that ChatGPT or Codex live capture still needs host-session isolation verification |
| `showkit doctor --capability codex-browser --json` | Backward-compatible alias for the OpenAI browser readiness check |
| `showkit doctor --capability claude-browser --json` | Reports the blocked built-in Claude Chrome route and the optional isolated Playwright fallback |
| `showkit doctor --capability playwright --json` | Checks the optional isolated Chromium runtime for headed live capture or CI |
| `showkit doctor --capability playwright --browser-channel chrome --json` | Checks optional Playwright with installed system Chrome, without requiring bundled Chromium |
| `showkit init --json` | Creates reversible `.showkit/` project files |
| `showkit capture <demo.spec.ts> --preflight --json` | Verifies Playwright file discovery and module loading without running the test or opening its configured browser |
| `showkit capture session <safe-envelope.json> --json` | Rechecks and atomically imports a private browser-session derivative, then deletes the temporary file |
| `showkit capture static <safe-envelope.json> --json` | Verifies bound project source hashes and atomically imports a source-derived semantic envelope |
| `showkit capture <spec> --json` | Runs an optional isolated Playwright source flow and saves an immutable safe derivative |
| `showkit story apply <file> --json` | Checks and saves demo content |
| `showkit validate --json` | Checks the current demo without changing it |
| `showkit build web,markdown --json` | Creates replaceable local files |
| `showkit preview --json` | Starts a loopback-only local server |
| `showkit diff --base <manifest> --json` | Compares 2 demo versions without changing them |
| `showkit diff --base <manifest> --check --json` | Fails CI when the demo is out of date |
| `showkit publish --version <hash> --json` | Rechecks the local publish gate; Cloud remains unavailable in the local-only release |

Exit codes are `0` for success, `2` for validation, `3` for environment,
`4` for external service, and `70` for an internal bug.

Successful Playwright capture JSON can include `capturePerformance` with the
number of fresh HTML scene extractions, actions, and their elapsed time. The
agent-browser session helper also reports asset-preparation and action-settle
time. These values are runtime diagnostics only: they are not written into the
captured product flow, demo content, content hash, or exported files.

`htmlSceneCount` counts sanitized, editable HTML states. It never counts a
full-scene screenshot. ShowKit does not reuse a complete HTML scene across
steps; a new safe derivative is required so that changed content, computed
presentation, unsupported surfaces, and sensitive-data policy are checked
again.
