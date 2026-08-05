# Claude Code notes

Keep dependencies and credentials unchanged unless the person approves the
change. Use the project package manager for the ShowKit CLI. Request permission
before publishing, opening an external destination, or changing project
dependencies.

For a page open in Claude in Chrome, read `claude-browser.md` first. The
installed `javascript_tool` capability must expose a host-validated isolated
read-only page world. When it runs in page context, extraction through that
tool is blocked with `UnsupportedSurface`. Do not run the extractor in the
page's main JavaScript realm. Follow the automatic recovery in
`claude-browser.md`: use already granted bound source when it represents the
flow, otherwise use or request the separate non-persistent headed Chrome
workflow. Do not ask the person to choose a capture implementation.

When the person works without a product repository, use a separate local
ShowKit output folder. The CLI can initialize and build there. When optional
Playwright is approved, the agent may create a temporary demo spec in that
folder and ask the person to sign in once in its separate visible browser
window. Write the final spec before launch and keep the same run-owned browser
context alive from sign-in through capture. Do not launch a reconnaissance
script, close its window, and ask for another sign-in. Run the no-browser
capture preflight first, then keep the real capture in a retained foreground
process; do not detach it to a background shell that may be killed while the
person signs in. Installing this skill does not install the CLI or Playwright.

Before applying the first demo content, show the exact default colors and font
stacks from `SKILL.md` and ask whether to keep them. If the person supplies
brand values, use only local font stacks and colors that pass the ShowKit WCAG
2.2 AA player checks. A failed theme must leave the previous demo unchanged.

Apply `references/visual-fidelity.md` to every supported source. Use its general
preflight, acceptance budget, and recovery ladder. Do not patch a generated
scene, add a site-specific rule, or substitute assets to make one comparison
pass. Report visual fidelity as `checked`, `incomplete`, or `blocked`.

Follow the model and reasoning budget in `SKILL.md`. Prefer a fast or balanced
model for deterministic CLI work and routine demo assembly. Reserve the most
capable model and high reasoning for ambiguous evidence, security decisions,
architecture changes, or unresolved fidelity failures; do not inherit an
extra-high default for every subtask.
