# Contributing to ShowKit

Thanks for helping improve ShowKit. Keep changes focused on the deterministic
CLI, portable agent skill, safe capture boundary, and interactive HTML player.

## Before opening an issue

- Use GitHub private vulnerability reporting for security problems.
- Never attach credentials, customer data, private product captures, cookies,
  storage values, raw DOM, or authenticated network data.
- Reduce a reproduction to public sample content.

## Development setup

Requirements: Node.js 22.12+ or 24 and pnpm 10.

```bash
corepack pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm docs:check
pnpm check
pnpm build
pnpm test
```

Run the narrower affected tests while developing. Before a pull request, run
`pnpm audit:prod`, `pnpm package:smoke`, and the complete command set above.
Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing package boundaries,
capture routes, hashing, or the player contract.

## Change expectations

- Use public Playwright APIs.
- Keep captures deterministic and fail closed before persistence.
- Keep generated demos semantic and selectable. Do not add a full-scene image
  fallback.
- Add a regression test for a bug fix.
- Do not update golden output automatically.
- Do not add competitor code, assets, schemas, fonts, or production
  dependencies without provenance and license review.
- Treat five steps as an example. Let each product flow determine its useful
  number of steps.

## Pull requests

Explain the user-visible result, the safety boundary affected, and the commands
you ran. Keep unrelated refactors in a separate pull request. A passing local
preview is not proof that anything was published.

Workflow changes must keep third-party actions pinned to a full commit SHA with
the reviewed release tag in a comment. Dependency changes must update the
lockfile and pass license and production vulnerability checks.
