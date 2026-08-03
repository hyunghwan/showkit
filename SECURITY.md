# Security

## Supported versions

Before the first npm release, security fixes are applied to the public `main`
branch. After `0.1.x` is published, fixes are provided for its latest patch.
Upgrade to the latest available patch before reporting a problem. Node.js and
browser support are listed in [`COMPATIBILITY.md`](COMPATIBILITY.md).

## Trust boundary

ShowKit treats the live page, DOM, browser state, network data, and local assets
as sensitive input.

- Captures use public Playwright fixture, page, and locator APIs.
- Cookies, headers, storage values, passwords, tokens, raw DOM, request bodies,
  and response bodies are never persisted.
- Unsupported surfaces, sensitive-looking values, remote assets, full-scene
  images, and oversized captures stop before a publishable capture is written.
- Generated demos contain structured semantic HTML, local content-addressed
  assets, a restrictive CSP, and no product scripts.
- `showkit publish` rechecks reports and file hashes. The local-only release
  does not upload anything.

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
