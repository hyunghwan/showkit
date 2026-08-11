import { expect, test } from "@showkit/cli/playwright";

test.use({ viewport: { width: 1280, height: 720 } });

test("captures visual fidelity states", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/assurance/visual-fidelity.html");

  const steps = [
    ["customize-view", "Customize the view", "Customize view"],
    ["align-preview", "Align the preview", "Align preview"],
    ["review-summary", "Review the summary", "Review summary"]
  ] as const;

  for (const [id, title, accessibleName] of steps) {
    const target = page.getByRole("button", { name: accessibleName });
    await target.focus();
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

  await expect(page.locator("body")).toHaveAttribute("data-state", "reviewed");
});
