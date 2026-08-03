import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { cropCapturedImage } from "./image.js";

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
