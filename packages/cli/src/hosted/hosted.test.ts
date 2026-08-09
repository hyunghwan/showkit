import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactManifest } from "../core/schemas.js";
import { contentHash, sha256 } from "../core/json.js";
import { publishCommand } from "../commands.js";
import { HostedPublishResponseSchema } from "./contracts.js";
import {
  FirebaseDeviceAuthTokenProvider,
  MemoryHostedTokenStore
} from "./auth.js";
import {
  commitPublicationReceipt,
  pendingIdempotencyKey
} from "./receipt.js";
import { createHostedPublishRequest } from "./request.js";
import { FetchHostedPublishTransport } from "./transport.js";

function artifact(contents: ReadonlyMap<string, Buffer>): ArtifactManifest {
  const files = [...contents].map(([filePath, value]) => ({
    path: filePath,
    sha256: sha256(value),
    bytes: value.byteLength,
    mediaType: filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8"
  })).sort((left, right) => left.path.localeCompare(right.path));
  const sourceCaptureHash = sha256("source");
  const storyHash = sha256(contents.get("story.js")!);
  const builderVersion = "0.2.7-test";
  return {
    schemaVersion: "0.1",
    state: "BUILT",
    version: contentHash({ sourceCaptureHash, storyHash, builderVersion, files }),
    sourceCaptureHash,
    storyHash,
    builderVersion,
    files,
    sanitization: {
      policyChecksPassed: true,
      fullSceneRasterCount: 0,
      remoteRequestCount: 0
    },
    publish: null
  } as ArtifactManifest;
}

function demoContents(styles = "body {}\n"): Map<string, Buffer> {
  return new Map([
    ["index.html", Buffer.from("<!doctype html><html></html>\n")],
    ["styles.css", Buffer.from(styles)],
    [
      "story.js",
      Buffer.from(
        `window.__SHOWKIT_DEMO__ = ${JSON.stringify({ title: "Approval workflow" })};\n`
      )
    ],
    ["player.js", Buffer.from("window.__SHOWKIT_PLAYER__ = true;\n")]
  ]);
}

describe("hosted CLI request and transport", () => {
  it("builds the bounded envelope without changing the artifact manifest", () => {
    const contents = demoContents();
    const manifest = artifact(contents);
    const original = structuredClone(manifest);
    const prepared = createHostedPublishRequest({
      projectId: "project-one",
      manifest,
      contents
    });
    expect(prepared.request).toMatchObject({
      projectId: "project-one",
      title: "Approval workflow",
      visibility: "unlisted",
      artifact: { version: manifest.version, publish: null }
    });
    expect(prepared.request.files.every((file) => file.encoding === "base64")).toBe(true);
    expect(manifest).toEqual(original);
  });

  it("keeps freshness metadata required to verify current artifact versions", () => {
    const contents = demoContents();
    const manifest = artifact(contents);
    const hash = "a".repeat(64);
    manifest.freshness = {
      steps: [
        {
          stepId: "story-open-approval",
          captureStepId: "open-approval",
          sourceIndex: 0,
          title: "Open approval",
          sceneHash: hash,
          targetHash: hash,
          evidenceIds: ["evidence-open-approval"],
          evidenceHash: hash,
          actionOutcomeHash: hash
        }
      ],
      terminalSceneHash: hash
    };
    manifest.version = contentHash({
      sourceCaptureHash: manifest.sourceCaptureHash,
      storyHash: manifest.storyHash,
      freshness: manifest.freshness,
      builderVersion: manifest.builderVersion,
      files: manifest.files
    });
    const prepared = createHostedPublishRequest({
      projectId: "project-one",
      manifest,
      contents
    });
    expect(prepared.request.artifact.freshness).toEqual(manifest.freshness);
    expect(prepared.request.artifact.version).toBe(manifest.version);
  });

  it("rejects the encoded envelope above 5 MiB before transport", () => {
    const contents = demoContents("x".repeat(4 * 1024 * 1024));
    expect(() =>
      createHostedPublishRequest({
        projectId: "project-one",
        manifest: artifact(contents),
        contents
      })
    ).toThrow(/larger than 5 MiB/);
  });

  it("accepts only the exact hosted URL and matching public ID", () => {
    const response = {
      ok: true,
      status: "published",
      action: "created",
      version: "a".repeat(64),
      demoId: "demo_123456789012",
      publicId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      generation: 1,
      url: "https://demos.showkit.sqncs.com/d/01HZZZZZZZZZZZZZZZZZZZZZZZ",
      dashboardUrl: "https://app.showkit.sqncs.com/demos"
    };
    expect(HostedPublishResponseSchema.safeParse(response).success).toBe(true);
    expect(
      HostedPublishResponseSchema.safeParse({
        ...response,
        url: "https://example.com/d/01HZZZZZZZZZZZZZZZZZZZZZZZ"
      }).success
    ).toBe(false);
    expect(
      HostedPublishResponseSchema.safeParse({
        ...response,
        publicId: "01HYYYYYYYYYYYYYYYYYYYYYYY"
      }).success
    ).toBe(false);
  });

  it("reuses one idempotency key when refreshing an expired ID token", async () => {
    const contents = demoContents();
    const prepared = createHostedPublishRequest({
      projectId: "project-one",
      manifest: artifact(contents),
      contents
    });
    const tokenCalls: boolean[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          status: "published",
          action: "created",
          version: prepared.request.artifact.version,
          demoId: "demo_123456789012",
          publicId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
          generation: 1,
          url: "https://demos.showkit.sqncs.com/d/01HZZZZZZZZZZZZZZZZZZZZZZZ",
          dashboardUrl: "https://app.showkit.sqncs.com/demos"
        })
      );
    const transport = new FetchHostedPublishTransport({
      baseUrl: "http://127.0.0.1:5000/api",
      tokens: {
        getIdToken: async (forceRefresh = false) => {
          tokenCalls.push(forceRefresh);
          return forceRefresh ? "fresh-token" : "stale-token";
        }
      },
      fetch: fetchMock
    });
    const result = await transport.publish({
      request: prepared.request,
      json: prepared.json,
      idempotencyKey: "operation-key-1234"
    });
    expect(result.status).toBe("published");
    expect(tokenCalls).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get("idempotency-key")).toBe("operation-key-1234");
      expect(call[1]?.body).toBe(prepared.json);
    }
  });

  it("rejects a success response for a different artifact version", async () => {
    const contents = demoContents();
    const prepared = createHostedPublishRequest({
      projectId: "project-one",
      manifest: artifact(contents),
      contents
    });
    const transport = new FetchHostedPublishTransport({
      baseUrl: "http://127.0.0.1:5000/api",
      tokens: { getIdToken: async () => "valid-token" },
      fetch: async () => Response.json({
        ok: true,
        status: "published",
        action: "created",
        version: "f".repeat(64),
        demoId: "demo_123456789012",
        publicId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        generation: 1,
        url: "https://demos.showkit.sqncs.com/d/01HZZZZZZZZZZZZZZZZZZZZZZZ",
        dashboardUrl: "https://app.showkit.sqncs.com/demos"
      })
    });

    await expect(transport.publish({
      request: prepared.request,
      json: prepared.json,
      idempotencyKey: "operation-key-1234"
    })).rejects.toMatchObject({
      code: "HostedRequestFailed",
      exitCode: 4
    });
  });
});

