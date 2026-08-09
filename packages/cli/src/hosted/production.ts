import { spawn } from "node:child_process";
import {
  FirebaseDeviceAuthTokenProvider,
  MemoryHostedTokenStore
} from "./auth.js";
import { FetchHostedPublishTransport } from "./transport.js";

const PRODUCTION_API_BASE_URL = "https://app.showkit.sqncs.com/api";
// Firebase Web API keys identify a Firebase project; they are not server secrets.
const PRODUCTION_FIREBASE_API_KEY = "AIzaSyAQDK8VeS68lHO1x5naL75bs2grWhsT9iY";

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
    firebaseApiKey: PRODUCTION_FIREBASE_API_KEY,
    tokens: new MemoryHostedTokenStore(),
    openExternal,
    progress
  });
  return new FetchHostedPublishTransport({
    baseUrl: PRODUCTION_API_BASE_URL,
    tokens
  });
}
