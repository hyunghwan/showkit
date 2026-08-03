import { test } from "@showkit/cli/playwright";

test("blocks an empty source flow", async ({ page, demo }) => {
  void demo;
  await page.goto("http://127.0.0.1:4173/empty/index.html");
});
