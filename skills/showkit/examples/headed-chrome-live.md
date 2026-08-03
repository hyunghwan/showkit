# Capture a live page in a temporary headed Chrome context

Use this route in Claude Code, the Claude Desktop Code tab, or another
terminal-capable host only after the person approves optional Playwright. It
does not require a product codebase, but it does create local ShowKit project
files in the selected output folder.

The Playwright test runner creates a fresh non-persistent browser context. The
visible window does not reuse or copy an existing Chrome profile. If the page
requires authentication, ask the person to sign in in that temporary window.
Do not read or save the password, cookies, headers, or browser storage.

```ts
import { expect, test } from "@showkit/cli/playwright";

test.use({
  browserName: "chromium",
  channel: "chrome",
  headless: false,
  screenshot: "off",
  trace: "off",
  video: "off"
});

test("captures the selected product flow", async ({ page, demo }) => {
  test.setTimeout(180_000);
  await page.goto("https://app.example.test/dashboard");

  // This visible product state is the sign-in completion gate. The person may
  // finish authentication in the temporary browser while this wait is active.
  await expect(
    page.getByRole("heading", { name: "Dashboard" })
  ).toBeVisible({ timeout: 150_000 });

  const filters = page.getByRole("button", { name: "Filters" });
  await demo.step({
    id: "open-filters",
    title: "Open filters",
    target: filters,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Filters"
    },
    action: () => filters.click()
  });
});
```

Replace the URL, readiness gate, semantic targets, and actions with evidence
from the selected product. Each `captureTarget` is plain serializable metadata
that ShowKit resolves again inside a Chromium CDP isolated world. The
Playwright `target` performs the action only after the isolated pre-action
scene passes policy. The implementation uses the public Playwright
`newCDPSession()` surface and CDP `Page.createIsolatedWorld`; the demo spec does
not inject an extractor into the page JavaScript realm.

Run:

```text
showkit doctor --capability playwright --json
showkit init --json
showkit capture temporary-live.demo.ts --json
```

Delete the temporary spec only after the resulting captured product flow is
saved and checked. The browser context closes at test teardown. Authentication
state is not written by ShowKit.
