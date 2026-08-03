import { ShowKitError } from "./errors.js";

export type SanitizedPageUrl = {
  origin: string;
  path: string;
  value: string;
};

export function sanitizePageUrl(value: string): SanitizedPageUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShowKitError({
      code: "PageUrlInvalid",
      message: "ShowKit requires a valid HTTP or HTTPS page URL.",
      recovery: "Use an HTTP or HTTPS URL without embedded credentials."
    });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ShowKitError({
      code: "PageUrlInvalid",
      message: "ShowKit requires a valid HTTP or HTTPS page URL.",
      recovery: "Use an HTTP or HTTPS URL without embedded credentials."
    });
  }
  const path = url.pathname || "/";
  return {
    origin: url.origin,
    path,
    value: `${url.origin}${path}`
  };
}
