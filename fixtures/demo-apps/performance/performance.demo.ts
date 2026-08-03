import { expect, test } from "@showkit/cli/playwright";

test("captures 25 deterministic steps", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/performance/index.html");

  for (let step = 1; step <= 25; step += 1) {
    const target = page.getByRole("button", { name: `Advance ${step} of 25` });
    await demo.step({
      id: `advance-${step}`,
      title: `Advance deterministic state ${step}`,
      target,
      captureTarget: {
        strategy: "role",
        role: "button",
        name: `Advance ${step} of 25`
      },
      action: () => target.click()
    });
  }

  await expect(
    page.getByRole("heading", { name: "Capture performance complete" })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __showkitMaxInputLatency: number;
          }
        ).__showkitMaxInputLatency
    )
  ).toBeLessThanOrEqual(50);
});
