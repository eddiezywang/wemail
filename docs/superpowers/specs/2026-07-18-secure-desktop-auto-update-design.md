# WeMail Secure Desktop Auto-Update Design

## Purpose

WeMail will check for a newer desktop release once after every application
startup. When a release is available, the application informs the user before
downloading it, reports download progress, and asks whether to install it
immediately or when the application next exits normally.

The first release supports these targets:

- Windows x64 with an NSIS installer.
- macOS Intel x64 with a DMG and update ZIP.
- macOS Apple Silicon arm64 with a DMG and update ZIP.

The update server address is not available yet. The feature remains disabled
without a configured HTTPS feed and does not interfere with application
startup. Once a release is built with a feed address, later releases can use
the automatic update path. A build shipped without a feed address cannot
discover a future address by itself and must be replaced through the existing
manual distribution process.

## Confirmed Product Behavior

- Check once after every real application startup.
- Do not block the main window, local API, or mailbox startup on the check.
- Notify the user when a newer version exists.
- Download only after explicit user confirmation.
- If the user declines, do not prompt again during the same run.
- Check and prompt again on the next application startup.
- After download, offer `Restart and install` and `Install on exit`.
- Closing the main window to the tray does not count as application exit.
- Install-on-exit runs only after an explicit tray or operating-system quit.
- A crash or forced termination must not initiate installation.
- Add a manual `Check for updates` action under Settings > About.
- Do not support mandatory updates, silent installation, skipped versions,
  release channels, or staged rollout in the first release.

## Chosen Approach

Use the existing `electron-updater` dependency with an electron-builder generic
HTTPS provider.

This approach matches the current Electron 41, electron-builder, NSIS, and DMG
toolchain. It provides update metadata generation, SHA-512 verification,
platform-specific installation, progress events, and package signature checks
without introducing a custom downloader or installer launcher.

The alternatives were rejected for the first release:

- A custom manifest and downloader would add security-sensitive networking,
  cache, installer, retry, and signature-verification code.
- Microsoft Store and Mac App Store distribution would move updates to the
  operating-system stores but does not match the current direct NSIS/DMG
  release model.

## Architecture

### Update Controller

`electron/main/updater.ts` becomes the main-process update controller. It owns
the `electron-updater` instance and all update state transitions. Its
responsibilities are:

- Resolve whether updates are enabled for the packaged build.
- Start automatic and manual checks without allowing concurrent checks.
- Normalize updater events into a stable WeMail update state.
- Start and cancel downloads after renderer requests.
- Arm immediate installation or install-on-exit only after user confirmation.
- Map low-level failures to safe error codes and diagnostic logs.
- Prevent invalid state transitions and duplicate installation attempts.

The controller depends on a small updater adapter rather than importing the
global updater throughout the application. Production uses an
`electron-updater` adapter; tests use a deterministic fake.

### Main Process Boundary

Only the Electron main process may:

- Read the packaged update feed configuration.
- Contact the update server.
- Select an update artifact.
- Download or delete an update artifact.
- Verify and launch an installer.
- Request application quit for installation.

The renderer cannot provide a URL, local path, shell command, certificate name,
Team ID, or installer argument.

### Preload and IPC

The preload bridge exposes fixed update operations:

- Get the current update state.
- Request a manual check.
- Confirm download.
- Cancel the active download.
- Retry a failed download.
- Request immediate installation.
- Select installation on normal exit.
- Subscribe to update-state changes.

IPC handlers validate that payloads contain only expected scalar values. The
main process derives all security-sensitive values from packaged configuration.

### Renderer Components

The renderer contains two presentation surfaces backed by the same state:

- A global, non-blocking update notification and dialog.
- Settings > About update status and manual-check controls.

The UI never owns update truth. Reopening a dialog or navigating between pages
reads the current state from the main process.

## Feed and Artifact Layout

The update host is static HTTPS storage or a CDN. It does not require login or
a dedicated update API.

Platform and architecture feeds are isolated to avoid metadata collisions:

```text
<base>/windows/x64/latest.yml
<base>/windows/x64/WeMail Setup <version>.exe
<base>/windows/x64/*.blockmap

<base>/mac/x64/latest-mac.yml
<base>/mac/x64/WeMail-<version>-x64.zip
<base>/mac/x64/WeMail-<version>-x64.dmg

<base>/mac/arm64/latest-mac.yml
<base>/mac/arm64/WeMail-<version>-arm64.zip
<base>/mac/arm64/WeMail-<version>-arm64.dmg
```

The exact filenames remain controlled by electron-builder, but each feed keeps
its metadata and referenced files in the same platform/architecture directory.

