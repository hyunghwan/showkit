import type { SanitizedNode } from "../core/schemas.js";
import type { SceneKernelResult } from "./extractor.js";

type CompleteSceneResult = Extract<
  SceneKernelResult,
  { ok: true; scanOnly: false }
>;

function serializeSanitizedNodes(nodes: SanitizedNode[]): string {
  const escapeText = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const escapeAttribute = (value: string): string =>
    escapeText(value).replace(/"/g, "&quot;");
  const serializeNode = (node: SanitizedNode): string => {
    if (node.type === "text") return escapeText(node.text);
    const attributes = Object.entries(node.attributes)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");
    const styleValue = Object.entries(node.styles)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
    const style = styleValue
      ? ` style="${escapeAttribute(styleValue)}"`
      : "";
    if (["hr", "img", "input"].includes(node.tag)) {
      return `<${node.tag}${attributes}${style}>`;
    }
    return `<${node.tag}${attributes}${style}>${node.children
      .map(serializeNode)
      .join("")}</${node.tag}>`;
  };
  return nodes.map(serializeNode).join("");
}

function decodeSceneTransfer(
  value: string,
  compressedLength: number,
  nodesJsonLength: number
): string {
  const compressed = new Uint8Array(compressedLength);
  let packedBuffer = 0;
  let packedBits = 0;
  let compressedOffset = 0;
  for (const character of value) {
    const packed = character.charCodeAt(0) - 0x100;
    if (packed < 0 || packed > 0x7fff) {
      throw new Error("The compressed HTML node transfer has invalid data.");
    }
    packedBuffer = (packedBuffer << 15) | packed;
    packedBits += 15;
    while (packedBits >= 8 && compressedOffset < compressed.length) {
      packedBits -= 8;
      compressed[compressedOffset] =
        (packedBuffer >> packedBits) & 0xff;
      compressedOffset += 1;
      packedBuffer &= (1 << packedBits) - 1;
    }
  }
  if (compressedOffset !== compressed.length) {
    throw new Error("The compressed HTML node transfer is incomplete.");
  }

  const output: number[] = [];
  let offset = 0;
  while (offset < compressed.length) {
    const flags = compressed[offset] ?? 0;
    offset += 1;
    for (let bit = 0; bit < 8 && offset < compressed.length; bit += 1) {
      if ((flags & (1 << bit)) === 0) {
        output.push(compressed[offset] ?? 0);
        offset += 1;
        continue;
      }
      if (offset + 2 >= compressed.length) {
        throw new Error("The compressed HTML node transfer is truncated.");
      }
      const distance =
        (((compressed[offset] ?? 0) << 8) |
          (compressed[offset + 1] ?? 0)) +
        1;
      const length = (compressed[offset + 2] ?? 0) + 3;
      offset += 3;
      if (distance <= 0 || distance > output.length) {
        throw new Error("The compressed HTML node transfer is invalid.");
      }
      const matchOffset = output.length - distance;
      for (let index = 0; index < length; index += 1) {
        output.push(output[matchOffset + index] ?? 0);
        if (output.length > 2_000_000) {
          throw new Error("The compressed HTML node transfer is too large.");
        }
      }
    }
  }

  const nodesJson = new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(output)
  );
  if (nodesJson.length !== nodesJsonLength) {
    throw new Error("The compressed HTML node transfer changed length.");
  }
  return nodesJson;
}

function parseNodes(value: string): SanitizedNode[] {
  const nodes = JSON.parse(value) as unknown;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("The captured HTML node transfer is empty.");
  }
  return nodes as SanitizedNode[];
}

export async function decodeSceneKernelResult(
  initialResult: SceneKernelResult,
  evaluateSegment: (
    offset: number,
    chunkSize: number
  ) => Promise<SceneKernelResult>
): Promise<SceneKernelResult> {
  if (
    !initialResult.ok ||
    initialResult.scanOnly ||
    typeof initialResult.nodesJson !== "string"
  ) {
    return initialResult;
  }

  let html = initialResult.html;
  let nodesJson = initialResult.nodesJson;
  if (initialResult.transfer?.mode === "lzss-json") {
    const transfer = initialResult.transfer;
    if (
      transfer.encoding !== "lzss-15bit" ||
      !Number.isInteger(transfer.compressedLength) ||
      transfer.compressedLength <= 0 ||
      transfer.compressedLength > 90_000 ||
      !Number.isInteger(transfer.nodesJsonLength) ||
      transfer.nodesJsonLength <= 0 ||
      transfer.nodesJsonLength > 2_000_000 ||
      nodesJson.length === 0 ||
      nodesJson.length > 48_000
    ) {
      throw new Error("The compressed HTML node transfer is invalid.");
    }
    nodesJson = decodeSceneTransfer(
      nodesJson,
      transfer.compressedLength,
      transfer.nodesJsonLength
    );
  } else if (initialResult.transfer?.mode === "chunked-json") {
    const transfer = initialResult.transfer;
    const totalLength = Math.max(
      transfer.htmlLength,
      transfer.nodesJsonLength
    );
    for (
      let offset = transfer.chunkSize;
      offset < totalLength;
      offset += transfer.chunkSize
    ) {
      const segment = await evaluateSegment(offset, transfer.chunkSize);
      if (
        !segment.ok ||
        segment.scanOnly ||
        segment.transfer?.mode !== "chunked-json" ||
        segment.transfer.offset !== offset ||
        typeof segment.html !== "string" ||
        typeof segment.nodesJson !== "string"
      ) {
        throw new Error("The captured HTML node transfer was interrupted.");
      }
      html += segment.html;
      nodesJson += segment.nodesJson;
    }
    if (
      html.length < transfer.htmlLength ||
      nodesJson.length < transfer.nodesJsonLength
    ) {
      throw new Error("The captured HTML node transfer is incomplete.");
    }
    html = html.slice(0, transfer.htmlLength);
    nodesJson = nodesJson.slice(0, transfer.nodesJsonLength);
  }

  const nodes = parseNodes(nodesJson);
  if (initialResult.transfer?.mode === "lzss-json") {
    html = serializeSanitizedNodes(nodes);
  }
  return {
    ...initialResult,
    html,
    nodes
  } satisfies CompleteSceneResult;
}
