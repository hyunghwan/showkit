import type { Locator, Page } from "@playwright/test";
import { EXIT_CODES, ShowKitError } from "../core/errors.js";
import { sha256 } from "../core/json.js";
import type { AssetPayload, Scene } from "../core/schemas.js";
import { DEFAULT_SECRET_PATTERN_SOURCES } from "../core/security.js";
import {
  extractSceneKernel,
  type SceneKernelBlocker,
  type SceneKernelOptions,
  type SceneKernelResult
} from "./extractor.js";
import { decodeSceneKernelResult } from "./scene-transfer.js";

export const PLAYWRIGHT_CAPTURE_ISOLATION_VERSION =
  "chromium-cdp-isolated-readonly-v1";

export type SemanticCaptureTarget = NonNullable<
  SceneKernelOptions["scopeTarget"]
>;

type CdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  detach(): Promise<void>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ariaSnapshotMatchesTarget(
  snapshot: string,
  target: { role?: string; name: string }
): boolean {
  if (!target.role || !target.name) return false;
  const role = escapeRegExp(target.role);
  const quotedName = escapeRegExp(JSON.stringify(target.name));
  return new RegExp(
    `^\\s*-\\s+${role}\\s+${quotedName}(?:\\s|:|$)`,
    "m"
  ).test(snapshot);
}

