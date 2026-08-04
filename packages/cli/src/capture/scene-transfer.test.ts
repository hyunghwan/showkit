import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  FrozenSceneTransferResult,
  SceneKernelResult
} from "./extractor.js";
import { decodeSceneKernelResult } from "./scene-transfer.js";

const html = "<main><p>Frozen HTML</p></main>";
const nodesJson = JSON.stringify([
  {
    type: "element",
    tag: "main",
    attributes: {},
    styles: {},
    children: [{ type: "text", text: "Frozen HTML" }]
  }
]);
const captureId = "frozen-transfer-test-0001";
const chunkSize = 16;

function payloadHash(valueHtml = html, valueNodesJson = nodesJson): string {
  return createHash("sha256")
    .update(`${valueHtml}\u0000${valueNodesJson}`)
    .digest("hex");
}

function initialResult(hash = payloadHash()): SceneKernelResult {
  return {
    ok: true,
    scanOnly: false,
    html: html.slice(0, chunkSize),
    nodes: [],
    nodesJson: nodesJson.slice(0, chunkSize),
    transfer: {
      mode: "chunked-json",
      captureId,
      payloadSha256: hash,
      offset: 0,
      chunkSize,
      htmlLength: html.length,
      nodesJsonLength: nodesJson.length
    },
    viewport: { width: 1280, height: 720 },
    evidenceTexts: ["Frozen HTML"],
    assetPayloads: [],
    fontFaces: [],
    excludedSurfaces: [],
    sensitiveText: {
      mode: "blocked-by-default",
      redactedTextNodeCount: 0,
      redactedAttributeCount: 0,
      regionCount: 0
    }
  };
}

function segment(offset: number, hash = payloadHash()): FrozenSceneTransferResult {
  return {
    ok: true,
    scanOnly: false,
    html: html.slice(offset, offset + chunkSize),
    nodesJson: nodesJson.slice(offset, offset + chunkSize),
    transfer: {
      mode: "chunked-json",
      captureId,
      payloadSha256: hash,
      offset,
      chunkSize,
      htmlLength: html.length,
      nodesJsonLength: nodesJson.length
    }
  };
}

describe("decodeSceneKernelResult", () => {
  test("assembles one frozen sanitized HTML transfer", async () => {
    const decoded = await decodeSceneKernelResult(initialResult(), async (offset) =>
      segment(offset)
    );

    expect(decoded).toEqual(
      expect.objectContaining({
        ok: true,
        scanOnly: false,
        html,
        nodes: [
          expect.objectContaining({
            type: "element",
            tag: "main"
          })
        ]
      })
    );
  });

  test("rejects a transfer whose frozen payload hash changed", async () => {
    await expect(
      decodeSceneKernelResult(initialResult("0".repeat(64)), async (offset) =>
        segment(offset, "0".repeat(64))
      )
    ).rejects.toThrow("changed content");
  });
});
