# Windows build pipeline and artifact naming

All versioned Electron artifacts use the canonical name
`WeMail-<version>-<arch>.<ext>`. The runtime executable remains
`WeMailDesktop.exe`; it is different from the installer filename.

| Command | Purpose | Signing | Output |
| --- | --- | --- | --- |
| `npm run build:desktop` | Compile renderer and Electron bundles | N/A | `build/`, `dist-electron/` |
| `npm run package:desktop:unpacked` | Local Windows unpacked app | No installer signing | `dist/win-unpacked/WeMailDesktop.exe` |
| `npm run package:desktop:installer` | Local Windows NSIS installer | Unsigned | `dist/WeMail-<version>-x64.exe` and `.blockmap` |
| `npm run package:windows` | WSL2/Linux Docker cross-build | Unsigned | `dist/WeMail-<version>-x64.exe` |
| `npm run package:release:windows` | Production Windows release | Authenticode required | `dist/release-win32-x64/` and `dist/update-feed/windows/x64/` |
| `npm run package:windows:self-signed` | Internal Windows test release | Test certificate | Same release/feed layout as above |

The `package:desktop:dir*` commands remain compatibility aliases for the
`package:desktop:unpacked*` commands.

The WSL2/Linux path is for local development and smoke testing; production
releases must use the signed native release command described below.

## WSL2/Linux cross-build

WeMail can be packaged into an unsigned Windows NSIS installer directly from
WSL2 / Linux using a containerised cross-build.

## Prerequisites

One of:

- **WSL2 + Docker Desktop** with the "WSL 2 integration" toggle enabled for
  your distro (Settings -> Resources -> WSL Integration). This is the primary
  supported path.
- **A native Windows host** with a supported Node version (22.19+ in the 22.x
  line or 24.x) and the repo checked out. Use
  `npm run package:windows:self-signed` for the signed internal-test package.

Disk cost: the `wemail-winbuild` image includes Wine, Mono and Node 22. It is
a one-time cost per machine; subsequent builds reuse the cached layers.

## Usage

```bash
# Just the Windows installer
npm run package:windows

# Package a clean commit that already passed the GitHub verification gate
npm run ship
```

`ship` requires GitHub CLI authentication, a clean Git worktree and a successful
latest `verification-gate` check from a full CI run for the current commit;
pull-request runs do not qualify. It does not run the
checks locally; run the appropriate verification separately before packaging.

`npm run package:windows` will:

1. Verify `docker` is available on `PATH` (exits with code 2 and a clear
   message if not).
2. Build the `wemail-winbuild:latest` image from `docker/windows-build/Dockerfile`.
3. Install dependencies with Bun's frozen lockfile, rebuild native modules (`better-sqlite3`) for `win32-x64` via
   `@electron/rebuild`, compile the electron bundles, and invoke
   `electron-builder --win nsis --x64 --publish=never` inside the container.
4. Print the path of the produced `dist/*.exe`.

The first invocation can take 5-15 minutes (image build + npm install + native
rebuild + electron download). Subsequent runs reuse the docker layer cache and
the `./.cache/electron` + `./.cache/electron-builder` volumes mounted by the
script.

## Unsigned binary warning

The produced installer is **unsigned**. Windows SmartScreen will show a
"Windows protected your PC" warning when run. Do not publish this artifact as
a production update.

Run production packaging on a native Windows host or the signed GitHub Actions
workflow:

```powershell
$env:WEMAIL_UPDATE_BASE_URL = "https://updates.example.com/downloads/"
$env:WEMAIL_WINDOWS_PUBLISHER = "WeMail Software"
$env:CSC_LINK = "<certificate path, URL, or base64>"
$env:CSC_KEY_PASSWORD = "<certificate password>"
npm run package:release:windows
```

The release command signs during packaging, stages `latest.yml`, the installer,
and blockmaps under `dist/update-feed/windows/x64`, then verifies the
Authenticode chain and expected publisher with `signtool`. See
[`desktop-updates.md`](./desktop-updates.md) for feed publication and installed
application acceptance.

## Self-signed internal-test package

For internal testing without a commercial certificate, generate the shared
WeMail test identity once:

```bash
npm run certificate:windows:test
```

This creates:

```text
workspace/signing/public/WeMail-Test.cer
workspace/signing/private/WeMail-Test.pfx
workspace/signing/private/windows-test-signing.json
```

Only the public `.cer` file is committed. The private directory is ignored by
Git. Its PFX and JSON password file must be copied to other developers through
a team password manager, CI secret store, or private file transfer. Never send
them through source control, issue attachments, chat, or the public update
server.