function sensitiveSelectors(): string[] {
  return (process.env.SHOWKIT_SENSITIVE_SELECTORS ?? "")
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function policyError(blocker: SceneKernelBlocker): ShowKitError {
  const definitions: Record<string, { message: string; recovery: string }> = {
    SensitiveDataDetected: {
      message: "Sensitive data was found. ShowKit did not save the captured page.",
      recovery: "Hide the data or update the capture rule, then try again."
    },
    UnsupportedSurface: {
      message: "ShowKit cannot capture this part of the page yet. No captured page was saved.",
      recovery: "Use supported HTML elements or remove this step."
    },
    CaptureTooLarge: {
      message: "The captured product flow exceeds a safety size limit.",
      recovery: "Reduce the number or size of captured states and assets, then capture again."
    },
    BrowserTargetAmbiguous: {
      message: "The browser target is missing, hidden, or ambiguous.",
      recovery: "Refresh the DOM snapshot and select one visible semantic target."
    },
    TargetMissing: {
      message: "ShowKit could not find this hotspot target.",
      recovery: "Use a target that matches one visible semantic element, then capture again."
    }
  };
  const definition =
    blocker.code === "UnsupportedSurface" &&
    blocker.category === "remote-asset"
      ? {
          message:
            "A visible control depends on an image the browser could not bundle. No captured page was saved.",
          recovery:
            "Use a page state where the original image bytes can be bundled, or remove that control from the captured range. Do not substitute the icon."
        }
      : definitions[blocker.code] ?? definitions.UnsupportedSurface!;
  return new ShowKitError({
    code: blocker.code,
    message: `[SHOWKIT:${blocker.code}] ${definition.message}`,
    exitCode: EXIT_CODES.validation,
    recovery: definition.recovery,
    details: {
      category: blocker.category,
      stepIndex: blocker.stepIndex,
      sourceFingerprint: blocker.sourceFingerprint
    }
  });
}

function kernelOptions(
  options: Partial<SceneKernelOptions> & Pick<SceneKernelOptions, "targetPresent">
): SceneKernelOptions {
  return {
    targetPresent: options.targetPresent,
    scanOnly: options.scanOnly ?? false,
    stepIndex: options.stepIndex ?? 0,
    secretPatternSources: [...DEFAULT_SECRET_PATTERN_SOURCES],
    sensitiveSelectors: sensitiveSelectors(),
    remoteAssetPolicy: options.remoteAssetPolicy ?? "strict",
    targetErrorCode: options.targetErrorCode ?? "TargetMissing",
    nodeMode: options.scanOnly ? "tree" : "json",
    ...(!options.scanOnly ? { transferEncoding: "lzss-json" as const } : {}),
    ...(options.anchorId ? { anchorId: options.anchorId } : {}),
    ...(options.scopeTarget ? { scopeTarget: options.scopeTarget } : {}),
    ...(options.transferEncoding
      ? { transferEncoding: options.transferEncoding }
      : {}),
    ...(options.transferOffset !== undefined
      ? { transferOffset: options.transferOffset }
      : {}),
    ...(options.transferChunkSize !== undefined
      ? { transferChunkSize: options.transferChunkSize }
      : {})
  };
}

function browserIsolationError(error?: unknown): ShowKitError {
  return new ShowKitError({
    code: "UnsupportedSurface",
    message:
      "[SHOWKIT:UnsupportedSurface] This browser cannot provide the isolated page world required for safe capture. No captured page was saved. [SHOWKIT-CATEGORY:browser-isolation-unavailable]",
    exitCode: EXIT_CODES.environment,
    recovery:
      "Run this flow in Chromium or Chrome through Playwright 1.60 or newer, or use the static-source route.",
    details: {
      category: "browser-isolation-unavailable",
      isolation: PLAYWRIGHT_CAPTURE_ISOLATION_VERSION,
      ...(error instanceof Error && error.message
        ? { reason: error.message.slice(0, 240) }
        : {})
    }
  });
}

async function evaluateInIsolatedWorld(
  page: Page,
  options: SceneKernelOptions
): Promise<SceneKernelResult> {
  let session: CdpSession | undefined;
  try {
    session = (await page.context().newCDPSession(page)) as CdpSession;
    const frameTree = (await session.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) throw new Error("The main browser frame is unavailable.");
    const isolatedWorld = (await session.send("Page.createIsolatedWorld", {
      frameId,
      worldName: "showkit-capture-readonly",
      grantUniveralAccess: false
    })) as { executionContextId?: number };
    if (!Number.isInteger(isolatedWorld.executionContextId)) {
      throw new Error("The isolated browser execution context is unavailable.");
    }
    const functionDeclaration = `async function(options) {
      const extract = ${extractSceneKernel.toString()};
      return await extract(options);
    }`;
    const callKernel = async (
      nextOptions: SceneKernelOptions
    ): Promise<SceneKernelResult> => {
      const response = (await session!.send("Runtime.callFunctionOn", {
        functionDeclaration,
        executionContextId: isolatedWorld.executionContextId,
        arguments: [{ value: nextOptions }],
        awaitPromise: true,
        returnByValue: true,
        userGesture: false
      })) as {
        result?: { value?: SceneKernelResult };
        exceptionDetails?: { text?: string };
      };
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.text ??
            "The isolated browser evaluation failed."
        );
      }
      if (!response.result || response.result.value === undefined) {
        throw new Error("The isolated browser evaluation returned no result.");
      }
      return response.result.value;
    };
    const initialResult = await callKernel(options);
    return await decodeSceneKernelResult(
      initialResult,
      (offset, chunkSize) =>
        callKernel({
          ...options,
          transferEncoding: "chunked-json",
          transferOffset: offset,
          transferChunkSize: chunkSize
        })
    );
  } catch (error) {
    if (error instanceof ShowKitError) throw error;
    throw browserIsolationError(error);
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

export async function inspectPagePolicy(page: Page): Promise<void> {
  const result = await evaluateInIsolatedWorld(
    page,
    kernelOptions({ targetPresent: false, scanOnly: true })
  );
  if (!result.ok) throw policyError(result.blocker);
}

export async function captureScene(
  page: Page,
  options?: {
    target: Locator;
    captureTarget: SemanticCaptureTarget;
    anchorId: string;
    stepIndex?: number;
    remoteAssetPolicy?: "strict" | "decorative-remove";
    targetErrorCode?: "TargetMissing" | "BrowserTargetAmbiguous";
  }
): Promise<{
  scene: Scene;
  evidenceTexts: string[];
  assets: AssetPayload[];
  excludedSurfaces: string[];
}> {
  if (options && (await options.target.count()) !== 1) {
    throw new ShowKitError({
      code: options.targetErrorCode ?? "TargetMissing",
      message: `[SHOWKIT:${options.targetErrorCode ?? "TargetMissing"}] ShowKit requires exactly one visible semantic target.`,
      recovery: "Refresh the page state and narrow the target to one visible semantic element."
    });
  }
  const locatorBounds = options
    ? await options.target.boundingBox()
    : undefined;
  let locatorAriaSnapshot: string | undefined;
  if (options) {
    try {
      locatorAriaSnapshot = await options.target.ariaSnapshot({
        timeout: 2_000
      });
    } catch {
      throw new ShowKitError({
        code: options.targetErrorCode ?? "TargetMissing",
        message: `[SHOWKIT:${options.targetErrorCode ?? "TargetMissing"}] ShowKit could not verify the action target's semantic identity.`,
        exitCode: EXIT_CODES.validation,
        recovery:
          "Use one visible semantic element with an accessible role and name, then capture again.",
        details: { category: "target-locator-unavailable" }
      });
    }
  }
  if (options && !locatorBounds) {
    throw new ShowKitError({
      code: options.targetErrorCode ?? "TargetMissing",
      message: `[SHOWKIT:${options.targetErrorCode ?? "TargetMissing"}] ShowKit requires one visible semantic target.`,
      exitCode: EXIT_CODES.validation,
      recovery: "Refresh the page state and select one visible semantic element.",
      details: { category: "target-locator-unavailable" }
    });
  }
  const result = await evaluateInIsolatedWorld(
    page,
    kernelOptions({
      targetPresent: Boolean(options),
      stepIndex: options?.stepIndex ?? 0,
      ...(options?.anchorId ? { anchorId: options.anchorId } : {}),
      ...(options?.captureTarget
        ? { scopeTarget: options.captureTarget }
        : {}),
      ...(options?.remoteAssetPolicy
        ? { remoteAssetPolicy: options.remoteAssetPolicy }
        : {}),
      ...(options?.targetErrorCode
        ? { targetErrorCode: options.targetErrorCode }
        : {})
    })
  );
  if (!result.ok) throw policyError(result.blocker);
  if (result.scanOnly) {
    throw new Error("The scene extractor returned a scan-only result during capture.");
  }
  if (options && (!result.target || result.evidenceTexts.length === 0)) {
    throw new ShowKitError({
      code: options.targetErrorCode ?? "TargetMissing",
      message: `[SHOWKIT:${options.targetErrorCode ?? "TargetMissing"}] ShowKit could not derive a semantic hotspot target.`,
      recovery: "Use a visible semantic target, then capture the flow again."
    });
  }
  if (options && locatorBounds && result.target) {
    const normalizedLocatorBounds = {
      x: locatorBounds.x / result.viewport.width,
      y: locatorBounds.y / result.viewport.height,
      width: locatorBounds.width / result.viewport.width,
      height: locatorBounds.height / result.viewport.height
    };
    const horizontalTolerance = Math.max(
      0.003,
      3 / result.viewport.width
    );
    const verticalTolerance = Math.max(
      0.003,
      3 / result.viewport.height
    );
    const sameBounds =
      Math.abs(normalizedLocatorBounds.x - result.target.bounds.x) <=
        horizontalTolerance &&
      Math.abs(
        normalizedLocatorBounds.width - result.target.bounds.width
      ) <= horizontalTolerance &&
      Math.abs(normalizedLocatorBounds.y - result.target.bounds.y) <=
        verticalTolerance &&
      Math.abs(
        normalizedLocatorBounds.height - result.target.bounds.height
      ) <= verticalTolerance;
    const sameSemanticIdentity =
      typeof locatorAriaSnapshot === "string" &&
      ariaSnapshotMatchesTarget(locatorAriaSnapshot, result.target);
    if (!sameBounds || !sameSemanticIdentity) {
      throw new ShowKitError({
        code: options.targetErrorCode ?? "TargetMissing",
        message: `[SHOWKIT:${options.targetErrorCode ?? "TargetMissing"}] The action target does not match the isolated capture target. [SHOWKIT-CATEGORY:target-locator-mismatch]`,
        exitCode: EXIT_CODES.validation,
        recovery:
          "Use the same visible semantic element for `target` and `captureTarget`, then capture again.",
        details: { category: "target-locator-mismatch" }
      });
    }
  }
  return {
    scene: {
      html: result.html,
      nodes: result.nodes,
      viewport: result.viewport,
      ...(options ? { anchorId: options.anchorId, target: result.target } : {})
    } as Scene,
    evidenceTexts: result.evidenceTexts.map((text) => text.trim()).filter(Boolean),
    assets: result.assetPayloads,
    excludedSurfaces: result.excludedSurfaces
  };
}

export function evidenceFromTexts(texts: string[]): Array<{ id: string; text: string }> {
  return [...new Set(texts)].map((text) => ({
    id: `ev-${sha256(text).slice(0, 12)}`,
    text
  }));
}
