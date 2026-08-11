# Route a short “open in Chrome” request

The installed skill must treat this as a complete request:

> Use ShowKit for this site. The flow is open in Chrome. Build and preview a
> checked local demo. Do not publish.

For install-first onboarding, finish the skill install and then ask only:

> What product URL or currently open product flow should I use?

Use a new empty output folder and 1440×900 by default after the answer. Do not
ask for the folder, audience, takeaway, viewport, or capture implementation
before the URL or open flow is known.

Do not ask the person to explain ShowKit, choose a capture implementation, or
repeat the workflow. Inspect already granted capabilities and continue:

1. In ChatGPT or Codex, reuse the selected tab only after
   `verifyOpenAIBrowserHostIsolation()` passes for that exact tab and origin.
2. In Claude Cowork or Claude Code, never use a page-context browser script for
   capture. Use already granted bound source automatically when it represents
   the requested flow without depending on the current signed-in state.
3. When live state is required, use an already available separate
   non-persistent Playwright browser. If the optional dependency or browser
   binary is missing, ask the single exact install permission in
   `../workflow.md`, then continue after approval. Launch one run-owned context
   and keep it alive from the single sign-in through capture; do not replace a
   reconnaissance browser with a second capture browser.
4. When no safe local route exists, give the exact Codex handoff in
   `../workflow.md`.

Do not respond with:

> How do you want to get that flow into the demo?

The source route is ShowKit's implementation decision. Ask only for a required
dependency or browser download, sign-in in a separate window, private-content
choice, theme choice, or an action confirmation.

For a Details → Approve flow, capture the Details state and the state
immediately before Approve. Selecting Approve requires exact confirmation at
the moment of the action unless the person has supplied a safe synthetic or
sandbox flow and explicitly authorized that change.
