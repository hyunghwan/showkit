# Create a demo from static source

Use this route when a codebase or checked-in static build is available and
Playwright is not needed.

1. Run `showkit doctor --capability static --json`.
2. Read the relevant source files and create supported sanitized semantic
   scenes with `createStaticCaptureEnvelope()`.
3. Bind every input to its project-relative path and current SHA-256. Do not
   include raw source, scripts, secrets, remote URLs, or a full-scene image.
4. Run:

```text
showkit init --json
showkit capture static safe-static-envelope.json --json
showkit story apply story.json --json
showkit validate --json
showkit build web,markdown --json
showkit preview --json
```

Report `sourceMode: "static-source"` and
`replayLevel: "source-derived"`. Compare the rendered source and local preview
before reporting visual fidelity as `checked`.
