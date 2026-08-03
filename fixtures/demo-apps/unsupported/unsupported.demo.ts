import { test } from "@showkit/cli/playwright";

test("blocks unsupported page content", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/unsupported/index.html");
  const target = page.getByRole("button", { name: "Open model" });
  await demo.step({
    id: "open-model",
    title: "Open the product model",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Open model"
    },
    action: () => target.click()
  });
});
