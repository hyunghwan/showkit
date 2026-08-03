# Changelog

All notable ShowKit changes are recorded here. Published versions are immutable;
fixes ship as a new version.

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
