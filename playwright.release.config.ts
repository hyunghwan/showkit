import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/player.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  reporter: [["line"]],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] }
    }
  ],
  use: {
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    screenshot: "off",
    trace: "off",
    video: "off"
  },
  webServer: {
    command: "node fixtures/demo-apps/server.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: true,
    timeout: 10_000
  }
});
