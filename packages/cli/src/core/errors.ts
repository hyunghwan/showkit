export const EXIT_CODES = {
  success: 0,
  validation: 2,
  environment: 3,
  external: 4,
  internal: 70
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class ShowKitError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly recovery: string;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: string;
    message: string;
    exitCode?: ExitCode;
    recovery: string;
    details?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "ShowKitError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? EXIT_CODES.validation;
    this.recovery = options.recovery;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function asShowKitError(error: unknown): ShowKitError {
  if (error instanceof ShowKitError) {
    return error;
  }

  return new ShowKitError({
    code: "InternalError",
    message: "ShowKit could not complete the command.",
    exitCode: EXIT_CODES.internal,
    recovery: "Run the command again with SHOWKIT_LOG_LEVEL=debug and report the operation ID."
  });
}
