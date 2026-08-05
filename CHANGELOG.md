# Changelog

All notable ShowKit changes are recorded here. Published versions are immutable;
fixes ship as a new version.

## Unreleased

- No unreleased changes.

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
