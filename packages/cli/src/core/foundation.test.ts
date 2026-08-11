import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { helpCommand } from "../commands.js";
import { asShowKitError, EXIT_CODES } from "./errors.js";
import { replaceDirectoryAtomic } from "./json.js";
import { satisfiesVersionRange } from "./version.js";

describe("public package contract", () => {
  it("keeps one package with stable root, Playwright, and schema subpaths", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(process.cwd(), "package.json"), "utf8")
    ) as {
      name: string;
      exports: Record<string, unknown>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      dependencies: Record<string, string>;
    };

    expect(packageJson.name).toBe("@showkit/cli");
    expect(Object.keys(packageJson.exports)).toEqual([".", "./playwright", "./schema/*"]);
    expect(packageJson.exports["."]).toMatchObject({
      import: "./dist/index.js",
      require: "./dist/index.js"
    });
    expect(packageJson.exports["./playwright"]).toMatchObject({
      import: "./dist/playwright.js",
      require: "./dist/playwright.js"
    });
    expect(packageJson.peerDependencies["@playwright/test"]).toBe(">=1.60.0 <2");
    expect(
      packageJson.peerDependenciesMeta["@playwright/test"]?.optional
    ).toBe(true);
    expect(packageJson.dependencies).not.toHaveProperty("@playwright/test");
  });

  it("keeps the help command JSON shape stable", () => {
    const result = helpCommand();
    expect({ ...result, operationId: "op-<id>" }).toMatchInlineSnapshot(`
      {
        "commands": [
          "showkit doctor --json",
          "showkit init --json",
          "showkit capture <demo.spec.ts> --viewport 1440x900 --preflight --json",
          "showkit capture <demo.spec.ts> --viewport 1440x900 [--project <name>] --json",
          "showkit capture session <safe-envelope.json> --json",
          "showkit capture static <safe-envelope.json> --json",
          "showkit story apply <story.json> --json",
          "showkit validate --json",
          "showkit build web,markdown --json",
          "showkit diff --base <artifact.json> --json",
          "showkit diff --base <artifact.json> --check --json",
          "showkit diff --base <artifact.json> --source <demo.spec.ts> [--project <name>] --check --json",
          "showkit preview --json",
          "showkit publish --version <hash> --json",
        ],
        "ok": true,
        "operationId": "op-<id>",
        "status": "help",
      }
    `);
  });
});

describe("supported version ranges", () => {
  it("checks the documented Node and Playwright boundaries", () => {
    expect(satisfiesVersionRange("v22.11.0", ">=22.12 <25")).toBe(false);
    expect(satisfiesVersionRange("v22.12.0", ">=22.12 <25")).toBe(true);
    expect(satisfiesVersionRange("v24.99.0", ">=22.12 <25")).toBe(true);
    expect(satisfiesVersionRange("v25.0.0", ">=22.12 <25")).toBe(false);
    expect(satisfiesVersionRange("1.60.0", ">=1.60.0 <2")).toBe(true);
    expect(satisfiesVersionRange("1.59.9", ">=1.60.0 <2")).toBe(false);
    expect(satisfiesVersionRange("2.0.0", ">=1.60.0 <2")).toBe(false);
  });

  it("maps unexpected failures to the stable internal exit code", () => {
    const error = asShowKitError(new Error("private implementation detail"));
    expect(error.code).toBe("InternalError");
    expect(error.exitCode).toBe(EXIT_CODES.internal);
    expect(error.message).not.toContain("private implementation detail");
  });
});

describe("immutable atomic directories", () => {
  it("removes a failed temporary directory and leaves no publishable target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "showkit-atomic-"));
    const target = path.join(root, "artifact");

    await expect(
      replaceDirectoryAtomic(target, async (temporaryPath) => {
        await writeFile(path.join(temporaryPath, "partial.txt"), "partial");
        throw new Error("injected write failure");
      })
    ).rejects.toThrow("injected write failure");

    expect(await readdir(root)).toEqual([]);
  });

  it("refuses to overwrite an immutable directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "showkit-immutable-"));
    const target = path.join(root, "run");
    await replaceDirectoryAtomic(target, async (temporaryPath) => {
      await writeFile(path.join(temporaryPath, "run.json"), "first");
    });

    await expect(
      replaceDirectoryAtomic(target, async (temporaryPath) => {
        await writeFile(path.join(temporaryPath, "run.json"), "second");
      })
    ).rejects.toThrow("Immutable directory already exists");
    expect(await readFile(path.join(target, "run.json"), "utf8")).toBe("first");
    expect(await readdir(root)).toEqual(["run"]);
  });
});
