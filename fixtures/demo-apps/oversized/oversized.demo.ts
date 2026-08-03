import { test } from "@showkit/cli/playwright";

test("rejects an oversized local image", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/oversized/index.html");
  const target = page.getByRole("button", { name: "Continue" });
  await demo.step({
    id: "continue",
    title: "Continue past the oversized asset",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Continue"
    },
    action: () => target.click()
  });
});
