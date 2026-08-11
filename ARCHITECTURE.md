# Architecture

ShowKit is a deterministic, agent-native CLI. A coding agent plans the demo;
ShowKit validates that plan, sanitizes supported product states, and builds a
portable interactive HTML result. ShowKit does not call or host an LLM.

## Dependency direction

```text
capture -> core <- player/build
```

- `capture` converts a supported source into sanitized, structured product
  states.
- `core` owns Zod schemas, security policy, hashing, validation, and named
  errors. It does not depend on capture hosts or rendering code.
- `player/build` turns checked states and demo content into semantic HTML,
  local content-addressed assets, hotspots, tooltips, and reports.

The public package surfaces remain `@showkit/cli` and
`@showkit/cli/playwright`. A second package boundary is not needed without a
second independent consumer.

## Lifecycle

1. `doctor` reports CLI, host, and optional Playwright capabilities separately.
2. `init` creates a local `.showkit/` project directory.
3. A static envelope, verified browser session, or Playwright fixture produces
   ordered sanitized states.
4. Security policy runs before persistence. A blocked capture may leave only
   secret-free diagnostics.
5. Demo content is checked against captured evidence.
6. `build` writes a new artifact through a temporary directory and atomic
   rename.
7. `validate`, `diff`, and the local publish gate recheck reports and hashes.
8. `preview` serves the latest artifact locally. Hosting remains a separate
   user action.

Capture runs are immutable. Timestamps and run IDs may appear in local
operations, but they do not affect artifact content hashes. The same captured
input and demo content produce the same artifact hash.

## Trust boundary

The live page, DOM, browser state, network data, and local assets are sensitive
inputs. ShowKit never persists cookies, headers, browser storage values,
passwords, tokens, raw DOM, general request or response bodies, or remote asset
URLs. For an exact requested public page, or after explicit private-session
asset consent, required visible images and WOFF2 fonts may be fetched through a
fresh credential-free request and persisted only as validated,
content-addressed bytes. Public CSS may be read transiently only to locate a
visible font; the stylesheet and its source URL are not captured. Opaque public
WOFF2 candidates may be disambiguated with fixed non-page text metrics in a
separate network-blocked context, with an 8 MB aggregate read limit and a
required single unique content-hash match per matching pass.

Supported output is structured HTML, CSS, semantic elements, and local
content-addressed assets. ShowKit fails closed when it cannot reproduce a
surface safely. There is no full-scene screenshot fallback, Playwright trace
input, product-script replay, or remote request in a built demo.

Capture support is capability-based, not URL-based. For an authored Playwright
flow or explicitly confirmed browser-session content, ShowKit may retain the
semantic scroll range from the document origin through the currently revealed
viewport, including the equivalent revealed range in nested scroll containers.
Content beyond that range remains excluded. The player restores those offsets
with native scrolling and keeps captured fixed or sticky context aligned.

The default camera mode is `fit`, so the complete HTML scene does not zoom. Its
first guided state is rendered already settled, without scene, progress, or
hotspot entrance animation.
`player.camera: "focus"` is an optional global presentation mode applied only
after the first complete preview. In that mode, camera motion remains a
deterministic player decision derived from normalized target geometry and the
available embed size: compact edge targets may receive a restrained focus zoom,
while ordinary targets, small embeds, and tall scenes remain fitted. Demo
content never stores per-step camera coordinates or a camera timeline. The
optional welcome cover is also deterministic and uses the first live HTML scene
rather than a raster preview; it is omitted by default.

Passing ShowKit checks establishes the player and artifact properties recorded
in its reports. It does not certify the source product's security,
accessibility, compliance, or approval status.

## Source routes

| Route | Boundary |
| --- | --- |
| Static source | Reads explicitly bound, checked-in HTML/CSS or a sanitized envelope; Playwright is not required |
| Verified browser session | Continues only when the installed host proves isolated, read-only execution |
| Playwright fixture | Uses public fixture, page, and locator APIs; the optional peer is installed only with approval; requested public-page or session-approved visible assets use fresh credential-free public-network requests and verified local bytes |

Trace files are optional diagnostics and never build input. A host that cannot
prove isolation is unsupported for live capture.

## Runtime contracts

Zod schemas in `packages/cli/src/core/schemas.ts` are the runtime source of
truth. The build generates matching JSON Schemas under the public
`@showkit/cli/schema/*` export. Commands write machine-readable JSON to stdout;
human progress belongs on stderr.

Expected failures use stable exit codes: `2` for validation, `3` for
environment or dependency problems, `4` for external capability problems, and
`70` for unexpected internal failures.

See [`packages/cli/README.md`](packages/cli/README.md) for commands and public
exports, and [`SECURITY.md`](SECURITY.md) for reporting and safe-use guidance.
