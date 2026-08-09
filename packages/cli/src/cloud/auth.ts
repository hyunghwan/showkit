import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import {
  DeviceAuthorizationCreateResponseSchema,
  DeviceAuthorizationPollResponseSchema
} from "./contracts.js";
import type { HostedIdTokenProvider } from "./transport.js";

export type FirebaseTokenSet = {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
};

export interface HostedTokenStore {
  load(): Promise<FirebaseTokenSet | null>;
  save(tokens: FirebaseTokenSet): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryHostedTokenStore implements HostedTokenStore {
  #tokens: FirebaseTokenSet | null = null;

  async load(): Promise<FirebaseTokenSet | null> {
    return this.#tokens;
  }

  async save(tokens: FirebaseTokenSet): Promise<void> {
    this.#tokens = tokens;
  }

  async clear(): Promise<void> {
    this.#tokens = null;
  }
}

type DeviceAuthOptions = {
  apiBaseUrl: string;
  firebaseApiKey: string;
  tokens: HostedTokenStore;
  fetch?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  progress?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  identityToolkitBaseUrl?: string;
  secureTokenBaseUrl?: string;
};

function safeBaseUrl(value: string): URL {
  const url = new URL(value);
  const local =
    url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("Hosted authentication requires HTTPS or an explicit local emulator URL.");
  }
  if (url.username || url.password) {
    throw new Error("Hosted authentication URLs cannot contain credentials.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function authError(message: string, recovery: string): ShowKitError {
  return new ShowKitError({
    code: "CloudAuthExpired",
    message,
    exitCode: EXIT_CODES.external,
    recovery
  });
}

function connectionUrl(options: {
  verificationUri: string;
  verificationUriComplete: string;
  authorizationId: string;
  deviceSecret: string;
}): string {
  const base = new URL(options.verificationUri);
  const local =
    base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname);
  if (
    (!local && base.origin !== "https://app.showkit.sqncs.com") ||
    base.pathname !== "/cli/connect" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error("Invalid ShowKit CLI verification URL");
  }
  const expected = new URL(base);
  expected.hash = `authorization=${options.authorizationId}&secret=${options.deviceSecret}`;
  if (expected.toString() !== options.verificationUriComplete) {
    throw new Error("Mismatched ShowKit CLI verification URL");
  }
  return expected.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Unsupported authentication response type");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Oversized authentication response");
  return JSON.parse(text) as unknown;
}

function firebaseTokenResponse(value: unknown, refreshed: boolean): {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
} {
  if (!isRecord(value)) throw new Error("Invalid Firebase token response");
  const idToken = value[refreshed ? "id_token" : "idToken"];
  const refreshToken = value[refreshed ? "refresh_token" : "refreshToken"];
  const rawExpiresIn = value[refreshed ? "expires_in" : "expiresIn"];
  const expiresIn = Number(rawExpiresIn);
  if (
    typeof idToken !== "string" ||
    idToken.length < 100 ||
    typeof refreshToken !== "string" ||
    refreshToken.length < 20 ||
    !Number.isFinite(expiresIn) ||
    expiresIn < 60 ||
    expiresIn > 86_400
  ) {
    throw new Error("Invalid Firebase token fields");
  }
  return { idToken, refreshToken, expiresIn };
}

