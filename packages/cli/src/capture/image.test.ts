import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { compareCapturedImages, cropCapturedImage } from "./image.js";

describe("compareCapturedImages", () => {
  test("reports identical in-memory screenshots without persisting an image", async () => {
    const screenshot = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 40, g: 60, b: 80, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    await expect(
      compareCapturedImages({ actual: screenshot, expected: screenshot })
    ).resolves.toEqual({
      width: 2,
      height: 2,
      changedPixelCount: 0,
      changedPixelRatio: 0,
      meanAbsoluteChannelDelta: 0,
      maximumChannelDelta: 0
    });
  });

  test("counts pixels beyond the anti-aliasing threshold", async () => {
    const expected = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();
    const actual = await sharp(
      Buffer.from([0, 0, 0, 255, 80, 0, 0, 255]),
      { raw: { width: 2, height: 1, channels: 4 } }
    )
      .png()
      .toBuffer();

    const comparison = await compareCapturedImages({
      actual,
      expected,
      channelThreshold: 16
    });

    expect(comparison.changedPixelCount).toBe(1);
    expect(comparison.changedPixelRatio).toBe(0.5);
    expect(comparison.maximumChannelDelta).toBe(80);
  });

  test("rejects screenshots with different dimensions", async () => {
    const onePixel = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();
    const twoPixels = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    await expect(
      compareCapturedImages({ actual: onePixel, expected: twoPixels })
    ).rejects.toThrow("identical dimensions");
  });
});

describe("cropCapturedImage", () => {
  test("crops one logical browser rectangle from a scaled screenshot", async () => {
    const screenshot = await sharp({
      create: {
        width: 4,
        height: 2,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    const result = await cropCapturedImage({
      bytes: screenshot,
      left: 1,
      top: 0,
      width: 1,
      height: 1,
      viewport: {
        width: 2,
        height: 1
      }
    });
    const metadata = await sharp(result.bytes).metadata();

    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
  });

  test("rejects a crop outside the visible screenshot", async () => {
    const screenshot = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .png()
      .toBuffer();

    await expect(
      cropCapturedImage({
        bytes: screenshot,
        left: 9,
        top: 9,
        width: 2,
        height: 2,
        viewport: {
          width: 10,
          height: 10
        }
      })
    ).rejects.toThrow("outside the screenshot");
  });
});
