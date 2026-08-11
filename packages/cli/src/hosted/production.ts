import { spawn } from "node:child_process";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import {
  FirebaseDeviceAuthTokenProvider,
  MemoryHostedTokenStore
} from "./auth.js";
import { FetchHostedPublishTransport } from "./transport.js";

const PRODUCTION_API_BASE_URL = "https://app.showkit.sqncs.com/api";
const PRODUCTION_FIREBASE_CONFIG_URL =
  "https://app.showkit.sqncs.com/__/firebase/init.json";
const PRODUCTION_FIREBASE_PROJECT_ID = "showkit-hosted-sqncs";
const PRODUCTION_FIREBASE_APP_ID =
  "1:840403654519:web:fa83fc443bf24d562a7372";

function hostedConfigError(): ShowKitError {
  return new ShowKitError({
    code: "HostedUnavailable",
    message: "ShowKit Cloud is unavailable right now.",
    exitCode: EXIT_CODES.external,
    recovery: "Your local demo remains unchanged. Try publishing again."
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function loadProductionFirebaseApiKey(
  fetchImplementation: typeof fetch = globalThis.fetch
): Promise<string> {
  try {
    const response = await fetchImplementation(PRODUCTION_FIREBASE_CONFIG_URL, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const text = await response.text();
    if (
      !response.ok ||
      contentType !== "application/json" ||
      Buffer.byteLength(text) > 32 * 1024
    ) {
      throw hostedConfigError();
    }
    const config: unknown = JSON.parse(text);
    if (
      !isRecord(config) ||
      typeof config.apiKey !== "string" ||
      !/^AIza[0-9A-Za-z_-]{30,}$/.test(config.apiKey) ||
      config.projectId !== PRODUCTION_FIREBASE_PROJECT_ID ||
      config.appId !== PRODUCTION_FIREBASE_APP_ID
    ) {
      throw hostedConfigError();
    }
    return config.apiKey;
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw hostedConfigError();
  }
}

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function openExternal(url: string): Promise<void> {
  if (process.env.SHOWKIT_DISABLE_BROWSER_OPEN === "true") return;
  const command = process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], {
      detached: true,
      shell: false,
      stdio: "ignore"
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

export function createProductionHostedPublishTransport(): FetchHostedPublishTransport {
  const tokens = new FirebaseDeviceAuthTokenProvider({
    apiBaseUrl: PRODUCTION_API_BASE_URL,
    firebaseApiKey: loadProductionFirebaseApiKey,
    tokens: new MemoryHostedTokenStore(),
    openExternal,
    progress
  });
  return new FetchHostedPublishTransport({
    baseUrl: PRODUCTION_API_BASE_URL,
    tokens
  });
}