export class FirebaseDeviceAuthTokenProvider implements HostedIdTokenProvider {
  readonly #apiBaseUrl: URL;
  readonly #firebaseApiKey: string;
  readonly #tokens: HostedTokenStore;
  readonly #fetch: typeof fetch;
  readonly #openExternal: ((url: string) => Promise<void>) | undefined;
  readonly #progress: (message: string) => void;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #identityToolkitBaseUrl: URL;
  readonly #secureTokenBaseUrl: URL;
  #session: FirebaseTokenSet | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(options: DeviceAuthOptions) {
    this.#apiBaseUrl = safeBaseUrl(options.apiBaseUrl);
    this.#firebaseApiKey = options.firebaseApiKey;
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#openExternal = options.openExternal;
    this.#progress = options.progress ?? (() => undefined);
    this.#sleep = options.sleep ?? delay;
    this.#now = options.now ?? Date.now;
    this.#identityToolkitBaseUrl = safeBaseUrl(
      options.identityToolkitBaseUrl ?? "https://identitytoolkit.googleapis.com/v1"
    );
    this.#secureTokenBaseUrl = safeBaseUrl(
      options.secureTokenBaseUrl ?? "https://securetoken.googleapis.com/v1"
    );
  }

  async #load(): Promise<FirebaseTokenSet | null> {
    if (this.#session) return this.#session;
    try {
      this.#session = await this.#tokens.load();
    } catch {
      this.#session = null;
    }
    return this.#session;
  }

  async #save(tokens: FirebaseTokenSet): Promise<void> {
    this.#session = tokens;
    try {
      await this.#tokens.save(tokens);
    } catch {
      this.#progress("The OS credential store is unavailable; this CLI connection is process-only.");
    }
  }

  async logout(): Promise<void> {
    this.#session = null;
    await this.#tokens.clear().catch(() => undefined);
  }

  async #firebaseRequest(url: URL, body: string, contentType: string): Promise<unknown> {
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": contentType },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    const value = await boundedJson(response);
    if (!response.ok) throw new Error("Firebase rejected the token exchange.");
    return value;
  }

  async #exchange(customToken: string): Promise<FirebaseTokenSet> {
    const url = new URL(`${this.#identityToolkitBaseUrl.pathname}/accounts:signInWithCustomToken`, this.#identityToolkitBaseUrl.origin);
    url.searchParams.set("key", this.#firebaseApiKey);
    const parsed = firebaseTokenResponse(
      await this.#firebaseRequest(
        url,
        JSON.stringify({ token: customToken, returnSecureToken: true }),
        "application/json"
      ),
      false
    );
    return {
      idToken: parsed.idToken,
      refreshToken: parsed.refreshToken,
      expiresAt: this.#now() + parsed.expiresIn * 1000
    };
  }

  async #refresh(refreshToken: string): Promise<FirebaseTokenSet> {
    const url = new URL(`${this.#secureTokenBaseUrl.pathname}/token`, this.#secureTokenBaseUrl.origin);
    url.searchParams.set("key", this.#firebaseApiKey);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }).toString();
    const parsed = firebaseTokenResponse(
      await this.#firebaseRequest(url, body, "application/x-www-form-urlencoded"),
      true
    );
    return {
      idToken: parsed.idToken,
      refreshToken: parsed.refreshToken,
      expiresAt: this.#now() + parsed.expiresIn * 1000
    };
  }

  async #apiRequest(pathname: string, init: RequestInit): Promise<Response> {
    const url = new URL(`${this.#apiBaseUrl.pathname}${pathname}`, this.#apiBaseUrl.origin);
    return this.#fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
  }

  async #connect(): Promise<FirebaseTokenSet> {
    const createResponse = await this.#apiRequest("/v1/device-authorizations", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}"
    });
    const created = DeviceAuthorizationCreateResponseSchema.safeParse(
      await boundedJson(createResponse)
    );
    if (!createResponse.ok || !created.success) {
      throw authError(
        "ShowKit could not start a CLI connection.",
        "Try connecting the ShowKit CLI again."
      );
    }
    let verificationUrl: string;
    try {
      verificationUrl = connectionUrl(created.data);
    } catch {
      throw authError(
        "ShowKit received an unsafe CLI connection destination.",
        "Stop and retry after checking the hosted ShowKit service."
      );
    }
    this.#progress(`Open ${verificationUrl}`);
    if (this.#openExternal) {
      await this.#openExternal(verificationUrl).catch(() => {
        this.#progress("The browser did not open. Copy the connection URL above into a browser.");
      });
    }

    const deadline = this.#now() + created.data.expiresIn * 1000;
    let interval = created.data.interval * 1000;
    while (this.#now() < deadline) {
      const response = await this.#apiRequest(
        `/v1/device-authorizations/${created.data.authorizationId}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `ShowKitDevice ${created.data.deviceSecret}`
          }
        }
      );
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "0") * 1000;
        interval = Math.min(5_000, Math.max(interval, retryAfter || interval));
        await response.arrayBuffer();
        await this.#sleep(interval);
        continue;
      }
      const polled = DeviceAuthorizationPollResponseSchema.safeParse(await boundedJson(response));
      if (!response.ok || !polled.success) {
        throw authError(
          "The ShowKit CLI connection was rejected.",
          "Start a new CLI connection from the checked demo."
        );
      }
      if (polled.data.status === "expired") {
        throw authError(
          "The ShowKit CLI connection expired.",
          "Start publish again and approve the new connection within 10 minutes."
        );
      }
      if (polled.data.status === "connected") {
        return this.#exchange(polled.data.customToken);
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "0") * 1000;
      interval = Math.min(5_000, Math.max(interval, retryAfter || interval));
      await this.#sleep(interval);
    }
    throw authError(
      "The ShowKit CLI connection expired.",
      "Start publish again and approve the new connection within 10 minutes."
    );
  }

  async #resolve(forceRefresh: boolean): Promise<string> {
    const current = await this.#load();
    if (!forceRefresh && current && current.expiresAt > this.#now() + 60_000) {
      return current.idToken;
    }
    if (current) {
      try {
        const refreshed = await this.#refresh(current.refreshToken);
        await this.#save(refreshed);
        return refreshed.idToken;
      } catch {
        await this.logout();
      }
    }
    const connected = await this.#connect();
    await this.#save(connected);
    return connected.idToken;
  }

  async getIdToken(forceRefresh = false): Promise<string> {
    if (!this.#inFlight) {
      this.#inFlight = this.#resolve(forceRefresh).finally(() => {
        this.#inFlight = null;
      });
    }
    return this.#inFlight;
  }
}
