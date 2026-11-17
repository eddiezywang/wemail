# Secure desktop updates

WeMail desktop releases use `electron-updater` with public, static HTTPS feeds.
The renderer can request fixed actions, but it cannot provide a URL, path,
publisher identity, Team ID, installer argument, or command.

## Artifact naming

Release artifacts use the same canonical versioned name on every platform:
`WeMail-<version>-<arch>.<ext>`. The unpacked Windows runtime executable is
`WeMailDesktop.exe` and is not an installer artifact.

## Supported release targets

| Target | Command | Feed directory |
| --- | --- | --- |
| Windows x64 | `npm run package:release:windows` | `dist/update-feed/windows/x64` |
| macOS Intel x64 | `npm run package:release:mac:x64` | `dist/update-feed/mac/x64` |
| macOS Apple Silicon arm64 | `npm run package:release:mac:arm64` | `dist/update-feed/mac/arm64` |

The commands require native runners because verification uses `signtool` on
Windows and `codesign`, `spctl`, `stapler`, and `lipo` on macOS. A release
command exits nonzero if signing, notarization, target architecture, feed URL,
metadata, or referenced artifacts cannot be verified.

## GitHub configuration

Repository variables:

- `WEMAIL_UPDATE_BASE_URL`: public or private update root such as
  `https://updates.example.com/downloads/`.
- `WEMAIL_WINDOWS_PUBLISHER`: expected Authenticode publisher display name.
- `APPLE_TEAM_ID`: Apple Developer Team ID expected in the signed app.

Repository secrets:

- Windows: `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`.
- macOS signing: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`.
- macOS notarization: `APPLE_API_KEY` containing the `.p8` key,
  `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

The workflow writes the Apple API key to a temporary runner file. Signing
credentials must never be committed, printed, included in artifacts, or placed
on the update host.

## Feed layout and content types

```text
<base>/windows/x64/latest.yml
<base>/windows/x64/WeMail-<version>-x64.exe
<base>/windows/x64/*.blockmap

<base>/mac/x64/latest-mac.yml
<base>/mac/x64/WeMail-<version>-x64.zip
<base>/mac/x64/WeMail-<version>-x64.dmg

<base>/mac/arm64/latest-mac.yml
<base>/mac/arm64/WeMail-<version>-arm64.zip
<base>/mac/arm64/WeMail-<version>-arm64.dmg
```

Configure storage/CDN MIME types as follows:

| Extension | MIME type |
| --- | --- |
| `.yml` | `application/yaml` or `text/yaml; charset=utf-8` |
| `.exe` | `application/vnd.microsoft.portable-executable` |
| `.blockmap` | `application/octet-stream` |
| `.zip` | `application/zip` |
| `.dmg` | `application/x-apple-diskimage` |

Do not combine platform or architecture directories. The metadata filenames
are fixed and would otherwise collide.

## Publication order

1. Run the target's release command and retain the verified feed directory
   byte-for-byte.
2. Upload versioned EXE, blockmap, ZIP, and DMG objects first.
3. Confirm every object is available over HTTPS with the expected byte length.
4. Upload `latest.yml` or `latest-mac.yml` last.

Metadata should use `Cache-Control: no-cache` or a short TTL. Versioned
artifacts should use a long immutable cache policy. Never overwrite an existing
version, even to repair a broken release; publish a higher version instead.
Test-feed promotion must copy the exact verified bytes to production rather
than rebuilding them.

No server upload step is included in GitHub Actions until the storage provider
and its atomic publication mechanism are selected.

## Trust and bootstrap limits

Feeds are public and require no client token. Trust comes from HTTPS, the
SHA-512 values generated in update metadata, Windows Authenticode publisher
verification, Apple Team ID signing, and Apple notarization.

The feed address is embedded at release time. An installed build that shipped
with updates disabled cannot discover a future server address. Users of that
build must manually install one feed-enabled release once; later releases can
then use automatic updates.

## Installed-application acceptance

Perform this checklist on signed Windows x64, macOS x64, and macOS arm64
release candidates. Install version `N` and serve verified version `N+1` over
HTTPS.

1. Startup reports `N+1` without downloading it.
2. `暂不更新` suppresses another prompt only for that process.
3. Settings > About can still perform a manual check.
4. Confirming the update shows progress and supports cancellation and retry.
5. A deliberately corrupt artifact produces a security verification failure
   with no bypass action.
6. A valid artifact offers immediate installation and install-on-exit.
7. Closing the window hides it to the tray and does not install.
8. Explicit tray or operating-system quit installs only when install-on-exit
   was selected.
9. Forced termination does not launch an installer.
10. After installation, WeMail reports version `N+1`.

Record the tested version pair, feed origin, target architecture, signing
identity, notarization result, and tester for each release candidate.
