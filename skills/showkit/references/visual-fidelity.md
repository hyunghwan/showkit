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
   wrapper performs the same action. If a compact disclosure control and its
   visible label are sibling elements that form one interaction, use their
   combined visible rectangle. Center a non-fixed target that sits within the
   top or bottom capture margin before extraction; keep fixed and sticky
   controls in place.
3. After each action, wait for a durable visible state. Require a bounded quiet
   window after page mutations and resizing, loaded visible images, ready
   fonts, and completed finite layout animations. Re-check the URL and visible
   semantic state after settling. A transient state that returns to the
   pre-action state is a failed action, not a captured product state.
4. Inspect a bounded dependency summary for only the visible capture range:
   non-generic fonts; image, background-image, mask-image, and list-image
   dependencies; inline SVG and `use` references; visible pseudo-element
   content; styled controls with `appearance: none`; and unsupported surfaces.
5. Keep the dependency summary structural. Do not print private visible text,
   raw DOM, original asset URLs, signed queries, headers, cookies, or browser
   storage.
6. Stop before persistence when a layout-critical dependency cannot be
   reproduced as safe HTML, CSS, or an approved local content-addressed asset.
   Use `UnsupportedSurface`; never substitute a generic icon, native control,
   unverified fallback font, blank media region, or full-scene screenshot. The
   only system text-font exception is the confirmed and bounded rule in
   `security.md`.

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
If exact loaded text-font bytes still remain unavailable after confirmed
visible-session consent, use the fixed system stack only when the bounded
non-page metric check in `security.md` passes. Keep icon fonts fail-closed.

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
- after `document.fonts.ready`, the generated preview reports
  `#scene-viewport[data-text-layout="checked"]`; require
  `data-text-metric-drift-count`, `data-text-multi-line-fragment-count`, and
  `data-text-collision-count`, and `data-suppressed-placeholder-count` to all be
  `0` on every step and the completion scene. A nonzero
  `data-redacted-multi-line-fragment-count` is allowed only for explicitly
  confirmed text-only redaction when its synthetic mask remains inside the
  recorded text box and metric drift and collisions are both `0`. A nonzero
  `data-bounded-multi-line-fragment-count` is allowed only for intentional
  wrapping retained from a pre-`0.2.7` capture when the wrapper still matches
  its recorded box and metric drift and collisions are both `0`.
  Inspect the generated HTML itself. A source screenshot or capture result is
  not evidence that the HTML passed. `pending` is not a pass.
  `failed` is a material mismatch.
- every layout-critical image, icon, mask, inline SVG, and pseudo-element
- a private-use control icon whose font bytes are unavailable is preserved only
  through the bounded text-free direct-element rule in `security.md`; under
  `decorative-remove`, a pseudo glyph on an independently visible text control
  may be omitted and must report `decorative-icon-font-glyphs`; a missing glyph
  box is always a material mismatch
- recognizable semantics and appearance of controls
- descendants of a source element hidden by a zero-scale transform remain
  hidden; never flatten that parent into `display: contents` and expose a badge,
  label, or ornament that the source viewport did not show
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
Each newly captured non-redacted `[data-showkit-text]` wrapper must represent
exactly one source line fragment. Group multiple client rectangles on the same
rendered line before classifying a wrapper as multi-line. A pre-`0.2.7` capture
may retain an intentionally wrapped wrapper only when it has no authored line
break, its rendered bounds match its recorded box within 4 CSS pixels, and it
adds no collision. Preserve collapsed leading and trailing inline space inside
that fragment. A confirmed text-only redaction may
keep a bounded multi-line synthetic mask only when its rendered bounds remain
within the recorded text box and the HTML audit reports zero metric drift and
collisions. It may adjust only synthetic mask tracking; it must not keep the
original text or move the source element.
When the documented asset provider rejects an otherwise visible WOFF2 because
its response type is unsupported, the player may fit the source-declared local
fallback inside the recorded line rectangle. This is allowed only when both
axis scale factors remain from `0.8` through `1.25`, translation is no more
than `8` CSS pixels, the text stays selectable, and the generated HTML audit
still reports zero drift, unsafe multi-line wrappers, and collisions. Record the
number in `data-text-metric-fit-count`. Do not fetch the font body through an
undocumented path, increase the capture resolution, or accept a larger fit.
For a confirmed visible-session capture, the extractor may instead replace an
unavailable loaded text font with ShowKit's fixed system stack before
persistence. It may do so only when fixed non-page Latin, Korean, and CJK
samples stay within `0.8` through `1.25` on both axes. The captured scene must
record `bounded-font-metric-fallback`, keep the text selectable, and still pass
the generated HTML audit with zero metric drift, unsafe wrapping, suppressed
placeholders, and collisions. This rule never applies to private-use glyphs or
another icon font.
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
- the generated HTML typography audit is `checked` with zero metric drift,
  unsafe multi-line wrappers, new text collisions, and suppressed placeholders on
  every scene
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
4. When the generated HTML reports text metric drift, verify that every
   visible non-system font has an exact `fontFaces` entry and local WOFF2 asset.
   A downloaded font file without its family, weight, and style mapping does
   not satisfy this check. If the documented provider rejected the WOFF2
   response type, use only the bounded generated-HTML metric fit above. For a
   confirmed visible session whose exact text-font bytes remain unavailable,
   accept only a recorded `bounded-font-metric-fallback` that passed the fixed
   non-page metric check. If either rule's limits are exceeded, keep the scene
   failed.
5. Recapture once through the normal extractor and rebuild the demo.
6. Use another supported semantic target or route only when it preserves the
   person's requested outcome.
7. If a compressed browser response exceeds one evaluate result, continue
   through the bounded chunked transfer path. Keep the same element and 25 MB
   envelope limits; do not relax them or switch to a screenshot scene.
8. If a material mismatch remains, stop with `UnsupportedSurface`, keep the
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
