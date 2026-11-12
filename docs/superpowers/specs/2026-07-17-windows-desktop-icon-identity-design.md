# WeMail Windows Desktop Icon And Notification Identity Design

## Goal

Ensure WeMail consistently uses the bundled WeMail icon in Windows Explorer,
the taskbar, development launches, directory packages, installed shortcuts,
the tray, and desktop notifications.

## Current Problem

The renderer and Electron main process already resolve
`electron/assets/wemail.ico` for the main window and tray. However, the Windows
directory package copies the Electron runtime and renames `electron.exe` to
`WeMail.exe` without replacing the executable resources. Windows therefore
continues to identify the process with Electron's embedded icon and metadata.

Development startup also invokes the stock Electron executable directly even
though `scripts/ensure-wemail-electron-exe.mjs` can prepare a branded executable.
Notifications set a stable AppUserModelID, but their construction does not share
the runtime icon resolver, and reliable Windows toast branding also depends on a
matching executable and Start Menu shortcut identity.

## Considered Approaches

### 1. Use electron-builder for every directory build

This would delegate executable resource editing to electron-builder. It is
correct but would replace the repository's incremental directory-packaging path
and make local packaging slower and more dependent on builder downloads.

### 2. Patch only notification options

Passing an icon to `Notification` is useful, but it does not repair the icon
embedded in `WeMail.exe`, taskbar grouping, Explorer display, or the Windows
application identity used by toast notifications.

### 3. Brand the executable and reuse one runtime identity

This is the selected approach. Patch the copied Windows executable with the
existing multi-resolution WeMail ICO and product metadata, use the already
prepared branded executable for development, and pass the resolved runtime icon
into main-process notifications. Preserve the existing electron-builder icon
configuration for formal NSIS installers.

## Design

### Executable branding helper

Extract the Windows executable resource editing into a focused reusable helper.
The helper accepts an executable path and icon path and applies:

- the WeMail ICO resource;
- `FileDescription=WeMail`;
- `ProductName=WeMail`;
- a WeMail-specific internal/original executable name.

It should use an already installed resource editor rather than introduce a new
binary download. It must fail the packaging operation when branding fails,
because silently shipping an Electron-branded executable is the defect being
fixed.

The helper should avoid rewriting an up-to-date branded executable when neither
the source executable nor icon changed. This keeps it compatible with the
in-progress incremental runtime cache and packaging work.

### Development startup

Change the desktop main startup script to launch through
`scripts/launch-desktop-dev.mjs`. On Windows this script prepares and runs
`WeMailDesktop.exe`; on other platforms it continues to use the normal Electron
launcher. Existing renderer URL and command-line arguments remain unchanged.

### Directory packaging

After the cached Electron runtime is copied or refreshed and `electron.exe` is
renamed to `WeMail.exe`, invoke the executable branding helper before smoke
launch and output verification. Branding must also run when an existing cached
layout predates the branding marker, so old Electron-branded outputs are
repaired without requiring users to delete the entire package directory.

The package marker should record the icon fingerprint or branding version. A
change to the icon or branding implementation must invalidate only the branding
step, not the production dependency cache.

### Notifications and Windows identity

Extend the desktop notification adapter so its options may include the runtime
WeMail icon. Resolve the icon once from the Electron app and provide it to every
main-process notification.

Keep `com.wemail.app` as the shared AppUserModelID for the app and packaged
shortcut. The packaged shortcut must continue to target the branded
`WeMail.exe`, use the same ICO, and carry that AppUserModelID. The icon passed to
`Notification` is supplemental; executable and shortcut identity remain the
primary Windows branding mechanism.

The renderer's browser notification test in Settings remains unchanged because
it inherits the Electron application identity rather than accepting the main
process notification adapter.

### Existing assets

Continue using:

- `electron/assets/wemail.ico` for runtime window, tray, executable, shortcut,
  and notification branding;
- `packaging/icon.ico` for electron-builder's formal Windows packaging config.

Both files already contain Windows icon frames through 256x256. This change does
not redesign or regenerate visual assets.

## Error Handling

- Missing icon or resource-editor binaries cause a clear build/package failure.
- Non-Windows development and packaging paths skip Windows resource editing.
- Notification creation still reports unsupported platforms without attempting
  to construct a notification.
- Shortcut repair remains best-effort at application startup so a locked Windows
  icon cache cannot prevent WeMail from launching.

## Verification

Add focused tests for:

- resource-editor arguments and refresh decisions;
- notification construction including the resolved icon;
- unchanged unsupported-notification behavior;
- package layout branding invalidation where practical without launching the
  full installer.

Run:

1. focused Vitest/Node tests for Electron helpers and packaging scripts;
2. `npm run typecheck:desktop`;
3. the deterministic WeMail desktop rebuild/launch workflow, verifying
   `loadURL-done`, `ready`, and a visible window;
4. `npm run package:desktop:dir` for the formal directory artifact;
5. inspect the associated icon and version metadata of
   `dist/win-unpacked/WeMail.exe` and verify a test notification uses WeMail
   branding.

## Scope

This change does not add code signing, redesign the logo, replace the installer
format, or clear the user's global Windows icon cache automatically. If Windows
retains an old pinned icon, acceptance instructions may require unpinning the
old shortcut and launching the newly branded executable once.
