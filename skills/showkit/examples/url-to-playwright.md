# Promote a browser session to Playwright

Use the browser-session recipe as an audit of ordered semantic targets. Recheck
each target in a fixture-owned environment before writing the Playwright source
flow.

```ts
import { test } from "@showkit/cli/playwright";

test("replays the report flow", async ({ page, demo }) => {
  await page.goto("/reports");

  const openFilters = page.getByRole("button", { name: "Filters" });
  await demo.step({
    id: "open-filters",
    title: "Open report filters",
    target: openFilters,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Filters"
    },
    action: () => openFilters.click()
  });

  const selectActivity = page.getByRole("button", { name: "Activity" });
  await demo.step({
    id: "review-activity",
    title: "Review report activity",
    target: selectActivity,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Activity"
    },
    action: () => selectActivity.click()
  });
});
```

Keep authentication in the Playwright fixture at runtime. Do not copy a cookie,
token, password, storage value, query string, or browser profile from the signed-
in session.

Capture the promoted source flow and compare it with the earlier version:

```text
showkit capture demos/reports.demo.ts --json
showkit story apply demos/reports.story.json --json
showkit validate --json
showkit build web,markdown --json
showkit diff --base <earlier-artifact.json> --check --json
```

The promoted capture is `ci-replayable` only after the Playwright path completes.
