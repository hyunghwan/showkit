import { test } from "@showkit/cli/playwright";

test("rejects an unsettled finite animation", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/assurance/render-settle.html");
  const target = page.getByRole("button", { name: "Review settled state" });
  await target.evaluate((element) => {
    element.style.animationDuration = "8s";
  });
  await demo.step({
    id: "review-unsettled-state",
    title: "Review the unsettled state",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Review settled state"
    },
    action: () => target.click()
  });
});
