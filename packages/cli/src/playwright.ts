import { test as base, expect } from "@playwright/test";
import { CaptureSession, type DemoController, type DemoStepOptions } from "./capture/session.js";
import { EXIT_CODES, ShowKitError } from "./core/errors.js";

export type { DemoController, DemoStepOptions };

export const test = base.extend<{ demo: DemoController }>({
  demo: async ({ page }, use, testInfo) => {
    const session = new CaptureSession(page, testInfo);
    let completed = false;
    try {
      try {
        await use(session);
        completed = true;
      } catch (error) {
        await session.recordFailure(
          error,
          "setup",
          "DemoFixtureSetupFailed"
        );
        throw error;
      }
    } finally {
      try {
        if (completed) {
          try {
            await session.finalize();
          } catch (error) {
            await session.recordFailure(error, "finalize", "InternalError");
            if (error instanceof ShowKitError) throw error;
            throw new ShowKitError({
              code: "InternalError",
              message:
                "[SHOWKIT:InternalError] ShowKit hit an internal capture error while finishing the flow. No captured page was saved.",
              exitCode: EXIT_CODES.internal,
              recovery:
                "Retry once, then report the failure without including private page content."
            });
          }
        }
      } finally {
        session.dispose();
      }
    }
  }
});

export { expect };
