# Changelog

All notable ShowKit changes are recorded here. Published versions are immutable;
fixes ship as a new version.

## Unreleased

## 0.2.13 - 2026-08-12

- Wait for visible fonts, images, DOM and layout changes, and finite animations
  to settle before capturing a product state, while allowing an already-visible
  semantic target to use the shorter verified quiet window. Stop on visible
  infinite animations instead of saving a nondeterministic frame.
- Preserve `backdrop-filter`, `background-clip`, and gradient text fill in
  interactive HTML scenes.
- Stop before saving visible individual transform longhands, including on
  pseudo-elements, open native popovers, indeterminate checkboxes, and
  unsupported native table border models instead of flattening them
  inaccurately.
- Added same-browser, in-memory visual comparisons for full scenes, active
  targets, and declared layout-critical regions without writing screenshot or
  diff files into the demo.
- Added a 25-step per-scene performance guard and updated the installed ShowKit
  skill compatibility range to require `@showkit/cli >=0.2.13 <0.3.0`.

## 0.2.12 - 2026-08-11

- Preserved the safely revealed document and nested-scroll range as selectable
  semantic HTML, restored native scrolling plus fixed and sticky context, and
  kept unrevealed content outside the capture.
- Added optional deterministic focus zoom for compact edge targets and an
  optional responsive welcome cover composed from the first live HTML scene.
  Both are off by default: new demos start on step one with the scene fitted,
  settled without entrance animation, and no per-step camera coordinates or
  raster cover are authored.
- Added a generic read-only `inspect` action for positioning and highlighting a
  semantic target without selecting it or requiring a page-state mutation.
- Raised the default new-demo capture viewport from 1280×720 to 1440×900 while
  preserving exact viewports recorded by existing demos.
- Added native-reference visual-fidelity coverage and stopped before persistence
  when a page relies on an open native dialog that cannot be reproduced safely.
- Removed committed production Firebase client configuration from the public
  package. Hosted publishing now loads it from ShowKit's bound Hosting endpoint
  and verifies the expected project and app before use.
- Updated the installed ShowKit skill compatibility range to require
  `@showkit/cli >=0.2.12 <0.3.0`.

## 0.2.11 - 2026-08-10

- Recovered a missing Playwright hotspot name from bounded semantic sources and
  a leaf-only accessibility fallback that excludes links, editable content, and
  selected files. Invalid target setup now includes a specific recovery action.
- Matched native table, grid, image, disclosure, list, and file-input semantics
  with Playwright, including safe live checked, selected, and open states.
- Verified exact target identity while allowing bounded visible labels and
  disclosure rows to become the interactive hotspot without a site exception.
- Allowed confirmed visible-session capture to use ShowKit's fixed system font
  stack when unavailable text-font metrics remain bounded across Latin, Korean,
  and CJK samples. Icon fonts and out-of-range metrics remain blocked.
- Applied one absolute deadline to consented public-asset recovery and preserved
  only context-safe control attributes in the final interactive player.
- Updated the installed ShowKit skill compatibility range to require
  `@showkit/cli >=0.2.11 <0.3.0`.
- Scoped CI runner jobs to the public export while retaining the complete local
  release gate for the private source workspace.

## 0.2.10 - 2026-08-10

- Added owner-only rename and delete actions to **Your demos**. Rename keeps the
  public URL and published content unchanged; delete closes the URL, returns the
  hosted slot, and preserves only a non-reusable public-ID tombstone.
- Split completion layouts when every overlay position would cover meaningful
  scene content, including the reserved bottom safe area in the fit calculation.
- Rejected control characters in hosted demo names, validated rename and delete
  API results, and aligned the installed ShowKit skill compatibility range with
  `@showkit/cli >=0.2.10 <0.3.0`.

## 0.2.9 - 2026-08-08

- Added explicit hosted publishing through the ShowKit CLI, including browser
  email-link authorization, checked-version upload, deterministic publish
  receipts, and exact-version republish behavior.
- Added the hosted account contract for listing and unpublishing demos while
  keeping Cloud implementation, deployment configuration, and operator
  documentation outside the public export.
- Rejected unsafe hosted-receipt symlinks and aligned the installed ShowKit skill
  compatibility range with `@showkit/cli >=0.2.9 <0.3.0`.

## 0.2.8 - 2026-08-06

- Added a non-persisting Playwright source freshness check that writes no
  ShowKit capture, run, operation log, or built demo and compares each
  selected demo step with an earlier built version before any update is
  approved.
- Source-flow failures now report the named stopping step, distinguish reached
  but unverified steps from later skipped steps, give a specific recovery
  action, and confirm that the previous demo was not changed.
- Source freshness now replays the captured Playwright project with one worker
  and accepts `--project <name>` when that configured project was renamed; its
  docs distinguish unchanged ShowKit files from product actions executed by the
  approved source flow.
- Added provider-neutral guidance for using an optional element picker as a
  temporary hotspot-authoring hint while resolving the final target again from
  the supported source flow and keeping picker output out of saved files.
- Updated the installed skill compatibility range to require
  `@showkit/cli >=0.2.8 <0.3.0` for the source-freshness contract.

