import { test } from "@showkit/cli/playwright";

test("rejects a remote image asset", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/remote-asset/index.html");
  const target = page.getByRole("button", { name: "Continue" });
  await demo.step({
    id: "continue",
    title: "Continue past the remote asset",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Continue"
    },
    action: () => target.click()
  });
});
