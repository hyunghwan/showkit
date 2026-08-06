# Capture a live page in a temporary headed Chrome context

Use this route in Claude Cowork, Claude Code, the Claude Desktop Code tab, or
another terminal-capable host that can show a local browser window, only after
the person approves optional Playwright. It does not require a product
codebase, but it does create local ShowKit project files in the selected output
folder.

The Playwright test runner creates a fresh non-persistent browser context. The
visible window does not reuse or copy an existing Chrome profile. If the page
requires authentication, ask the person to sign in once in that temporary
window. Write this final capture spec before launching it, then keep the same
run-owned browser context and page alive from the readiness gate through every
`demo.step()`. Do not create a one-shot `recon` script, close its authenticated
window, and launch a second browser. Do not read or save the password, cookies,
headers, or browser storage.

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
  test.setTimeout(600_000);
  await page.goto("https://app.example.test/dashboard");

  // This visible product state is the sign-in completion gate. The person may
  // finish authentication in the temporary browser while this wait is active.
  await expect(
    page.getByRole("heading", { name: "Dashboard" })
  ).toBeVisible({ timeout: 540_000 });

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
    // For the exact requested public URL in this signed-out context, keep
    // required visible images as local assets without another prompt.
    pageAssetConsent: {
      mode: "public-page",
      consent: "requested"
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

For the exact requested public URL in a fresh, signed-out context, keep the
`public-page` block on the first step when required visible images need local
copies. Do not ask another image question. For a signed-in or private flow,
explain the local-file effect, ask once before the real capture, and replace it
with `pageAssetConsent: { mode: "visible-session", consent: "confirmed" }`
only after an explicit yes. ShowKit fetches visible images without cookies,
authorization, or a referrer, rejects local and private addresses, verifies
their bytes, and stores only local content-addressed assets. Do not use a
screenshot or a blank image region instead.

Run:

```text
showkit doctor --capability playwright --browser-channel chrome --json
showkit init --json
showkit capture temporary-live.spec.ts --viewport 1280x720 --preflight --json
showkit capture temporary-live.spec.ts --viewport 1280x720 --json
```

Delete the temporary spec only after the resulting captured product flow is
saved and checked. The browser context closes at test teardown. Authentication
state is not written by ShowKit. One capture run has one browser context and at
most one person-assisted sign-in. Run the real capture as a retained foreground
process whose host timeout exceeds the sign-in gate; a killed background shell
closes the browser and is not a sign-in failure.