## 0.2.7 - 2026-08-06

- Grouped multiple text client rectangles on the same rendered line before
  classifying a captured wrapper as multi-line.
- Kept intentional wrapped text from older captures when its rendered bounds
  still match the recorded text box, while fitting small fallback-font changes
  that would otherwise push a captured one-line label onto a second line.
- Kept explicitly confirmed multi-line redaction masks bounded by their
  recorded text boxes while preserving zero-drift and zero-collision checks for
  every visible text fragment.
- Added a neutral inline-typography assurance case and updated the installed
  skill compatibility range to require `@showkit/cli >=0.2.7 <0.3.0`.

## 0.2.6 - 2026-08-06

- Preserved wrapped and mixed-inline text as positioned selectable fragments,
  bounded fallback-font fitting to captured text boxes, and generated-HTML
  typography diagnostics for metric drift, multiline fragments, and text
  collisions.
- Replayed supported private-use control icons from checked local font assets,
  removed unavailable decorative glyphs, and stopped before persistence when a
  required visible icon could not be reproduced.
- Normalized browser-session navigation targets across absolute and relative
  URLs, waited for durable post-action states, centered targets near viewport
  edges, and promoted compact controls to their complete visible labels.
- Kept responsive guide cards inside narrow player scenes and clear of the
  active target while omitting hidden descendants from zero-scale interface
  states.
- Updated the installed skill compatibility range to require
  `@showkit/cli >=0.2.6 <0.3.0` for the typography and capture-fidelity
  contracts.
- Updated the pinned GitHub Actions while keeping Node type definitions on the
  supported Node.js 24 line and Playwright on the release-validated version.

## 0.2.5 - 2026-08-05

- Recomputed guide-card placement from the current visual viewport after
  resize, kept every card action inside the visible scene shell, and reserved
  adaptive bottom-edge clearance.
- Added obstacle-bound placement candidates so step cards avoid the active
  hotspot and visible dialogs, alert dialogs, menus, listboxes, and tooltips
  instead of merely choosing the least-overlapping fixed side.
- Disambiguated repeated browser-session test IDs with the target's exact
  visible name and kept highlights on the complete labeled interaction box.
- Updated the Stripe gallery flow to use the Date and time and Amount filters
  while retaining matching payment rows through the completion state.
- Updated the installed skill compatibility range to require
  `@showkit/cli >=0.2.5 <0.3.0` for the responsive placement contract.

## 0.2.4 - 2026-08-05

- Added an explicit Playwright capture viewport contract. New captures default
  to 1280×720, `--viewport WIDTHxHEIGHT` records an exact requested or
  existing-demo size, and a mismatched Playwright viewport now fails before any
  captured page is saved. The viewport is rechecked before every step and the
  terminal scene instead of allowing a later narrower scene to be treated as a
  complete desktop demo.
- Made visually hidden radio and checkbox targets use their complete visible
  label for hotspot, spotlight, and tooltip-clearance geometry, including a
  label clipped by the capture viewport. The player now ranks zero target
  overlap ahead of preferred tooltip placement.
- Preserved safe percent-encoded SVG data icons as checked local assets and
  kept active SVG content blocked. Partially clipped interactive sprites can be
  discovered without using an unsafe element screenshot fallback.
- Clarified that a clean-install static smoke preview proves only the local CLI
  lifecycle and is not product-capture or visual-fidelity evidence.
- Updated the installed skill compatibility range to require
  `@showkit/cli >=0.2.4 <0.3.0` for the viewport and visible-target contracts.

## 0.2.3 - 2026-08-05

- Updated verified Codex Browser and Chrome capture for the current installed
  OpenAI host build.
- Made public-page capture tolerate unavailable unused images while still
  stopping when a visible control needs an asset that cannot be reproduced.
- Added a bounded readiness wait for semantic targets that appear after page
  transitions.
- Made optional Playwright capture drop hidden inputs without treating their
  unsaved values as visible private content.
- Made optional Playwright capture localize visible images from an exact
  requested public page without another prompt. Private-session images still
  require explicit consent. Public requests use pinned public DNS, default
  ports, no credentials or referrer, bounded redirects, and verified local
  bytes while keeping source URLs, cookies, headers, and browser storage out of
  the demo.
- Added bounded public stylesheet traversal for visible WOFF2 faces, including
  verified embedded WOFF2 data, without persisting CSS or data URLs.
- Added a bounded fallback for opaque public WOFF2 filenames: compare four
  fixed, non-page text metric samples in a separate network-blocked context and
  use the bytes only when one unique content hash matches the loaded face.
- Added network-blocked, JavaScript-disabled rasterization of only the bounded
  background layer for static complex SVG sprites. Full controls, text regions,
  and scenes remain semantic HTML and are never rasterized.
- Prioritized assets inside visible controls, retried a changed public page once,
  and kept unresolved decorative assets removable while critical assets remain
  fail-closed.
- Verified point-in-time signed-out capture flows on Airbnb's responsive HTML
  list view, eBay, Amazon, and Daum, including a Daum news article and its
  latest/recommended comment tabs. Airbnb's desktop split-map state remains
  fail-closed.
