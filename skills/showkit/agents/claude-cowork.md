# Claude Cowork notes

Use the ShowKit skill installed through the `hyunghwan/showkit` Claude plugin
marketplace. A plugin or skill install adds instructions only; it does not add
`@showkit/cli`, Playwright, or a browser binary.

Run this installed skill's `../scripts/conformance.mjs` before
`showkit doctor --json`. With `@showkit/cli 0.2.x`, a plugin-loaded skill is
outside the CLI's skill-directory search and `doctor` may report
`checks.skill.installed: false`. When conformance passes and the reported CLI
version satisfies `../compatibility.json`, continue without running the
doctor's `npx skills add` recovery. Do not install a duplicate skill. A real
runtime mismatch or any other failed doctor check still blocks its route.

Treat a short request such as “ShowKit this site; it is open in Chrome” as a
complete workflow request. Inspect already granted Cowork files, terminal
access, and Claude in Chrome capability, then follow
`browser-capabilities.md`. Do not ask the person to select a capture
architecture or restate the full ShowKit workflow.

Claude in Chrome may navigate the page for ordinary browser work, but it is a
ShowKit capture source only when the installed capability proves a
host-validated isolated page world. Read `claude-browser.md` before any live
extraction. When isolation is unavailable, leave the existing tab and previous
demo unchanged, then run the automatic recovery in `../workflow.md`.

Use the selected Cowork working folder as source only when its checked-in code
or static build represents the requested flow. Otherwise prepare the separate
non-persistent headed browser. If Playwright is missing, ask the single exact
dependency permission from `../workflow.md`; after approval, continue without
another route question. The person signs in again in the separate window.

Keep credentials unchanged. Ask for exact confirmation immediately before
private visible content is saved or an action creates, updates, sends,
publishes, purchases, uploads, downloads, or deletes. Never publish without a
separate explicit request and destination confirmation. The person's
confirmation does not override Claude's host safety policy. If the host blocks
the action, keep the nearest allowed pre-action state and report it once; do
not restart capture or attempt a differently named command.
