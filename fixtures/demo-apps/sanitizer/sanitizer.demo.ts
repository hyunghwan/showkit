import { expect, test } from "@showkit/cli/playwright";

test("removes executable and form surfaces", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/sanitizer/index.html");
  const target = page.getByRole("button", { name: "Continue safely" });
  await demo.step({
    id: "continue-safely",
    title: "Continue with the safe product state",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Continue safely"
    },
    action: () => target.click()
  });
  await expect(page.getByRole("heading", { name: "Safe product state ready" })).toBeVisible();
});
