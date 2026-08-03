import sharp from "sharp";
import { Buffer } from "node:buffer";

export type CapturedImageCrop = {
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
};

export async function cropCapturedImage(input: {
  bytes: Uint8Array;
  left: number;
  top: number;
  width: number;
  height: number;
  allowPartial?: boolean;
  viewport: {
    width: number;
    height: number;
  };
}): Promise<CapturedImageCrop> {
  if (
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > 16 * 1_048_576
  ) {
    throw new TypeError("The browser screenshot size is unsupported.");
  }
  if (
    !Number.isFinite(input.viewport.width) ||
    !Number.isFinite(input.viewport.height) ||
    input.viewport.width <= 0 ||
    input.viewport.height <= 0
  ) {
    throw new TypeError("The browser screenshot viewport is invalid.");
  }
  const logicalRectangle = {
    left: input.left,
    top: input.top,
    width: input.width,
    height: input.height
  };
  if (
    !Number.isFinite(logicalRectangle.left) ||
    !Number.isFinite(logicalRectangle.top) ||
    !Number.isFinite(logicalRectangle.width) ||
    !Number.isFinite(logicalRectangle.height) ||
    logicalRectangle.width < 1 ||
    logicalRectangle.height < 1 ||
    logicalRectangle.width > 512 ||
    logicalRectangle.height > 512
  ) {
    throw new TypeError("The captured image crop is outside the supported range.");
  }
  if (
    input.allowPartial !== true &&
    (logicalRectangle.left < 0 ||
      logicalRectangle.top < 0 ||
      logicalRectangle.left + logicalRectangle.width >
        input.viewport.width ||
      logicalRectangle.top + logicalRectangle.height >
        input.viewport.height)
  ) {
    throw new TypeError("The captured image crop is outside the screenshot.");
  }
  const source = sharp(Buffer.from(input.bytes), {
    failOn: "error",
    limitInputPixels: 4096 * 4096
  });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) {
    throw new TypeError("The captured image crop is outside the screenshot.");
  }
  const scaleX = metadata.width / input.viewport.width;
  const scaleY = metadata.height / input.viewport.height;
  if (
    scaleX < 0.9 ||
    scaleY < 0.9 ||
    scaleX > 4.1 ||
    scaleY > 4.1 ||
    Math.abs(scaleX - scaleY) > 0.15
  ) {
    throw new TypeError("The browser screenshot scale is unsupported.");
  }
  const visibleLogicalRectangle = {
    left: Math.max(0, logicalRectangle.left),
    top: Math.max(0, logicalRectangle.top),
    right: Math.min(
      input.viewport.width,
      logicalRectangle.left + logicalRectangle.width
    ),
    bottom: Math.min(
      input.viewport.height,
      logicalRectangle.top + logicalRectangle.height
    )
  };
  if (
    visibleLogicalRectangle.right <= visibleLogicalRectangle.left ||
    visibleLogicalRectangle.bottom <= visibleLogicalRectangle.top
  ) {
    throw new TypeError("The captured image crop is outside the screenshot.");
  }
  const rectangle = {
    left: Math.round(visibleLogicalRectangle.left * scaleX),
    top: Math.round(visibleLogicalRectangle.top * scaleY),
    right: Math.round(visibleLogicalRectangle.right * scaleX),
    bottom: Math.round(visibleLogicalRectangle.bottom * scaleY)
  };
  const output = {
    width: Math.round(logicalRectangle.width * scaleX),
    height: Math.round(logicalRectangle.height * scaleY),
    left: Math.round(
      (visibleLogicalRectangle.left - logicalRectangle.left) * scaleX
    ),
    top: Math.round(
      (visibleLogicalRectangle.top - logicalRectangle.top) * scaleY
    )
  };
  const sourceWidth = rectangle.right - rectangle.left;
  const sourceHeight = rectangle.bottom - rectangle.top;
  const padding = {
    left: output.left,
    top: output.top,
    right: output.width - output.left - sourceWidth,
    bottom: output.height - output.top - sourceHeight
  };
  if (
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    output.width < 1 ||
    output.height < 1 ||
    output.width > 1024 ||
    output.height > 1024 ||
    rectangle.right > metadata.width ||
    rectangle.bottom > metadata.height ||
    Object.values(padding).some((value) => value < 0)
  ) {
    throw new TypeError("The captured image crop is outside the screenshot.");
  }
  let cropped = source.extract({
    left: rectangle.left,
    top: rectangle.top,
    width: sourceWidth,
    height: sourceHeight
  });
  if (Object.values(padding).some((value) => value > 0)) {
    cropped = cropped.extend({
      ...padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
  }
  const bytes = await cropped
    .png({
      adaptiveFiltering: false,
      compressionLevel: 9,
      palette: false
    })
    .toBuffer();
  return {
    bytes,
    mimeType: "image/png",
    width: output.width,
    height: output.height
  };
}
