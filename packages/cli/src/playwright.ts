import { test as base, expect } from "@playwright/test";
import { CaptureSession, type DemoController, type DemoStepOptions } from "./capture/session.js";

export type { DemoController, DemoStepOptions };

export const test = base.extend<{ demo: DemoController }>({
  demo: async ({ page }, use, testInfo) => {
    const session = new CaptureSession(page, testInfo);
    let completed = false;
    try {
      await use(session);
      completed = true;
    } finally {
      if (completed) {
        await session.finalize();
      }
    }
  }
});

export { expect };
