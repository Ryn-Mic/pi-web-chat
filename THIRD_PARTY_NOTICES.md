# Third-Party Notices

This distribution uses self-hosted runtime assets from the direct
`file-viewer-copy-assets` dependency and includes notices for its
transitive/embedded components. The notices below list the components used by
the package, their resolved versions, license identifiers, source URLs, and the
corresponding license file shipped under `third-party-licenses/`.

The root `pi-web-chat` package itself is licensed under MIT (see `LICENSE`).
The `morphicons` runtime library is licensed under MIT; its license text is
shipped at `third-party-licenses/morphicons-MIT.txt`. The GrokBot body and
expression paths are derived from LaoA-GrokBot under MIT; its license text is
shipped at `third-party-licenses/LaoA-GrokBot-MIT.txt`. The File Viewer **root
packages** (`@file-viewer/react-full`, `@file-viewer/core`,
`@file-viewer/vite-plugin`, `file-viewer-copy-assets`) are licensed under Apache
License 2.0. Other runtime
components listed below are subject to their own licenses. This document does not
state any legal conclusion about how those licenses interact; it only records
where each component and its license text can be found.

## File Viewer root packages

- Packages: `@file-viewer/react-full`, `@file-viewer/core`, `@file-viewer/vite-plugin`, `file-viewer-copy-assets`
- Resolved versions: `2.2.8`
- Project: <https://github.com/flyfish-dev/file-viewer>
- License: Apache License 2.0
- License copy: `third-party-licenses/Apache-2.0.txt`

The main package does not copy the complete File Viewer
`file-viewer-copy-assets/viewer/` static asset tree into `dist`. The server
exposes that version-pinned installed tree at `/file-viewer/` for self-hosted
document preview support; renderer bundle fallbacks remain governed by their
upstream package licenses.

## Runtime components and embedded assets

| Component | Version | License | Source | Local license / notice |
|---|---|---|---|---|
| `morphicons` | `1.7.0` | MIT | <https://github.com/guillermolg00/morphicons> | `third-party-licenses/morphicons-MIT.txt` |
| LaoA-GrokBot-derived body and expression paths | derived asset | MIT | <https://github.com/zhulin025/LaoA-GrokBot> | `third-party-licenses/LaoA-GrokBot-MIT.txt` |
| `@flyfish-dev/cad-viewer` | `0.8.0` | `AGPL-3.0-only` | <https://github.com/flyfish-dev/cad-viewer> | `third-party-licenses/AGPL-3.0-only.txt` (shared with `dwf-viewer`; identical license text), `third-party-licenses/cad-viewer-NOTICE.txt` |
| `dwf-viewer` | `0.6.4` | `AGPL-3.0-only` | <https://github.com/flyfish-dev/dwf-viewer> | `third-party-licenses/AGPL-3.0-only.txt` (shared with `@flyfish-dev/cad-viewer`; identical license text), `third-party-licenses/dwf-viewer-NOTICE.txt` |
| `@mlightcad/libredwg-web` | `0.7.9` | `GPL-3.0` (SPDX: `GPL-3.0-only`) | <https://github.com/mlightcad/libredwg-web> | `third-party-licenses/GPL-3.0-only.txt` (no license file shipped inside the installed package) |
| `@fontsource-variable/noto-sans-sc` | `5.2.10` | `OFL-1.1` | <https://github.com/fontsource/font-files/tree/main/fonts/variable/noto-sans-sc> | `third-party-licenses/OFL-1.1.txt` |
| `occt-import-js` | `0.0.23` | `LGPL-2.1` | <https://github.com/kovacsv/occt-import-js> | `third-party-licenses/LGPL-2.1.txt` |
| `@file-viewer/ppt` | `0.3.3` | Flyfish Public Watermarked Runtime License v2.0 (see `SEE LICENSE` in package metadata) | <https://github.com/flyfish-dev/file-viewer> | `third-party-licenses/file-viewer-ppt-LICENSE.txt`, `third-party-licenses/file-viewer-ppt-NOTICE.txt` |

## Asset-embedded notices retained in the runtime dependency

The `file-viewer-copy-assets` dependency retains renderer-specific license and
notice files in its `viewer/` tree. The server exposes those files without
creating a second copy. Representative package-relative paths include:

- `file-viewer-copy-assets/viewer/vendor/ppt/LICENSE`
- `file-viewer-copy-assets/viewer/vendor/ppt/NOTICE`
- `file-viewer-copy-assets/viewer/wasm/model/LICENSE.occt-import-js.txt`
- `file-viewer-copy-assets/viewer/wasm/model/LICENSE.occt.txt`
- `file-viewer-copy-assets/viewer/vendor/pdf/cmaps/LICENSE`
- `file-viewer-copy-assets/viewer/vendor/drawio/LICENSE`

Additional license files for PDF.js, draw.io stencils/shapes, and other bundled
renderer assets are present in the dependency tree as shipped by the upstream
File Viewer package.
