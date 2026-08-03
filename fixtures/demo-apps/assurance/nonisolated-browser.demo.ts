import { test } from "@showkit/cli/playwright";

test("fails closed without a Chromium isolated world", async ({ page, demo }) => {
  Object.defineProperty(page.context(), "newCDPSession", {
    configurable: true,
    value: async () => {
      throw new Error("The isolated-world assurance fixture disabled CDP.");
    }
  });
  await page.goto("http://127.0.0.1:4173/public/index.html");
  const target = page.getByRole("button", { name: "Add filter" });
  await demo.step({
    id: "open-session-filters",
    title: "Open session filters",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Add filter"
    },
    action: () => target.click()
  });
});
