# Third-Party Licenses

> Generated file. Do not edit by hand.
>
> Regenerate: `node scripts/generate-third-party-licenses.mjs`
> Full inventory: `node scripts/generate-third-party-licenses.mjs --all --output THIRD_PARTY_LICENSES.all.md`
> Idempotency check: `node scripts/generate-third-party-licenses.mjs --check`

## Coverage

All direct dependencies (`dependencies` + `devDependencies` in `package.json`) plus every resolved package whose declared license is not a plain MIT / Apache-2.0 / ISC / BSD-family license, is a compound/dual license, or has no license metadata.

- Resolved packages in `bun.lock`: 1303
- Installed manifests read from `node_modules`: 1132
- Rows in this file: 298
- Rows with non-permissive, compound, dual, or missing license metadata: 215

Inputs are `bun.lock`, `package.json`, and the `license` / `licenses` fields
of installed `node_modules/**/package.json`. Generation is offline and
deterministic: LF line endings, stable sort by package name / version / source,
no timestamps and no absolute paths.

A package marked `UNKNOWN` has no usable license field in its installed
manifest (or is resolved by the lockfile but not installed in this checkout,
for example platform-specific optional binaries). The `UNKNOWN` marker is a
request for manual verification against the package's shipped LICENSE file
and upstream source; it is not a claim that the package is unlicensed.

License text and notices shipped with each package remain authoritative.
See `THIRD_PARTY_NOTICES.md` for distribution-form obligations and for the
bundled JetBrains Mono font license, and
`electron/assets/fonts/jetbrains-mono/OFL.txt` for the OFL 1.1 text.

## Packages

