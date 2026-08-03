import { test } from "@showkit/cli/playwright";

test("isolates capture from hostile page prototypes", async ({ page, demo }) => {
  await page.goto(
    "http://127.0.0.1:4173/assurance/browser-realm-attack.html"
  );
  const target = page.getByRole("button", { name: "Open assurance" });
  await demo.step({
    id: "open-assurance",
    title: "Open the browser isolation assurance",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Open assurance"
    },
    action: () => target.click()
  });
});