describe("device authorization client", () => {
  it("keeps the device secret out of the poll URL and exchanges the custom token once", async () => {
    const deviceSecret = "s".repeat(43);
    const customToken = "c".repeat(120);
    const idToken = "i".repeat(120);
    const refreshToken = "r".repeat(40);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v1/device-authorizations")) {
        return Response.json({
          ok: true,
          authorizationId: "a".repeat(32),
          deviceSecret,
          verificationUri: "https://app.showkit.sqncs.com/cli/connect",
          verificationUriComplete: `https://app.showkit.sqncs.com/cli/connect#authorization=${"a".repeat(32)}&secret=${deviceSecret}`,
          expiresIn: 600,
          interval: 2
        });
      }
      if (url.pathname.endsWith(`/v1/device-authorizations/${"a".repeat(32)}`)) {
        expect(url.toString()).not.toContain(deviceSecret);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `ShowKitDevice ${deviceSecret}`
        );
        return Response.json({ ok: true, status: "connected", customToken });
      }
      if (url.pathname.endsWith("/accounts:signInWithCustomToken")) {
        expect(String(init?.body)).toContain(customToken);
        return Response.json({ idToken, refreshToken, expiresIn: "3600" });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const opened: string[] = [];
    const store = new MemoryHostedTokenStore();
    const provider = new FirebaseDeviceAuthTokenProvider({
      apiBaseUrl: "http://127.0.0.1:5000/api",
      firebaseApiKey: "emulator-api-key",
      tokens: store,
      fetch: fetchMock,
      openExternal: async (url) => { opened.push(url); },
      sleep: async () => undefined,
      identityToolkitBaseUrl: "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1",
      secureTokenBaseUrl: "http://127.0.0.1:9099/securetoken.googleapis.com/v1"
    });
    await expect(provider.getIdToken()).resolves.toBe(idToken);
    expect(opened).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await store.load())).not.toContain(customToken);
    await expect(provider.getIdToken()).resolves.toBe(idToken);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("private publication receipt", () => {
  const previousRoot = process.env.SHOWKIT_PROJECT_ROOT;
  afterEach(() => {
    if (previousRoot === undefined) delete process.env.SHOWKIT_PROJECT_ROOT;
    else process.env.SHOWKIT_PROJECT_ROOT = previousRoot;
  });

  it("is a private ignored file and reuses only a matching pending operation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "showkit-hosted-receipt-"));
    process.env.SHOWKIT_PROJECT_ROOT = root;
    const first = await pendingIdempotencyKey({
      projectId: "project-one",
      requestHash: "1".repeat(64),
      create: () => "operation-key-one",
      now: "2026-08-07T12:00:00.000Z"
    });
    const recovered = await pendingIdempotencyKey({
      projectId: "project-one",
      requestHash: "1".repeat(64),
      create: () => "must-not-be-used",
      now: "2026-08-07T12:01:00.000Z"
    });
    expect(recovered).toBe(first);
    const receiptPath = path.join(
      root,
      ".showkit",
      "hosted",
      "publications",
      `${sha256("project-one")}.json`
    );
    const receiptStat = await stat(receiptPath);
    expect(receiptStat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(receiptStat.mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path.join(root, ".showkit", ".gitignore"), "utf8")).toContain(
      "hosted/"
    );

    await commitPublicationReceipt({
      projectId: "project-one",
      requestHash: "1".repeat(64),
      idempotencyKey: first,
      now: "2026-08-07T12:02:00.000Z",
      result: {
        ok: true,
        status: "published",
        action: "created",
        version: "2".repeat(64),
        demoId: "demo_123456789012",
        publicId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        generation: 1,
        url: "https://demos.showkit.sqncs.com/d/01HZZZZZZZZZZZZZZZZZZZZZZZ",
        dashboardUrl: "https://app.showkit.sqncs.com/demos"
      }
    });
    const next = await pendingIdempotencyKey({
      projectId: "project-one",
      requestHash: "1".repeat(64),
      create: () => "operation-key-two",
      now: "2026-08-07T12:03:00.000Z"
    });
    expect(next).toBe("operation-key-two");
  });

  it("refuses a symlinked private receipt directory without touching its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "showkit-hosted-receipt-link-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "showkit-hosted-receipt-outside-"));
    process.env.SHOWKIT_PROJECT_ROOT = root;
    await mkdir(path.join(root, ".showkit"));
    const markerPath = path.join(outside, "marker.txt");
    await writeFile(markerPath, "unchanged\n");
    await symlink(outside, path.join(root, ".showkit", "hosted"), "dir");

    await expect(
      pendingIdempotencyKey({
        projectId: "project-one",
        requestHash: "1".repeat(64),
        create: () => "must-not-be-used",
        now: "2026-08-07T12:00:00.000Z"
      })
    ).rejects.toMatchObject({ code: "HostedReceiptUnsafe", exitCode: 3 });
    expect(await readFile(markerPath, "utf8")).toBe("unchanged\n");
    await expect(stat(path.join(outside, "publications"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("runs the existing local gate before an injected emulator publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "showkit-hosted-command-"));
    process.env.SHOWKIT_PROJECT_ROOT = root;
    const example = new URL("../../../../examples/product-insights/", import.meta.url);
    const exampleManifest = JSON.parse(
      await readFile(new URL("artifact.json", example), "utf8")
    ) as { version: string };
    const artifactDirectory = path.join(
      root,
      ".showkit",
      "artifacts",
      exampleManifest.version
    );
    await mkdir(path.dirname(artifactDirectory), { recursive: true });
    await cp(example, artifactDirectory, { recursive: true });
    await writeFile(
      path.join(root, ".showkit", "project.json"),
      `${JSON.stringify({
        schemaVersion: "0.1",
        projectId: "project-command-test",
        createdAt: "2026-08-07T12:00:00.000Z",
        latestArtifactVersion: exampleManifest.version
      })}\n`
    );
    await writeFile(path.join(root, ".showkit", ".gitignore"), "artifacts/\n");

    const invocations: Array<{ idempotencyKey: string; projectId: string }> = [];
    const result = await publishCommand(
      ["--version", exampleManifest.version],
      {
        destination: "Firebase Emulator",
        publish: async (invocation) => {
          invocations.push({
            idempotencyKey: invocation.idempotencyKey,
            projectId: invocation.request.projectId
          });
          return {
            ok: true,
            status: "published",
            action: "created",
            version: invocation.request.artifact.version,
            demoId: "demo_123456789012",
            publicId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
            generation: 1,
            url: "https://demos.showkit.sqncs.com/d/01HZZZZZZZZZZZZZZZZZZZZZZZ",
            dashboardUrl: "https://app.showkit.sqncs.com/demos"
          };
        }
      }
    );
    expect(result).toMatchObject({ ok: true, status: "published", action: "created" });
    expect(invocations).toEqual([
      expect.objectContaining({ projectId: "project-command-test" })
    ]);
    expect(invocations[0]?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    const unchangedManifest = JSON.parse(
      await readFile(path.join(artifactDirectory, "artifact.json"), "utf8")
    ) as { publish: unknown };
    expect(unchangedManifest.publish).toBeNull();

    const stylesPath = path.join(artifactDirectory, "styles.css");
    const outsideStyles = path.join(root, "outside-styles.css");
    await writeFile(outsideStyles, await readFile(stylesPath));
    await rm(stylesPath);
    await symlink(outsideStyles, stylesPath);
    let unsafeTransportCalls = 0;
    await expect(
      publishCommand(["--version", exampleManifest.version], {
        destination: "must not be reached",
        publish: async () => {
          unsafeTransportCalls += 1;
          throw new Error("unsafe transport reached");
        }
      })
    ).rejects.toMatchObject({ code: "ArtifactPublishBlocked" });
    expect(unsafeTransportCalls).toBe(0);
  });
});
