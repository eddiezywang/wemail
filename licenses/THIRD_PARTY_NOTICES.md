# Third-Party Notices

This project, **WeMail**, is based on **Agentic Inbox** developed by
**Cloudflare, Inc.** (<https://github.com/cloudflare/agentic-inbox>),
licensed under the Apache License, Version 2.0.

Files originating from the upstream project retain their original
copyright headers:

> Copyright (c) 2026 Cloudflare, Inc.
> Licensed under the Apache 2.0 license found in the LICENSE file or at:
> <https://opensource.org/licenses/Apache-2.0>

Modifications and additional code in this repository are licensed under
the Apache License, Version 2.0 unless stated otherwise.

## Major dependencies

WeMail is built on many open-source packages. The table below lists the most
significant direct dependencies in `package.json` and their declared licenses.

| Area | Packages | License |
| --- | --- | --- |
| Runtime | electron, electron-updater | MIT |
| UI framework | react, react-dom, react-router, zustand, @tanstack/react-query | MIT |
| Local API | hono, @hono/node-server | MIT |
| Mail transport and parsing | imapflow (MIT), nodemailer (MIT-0), postal-mime (MIT-0), pdf-parse (Apache-2.0), node-html-parser (MIT), node-html-markdown (MIT) | MIT / MIT-0 / Apache-2.0 |
| Database | better-sqlite3, drizzle-orm | MIT / Apache-2.0 |
| Agent runtime | @earendil-works/pi-agent-core, @earendil-works/pi-ai, @earendil-works/pi-coding-agent | MIT |
| Bot adapters | @qwen-code/channel-base, @qwen-code/channel-feishu, @qwen-code/channel-wecom | See Qwen Code note below |
| Rich text | @tiptap/* (ProseMirror) | MIT |
| Styling | tailwindcss, @tailwindcss/vite | MIT |
| Imaging | sharp | Apache-2.0 (see obligations below) |
| Testing | vitest, jsdom, @testing-library/* | MIT |
| Secrets / crypto | Electron safeStorage (platform API) | — |

`mailparser` and the `@mariozechner/pi-*` agent packages are not dependencies of
this build. Mail parsing uses `postal-mime`, and the agent runtime uses the
`@earendil-works/pi-*` packages; AI provider SDKs (`@anthropic-ai/sdk`,
`@google/genai`, `openai`) are transitive dependencies of `pi-ai`, not direct
ones. See `THIRD_PARTY_LICENSES.md` for the resolved tree.

## Per-dependency license inventory

`THIRD_PARTY_LICENSES.md` is a generated inventory of packages resolved by
`bun.lock`. It reflects the installed manifests on the machine where it was
generated; refresh it on the release platform to cover its installed package
set. Generate or refresh it offline with:

```
node scripts/generate-third-party-licenses.mjs
```

The generator reads `bun.lock` for resolved name/version pairs and the
`license` / `licenses` fields of installed package manifests. By default it
lists all direct dependencies plus every package whose declared license is not
a plain MIT / Apache-2.0 / ISC / BSD-family license, is a compound or dual
license, or has no license metadata. `node scripts/generate-third-party-licenses.mjs --all`
emits the complete resolved inventory, and `--check` verifies the committed
file is current. `bun pm ls` / `npm ls` alone list the tree, not license
metadata, and are not a substitute for this inventory.

The inventory records declared metadata, not a legal determination. Packages
marked `UNKNOWN` have no usable `license` field in the installed manifest (or
are resolved by the lockfile but not installed in that checkout, such as
platform-specific optional binaries); these require manual verification
against the package's shipped LICENSE file and upstream source. Regenerate the
inventory on the actual release-packaging platform so the shipped binary set
is covered.

The installed `@qwen-code/channel-base`, `@qwen-code/channel-feishu`, and
`@qwen-code/channel-wecom` packages at 0.21.1 omit a license field and license
file. Their package names and versions match the source packages in the
[Qwen Code v0.21.1 repository](https://github.com/QwenLM/qwen-code/tree/v0.21.1/packages/channels),
whose root license is Apache-2.0. A copy of that upstream license, including
its copyright notices, is provided in
`licenses/third-party/Qwen-Code-0.21.1-LICENSE.txt`. The inventory retains the
packages' missing-metadata status; verify provenance and applicable notices
for the actual distributed artifacts.

### Obligations tied to the distributed form

Being listed in the inventory does not by itself establish that every license
obligation is satisfied. The following must be settled against the actual
distributed artifact (source vs. binary, static vs. dynamic linking, and which
platform packages ship), and the corresponding license texts and notices
included in the distribution:

- **sharp / libvips (LGPL)**: `sharp` itself declares Apache-2.0, but the
  prebuilt native binary packages such as `@img/sharp-win32-x64` declare
  `Apache-2.0 AND LGPL-3.0-or-later` because of the bundled libvips. Shipping
  those binaries requires satisfying the LGPL-3.0-or-later terms for the
  libvips portion (source availability or relinking information, notices and
  license text), not only the Apache-2.0 part.
  The `licenses/third-party/` directory includes LGPL-3.0-or-later and
  GPL-3.0-or-later texts and the sharp-libvips 1.2.4 third-party notices as
  supporting material. Match the notices, source and corresponding
  obligations to the actual binaries in each release before distribution;
  these files do not by themselves establish compliance.
  For the currently installed `@img/sharp-win32-x64@0.34.5`, the package's
  `versions.json` is included as
  `licenses/third-party/sharp-win32-x64-0.34.5-versions.json`; it identifies
  libvips 8.17.3 and other bundled library versions. It is evidence for that
  specific package, not for macOS or future releases.
  For this Windows x64 package, the upstream source and packaging references
  include [libvips v8.17.3](https://github.com/libvips/libvips/tree/v8.17.3),
  [libvips Windows build v8.17.3](https://github.com/libvips/build-win64-mxe/tree/v8.17.3),
  and [sharp-libvips v1.2.4](https://github.com/lovell/sharp-libvips/tree/v1.2.4).
  The accompanying `versions.json` identifies the bundled dependencies whose
  corresponding source and build inputs must also be checked. In the Windows
  package, the libvips DLLs are under
  `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/`.
  These references and paths are aids to the distribution review, not a
  substitute for confirming the applicable source and relinking requirements.
  Sources: [SPDX license texts](https://github.com/spdx/license-list-data/tree/main/text)
  and [sharp-libvips 1.2.4 notices](https://github.com/lovell/sharp-libvips/blob/v1.2.4/THIRD-PARTY-NOTICES.md).
- **lightningcss (MPL-2.0)**: MPL-2.0 is file-level copyleft. If the shipped
  build carries MPL-covered source files, their source must be made available
  and notices retained; confirm which form (source or generated output) the
  distribution actually contains.
- **DOMPurify ((MPL-2.0 OR Apache-2.0))**: WeMail elects the Apache-2.0
  option for its distributed copy. DOMPurify's license identifies its
  copyright as `Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53`.
  `licenses/third-party/DOMPurify-3.3.3-LICENSE.txt` contains the license
  shipped with the installed 3.3.3 package. Retain the notices in each
  distribution and verify that the bundled version matches; the inventory
  alone is not a substitute for those notices.

## Fonts

| Field | Value |
| --- | --- |
| Font | JetBrains Mono, weights 400 / 500 / 600 / 700 |
| Source | Upstream project <https://github.com/JetBrains/JetBrainsMono>; copyright line verified from the bundled files' embedded name records |
| License | SIL Open Font License, Version 1.1 (OFL-1.1) |
| Bundled files | `electron/assets/fonts/jetbrains-mono/jb-400.woff2`, `jb-500.woff2`, `jb-600.woff2`, `jb-700.woff2` |
| Copyright notice and full license text | `electron/assets/fonts/jetbrains-mono/OFL.txt` |
| Used by | `electron/assets/notification-window.html` (`@font-face`) and `app/styles/tokens.css` (`--font-mono-meta`) |

The four WOFF2 files are bundled copies of JetBrains Mono and are used by the
desktop notification window and the renderer's monospace token. They are not
removed, so the OFL-1.1 requirement that the copyright notice and license
accompany each copy is met by shipping `OFL.txt` in the same directory.

`package.json` `build.extraResources` maps the whole `electron/assets`
directory to `resources/assets` in the packaged app. That is a directory copy
with no extension filter, so all four WOFF2 files and `OFL.txt` are included
in the distribution together. No separate assets rule is needed.

"JetBrains Mono" and JetBrains are trademarks of JetBrains s.r.o. This project
is not affiliated with or endorsed by JetBrains.

## Trademarks

"Cloudflare" and the upstream project name are trademarks of Cloudflare,
Inc. This project is an independent derivative work and is not endorsed
by or affiliated with Cloudflare.
