# Capture security

- Treat the live page, DOM, browser storage, screenshots, and network data as
  sensitive input.
- Persist only the allowlisted HTML, CSS, text, semantic attributes, target
  geometry, evidence, and approved local assets returned by a supported capture
  path.
- Treat page JavaScript as hostile. Before any ChatGPT or Codex live
  extraction, inspect the installed Browser or Chrome host with
  `verifyOpenAIBrowserHostIsolation({ pluginRoot, tab })`. Require its
  allowlisted version and implementation hash, documented read-only evaluate
  surface, `Page.createIsolatedWorld`, host-owned wrapper, and live probe on
  that exact tab. A DOM snapshot or page-provided claim is never proof.
- A verified OpenAI host may use its official tab-scoped `cdp` capability only
  when the higher-level evaluator is blocked by host policy or its bounded CDP
  setup times out, and only after exact-site approval. Permit exactly
  `Page.getFrameTree`, `Page.createIsolatedWorld`, and `Runtime.evaluate`. Bind
  the bridge to the selected tab and initial HTTP or HTTPS origin, refresh its
  isolated context when the main-frame loader changes, validate results by
  value, and cap their size. Never send `Network`, `Storage`, `Fetch`, cookie,
  `DOMSnapshot`, or another CDP command. Do not expose or persist the raw
  capability.
- A Claude `javascript_tool` capability that runs in page context has no
  host-validated isolated-world guarantee. Return
  `UnsupportedSurface` with
  `browser-isolation-unverified` before live Claude environment extraction,
  scene extraction, actions, or persistence.
- Static-source envelopes must be bound to unique, sorted, project-relative
  source paths and their current SHA-256 values. Report them as
  `source-derived`, not browser-verified.
- Never read or save cookies, headers, request or response bodies, passwords,
  tokens, storage state values, or raw DOM.
- Stop before persistence when a configured sensitive-data pattern is found.
- Treat sensitive-text replacement as opt-in. The coding agent must ask the
  person before capture and may pass `consent: "confirmed"` only after an
  explicit yes.
- When confirmed, replace only captured text nodes and textual accessibility
  attributes. Keep the supported element tree, computed styles, and hotspot
  geometry unchanged. Do not mutate the live DOM or create a synthetic
  replacement page.
- Do not persist runtime redaction selectors or original text. Record only the
  mode, scoped region count, and redacted node and attribute counts.
- A password or unsupported surface still stops capture after redaction consent.
- Exact visible-session capture is also opt-in. Record only confirmed
  `visible-session` mode. It may keep supported visible account or email text
  and current-page image bytes in the local derivative, but never hidden input
  values, passwords, tokens, payment secrets, cookies, headers, storage values,
  request bodies, or response bodies.
- When the person selects **Keep visible content**, the described exact-capture
  choice authorizes the supported visible text and current-page assets together.
  Connect `createOpenAIPageAssetProvider({ tab })` and pass both confirmed
  `privateContentConsent` and `pageAssetConsent` modes. Text-only redaction does
  not grant private asset consent.
- Recheck browser-session HTML, evidence, URLs, asset hashes, and content policy
  in the CLI before persistence.
- The optional Playwright path must use Chromium or Chrome and resolve every
  serializable `captureTarget` through `newCDPSession()` and
  `Page.createIsolatedWorld`. A browser without that capability fails before
  persistence. Use a fresh non-persistent context for codebase-free live
  capture; do not copy an existing profile.
- Allow at most 64 captured assets, 1 MB per asset, and 20 MB of aggregate
  decoded asset payloads. Reject an over-limit or malformed envelope before
  persistence.
- Visible URL text may remain selectable text. A remote URL in an image,
  markup request attribute, CSS request source, or another requesting surface
  must still be removed or replaced by an approved local asset before
  persistence.
- Allow a custom element only when it is a transparent wrapper around
  renderable light DOM, or when its open shadow root contains text-only
  `b`, `em`, `i`, `small`, `span`, `strong`, or `time` descendants with no
  slot, interactive role, control, or editable content. Stop on closed shadow
  roots, interactive or visual open shadow roots, opaque custom elements,
  WebGL, cross-origin frames, or another unsupported surface.
- Treat canvas as unsupported except for one isolated rendered control icon.
  With confirmed visible-session asset consent, the adapter may localize a
  canvas from 4 by 4 through 64 by 64 CSS pixels when it fits wholly in the
  viewport, belongs to a text-free semantic control, overlaps no rendered
  text, has no transform, filter, or shadow, and can be captured with a stable
  backdrop. Persist only its verified local PNG bytes. A chart, editor, map,
  large canvas, or canvas outside those constraints remains
  `UnsupportedSurface`.
- Bundle a visible remote image through the documented browser `pageAssets`
  capability. Require exact public or fixture approval by default; permit
  private images, avatars, account images, and query-bearing image URLs only
  after explicit visible-session asset consent. Reject invalid file signatures
  and files over 1 MB. Persist only verified content-addressed PNG, JPEG, WebP,
  GIF, or safe SVG bytes, never the source URL.
- Treat a remote CSS image inside a visible interactive control as critical.
  When `pageAssets` does not expose its bytes, explicit visible-session asset
  consent may preserve the exact rendered pixels of a text-free icon element
  no larger than 64 by 64 CSS pixels. The element must have one direct HTTP or
  HTTPS background image, fit wholly in the viewport, and contain no SVG,
  canvas, image, picture, or video descendant. Keep its control and surrounding
  scene as semantic HTML. Record `isolated-rendered-icons` in excluded surfaces.
  Stop with `UnsupportedSurface` for any icon outside these constraints; never
  emit a blank or substituted control icon.
- The host must capture that icon element directly. Do not take a viewport
  screenshot and crop it, even transiently. If bounded element capture is
  unavailable, stop with `UnsupportedSurface`.
- Preserve a visible `img` or SVG `image` only from exact bytes returned by the
  approved page-asset inventory. Do not rasterize an image element, transformed
  accessory, complete control, text region, or scene. If its exact bytes are
  unavailable, stop with `UnsupportedSurface`.
- Never use a full-screen image or Playwright trace as demo input.
- A source-versus-preview screenshot may exist only as temporary QA evidence
  after the same content consent required for capture. Do not add it to the
  project, captured product flow, demo, or publish payload.
- Publishing is a separate external action and requires explicit intent.
- Browser-session capture must not inspect or change authentication state. Close
  only a tab created for the capture.
