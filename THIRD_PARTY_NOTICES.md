# Third-party notices

ShowKit publishes two direct runtime dependencies and one optional peer
dependency. npm installs their transitive and platform-specific packages
separately; they are not copied into the `@showkit/cli` tarball.

| Package or family | Relationship | Declared license |
|---|---|---|
| `sharp` | Runtime image processing | Apache-2.0 |
| `zod` | Runtime schema validation | MIT |
| `@img/colour` | Transitive color utilities used by `sharp` | MIT |
| `detect-libc` | Transitive platform detection used by `sharp` | Apache-2.0 |
| `semver` | Transitive version handling used by `sharp` | ISC |
| `@img/sharp-*` | Optional platform binaries selected by `sharp` | Apache-2.0; some WebAssembly and Windows packages also declare LGPL-3.0-or-later and MIT |
| `@img/sharp-libvips-*` | Optional platform-specific libvips packages selected by `sharp` | LGPL-3.0-or-later |
| `@types/node`, `undici-types` | Optional peer type dependency closure resolved with `sharp` in release checks | MIT |
| `@playwright/test` | Project-installed peer dependency | Apache-2.0 |

ShowKit does not include competitor code, assets, schemas, fonts, or bundled
browser binaries. Release automation enumerates the complete production,
transitive, peer, and platform-optional graph resolved by the lockfile. It reads
installed package metadata and verifies exact-version metadata for unavailable
platform packages against the npm registry, then generates a versioned license
report and SPDX SBOM. An unknown license stops the release.
