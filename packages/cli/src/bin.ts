#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { asShowKitError } from "./core/errors.js";
import { recordFailedCommand, runCommand } from "./commands.js";
import { createProductionHostedPublishTransport } from "./hosted/production.js";

const fallbackOperationId = `op-${randomUUID()}`;
const commandArguments = process.argv.slice(2);

try {
  const result = await runCommand(
    commandArguments,
    commandArguments[0] === "publish"
      ? { hostedPublish: createProductionHostedPublishTransport() }
      : {}
  );
  if (result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  const showkitError = asShowKitError(error);
  const command = [process.argv[2], process.argv[2] === "story" ? process.argv[3] : undefined]
    .filter(Boolean)
    .join(" ");
  const nonPersistingSourceDiff =
    commandArguments[0] === "diff" && commandArguments.includes("--source");
  if (!nonPersistingSourceDiff) {
    await recordFailedCommand(
      fallbackOperationId,
      command || "unknown",
      showkitError.code
    ).catch(() => undefined);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      operationId: fallbackOperationId,
      status: "error",
      error: {
        code: showkitError.code,
        message: showkitError.message,
        recovery: showkitError.recovery,
        ...(showkitError.details ? { details: showkitError.details } : {})
      }
    })}\n`
  );
  process.exitCode = showkitError.exitCode;
}
