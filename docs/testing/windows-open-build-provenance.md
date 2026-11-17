# Windows open-edition test build provenance

This record describes the local, unsigned Windows x64 **test** installer built
from source tree `1d3365dd2f37a84f6869834ff4b06b9e3d3c2118` (commit
`a0b0c66` before later documentation-only changes). It is not a release
approval or a determination of license compliance.

| Item | Value |
| --- | --- |
| Artifact | `WeMail-1.1.4-x64.exe` |
| SHA-256 | `C341DE33A13E20650214724E24E7BB5B3BC8F6061D422827476700CA0DE8A1B5` |
| Signing | Unsigned |
| Edition | Open; no private edition features configured |

The installer contains the project license, third-party notices and inventory,
the Qwen Code v0.21.1 upstream license, and the bundled font license. Its
`@img/sharp-win32-x64` package declares version 0.34.5 and
`Apache-2.0 AND LGPL-3.0-or-later`. The installed `versions.json` matches the
bundled version inventory as JSON data and identifies libvips 8.17.3.

The following SHA-256 values were measured on files in the unpacked app used
to construct the installer:

| File | SHA-256 |
| --- | --- |
| `libvips-42.dll` | `F8D356DEF73941668252347B825055310E99023FF77C7D3036E592D0771E1529` |
| `libvips-cpp-8.17.3.dll` | `F1B3C3EEEA1B6A8292A69D78DD2CD1DEBACB9951CABDD9217A57E34137570CD1` |
| `sharp-win32-x64.node` | `AFC813593F255968DDAE8F1D66557E0F96484BB374606E4EB2267A7DBC7CB25A` |

PE import-table inspection shows the sharp module imports both libvips DLLs,
and the C++ wrapper imports `libvips-42.dll`. The latter imports Windows
system libraries; the import table alone does not establish the linkage or
license compliance of every component embedded in it.

The upstream `vips-dev-w64-web-8.17.3-static.zip` release asset was downloaded
and its SHA-256 matched the digest in the GitHub release metadata:
`657e14296b96d0b57d33cb1c568f0237ffa5c811e11f5931390ac0feea8eb74b`.
The archive's `vips-dev-8.17/bin/libvips-42.dll` has the same SHA-256 as the
file in the installer input listed above. The upstream `vips-8.17.3.tar.xz`
source release was also downloaded and matched its published checksum:
`41e9a1439cd57dcc6d4435a085e2cfe181d9da1962fa84a484f09e8b536e4b77`.

## Dependency source checks

The following source archives were downloaded locally and their SHA-256 values
matched the checksums in the upstream Windows build recipe. This verifies the
archives against that recipe; it does not prove which container image built the
specific DLL, or that this list includes every source and build input required.

