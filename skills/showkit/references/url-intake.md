# Signed-in URL intake

This path turns an already open, supported product page into the same guided
HTML interactive demo used by the static and optional Playwright paths. The
host agent plans the steps. In a ChatGPT or Codex app, Browser or Chrome
operates the selected tab. ShowKit validates and imports only the safe
derivative after the installed host isolation gate.

Claude's built-in Chrome intake is not supported when its installed
`javascript_tool` capability runs in page context and does not expose a
host-validated isolated page world. Return
`UnsupportedSurface` before extraction or persistence and offer static source
or, after dependency approval, the separate headed Playwright route.

## Input and step policy

- Accept HTTP or HTTPS URLs only.
- Remove query strings, fragments, and embedded credentials before selection,
  metadata, diagnostics, or logs.
- Choose the number of steps that explains the requested flow. Five steps is
  only an example, not a requirement. The bounded browser-session intake
  accepts 3 to 7 ordered steps and must not pad or truncate a flow to reach a
  fixed count. Use static source or optional Playwright when a shorter or
  longer sequence is required.
- Prefer the main result and primary navigation.
- Use one visible semantic target per step.
- End at a clear product result.
- Write tooltip claims only from captured evidence.
- Use “select,” not “click” or “tap,” in viewer instructions.
- Apply `visual-fidelity.md` without adding a site-specific branch or patching a
  generated scene.

The read-only default permits navigation, disclosure, filters, and controls that
do not change external data. Require exact approval immediately before create,
update, invite, send, publish, purchase, upload, download, permission, security,
legal, or delete actions.

## Safety and persistence

Before the shared extractor runs in a ChatGPT or Codex selected tab, call
`verifyOpenAIBrowserHostIsolation({ pluginRoot, tab })`, pass the returned validation
to the environment reader and adapter, and require
`executionWorld: "isolated-readonly-v1"`. A `domSnapshot()` is an untrusted
planning hint only. The isolated extractor scans before each action and scans
the terminal scene.
If verified higher-level evaluation is policy-blocked or its bounded CDP setup
times out, the adapter may request the official tab-scoped `cdp` capability.
Continue only after exact-site approval and only with `Page.getFrameTree`,
`Page.createIsolatedWorld`, and `Runtime.evaluate`; leaving the approved origin
ends the capture.
By default, stop before persistence on a password or hidden input, configured
selector, token, email, payment pattern, unsupported HTML surface, or critical
remote asset.

If the requested flow needs sensitive visible text, ask the person whether to
keep the visible session content, capture with text-only redaction, or stop
before starting the capture. Continue only after an explicit choice. Exact
local capture passes:

```js
{
  privateContentConsent: {
    mode: "visible-session",
    consent: "confirmed"
  },
  pageAssetConsent: {
    mode: "visible-session",
    consent: "confirmed"
  }
}
```

For **Keep visible content**, also connect
`createOpenAIPageAssetProvider({ tab, hostValidation })` to the browser adapter. The one
exact-capture choice maps to both confirmed modes above. Text-only redaction
does not grant private asset consent.

Text-only redaction passes:

```js
{
  sensitiveTextRedaction: {
    mode: "text-only",
    consent: "confirmed",
    selectors: ["<smallest runtime-only private text region>"]
  }
}
```

Do not persist the selectors. The recipe records only confirmed mode and region
count. The extractor keeps the supported element tree, computed styles, and
hotspot geometry and applies a length-preserving mask to captured text nodes
and textual accessibility attributes. Hidden inputs remain excluded from the
derivative. It does not mutate the live DOM. Do not
create a synthetic fixture, replacement interface, screenshot, or sample
content. If the person declines or does not answer, stop without saving.
Passwords and unsupported surfaces remain blocked.

Decorative remote assets may be removed. A target, evidence, or layout-critical
remote asset blocks capture unless the selected browser exposes the documented
`pageAssets` capability and either the exact public or fixture asset was
approved, or the person explicitly confirmed visible-session assets. Inventory
only the current page state. The adapter accepts PNG, JPEG, WebP, GIF, or safe
SVG bytes up to 1 MB, verifies the file signature, hashes the bytes, and gives
the extractor only the in-memory local replacement. It never persists the
original remote URL, request headers, cookies, or signed query. Never make a
full-screen image fallback.

