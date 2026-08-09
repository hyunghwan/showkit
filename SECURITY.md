# Security

## Supported versions

ShowKit `0.2.x` is the current security support window. Fixes are provided for
its latest patch. Upgrade to the latest available patch before reporting a
problem. Node.js and browser support are listed in
[`COMPATIBILITY.md`](COMPATIBILITY.md).

## Trust boundary

ShowKit treats the live page, DOM, browser state, network data, and local assets
as sensitive input.

- Captures use public Playwright fixture, page, and locator APIs.
- Cookies, headers, storage values, passwords, tokens, raw DOM, request bodies,
  and general response bodies are never persisted. For an exact requested
  public page, or after explicit private-session asset consent, the bounded
  exception is a required visible image or WOFF2 font fetched without
  credentials: ShowKit verifies its file type and size, then persists only the
  content-addressed bytes. Public CSS may be read transiently, up to 4 MB in
  aggregate, only to locate a visible WOFF2 face; CSS bytes and source URLs are
  never captured. When an observed public WOFF2 filename does not identify its
  family, ShowKit compares four fixed, non-page text metric samples in a
  separate network-blocked context. It accepts only one unique content-hash
  match and reads at most 8 MB of candidate font bytes per matching pass.
- Unsupported surfaces, sensitive-looking captured values, unresolved critical
  assets, full-scene images, and oversized captures stop before a publishable
  capture is written.
- Generated demos contain structured semantic HTML, local content-addressed
  assets, a restrictive CSP, and no product scripts.
- Query-bearing visible images in an isolated Playwright flow are allowed for
  the exact requested public page. Private-session images require explicit
  consent. Their source URLs are never written to the captured flow or demo.
- Credential-free asset requests use public DNS only, pin the selected address,
  allow default HTTP or HTTPS ports, omit cookies, authorization, and referrers,
  and reject private addresses, HTTPS downgrade redirects, invalid signatures,
  and oversized files. The page itself never performs this download.
- A static but otherwise non-reusable SVG background may be rendered as one
  bounded background layer in a JavaScript-disabled, network-blocked empty
  browser context. The source SVG is not persisted. A tightly bounded text-free
  icon may instead use direct element capture when its original bytes are not
  safely reusable. Neither path may rasterize the control, its text, or the
  scene.
- `showkit publish` rechecks reports and file hashes before the installed CLI
  connects to ShowKit's fixed first-party hosted service. A failed check uploads
  nothing and leaves the previous published demo unchanged.

Passing ShowKit checks is not a security, compliance, or approval guarantee.

## Report a vulnerability

Use GitHub private vulnerability reporting for a suspected vulnerability. Do
not open a public issue for an unpatched vulnerability.

Include the affected ShowKit version, source route, operating system, named
error code, expected result, and a minimal public or synthetic reproduction.
Describe the sensitive value by type; never send the value itself. Do not
attach credentials, customer data, private product captures, cookies, storage
values, raw DOM, request bodies, or response bodies.

If private reporting is unavailable, contact the repository owner without
sending sensitive material and ask for a private channel. Maintainers will
confirm the report, coordinate a fix and disclosure when reproducible, and
credit the reporter if requested and appropriate. No response-time or fix-time
guarantee is implied.
