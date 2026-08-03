import { test } from "@showkit/cli/playwright";

test("binds the action locator to the isolated capture target", async ({
  page,
  demo
}) => {
  await page.goto(
    "http://127.0.0.1:4173/assurance/target-mismatch.html"
  );
  const actionTarget = page.getByRole("button", {
    name: "Open settings",
    exact: true
  });
  await demo.step({
    id: "open-overview",
    title: "Open overview",
    target: actionTarget,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Open overview"
    },
    action: () => actionTarget.click()
  });
});
