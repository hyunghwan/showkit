import { expect, test } from "@showkit/cli/playwright";

test("captures a product-insights investigation", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/public/index.html");

  const steps = [
    ["open-session-filters", "Open session filters", "Add filter"],
    ["focus-engaged-visitors", "Focus on engaged visitors", "Engaged visitors"],
    ["review-friction-insight", "Review checkout friction", "Review friction insight"]
  ] as const;

  for (const [id, title, accessibleName] of steps) {
    const target = page.getByRole("button", { name: accessibleName });
    await demo.step({
      id,
      title,
      target,
      captureTarget: {
        strategy: "role",
        role: "button",
        name: accessibleName
      },
      action: () => target.click()
    });
  }

  await expect(page.getByRole("heading", { name: "Checkout friction" })).toBeVisible();
});
