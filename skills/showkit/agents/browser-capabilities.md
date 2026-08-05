# Browser capability routing

Choose a capture route from verified capabilities, not from an app name alone.
The same ShowKit skill may run in Codex, ChatGPT, Claude Cowork, Claude Code, or
the Code tab in a desktop app with different browser and terminal access.

The automated install, update, and remove lifecycle is tested for the `codex`
and `claude-code` agent targets. ChatGPT can use the same Codex/OpenAI skill
bundle only where that app exposes it. The Code tab in Claude Desktop can use
the Claude Code skill directory and capabilities where available. Claude
Cowork uses the ShowKit plugin from the `hyunghwan/showkit` marketplace.
These app routes are capability routing, not a claim that a separate ChatGPT,
Cowork, or Claude Desktop install was executed.

For the `0.2.x` compatibility contract, Cowork is covered by the existing
`claude-app` host identifier. Do not add a new compatibility enum until the
CLI reader version and skill range move together.

| Available capability | Route | Result |
|---|---|---|
| OpenAI Browser or Chrome plugin passes `verifyOpenAIBrowserHostIsolation()` | selected signed-in tab | `agent-browser-session`, `session-captured` |
| Terminal and optional Playwright 1.60+ are approved | temporary headed Chromium or Chrome context | `playwright-spec`, `ci-replayable` |
| Product source or a checked-in static build is available | bound static source | `static-source`, `source-derived` |
| Browser scripts run only in the page JavaScript realm | stop before extraction | `UnsupportedSurface`, `browser-isolation-unverified` |
| No terminal, source access, or verified isolated browser API | stop before extraction | `UnsupportedSurface` |

Select the first route whose evidence matches the requested flow. If a
Claude-controlled current tab fails isolation, use available bound source
automatically when it represents that flow; otherwise use or request the
separate non-persistent Playwright route. Do not ask the person to choose among
these implementation names.

The OpenAI route is available in a ChatGPT or Codex app only when the installed
Browser or Chrome plugin passes the installed-host check. Record `sourceHost`
as `chatgpt` or `codex` according to the app that owns the browser session.
The plugin name may be `browser` or `chrome`; both must expose the same verified
read-only isolated implementation.

Claude Cowork, Claude Code, and the Code tab in Claude Desktop may use the
Playwright route when terminal and file access are available and the person
approves the optional dependency. This route opens a separate visible browser
with a non-persistent Playwright context. It does not reuse or copy the
person’s existing Chrome profile, cookies, or storage. Ask the person to sign
in once in that temporary window when authentication is required. Keep the
same run-owned context alive through the complete capture; reconnaissance must
not create and discard a separate authenticated context.

Never downgrade from an unavailable isolated route to main-world JavaScript,
Computer Use, a screenshot, a copied profile, or a raw DOM export.
