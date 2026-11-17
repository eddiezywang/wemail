# WeMail Desktop Quick Start Design

## Goal

Provide one repository command, `npm run desktop:quick`, for routine local
validation of small renderer or Electron changes. The command must retain the
WeMail executable identity and icon instead of launching the stock
`electron.exe` identity.

## Command Behavior

The command will:

1. Prepare cached Electron native bindings.
2. Compile the Electron main process with TypeScript incremental state so the
   first run is complete and subsequent runs avoid unchanged work.
3. Start the renderer through the existing Vite development server on
   `127.0.0.1:5173`, preserving HMR for frontend edits.
4. Wait for the renderer HTTP endpoint before launching Electron.
5. Launch through `scripts/launch-desktop-dev.mjs`, which prepares and uses
   `node_modules/electron/dist/WeMailDesktop.exe` with the generated WeMail ICO
   and Windows executable metadata.
6. Keep renderer and desktop output visible in one terminal and terminate both
   child processes when the user presses `Ctrl+C`.

## Implementation

Add focused package scripts rather than another orchestration program:

- `build:desktop:main:quick` performs incremental Electron TypeScript output.
- `desktop:quick:main` waits for the renderer and launches the branded desktop
  executable.
- `desktop:quick` prepares native bindings, compiles the main process, then uses
  the existing `concurrently` dependency to run Vite and the desktop launcher.

The TypeScript build-info file will live under the ignored build output rather
than the repository root. Existing `dev:desktop` and production build/package
commands remain unchanged.

## Failure Behavior

- Missing Electron runtime or native bindings fails before Vite starts.
- TypeScript errors stop the command before desktop launch.
- A renderer port conflict or renderer compilation error remains visible in the
  shared terminal.
- The desktop launcher continues to pass `VITE_DEV_SERVER_URL` explicitly,
  preventing the unpackaged-app white-screen failure.
- The command does not terminate unrelated Tencent WeMail processes.

## Verification

- Assert the package scripts contain the branded launcher and do not invoke the
  full `build:desktop` or formal packaging paths.
- Run the incremental main-process compile twice and verify both succeed.
- Start `npm run desktop:quick`, require renderer HTTP 200, a visible WeMail
  window, and fresh `loadURL-done` plus `ready` startup-log entries.
- Confirm the launched executable is `WeMailDesktop.exe` and the Windows taskbar
  uses the WeMail icon.
