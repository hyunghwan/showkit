import { test } from "@showkit/cli/playwright";

test("rejects an unreproducible native dialog", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/assurance/native-dialog.html");
  const target = page.getByRole("button", { name: "Continue" });
  await demo.step({
    id: "continue-dialog",
    title: "Continue from the dialog",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Continue"
    },
    action: () => target.click()
  });
});
