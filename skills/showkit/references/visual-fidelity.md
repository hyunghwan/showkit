# Source-faithful visual fidelity

Use this contract for every supported static, isolated Playwright, or verified
ChatGPT or Codex browser source.
The goal is a recognizable, plausible guided HTML demo whose captured product
scene preserves the source's visible structure and interaction cues. This is
not a promise to clone every website or to produce pixel-identical output.

## Keep the fix general

- Apply one source-independent capture, asset, comparison, and recovery process.
- Do not add site names, product-specific selectors, per-site CSS branches, font
  substitutions, icon replacements, or one-off geometry offsets.
- Do not patch generated demo files, captured HTML, or a single scene to hide a
  mismatch.
- Do not mutate the source page or invent replacement content.
- When the person explicitly asks for a reusable extractor or player change,
  prove it with a brand-neutral public `assurance` fixture before recapturing the
  requested flow. Do not copy source branding or production assets into that
  fixture.

## Before capture

1. Lock the source tab, product state, CSS viewport, zoom, locale, timezone,
   and color scheme. For a ChatGPT or Codex selected tab, verify the installed
   isolated world first and
   record the viewport returned by
   `readOpenAIBrowserEnvironment(tab, hostValidation)` as the capture contract.
2. Wait for a concrete ready signal for the requested state. Prefer a visible
   semantic target plus `document.fonts.ready`; include a page-specific
   loading indicator only when it is already visible in the bounded DOM
   snapshot. Do not use an arbitrary sleep as proof that the page is ready.
   Resolve the complete labeled interaction box for compound controls. Do not
   anchor a demo to a nested add, chevron, or disclosure icon when its labeled
   wrapper performs the same action.
3. Inspect a bounded dependency summary for only the visible capture range:
   non-generic fonts; image, background-image, mask-image, and list-image
   dependencies; inline SVG and `use` references; visible pseudo-element
   content; styled controls with `appearance: none`; and unsupported surfaces.
4. Keep the dependency summary structural. Do not print private visible text,
   raw DOM, original asset URLs, signed queries, headers, cookies, or browser
   storage.
5. Stop before persistence when a layout-critical dependency cannot be
   reproduced as safe HTML, CSS, or an approved local content-addressed asset.
   Use `UnsupportedSurface`; never substitute a generic icon, native control,
   fallback font, blank media region, or full-scene screenshot.

Layout-critical means its absence changes recognition, meaning, target
affordance, text wrapping, control geometry, or the primary layout. A purely
decorative detail may be omitted only when it changes none of those.

## Asset consent and adapter wiring

Public and fixture assets keep their exact asset-ID and origin approval rules.
For a private signed-in page, the single **Keep visible content** choice
authorizes only the supported visible text and current-page assets described in
the confirmation. Map that choice to both confirmed modes and connect the page
asset provider:

```js
const pageAssetProvider = createOpenAIPageAssetProvider({ tab });
const adapter = createOpenAIBrowserAdapter({
  tab,
  browserSurface,
  browserName,
  viewport,
  locale,
  timezoneId,
  authenticated: true,
  ownedTab: false,
  hostValidation,
  pageAssetProvider
});

await captureBrowserSession({
  adapter,
  sourceHost: "chatgpt",
  expectedViewport: viewport,
  id,
  url,
  steps,
  privateContentConsent: {
    mode: "visible-session",
    consent: "confirmed"
  },
  pageAssetConsent: {
    mode: "visible-session",
    consent: "confirmed"
  }
});
```

Do this only after explicit consent. Text-only redaction does not grant private
asset consent. Fonts and layout-critical images, masks, backgrounds, and icons
are assets; bundle only supported bytes exposed by the documented provider.

## Compare the source and preview

Compare at the same CSS viewport and same product state. ShowKit's tooltip,
hotspot, backdrop, and player controls are expected overlays; compare the
captured product scene underneath them.

Visual screenshots may be used only as temporary QA evidence after the same
content consent required for capture. Keep them out of the project, captured
product flow, demo, and publish payload. A screenshot is never capture input or
a scene fallback.

Check all of the following:

- primary containers, spacing, fills, borders, radii, shadows, and stacking
- grid line placement, flex order, and layout-only generated items that affect
  automatic placement, including items exposed through `display: contents`
- visible task text, line count, wrapping, clipping, baseline, and font metrics
- every layout-critical image, icon, mask, inline SVG, and pseudo-element
- recognizable semantics and appearance of controls
- semantic target bounds and hotspot alignment
- the complete visible interaction box remains highlighted and uncovered; for
  a visually hidden radio or checkbox input, use its visible associated label
  box instead of the input's clipped rectangle
- child geometry inside bordered controls, not only the outer control bounds
- no ShowKit tooltip or completion card overlaps a visible captured dialog,
  alert dialog, menu, listbox, tooltip, or the active hotspot target
- after a viewport resize without reload, placement is recomputed from the
  current visual viewport and measured card size; the complete card and all of
  its actions stay inside the visible scene shell with bottom-edge clearance
- the complete source scene at the capture aspect ratio
- scene and hotspot alignment after one resized-preview check

For width-bound text, compare `Range.getClientRects()`. For a bordered control,
compare visible child `getBoundingClientRect()` values relative to the control.
The current target must remain visible and undimmed inside the spotlight.
For CSS generated content, preserve only the visual content before an optional
alternative-text `/` value. Keep an empty generated item only when its box
changes grid or flex placement. For a virtualized or scrolled list, compare
the rendered viewport coordinates rather than the element's unscrolled layout
offset.

## Acceptance budget

Report visual fidelity as `checked` only when:

- the requested task and ordered steps are preserved
- task-relevant visible text is present, with the same line count and no new
  clipping
- primary layout and hotspot geometry differ by no more than 4 CSS pixels at
  the capture viewport
- each visible control keeps its recognizable affordance
- every layout-critical asset is present
- player cards have zero overlap with prominent captured components at the
  capture viewport and in the resized preview, including zero intersection with
  the complete active highlighted interaction box at every step
- the complete source scene remains visible at the capture aspect ratio
- one resized preview keeps the scene and hotspot aligned

Subpixel antialiasing, operating-system scrollbar rendering, and a purely
decorative omission that changes no layout or meaning are acceptable. A missing
action icon, fallback font that changes wrapping, native control replacing a
styled control, blank media region, shifted primary container, clipped scene,
or target drift is not acceptable.

Passing this budget does not prove pixel identity, source accessibility,
security, compliance, or approval.

## Generic recovery ladder

When the comparison fails:

1. Restore the same source tab, product state, and capture viewport.
2. Wait again for the concrete layout, font, and lazy-asset ready signals.
3. Verify that the required consent, `createOpenAIPageAssetProvider`, and
   `pageAssetConsent` were connected for the current capture.
4. Recapture once through the normal extractor and rebuild the demo.
5. Use another supported semantic target or route only when it preserves the
   person's requested outcome.
6. If a compressed browser response exceeds one evaluate result, continue
   through the bounded chunked transfer path. Keep the same element and 25 MB
   envelope limits; do not relax them or switch to a screenshot scene.
7. If a material mismatch remains, stop with `UnsupportedSurface`, keep the
   previous demo unchanged, and report the unmet criterion. Do not add a
   site-specific workaround.

## Reporting

Report visual fidelity as `checked`, `incomplete`, or `blocked`:

- `checked`: every acceptance item passed
- `incomplete`: comparison could not finish, so no fidelity claim is made
- `blocked`: a material mismatch or unsupported dependency remained

Include the capture viewport and name any unmet criterion without exposing
private content. Keep captured, built, checked, previewed, and published states
distinct.