The release-time base URL is supplied to electron-builder through release
configuration and written into the packaged updater configuration. Development
and automated tests may use an explicit test override. Production does not
accept a feed URL from renderer IPC or user-editable application settings.

## Update State Model

The renderer receives a serializable state with a discriminated `status` and
only fields relevant to that status.

```text
disabled
idle
checking
up-to-date
available
downloading
downloaded
install-on-exit
installing
check-failed
download-failed
security-failed
install-failed
```

Relevant state data includes:

- Current application version.
- Available version.
- Sanitized release title and notes.
- Artifact size when available.
- Download percentage, bytes transferred, total bytes, and transfer rate.
- Last successful or failed check time.
- Stable user-facing error code.

The renderer does not receive installer paths, raw HTTP responses, stack
traces, certificate data, or feed credentials.

## Startup and Manual Check Flow

1. Electron completes application readiness and creates the main window.
2. The update controller initializes without delaying local services.
3. Packaged production builds with a valid HTTPS feed schedule one update
   check after the renderer is ready.
4. Development, test, unpackaged, or unconfigured builds report `disabled`
   unless an explicit test mode enables updates.
5. A successful response with no newer version enters `up-to-date` silently.
6. A newer semantic version enters `available` and triggers a non-blocking
   renderer notification.
7. The user opens the update dialog and chooses `Update now` or `Not now`.
8. `Not now` suppresses automatic prompting for the rest of the process.
9. Settings > About may still show the available version during that run.
10. The next application process performs a fresh check and may prompt again.

Manual checks use the same controller and are deduplicated against an active
automatic check or download. Manual check failures are visible in Settings >
About; automatic check failures remain non-blocking and silent outside logs.

## Download and Installation Flow

1. `Update now` asks the main process to download the already-selected release.
2. The controller rejects the request unless state is `available` or
   `download-failed` for the same version.
3. Download progress events update the global dialog and Settings > About.
4. The user may cancel an active download. Cancellation returns to `available`.
5. A verified download enters `downloaded` and prompts for installation.
6. `Restart and install` begins the normal application shutdown sequence and
   invokes `quitAndInstall` once shutdown guards permit it.
7. `Install on exit` arms installation only in process memory for the current
   run. It does not treat window hiding as exit.
8. A later explicit application quit invokes installation after local services
   and persistent stores stop cleanly.
9. A crash or forced process termination does not invoke installation.
10. On the next startup, a cached artifact may be reused only after the updater
    re-evaluates the release and its integrity. The user is prompted again.

Installation requests are idempotent. Once installation begins, additional IPC
requests are rejected.

## Security Model

### Transport and Origin

- Production feeds must use HTTPS.
- HTTP, filesystem, and custom-protocol feed URLs are rejected.
- Redirects to non-HTTPS destinations are rejected.
- The configured feed origin is fixed by the packaged release configuration.
- Update checks require no login and contain no application secrets.

Public access means third parties can see release metadata and download files.
This is acceptable for WeMail. CDN rate limiting and object-storage controls may
be used to limit bandwidth abuse, but they are not part of client trust.

### Version Policy

- Accept only a valid release version greater than the installed version.
- Reject downgrades and same-version replacement.
- Do not enable prerelease channels in the first release.
- Do not overwrite published version artifacts. Correct a bad release by
  publishing a higher version.

### Integrity and Publisher Verification

- Every downloaded artifact must match the SHA-512 value in generated update
  metadata.
- A hash mismatch deletes the temporary artifact and enters `security-failed`.
- Windows installers must carry a valid Authenticode signature from the
  configured WeMail publisher identity.
- macOS application bundles must be signed with the configured Apple Team ID
  and successfully notarized before publication.
- A package with an invalid, missing, expired-at-signing, or unexpected
  publisher signature is never installed.
- Security failures have no user override.

Hash validation protects against corrupted or mismatched downloads. Platform
code signing protects publisher identity if release storage or metadata is
modified by an attacker who does not possess the signing credentials.

### Signing Credentials

- Windows signing keys, Apple signing keys, certificate passwords, Apple API
  credentials, and notarization credentials exist only in the release
  environment's secret store.
- They are never committed to the repository, embedded in the application,
  uploaded beside artifacts, or written to logs.
- Release jobs fail closed if signing or notarization is unavailable.

### Release Notes

- Release notes are rendered as plain text or sanitized allowlist Markdown.
- Remote HTML, scripts, event handlers, embedded frames, and remote images are
  not rendered.
- External links use the existing validated external-link path and require an
  explicit user action.

### Logging

Update logs may contain:

- Current and target versions.
- Platform and architecture.
- Update stage and stable error code.
- Timing and aggregate byte counts.
- Whether a signature or hash check succeeded.

