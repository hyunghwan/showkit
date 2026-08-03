import { test } from "@showkit/cli/playwright";

test("rejects a full-scene image", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/screenshot/index.html");
  const target = page.getByRole("button", { name: "Continue" });
  await demo.step({
    id: "continue",
    title: "Continue from the screenshot",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Continue"
    },
    action: () => target.click()
  });
});
