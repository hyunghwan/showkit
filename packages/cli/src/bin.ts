#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { asShowKitError } from "./core/errors.js";
import { recordFailedCommand, runCommand } from "./commands.js";

const fallbackOperationId = `op-${randomUUID()}`;

try {
  const result = await runCommand(process.argv.slice(2));
  if (result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  const showkitError = asShowKitError(error);
  const command = [process.argv[2], process.argv[2] === "story" ? process.argv[3] : undefined]
    .filter(Boolean)
    .join(" ");
  await recordFailedCommand(
    fallbackOperationId,
    command || "unknown",
    showkitError.code
  ).catch(() => undefined);
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
