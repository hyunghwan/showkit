import { expect, test } from "@showkit/cli/playwright";

test.use({
  storageState: {
    cookies: [
      {
        name: "session",
        value: "SHOWKIT_SECRET_CANARY_7F92D1A4",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax"
      }
    ],
    origins: [
      {
        origin: "http://127.0.0.1:4173",
        localStorage: [
          {
            name: "session",
            value: "SHOWKIT_SECRET_CANARY_7F92D1A4"
          }
        ]
      }
    ]
  }
});

test("keeps storage state runtime-only", async ({ page, demo }) => {
  await page.goto("http://127.0.0.1:4173/storage/index.html");
  const target = page.getByRole("button", { name: "Finish authenticated step" });
  await demo.step({
    id: "finish-authenticated-step",
    title: "Finish the authenticated step",
    target,
    captureTarget: {
      strategy: "role",
      role: "button",
      name: "Finish authenticated step"
    },
    action: () => target.click()
  });
  await expect(
    page.getByRole("heading", { name: "Authenticated step complete" })
  ).toBeVisible();
});
