import { test } from "@showkit/cli/playwright";

test("blocks a sensitive action outcome title", async ({ page, demo }) => {
  await page.goto(
    "http://127.0.0.1:4173/assurance/sensitive-title.html"
  );
  const target = page.getByRole("button", {
    name: "Continue setup",
    exact: true
  });
  await demo.step({
    id: "continue-setup",
    title: "Continue account setup",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Continue setup"
    },
    action: () => target.click()
  });
});