| Name | Version | License | Source | Scope |
| --- | --- | --- | --- | --- |
| @cloudflare/kv-asset-handler | 0.4.2 | MIT OR Apache-2.0 | node_modules/@cloudflare/kv-asset-handler/package.json | special |
| @cloudflare/unenv-preset | 2.15.0 | MIT OR Apache-2.0 | node_modules/@cloudflare/unenv-preset/package.json | special |
| @cloudflare/workerd-darwin-64 | 1.20260312.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @cloudflare/workerd-darwin-arm64 | 1.20260312.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @cloudflare/workerd-linux-64 | 1.20260312.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @cloudflare/workerd-linux-arm64 | 1.20260312.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @cloudflare/workers-types | 4.20260316.1 | MIT OR Apache-2.0 | node_modules/@cloudflare/workers-types/package.json | special |
| @earendil-works/pi-agent-core | 0.80.6 | MIT | node_modules/@earendil-works/pi-agent-core/package.json | direct |
| @earendil-works/pi-ai | 0.80.6 | MIT | node_modules/@earendil-works/pi-ai/package.json | direct |
| @earendil-works/pi-coding-agent | 0.80.6 | MIT | node_modules/@earendil-works/pi-coding-agent/package.json | direct |
| @electron/rebuild | 4.0.4 | MIT | node_modules/@electron/rebuild/package.json | direct |
| @emnapi/runtime | 1.9.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/aix-ppc64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/aix-ppc64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/aix-ppc64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-arm | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-arm | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-arm | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/android-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/darwin-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/darwin-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/darwin-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/darwin-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/darwin-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/darwin-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/freebsd-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/freebsd-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/freebsd-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/freebsd-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/freebsd-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/freebsd-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-arm | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-arm | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-arm | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-ia32 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-ia32 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-ia32 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-loong64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-loong64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-loong64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-mips64el | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-mips64el | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-mips64el | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-ppc64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-ppc64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-ppc64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-riscv64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-riscv64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-riscv64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-s390x | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-s390x | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-s390x | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/linux-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/netbsd-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/netbsd-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/netbsd-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/netbsd-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/netbsd-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/netbsd-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openbsd-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openbsd-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openbsd-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openbsd-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openbsd-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openbsd-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openharmony-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openharmony-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/openharmony-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/sunos-x64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/sunos-x64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/sunos-x64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/win32-arm64 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/win32-arm64 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/win32-arm64 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/win32-ia32 | 0.25.12 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/win32-ia32 | 0.27.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @esbuild/win32-ia32 | 0.27.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @hono/node-server | 2.0.0 | MIT | node_modules/@hono/node-server/package.json | direct |
| @img/sharp-darwin-arm64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-darwin-x64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-darwin-x64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linux-arm | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linux-arm64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linux-ppc64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linux-riscv64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linux-s390x | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linux-x64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linuxmusl-arm64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.4 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linux-arm | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linux-arm64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linux-ppc64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linux-riscv64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linux-s390x | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linux-x64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linuxmusl-arm64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-linuxmusl-x64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-wasm32 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-win32-arm64 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-win32-ia32 | 0.34.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @img/sharp-win32-x64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | node_modules/@img/sharp-win32-x64/package.json | special |
| @larksuiteoapi/node-sdk | 1.71.1 | MIT | node_modules/@larksuiteoapi/node-sdk/package.json | direct |
| @mariozechner/clipboard-darwin-arm64 | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-darwin-universal | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-darwin-x64 | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-linux-arm64-gnu | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-linux-arm64-musl | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-linux-riscv64-gnu | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-linux-x64-gnu | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-linux-x64-musl | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @mariozechner/clipboard-win32-arm64-msvc | 0.3.9 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-android-arm64 | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-darwin-arm64 | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-darwin-x64 | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-linux-arm-gnueabihf | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-linux-arm64-gnu | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-linux-arm64-musl | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-linux-riscv64-gnu | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-linux-x64-gnu | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @napi-rs/canvas-linux-x64-musl | 0.1.80 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @phosphor-icons/react | 2.1.10 | MIT | node_modules/@phosphor-icons/react/package.json | direct |
| @qwen-code/channel-base | 0.21.1 | UNKNOWN (no license field) | node_modules/@qwen-code/channel-base/package.json | direct + special |
| @qwen-code/channel-feishu | 0.21.1 | UNKNOWN (no license field) | node_modules/@qwen-code/channel-feishu/package.json | direct + special |
| @qwen-code/channel-wecom | 0.21.1 | UNKNOWN (no license field) | node_modules/@qwen-code/channel-wecom/package.json | direct + special |
| @radix-ui/react-dialog | 1.1.15 | MIT | node_modules/@radix-ui/react-dialog/package.json | direct |
| @radix-ui/react-dropdown-menu | 2.1.16 | MIT | node_modules/@radix-ui/react-dropdown-menu/package.json | direct |
| @radix-ui/react-popover | 1.1.15 | MIT | node_modules/@radix-ui/react-popover/package.json | direct |
| @radix-ui/react-select | 2.2.6 | MIT | node_modules/@radix-ui/react-select/package.json | direct |
| @radix-ui/react-switch | 1.2.6 | MIT | node_modules/@radix-ui/react-switch/package.json | direct |
| @radix-ui/react-tabs | 1.1.13 | MIT | node_modules/@radix-ui/react-tabs/package.json | direct |
| @radix-ui/react-tooltip | 1.2.8 | MIT | node_modules/@radix-ui/react-tooltip/package.json | direct |
| @react-router/dev | 7.13.1 | MIT | node_modules/@react-router/dev/package.json | direct |
| @react-router/node | 7.13.1 | MIT | node_modules/@react-router/node/package.json | direct |
| @rollup/rollup-android-arm-eabi | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-android-arm64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-darwin-arm64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-darwin-x64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-freebsd-arm64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-freebsd-x64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-arm-gnueabihf | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-arm-musleabihf | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-arm64-gnu | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-arm64-musl | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-loong64-gnu | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-loong64-musl | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-ppc64-gnu | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-ppc64-musl | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-riscv64-gnu | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-riscv64-musl | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-s390x-gnu | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-x64-gnu | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-linux-x64-musl | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-openbsd-x64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-openharmony-arm64 | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-win32-arm64-msvc | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @rollup/rollup-win32-ia32-msvc | 4.59.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @speed-highlight/core | 1.2.14 | CC0-1.0 | node_modules/@speed-highlight/core/package.json | special |
| @tailwindcss/oxide-android-arm64 | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-darwin-arm64 | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-darwin-x64 | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-freebsd-x64 | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-linux-arm-gnueabihf | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-linux-arm64-gnu | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-linux-arm64-musl | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-linux-x64-gnu | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-linux-x64-musl | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-wasm32-wasi | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/oxide-win32-arm64-msvc | 4.2.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @tailwindcss/vite | 4.2.1 | MIT | node_modules/@tailwindcss/vite/package.json | direct |
| @tanstack/react-query | 5.99.0 | MIT | node_modules/@tanstack/react-query/package.json | direct |
| @testing-library/jest-dom | 6.9.1 | MIT | node_modules/@testing-library/jest-dom/package.json | direct |
| @testing-library/react | 16.3.2 | MIT | node_modules/@testing-library/react/package.json | direct |
| @testing-library/user-event | 14.6.1 | MIT | node_modules/@testing-library/user-event/package.json | direct |
| @tiptap/extension-color | 3.20.2 | MIT | node_modules/@tiptap/extension-color/package.json | direct |
| @tiptap/extension-highlight | 3.20.2 | MIT | node_modules/@tiptap/extension-highlight/package.json | direct |
| @tiptap/extension-image | 3.20.2 | MIT | node_modules/@tiptap/extension-image/package.json | direct |
| @tiptap/extension-link | 3.20.2 | MIT | node_modules/@tiptap/extension-link/package.json | direct |
| @tiptap/extension-text-align | 3.20.2 | MIT | node_modules/@tiptap/extension-text-align/package.json | direct |
| @tiptap/extension-text-style | 3.20.2 | MIT | node_modules/@tiptap/extension-text-style/package.json | direct |
| @tiptap/extension-underline | 3.20.2 | MIT | node_modules/@tiptap/extension-underline/package.json | direct |
| @tiptap/react | 3.20.2 | MIT | node_modules/@tiptap/react/package.json | direct |
| @tiptap/starter-kit | 3.20.2 | MIT | node_modules/@tiptap/starter-kit/package.json | direct |
| @types/better-sqlite3 | 7.6.13 | MIT | node_modules/@types/better-sqlite3/package.json | direct |
| @types/dompurify | 3.0.5 | MIT | node_modules/@types/dompurify/package.json | direct |
| @types/node | 20.19.37 | MIT | node_modules/@types/node/package.json | direct |
| @types/node | 24.12.2 | MIT | node_modules/@types/qrcode/node_modules/@types/node/package.json | direct |
| @types/nodemailer | 8.0.0 | MIT | node_modules/@types/nodemailer/package.json | direct |
| @types/plist | 3.0.5 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @types/qrcode | 1.5.6 | MIT | node_modules/@types/qrcode/package.json | direct |
| @types/react | 19.2.14 | MIT | node_modules/@types/react/package.json | direct |
| @types/react-dom | 19.2.3 | MIT | node_modules/@types/react-dom/package.json | direct |
| @types/verror | 1.10.11 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| @types/yazl | 2.4.6 | MIT | node_modules/@types/yazl/package.json | direct |
| @vitejs/plugin-react | 5.2.0 | MIT | node_modules/@vitejs/plugin-react/package.json | direct |
| @vitest/ui | 4.1.5 | MIT | node_modules/@vitest/ui/package.json | direct |
| @zone-eu/mailsplit | 5.4.9 | (MIT OR EUPL-1.1+) | node_modules/@zone-eu/mailsplit/package.json | special |
| argparse | 2.0.1 | Python-2.0 | node_modules/argparse/package.json | special |
| assert-plus | 1.0.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| astral-regex | 2.0.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| better-sqlite3 | 12.9.0 | MIT | node_modules/better-sqlite3/package.json | direct |
| caniuse-lite | 1.0.30001779 | CC-BY-4.0 | node_modules/caniuse-lite/package.json | special |
| chownr | 3.0.0 | BlueOak-1.0.0 | node_modules/chownr/package.json | special |
| class-variance-authority | 0.7.1 | Apache-2.0 | node_modules/class-variance-authority/package.json | direct |
| cli-truncate | 2.1.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| clsx | 2.1.1 | MIT | node_modules/clsx/package.json | direct |
| concurrently | 9.2.1 | MIT | node_modules/concurrently/package.json | direct |
| core-util-is | 1.0.2 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| crc | 3.8.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| dmg-license | 1.0.11 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| dompurify | 3.3.3 | (MPL-2.0 OR Apache-2.0) | node_modules/dompurify/package.json | direct + special |
| drizzle-orm | 0.45.1 | Apache-2.0 | node_modules/drizzle-orm/package.json | direct |
| echarts | 6.1.0 | Apache-2.0 | node_modules/echarts/package.json | direct |
| electron | 41.3.0 | MIT | node_modules/electron/package.json | direct |
| electron-builder | 26.8.1 | MIT | node_modules/electron-builder/package.json | direct |
| electron-is-dev | 3.0.1 | MIT | node_modules/electron-is-dev/package.json | direct |
| electron-updater | 6.8.3 | MIT | node_modules/electron-updater/package.json | direct |
| expand-template | 2.0.3 | (MIT OR WTFPL) | node_modules/expand-template/package.json | special |
| extsprintf | 1.4.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| figlet | 1.12.0 | MIT | node_modules/figlet/package.json | direct |
| fsevents | 2.3.3 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| glob | 13.0.6 | BlueOak-1.0.0 | node_modules/glob/package.json | special |
| hono | 4.12.8 | MIT | node_modules/hono/package.json | direct |
| iconv-corefoundation | 1.1.7 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| imapflow | 1.3.2 | MIT | node_modules/imapflow/package.json | direct |
| isbot | 5.1.36 | Unlicense | node_modules/isbot/package.json | direct + special |
| isexe | 3.1.5 | BlueOak-1.0.0 | node_modules/app-builder-lib/node_modules/which/node_modules/isexe/package.json | special |
| isexe | 4.0.0 | BlueOak-1.0.0 | node_modules/isexe/package.json | special |
| jose | 6.2.1 | MIT | node_modules/jose/package.json | direct |
| jsdom | 29.0.2 | MIT | node_modules/jsdom/package.json | direct |
| khroma | 2.1.0 | UNKNOWN (no license field) | node_modules/khroma/package.json | special |
| lightningcss | 1.31.1 | MPL-2.0 | node_modules/lightningcss/package.json | special |
| lightningcss-android-arm64 | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-darwin-arm64 | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-darwin-x64 | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-freebsd-x64 | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-linux-arm-gnueabihf | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-linux-arm64-gnu | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-linux-arm64-musl | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-linux-x64-gnu | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-linux-x64-musl | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-win32-arm64-msvc | 1.31.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| lightningcss-win32-x64-msvc | 1.31.1 | MPL-2.0 | node_modules/lightningcss-win32-x64-msvc/package.json | special |
| lru-cache | 11.3.5 | BlueOak-1.0.0 | node_modules/lru-cache/package.json | special |
| mdn-data | 2.27.1 | CC0-1.0 | node_modules/mdn-data/package.json | special |
| minimatch | 10.2.5 | BlueOak-1.0.0 | node_modules/minimatch/package.json | special |
| minipass | 7.1.3 | BlueOak-1.0.0 | node_modules/minipass/package.json | special |
| node-abi | 3.89.0 | MIT | node_modules/prebuild-install/node_modules/node-abi/package.json | direct |
| node-abi | 4.28.0 | MIT | node_modules/node-abi/package.json | direct |
| node-addon-api | 1.7.2 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| node-html-markdown | 2.0.0 | MIT | node_modules/node-html-markdown/package.json | direct |
| node-html-parser | 6.1.13 | MIT | node_modules/node-html-parser/package.json | direct |
| nodemailer | 8.0.5 | MIT-0 | node_modules/nodemailer/package.json | direct |
| partial-json | 0.1.7 | MIT | node_modules/partial-json/package.json | direct |
| path-scurry | 2.0.2 | BlueOak-1.0.0 | node_modules/path-scurry/package.json | special |
| pdf-parse | 2.4.5 | Apache-2.0 | node_modules/pdf-parse/package.json | direct |
| postal-mime | 2.7.3 | MIT-0 | node_modules/postal-mime/package.json | direct |
| qrcode | 1.5.4 | MIT | node_modules/qrcode/package.json | direct |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | node_modules/rc/package.json | special |
| react | 19.2.4 | MIT | node_modules/react/package.json | direct |
| react-dom | 19.2.4 | MIT | node_modules/react-dom/package.json | direct |
| react-resizable-panels | 4.12.1 | MIT | node_modules/react-resizable-panels/package.json | direct |
| react-router | 7.13.1 | MIT | node_modules/react-router/package.json | direct |
| robust-predicates | 3.0.3 | Unlicense | node_modules/robust-predicates/package.json | special |
| sanitize-filename | 1.6.4 | WTFPL OR ISC | node_modules/sanitize-filename/package.json | special |
| sax | 1.6.0 | BlueOak-1.0.0 | node_modules/sax/package.json | special |
| sharp | 0.34.5 | Apache-2.0 | node_modules/sharp/package.json | direct |
| slice-ansi | 3.0.0 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| sonner | 2.0.7 | MIT | node_modules/sonner/package.json | direct |
| streamdown | 2.5.0 | Apache-2.0 | node_modules/streamdown/package.json | direct |
| tailwind-merge | 3.5.0 | MIT | node_modules/tailwind-merge/package.json | direct |
| tailwindcss | 4.2.1 | MIT | node_modules/tailwindcss/package.json | direct |
| tar | 7.5.13 | BlueOak-1.0.0 | node_modules/tar/package.json | special |
| truncate-utf8-bytes | 1.0.2 | WTFPL | node_modules/truncate-utf8-bytes/package.json | special |
| tsx | 4.21.0 | MIT | node_modules/tsx/package.json | direct |
| type-fest | 0.13.1 | (MIT OR CC0-1.0) | node_modules/type-fest/package.json | special |
| typescript | 5.9.3 | Apache-2.0 | node_modules/typescript/package.json | direct |
| utf8-byte-length | 1.0.5 | (WTFPL OR MIT) | node_modules/utf8-byte-length/package.json | special |
| verror | 1.10.1 | UNKNOWN (not installed in this checkout) | bun.lock (no local package.json) | special |
| vite | 6.4.1 | MIT | node_modules/vite/package.json | direct |
| vite-tsconfig-paths | 5.1.4 | MIT | node_modules/vite-tsconfig-paths/package.json | direct |
| wait-on | 9.0.5 | MIT | node_modules/wait-on/package.json | direct |
| wrangler | 4.74.0 | MIT OR Apache-2.0 | node_modules/wrangler/package.json | special |
| yallist | 5.0.0 | BlueOak-1.0.0 | node_modules/yallist/package.json | special |
| yauzl | 2.10.0 | MIT | node_modules/yauzl/package.json | direct |
| yazl | 2.5.1 | MIT | node_modules/yazl/package.json | direct |
| zod | 3.25.76 | MIT | node_modules/zod/package.json | direct |
| zustand | 5.0.12 | MIT | node_modules/zustand/package.json | direct |