| Source archive | SHA-256 |
| --- | --- |
| [glib 2.86.1](https://download.gnome.org/sources/glib/2.86/glib-2.86.1.tar.xz) | `119d1708ca022556d6d2989ee90ad1b82bd9c0d1667e066944a6d0020e2d5e57` |
| [fribidi 1.0.16](https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz) | `1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c` |
| [libexif 0.6.25](https://github.com/libexif/libexif/releases/download/v0.6.25/libexif-0.6.25.tar.xz) | `62f74cf3bf673a6e24d2de68f6741643718541f83aca5947e76e3978c25dce83` |
| [librsvg 2.61.2](https://download.gnome.org/sources/librsvg/2.61/librsvg-2.61.2.tar.xz) | `4644d83623dd61cc4479c2b3c372e1da2b281552ebc90035c8d1ac502eb1dc00` |
| [pango 1.57.0](https://download.gnome.org/sources/pango/1.57/pango-1.57.0.tar.xz) | `890640c841dae77d3ae3d8fe8953784b930fa241b17423e6120c7bfdf8b891e7` |
| [libheif 1.20.2](https://github.com/strukturag/libheif/releases/download/v1.20.2/libheif-1.20.2.tar.gz) | `68ac9084243004e0ef3633f184eeae85d615fe7e4444373a0a21cebccae9d12a` |
| [proxy-libintl 0.5](https://github.com/frida/proxy-libintl/archive/refs/tags/0.5.tar.gz) | `f7a1cbd7579baaf575c66f9d99fb6295e9b0684a28b095967cfda17857595303` |

## Replacement loading smoke test

In an isolated copy of the Windows sharp package, a test marker was appended as
PE overlay data to `libvips-42.dll`. Its resulting SHA-256 was
`FADC17890C0D27A2670CD41C7AC6F33A29CA458230EDAB491D1DE2136C330DA5`.
Node and the packaged Electron 41.3.0 runtime each loaded that copied DLL, as
confirmed by their diagnostic shared-object lists, and generated a 2-by-3 PNG.
The installed application and its files were not modified. Appending overlay
data is not a functional modification or recompilation: this smoke test does
not establish that a modified library can be rebuilt or relinked, or that the
relevant license obligations are satisfied.

## Dynamic upstream build experiment

The separate upstream [Windows web dynamic build](https://github.com/libvips/build-win64-mxe/releases/download/v8.17.3/vips-dev-w64-web-8.17.3.zip)
was downloaded and matched its release asset SHA-256
`4c960366551911debc7e7dc8f7c41dc804bb2d39c73823a54f0993464d0f2d29`.
Its `bin` directory contains 38 DLLs, including separate GLib libraries.
In a disposable copy of the sharp package, replacing the static-build DLL
and adding the dynamic-build DLLs caused the existing sharp native addon to
fail to load with a missing procedure. PE inspection found seven symbols
imported by the addon from `libvips-42.dll` that this dynamic DLL does not
export, and 25 such imports in the bundled C++ wrapper. These include GLib
symbols provided separately in the dynamic build. Therefore this archive is
not a drop-in replacement for the bundled sharp binary. A dynamic distribution
would require a compatible rebuilt addon and wrapper, plus functional,
packaging, source and license verification; this experiment does not provide
those or establish compliance.

An additional, isolated Windows build of sharp 0.34.5 and its C++ wrapper was
linked against the dynamic archive's libvips, GLib and GObject libraries.
The locally built addon SHA-256 was
`c218b1e650b98875db563116b6aead122172bb681e30bd79afdaf429837c4459`;
the wrapper SHA-256 was
`3a9b2a36a27485285fdc62da96962c31f697db546ec8b3b7c7584c0c8c68b838`.
PE inspection found separate GLib and GObject imports in both binaries.
With the dynamic DLLs in a private test directory, Node and the packaged
Electron 41.3.0 runtime loaded them and converted and resized a synthetic
image. Sixteen existing remote-image and attachment-store tests passed under
both Node and Electron 41.3.0 with this addon. The experiment is not integrated into WeMail packaging;
reproducible build instructions, distribution of corresponding sources,
testing a rebuilt modified library, and review of the complete license inventory remain.

For a further compatibility check, a second disposable copy replaced only
the GLib and GObject DLLs with the different binaries from the upstream
[8.17.2 Windows web archive](https://github.com/libvips/build-win64-mxe/releases/download/v8.17.2/vips-dev-w64-web-8.17.2.zip)
(archive SHA-256 `4b100e2e53cf0ee83525b36ffbb5d7605cfab54a5e43281217fe2dcc43ab7c55`).
The substituted GLib and GObject DLLs had SHA-256 values
`a6f00a3844e27bd3f1a48407e287d62ebb55cd3c1f0f043f0bec10fe5c76cf3b` and
`8f5cd7a7fbe4677c9640e9ec8cfb8c22e8a22a45a13e41a8eb4c3356183e3e4a`.
Node and Electron 41.3.0 loaded that copy and completed the image conversion;
the same 16 application tests passed under both runtimes. This demonstrates loading
different upstream binaries in the isolated experiment, not building a
modified library from source or satisfying all distribution obligations.

## Upstream references

- [sharp v0.34.5 Windows package metadata](https://github.com/lovell/sharp/blob/v0.34.5/npm/win32-x64/package.json)
- [sharp-libvips v1.2.4 dependency versions](https://github.com/lovell/sharp-libvips/blob/v1.2.4/versions.properties)
- [sharp-libvips v1.2.4 Windows packaging script](https://github.com/lovell/sharp-libvips/blob/v1.2.4/build/win.sh)
- [libvips Windows build v8.17.3 and dependency list](https://github.com/libvips/build-win64-mxe/tree/v8.17.3)
- [Windows upstream prebuilt archive](https://github.com/libvips/build-win64-mxe/releases/download/v8.17.3/vips-dev-w64-web-8.17.3-static.zip)
- [libvips v8.17.3 source release](https://github.com/libvips/libvips/releases/tag/v8.17.3)
- [Windows build patches](https://github.com/libvips/build-win64-mxe/tree/v8.17.3/build/patches)
- [MXE base image recipe](https://github.com/libvips/build-win64-mxe/blob/v8.17.3/container/base.Dockerfile)

The upstream Windows packaging script selects the `web` static build for
libvips 8.17.3 and post-processes its files. The matching DLL identifies the
upstream binary, but the libvips source archive alone does not establish all
corresponding dependency sources, patches, build inputs, replacement or
relinking rights, or satisfaction of third-party license obligations.
The Windows build repository contains patches for libvips and other LGPL
dependencies. Its base recipe references an MXE branch, while the build recipe
defaults to a `latest` container image; neither observation proves the exact
toolchain image used to produce this specific upstream binary. Record and
retain the applicable dependency sources, patches and build inputs, and
verify recipients' replacement or relinking path before a release.
Those remain to be checked before the installer is distributed as a release.
The installer itself also needs clean-machine, real-mailbox acceptance.