A remote CSS image inside a visible interactive control is layout-critical,
including toolbar, navigation, and action icons. If `pageAssets` does not expose
its bytes and the person confirmed visible-session assets, the browser adapter
may preserve the exact rendered pixels of an isolated, text-free icon element
no larger than 64 by 64 CSS pixels. This produces a local content-addressed
image asset for that icon only; the control, text, layout, and scene remain
semantic HTML. Return `UnsupportedSurface` when the element contains text,
another visual surface, multiple background images, is larger than the limit,
or cannot be captured exactly. Do not silently remove it or replace it with a
synthetic icon, and never rasterize a complete control or scene.

The selected browser must capture the bounded icon element directly. If direct
element capture is unavailable, return `UnsupportedSurface`. Never take a
viewport screenshot and crop it, even transiently.

The same confirmed asset mode may localize one visible image element as a
bounded rendered image through direct element capture when the current-page
inventory cannot match its bytes. A transformed image must be a pointer-inert,
text-free two-dimensional accessory inside a semantic control and may not
overlap rendered text. Replay uses the rendered local pixels without applying
the source transform twice.

Canvas remains blocked except for a 4 by 4 through 64 by 64 CSS pixel,
text-free control icon that fits wholly in the viewport, overlaps no rendered
text, has no transform, filter, or shadow, and can be captured against a stable
backdrop. Charts, editors, maps, large canvases, WebGL, and any canvas outside
that exact boundary return `UnsupportedSurface`.

Transparent custom-element wrappers around renderable light DOM are supported.
An open shadow root is supported only when its visible descendants are
text-only, noninteractive, noneditable, and slot-free. Opaque custom elements,
closed shadow roots, and interactive or visual shadow content remain blocked.

The adapter keeps safe demo steps in memory, creates a private mode `0600` file
in the operating system temporary directory, and hands it to:

```text
showkit capture session <safe-envelope.json> --json
```

The CLI checks the schema, content policy, URL policy, asset hashes, size limits,
and deterministic capture ID before an atomic import. It deletes the temporary
file on success or failure. A blocked attempt leaves only a content-free
diagnostic and does not change the previous captured product flow.

## Source truth

Browser-session capture records `session-captured`. It proves which safe HTML
states were captured in that session. It does not prove that CI can replay the
flow.

Treat visual fidelity as the required general acceptance check in
`visual-fidelity.md`, not a promise that every website is supported. Compare the
live source and local preview at the same CSS viewport and product state, then
resize the preview once. Use the stated task, text, asset, control, complete
scene, and 4 CSS pixel geometry criteria. Follow the generic recovery ladder
once. Do not hand-tune one generated scene, patch captured HTML, or add a
site-specific rule. Report `checked`, `incomplete`, or `blocked`. Stop with
`UnsupportedSurface` instead of approximating an unsupported canvas, WebGL,
DRM media, a closed or interactive shadow root, a cross-origin frame, or
another material mismatch.

For repeatable release checks, promote the ordered semantic recipe to a
Playwright source flow that imports `@showkit/cli/playwright` and uses
`demo.step()`. That promoted source is `ci-replayable`. Keep authentication
runtime-only, then compare the promoted version with `showkit diff --check`.

## Named stops

| Error | Next action |
|---|---|
| `PageUrlInvalid` | Use an HTTP or HTTPS URL without credentials |
| `BrowserSessionUnavailable` | Connect Browser or Chrome and select the page |
| `BrowserDomAccessRequired` | Use a supported browser DOM surface |
| `BrowserAuthenticationRequired` | Sign in in the selected browser |
| `BrowserSessionInterrupted` | Select the tab again and start a new capture |
| `BrowserTargetAmbiguous` | Narrow the isolated result classified as missing, hidden, or duplicate |
| `BrowserActionConfirmationRequired` | Approve the exact action or use a read-only flow |
| `SensitiveDataDetected` | Ask about text-only redaction; continue only after an explicit yes |
| `UnsupportedSurface` | Verify host isolation or choose supported HTML content |

Passing these checks is not a security, compliance, or approval guarantee.