- Added safe capture error categories so an installed skill can distinguish
  unsupported media, missing assets, and other recovery paths without exposing
  page content.
- Added progress messages during longer Playwright captures and verified the
  current Codex Browser and Chrome plugin build.

## 0.2.2 - 2026-08-04

- Shortened the agent install prompt across the public guides and npm README.
  Browser, capture, and recovery details now stay in the installed skill after
  it verifies installation and asks for the product URL.

## 0.2.1 - 2026-08-04

- Added a Claude plugin marketplace entry so the ShowKit skill can be installed
  and discovered in Claude Cowork as well as Claude Code.
- Made requests such as “Use ShowKit for the site open in Chrome” route by
  capability automatically. Claude hosts now use available bound source or a
  separately approved temporary browser instead of ending with an open-ended
  capture-method question when the existing tab cannot pass isolation checks.
- Changed first-run onboarding to install and verify the skill, then ask for a
  product URL before choosing an output folder or demo details. New demos use
  1280×720 by default.
- Added a no-browser Playwright capture preflight, CommonJS consumer loading
  on Node.js 22.12+, and installed-Chrome doctor checks so a temporary live
  flow fails before
  sign-in when its file or module setup is invalid and does not require a
  redundant bundled Chromium download.
- Required one retained foreground capture process and one non-persistent
  browser context from sign-in through capture, preventing reconnaissance and
  command timeouts from repeatedly discarding authenticated windows.

## 0.2.0 - 2026-08-04

- Made verified browser HTML capture faster by reusing isolated browser
  contexts, freezing large scene transfers, and reporting non-persisted
  performance diagnostics.
- Added an exact-site, tab-scoped Chrome CDP fallback limited to
  `Page.getFrameTree`, `Page.createIsolatedWorld`, and `Runtime.evaluate` when
  the verified higher-level browser evaluator is unavailable.
- Added capture-size selection and exact viewport verification for marketer
  workflows while preserving the selected signed-in tab.
- Replaced the Shopify product-options gallery entry with the Stripe payments
  walkthrough used on the ShowKit website.
- Kept hotspots aligned throughout responsive resize transitions and kept
  completion cards clear of prominent captured dialogs and menus.
- Added compact, accessible Back and Restart demo icon controls when completion
  actions need more room, including visible hover and keyboard-focus labels.
- Namespaced player asset revisions so cached player files from another demo do
  not replace the current demo's controls or styles.
- Updated the ShowKit skill compatibility window to require
  `@showkit/cli >=0.2.0 <0.3.0` for the new browser and player contracts.
- Added regression coverage for large HTML scene transfers, browser-session
  performance, responsive geometry, completion-card clearance, and player
  asset revisions.

## 0.1.1 - 2026-08-03

- Added a small, unobtrusive `Powered by ShowKit` link to the bottom-right of
  generated demos. The link opens `showkit.sqncs.com` in a new tab and stays
  below hotspots, tooltips, controls, and the welcome layer.

## 0.1.0 - 2026-08-03

- Added the deterministic `@showkit/cli` command and JSON/exit-code contracts.
- Added verified OpenAI Browser and Chrome session capture for Codex and
  ChatGPT, gated by installed-host isolated-world inspection.
- Added Playwright-free `static-source` capture bound to project-relative
  source hashes.
- Kept public Playwright `demo.step()` capture through
  `@showkit/cli/playwright` as an optional trusted CI-replay path.
- Blocked built-in Claude browser extraction when the host cannot expose a
  validated isolated read-only page world; documented static-source and
  approved temporary headed Chrome routes for Claude Code and the Claude app.
- Added fail-closed capture policies and secret-free blocked diagnostics.
- Added guided interactive HTML demos with semantic DOM, local assets,
  DOM-anchored hotspots, tooltips, keyboard navigation, and Markdown output.
- Added a minimal single-container player with a welcome card, top-edge
  progress, and Back/Next controls in the tooltip. Restart demo and the
  enabled-by-default lead action appear on the final card. Title, 3-by-3
  overlay slots, and the compact frame remain optional.
- Added constrained per-card backdrop strengths and hotspot-only navigation for
  demos that should advance from the product surface.
- Added safe brand color and local font-stack guidance for ShowKit skills.
- Added deterministic hashes, atomic writes, drift checks, quality reports, and
  portable static-host verification.
- Added the portable ShowKit skill with Codex, ChatGPT, Claude Code, and Claude
  app conformance.
- Added the one-command `npx skills add hyunghwan/showkit` onboarding path. The
  skill bootstraps a compatible CLI in a new output folder and keeps optional
  Playwright behind explicit approval.
- Added a synthetic, checked product-insights demo and GitHub Pages workflow.
- Added npm package smoke tests, production dependency auditing, the
  compatibility matrix, complete dependency license report, SPDX SBOM,
  checksums, provenance configuration, and first-release and later-release
  rollback drills.
- Added a fresh-history public export verification gate, issue and pull request
  templates, contribution guidance, and private vulnerability reporting.
- Added clean `HOME` and `USERPROFILE` package smoke coverage for copied skill
  resolution and the complete no-Playwright static build and preview.
