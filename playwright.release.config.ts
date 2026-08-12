import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/player.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  maxFailures: process.env.CI ? 1 : 0,
  expect: {
    timeout: 5_000
  },
  reporter: [["line"]],
  projects: [
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 900 }
      }
    }
  ],
  use: {
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    screenshot: "off",
    trace: "off",
    video: "off"
  },
  webServer: {
    command: "node fixtures/demo-apps/server.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer:
      process.env.SHOWKIT_TEST_REUSE_FIXTURE_SERVER === "true",
    timeout: 10_000
  }
});
