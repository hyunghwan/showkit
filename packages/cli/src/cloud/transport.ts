import { ShowKitError, EXIT_CODES } from "../core/errors.js";
import {
  HostedApiErrorSchema,
  HostedPublishResponseSchema,
  type HostedPublishRequest,
  type HostedPublishResponse
} from "./contracts.js";

export type HostedPublishInvocation = {
  request: HostedPublishRequest;
  json: string;
  idempotencyKey: string;
};

export interface HostedPublishTransport {
  readonly destination: string;
  publish(invocation: HostedPublishInvocation): Promise<HostedPublishResponse>;
}

export interface HostedIdTokenProvider {
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

function transportError(error: unknown): ShowKitError {
  if (error instanceof ShowKitError) return error;
  return new ShowKitError({
    code: "CloudRequestFailed",
    message: "ShowKit could not reach the hosted publish service. Nothing in the local demo changed.",
    exitCode: EXIT_CODES.external,
    recovery: "Check the connection, then run the same publish command again."
  });
}

function endpointUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const local =
    url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("Hosted transport requires HTTPS or an explicit local emulator URL.");
  }
  if (url.username || url.password) {
    throw new Error("Hosted transport URLs cannot contain credentials.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export class FetchHostedPublishTransport implements HostedPublishTransport {
  readonly destination: string;
  readonly #baseUrl: URL;
  readonly #tokens: HostedIdTokenProvider;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    tokens: HostedIdTokenProvider;
    fetch?: typeof fetch;
  }) {
    this.#baseUrl = endpointUrl(options.baseUrl);
    this.destination = this.#baseUrl.origin;
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #request(
    invocation: HostedPublishInvocation,
    forceRefresh: boolean
  ): Promise<Response> {
    const url = new URL(
      `${this.#baseUrl.pathname}/v1/demos/${encodeURIComponent(invocation.request.projectId)}`,
      this.#baseUrl.origin
    );
    return this.#fetch(url, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await this.#tokens.getIdToken(forceRefresh)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": invocation.idempotencyKey
      },
      body: invocation.json,
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
  }

  async publish(invocation: HostedPublishInvocation): Promise<HostedPublishResponse> {
    try {
      let response = await this.#request(invocation, false);
      if (response.status === 401) response = await this.#request(invocation, true);
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw new Error("Unsupported API response type");
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Oversized API response");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("Invalid API response");
      }
      if (!response.ok) {
        const parsed = HostedApiErrorSchema.safeParse(value);
        if (!parsed.success) throw new Error("Invalid API error");
        const validationCodes = new Set([
          "CloudArtifactRejected",
          "CloudArtifactTooLarge",
          "CloudProjectMismatch",
          "CloudRequestInvalid"
        ]);
        throw new ShowKitError({
          code: parsed.data.error.code,
          message: `${parsed.data.error.message} Nothing in the local demo changed.`,
          exitCode: validationCodes.has(parsed.data.error.code)
            ? EXIT_CODES.validation
            : EXIT_CODES.external,
          recovery: parsed.data.error.recovery,
          details: { requestId: parsed.data.error.requestId }
        });
      }
      const parsed = HostedPublishResponseSchema.safeParse(value);
      if (!parsed.success) throw new Error("Invalid success response");
      return parsed.data;
    } catch (error) {
      throw transportError(error);
    }
  }
}