The tracked public certificate has this SHA-256 fingerprint:

```text
C8:15:1E:B5:38:C1:04:66:0A:99:6A:21:26:8F:03:97:03:DA:7C:01:F5:BF:D2:12:95:60:39:62:ED:90:61:A7
```

On each internal Windows test machine, open an elevated PowerShell prompt and
trust the public certificate for both root and publisher validation:

```powershell
Import-Certificate `
  -FilePath "workspace\signing\public\WeMail-Test.cer" `
  -CertStoreLocation "Cert:\LocalMachine\Root"
Import-Certificate `
  -FilePath "workspace\signing\public\WeMail-Test.cer" `
  -CertStoreLocation "Cert:\LocalMachine\TrustedPublisher"
```

Then build the signed internal-test installer on a native Windows host:

```powershell
npm run package:windows:self-signed
```

The command loads the ignored PFX configuration, signs the unpacked app and
NSIS installer, writes update metadata, and stages the feed under:

```text
dist/release-win32-x64/WeMail-<version>-x64.exe
dist/release-win32-x64/latest.yml
dist/release-win32-x64/WeMail-<version>-x64.exe.blockmap
dist/update-feed/windows/x64/
```

The default example feed URL is:

```text
https://updates.example.com/downloads/windows/x64
```

Override the root before packaging if needed:

```powershell
$env:WEMAIL_UPDATE_BASE_URL = "https://updates.example.com/downloads/"
npm run package:windows:self-signed
```

The command never prints the PFX password. `npm run package:release:windows`
still requires a publicly trusted production certificate.

### Current private-key storage

The current internal-test signing private key is stored as a password-protected
PFX file at:

```text
workspace/signing/private/WeMail-Test.pfx
```

Its local password and metadata are stored in:

```text
workspace/signing/private/windows-test-signing.json
```

That directory is ignored by Git via `/workspace/signing/private/`. Only the
public certificate is committed at `workspace/signing/public/WeMail-Test.cer`.
To let another developer package the same update stream, distribute the PFX
and JSON through a team password manager, CI secret store, or private file
transfer. Do not commit either private file or upload them to the update host.

On the packaging machine, the PFX must also be imported into the current user's
Windows certificate store so the unpacked app can be signed before NSIS builds
the installer:

```powershell
$config = Get-Content "workspace\signing\private\windows-test-signing.json" | ConvertFrom-Json
Import-PfxCertificate `
  -FilePath "workspace\signing\private\WeMail-Test.pfx" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -Password (ConvertTo-SecureString $config.password -AsPlainText -Force)
```

The self-signed installer is only trusted on machines where the public
certificate was installed manually. Do not publish it as a public automatic
update.

## Troubleshooting

### `better-sqlite3` ABI mismatch at launch

The container flow runs `@electron/rebuild --arch=x64 --platform=win32`
automatically so the shipped `.node` matches the electron ABI. If you
hand-build outside the script and see `NODE_MODULE_VERSION` errors, re-run
`npx @electron/rebuild --arch=x64 --platform=win32 --module-dir .` before
packaging.

### Electron download fails inside the container

The container inherits network from the host. If your corporate proxy blocks
`github.com` downloads, set `ELECTRON_MIRROR` (and optionally `ELECTRON_CUSTOM_DIR`)
in the `docker/windows-build/Dockerfile` or pass it through via
`-e ELECTRON_MIRROR=...` in `scripts/build-windows.sh`. Downloads are cached
under `.cache/electron` so a single successful run unblocks subsequent builds.

### WSL2 path translation

Always run `npm run package:windows` from inside WSL using the WSL path
(e.g. `/mnt/d/git/wemail` or a path under `~`). Do **not** `cd` via
`\\wsl$\...` from PowerShell; Docker volume mounts are unreliable when the
working directory is crossed between filesystems.

### Docker image rebuild is slow / large

The ~3 GB image is expected - wine + mono alone is ~1 GB. If disk pressure is
an issue, `docker image prune` between releases, or pin to an already-pulled
tag. The image only needs rebuilding when you edit the Dockerfile.

### Wine permission errors

If you see `wine: could not load kernel32.dll` or similar, the container is
missing wine assets. Rebuild the image with `docker build --no-cache -t
wemail-winbuild:latest docker/windows-build`.

## CI

`.github/workflows/ci.yml` runs the verification gate. The separate
`.github/workflows/release-desktop.yml` requires a successful gate for the
target commit before running signed platform packaging jobs on a tag or manual
dispatch. Local `ship` checks the same named gate before packaging.