Logs must not contain raw response bodies, installer contents, certificate
private material, environment secrets, query tokens, stack traces shown to the
renderer, or user mailbox data.

## User Experience

### Available Update

The application first shows a non-blocking update indicator so it does not
cover an active compose or other critical task. Opening it shows:

- Current and available versions.
- Sanitized release notes.
- Download size when known.
- `Update now` and `Not now` actions.

### Download

The update dialog shows percentage, transfer rate, transferred bytes, total
bytes, and a cancel action. Duplicate clicks cannot start duplicate downloads.

### Download Complete

The dialog offers:

- `Restart and install`.
- `Install on exit`.

Settings > About mirrors the pending state and allows immediate installation
after the user previously selected install-on-exit.

### Error Presentation

Low-level errors map to these user-facing categories:

- Network unavailable.
- Update server unavailable.
- Invalid update metadata.
- Insufficient disk space.
- Download failed.
- Update cancelled.
- Update package failed security verification.
- Installer could not start.

Automatic check failures do not interrupt startup. Manual check and download
failures show a retry action. Security failures state that the package was
blocked and provide no bypass.

## Release Process

For each version:

1. Build Windows x64, macOS x64, and macOS arm64 artifacts from the same source
   revision and application version.
2. Sign the Windows installer with the approved Authenticode identity.
3. Sign each macOS application with the approved Team ID and hardened runtime.
4. Submit macOS artifacts for notarization and staple the result where
   applicable.
5. Verify signatures, notarization, versions, architectures, metadata, and
   hashes in the release job.
6. Upload immutable installers, ZIP files, DMGs, and blockmaps to their
   platform/architecture directories.
7. Upload `latest.yml` and `latest-mac.yml` only after all referenced files are
   available.
8. Run installed-application update tests against an isolated test feed.
9. Promote the same signed bytes and metadata to the production feed. Do not
   rebuild or re-sign between test and production publication.

## Testing Strategy

### Unit Tests

The fake updater adapter drives tests for:

- Disabled and unconfigured builds.
- No update and newer update results.
- Automatic and manual check deduplication.
- Declining an update for the current run.
- Download confirmation, progress, cancellation, retry, and completion.
- Immediate installation and install-on-exit behavior.
- Window hide versus real application quit.
- Crash-safe behavior and repeated IPC requests.
- Invalid state transitions and stale-version commands.
- Network, metadata, disk, download, security, and installer failures.
- HTTPS feed validation, downgrade rejection, hash mismatch, and publisher
  mismatch.

### IPC and Renderer Tests

- Preload exposes only the fixed update contract.
- IPC payload validation rejects unexpected values.
- Initial state and state subscriptions remain consistent.
- The global indicator and dialog render every relevant state.
- Settings > About shows current version, last check, manual check, progress,
  retry, and pending installation.
- Security errors never render a bypass action.
- Sanitized release notes cannot execute HTML or scripts.

### Packaged Integration Tests

- Install an older signed Windows x64 release and update it through NSIS.
- Install older signed macOS x64 and arm64 releases and update each through its
  architecture-specific feed.
- Verify offline startup, 404 responses, interrupted downloads, cancellation,
  application restart, insufficient disk space, corrupt artifacts, invalid
  signatures, and unavailable installers.
- Verify main-window close hides to tray without installing.
- Verify explicit tray quit installs only after `Install on exit` was selected.
- Verify a production build without a feed reports disabled and starts normally.

Auto-update behavior must be tested from installed, packaged applications;
unpackaged Electron runs are not sufficient evidence for platform installation.

## Acceptance Criteria

- Every packaged startup performs at most one automatic check after the UI is
  ready when a valid feed is configured.
- A newer version is never downloaded before user confirmation.
- Declining suppresses further automatic prompts only for the current run.
- Download progress and recoverable errors are visible without blocking the
  rest of the application.
- A downloaded update installs immediately or on real application exit only
  after the corresponding user choice.
- Window hiding, crashes, and forced termination never trigger installation.
- Windows x64 and macOS x64/arm64 select only their own feed and artifacts.
- HTTPS, SHA-512, expected Windows publisher identity, expected Apple Team ID,
  and macOS notarization requirements fail closed.
- The renderer cannot choose update URLs, files, commands, or trust identities.
- Settings > About supports manual checking and reports the current update
  state.
- Missing feed configuration disables updates without degrading application
  startup or normal mail functionality.

## Out of Scope

- Mandatory or deadline-based updates.
- Silent background download or installation.
- Skipping a specific version.
- Beta, preview, or enterprise release channels.
- Staged percentage rollouts.
- Delta formats outside electron-updater support.
- Authentication, entitlement checks, or per-customer feeds.
- Linux updates.
- In-application rollback to an older release.
