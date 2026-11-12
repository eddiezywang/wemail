# macOS Electron Runtime Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and launch the cached Electron runtime on macOS using its application-bundle executable path.

**Architecture:** Add one platform-aware executable-path helper and reuse it for runtime validation and the executable returned to the launcher. Preserve the current cache, extraction, distribution-link, and Windows/Linux behavior.

**Tech Stack:** Node.js ESM, `node:path`, `node:test`, Electron.

---

### Task 1: Resolve Platform-Specific Electron Executables

**Files:**
- Modify: `tests/scripts/ensure-electron-runtime.test.mjs`
- Create: `tests/scripts/ensure-wemail-electron-exe.test.mjs`
- Modify: `tests/scripts/ensure-electron-native-bindings.test.mjs`
- Modify: `scripts/ensure-electron-runtime.mjs`
- Modify: `scripts/ensure-electron-native-bindings.mjs`
- Modify: `scripts/desktop-build-cache.mjs`
- Modify: `scripts/ensure-wemail-electron-exe.mjs`

- [ ] **Step 1: Write the failing macOS regression test**

Import `getElectronExecutablePath`, create `Electron.app/Contents/MacOS/Electron` and a matching `version` file in a temporary directory, then assert that the helper returns the bundle executable and `isValidElectronRuntime` returns `true`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/scripts/ensure-electron-runtime.test.mjs`

Expected: FAIL because `getElectronExecutablePath` is not exported yet.

- [ ] **Step 3: Implement the minimal platform-aware helper**

Add:

```js
export function getElectronExecutablePath(runtime, platform) {
  if (platform === "win32") return path.join(runtime, "electron.exe");
  if (platform === "darwin") {
    return path.join(runtime, "Electron.app", "Contents", "MacOS", "Electron");
  }
  return path.join(runtime, "electron");
}
```

Use it in `isValidElectronRuntime` and for the executable returned by `ensureElectronRuntime`.

Also select `path.win32` when `resolveDesktopBuildCacheRoot` receives an injected
Windows platform, so its existing cross-platform fallback test uses Windows path
semantics on non-Windows hosts.

Ensure the Electron package `path.txt` is rewritten on every successful runtime
check. On macOS it must contain `Electron.app/Contents/MacOS/Electron` without a
trailing newline, including when the existing `dist` directory is already valid.

Verify that importing the Windows executable preparation script on non-Windows
platforms returns control to its caller instead of terminating the launcher.

Install the cached Electron ABI binding into the existing runtime lookup path at
`node_modules/better-sqlite3/bin/<platform>-<arch>-<abi>/better-sqlite3.node`
without replacing the Node ABI binding used by server development and tests.

- [ ] **Step 4: Run focused verification and verify GREEN**

Run: `node --test tests/scripts/ensure-electron-runtime.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Verify desktop compilation**

Run: `npm run typecheck:desktop`

Expected: exit code 0.

- [ ] **Step 6: Commit the fix**

```bash
git add scripts/ensure-electron-runtime.mjs tests/scripts/ensure-electron-runtime.test.mjs docs/superpowers/plans/2026-07-19-macos-electron-runtime.md
git commit -m "fix: resolve macos electron runtime executable"
```

### Task 2: Launch the Desktop Application

**Files:**
- No source changes.

- [ ] **Step 1: Stop the Web-only development session**

Send an interrupt to the running `npm run dev:web` process so port 5173 becomes available.

- [ ] **Step 2: Start desktop development mode**

Run: `npm run dev:desktop`

Expected: the runtime validates, the desktop build completes, and Electron remains running without an immediate nonzero exit.

- [ ] **Step 3: Confirm renderer connectivity**

Run: `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/`

Expected: `200`.
