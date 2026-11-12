# macOS Electron Runtime Path Design

## Goal

Allow the desktop development launcher to validate and launch a cached Electron runtime on macOS while preserving the existing Windows behavior.

## Design

Centralize the platform-specific executable location in a small exported helper. Windows resolves `electron.exe`, macOS resolves `Electron.app/Contents/MacOS/Electron`, and other platforms resolve `electron` at the runtime root. Runtime validation, the returned executable path, and the `node_modules/electron` distribution link all continue to use the same extracted runtime directory.

## Error Handling

An extracted runtime remains invalid when either its platform-specific executable or its matching `version` file is missing. The existing download, checksum, staging, cleanup, and retry behavior remains unchanged.

## Testing

Add a regression test that constructs a minimal macOS runtime layout and verifies both executable resolution and runtime validation. Keep the existing Windows test to prevent regressions, then run the focused test, desktop typecheck, and the real desktop launcher.
