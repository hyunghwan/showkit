import { describe, expect, it } from "vitest";
import { SanitizedNodeSchema } from "./schemas.js";
import { containsConfiguredSensitiveText } from "./security.js";

describe("configured sensitive text", () => {
  it("keeps public long numeric identifiers that are not payment cards", () => {
    expect(
      containsConfiguredSensitiveText(
        "/Example-State/Example-City/example/home/1234567890123456789"
      )
    ).toBe(false);
  });

  it("detects Luhn-valid payment card numbers", () => {
    expect(containsConfiguredSensitiveText("4111 1111 1111 1111")).toBe(true);
  });

  it("accepts safe local SVG clip paths in sanitized nodes", () => {
    expect(() =>
      SanitizedNodeSchema.parse({
        type: "element",
        tag: "clippath",
        attributes: {
          id: "logo-clip",
          clipPathUnits: "userSpaceOnUse"
        },
        styles: {
          "clip-path": 'url("#logo-clip")'
        },
        children: []
      })
    ).not.toThrow();
  });

  it("accepts a sanitized same-document SVG symbol reference", () => {
    expect(() =>
      SanitizedNodeSchema.parse({
        type: "element",
        tag: "svg",
        attributes: {
          viewBox: "0 0 16 16"
        },
        styles: {},
        children: [
          {
            type: "element",
            tag: "defs",
            attributes: {},
            styles: {},
            children: [
              {
                type: "element",
                tag: "symbol",
                attributes: {
                  id: "project-icon",
                  viewBox: "0 0 16 16"
                },
                styles: {},
                children: [
                  {
                    type: "element",
                    tag: "path",
                    attributes: {
                      d: "M2 2h12v12H2z"
                    },
                    styles: {},
                    children: []
                  }
                ]
              }
            ]
          },
          {
            type: "element",
            tag: "use",
            attributes: {
              href: "#project-icon"
            },
            styles: {},
            children: []
          }
        ]
      })
    ).not.toThrow();
  });
});
