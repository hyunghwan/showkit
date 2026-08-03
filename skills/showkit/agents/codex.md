# Codex notes

Keep dependencies and credentials unchanged unless the person approves the
change. Use local shell commands for the ShowKit CLI. Request permission before
publishing, opening an external destination, or changing project dependencies.

When a person supplies an HTTP or HTTPS product URL, read
`browser-capabilities.md` and `codex-browser.md` before using Browser or
Chrome. The same installed-host gate applies in a ChatGPT or Codex app.
Browser selection and interaction remain host-owned. The ShowKit CLI never
controls the browser.

Follow the model and reasoning budget in `SKILL.md`. Prefer a fast or balanced
model for deterministic CLI work and routine demo assembly. Reserve the most
capable model and high reasoning for ambiguous evidence, security decisions,
architecture changes, or unresolved fidelity failures; do not inherit an
extra-high default for every subtask.
