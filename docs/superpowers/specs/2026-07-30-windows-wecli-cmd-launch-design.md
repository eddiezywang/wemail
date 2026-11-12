# Windows WeCLI CMD Launch Fix Design

## Problem

On Windows, WeMail resolves an npm-installed WeCLI binary to a `.cmd` shim and launches it through `cmd.exe /d /s /c`. When the shim path contains spaces, Node escapes the quoted command payload again. `cmd.exe` then treats the escaped quoted path as the command name and exits before WeCLI starts.

The same launch path is used by the WeCLI health checker and normal WeCLI operations. As a result, `wecli --version`, `wecli doctor`, and user-requested WeCLI commands can all fail even though the shim is present and works from an interactive command prompt.

Windows command-shell diagnostics may use the system OEM/GBK code page. The current health checker always decodes process output as UTF-8, which turns the underlying error into replacement characters and prevents useful diagnosis.

## Scope

- Fix `.cmd` and `.bat` invocation through the shared WeCLI launch resolver.
- Apply the corrected launch options to both health checks and normal WeCLI execution.
- Preserve existing behavior for `.exe`, explicit non-shim binaries, and non-Windows platforms.
- Decode valid UTF-8 output unchanged and fall back to GBK only for invalid UTF-8 output on Windows.
- Add focused regression tests for paths containing spaces and Windows diagnostic decoding.

This change does not alter WeCLI command classification, confirmation requirements, audit logging, installation, or PATH resolution.

## Chosen Approach

Keep `cmd.exe` as the supported launcher for Windows command shims. For `.cmd` and `.bat` binaries, the shared resolver will wrap the complete `/c` payload using the quoting form required by `cmd.exe` and indicate that the child process must use `windowsVerbatimArguments: true`. This prevents Node from adding a second layer of escaping around the payload without introducing `call`'s second expansion pass.

Arguments continue to be passed through the existing Windows command-argument quoting function. Existing percent-sign handling remains unchanged, and arguments containing command-shell metacharacters remain quoted.

The resolver's result becomes the single source of truth for both the command/arguments and any Windows-specific spawn options. Callers must not reconstruct those options independently.

## Output Decoding

Process output will be collected as raw buffers. A decoding helper will:

1. Attempt strict UTF-8 decoding.
2. Return UTF-8 when all bytes are valid.
3. On Windows only, fall back to GBK when strict UTF-8 decoding fails.
4. On other platforms, use normal UTF-8 replacement behavior for malformed data.

This keeps normal Node-based WeCLI output unchanged while making `cmd.exe` diagnostics readable on Chinese Windows systems.

## Error Handling

Existing exit-code, timeout, missing-binary, and spawn-error behavior remains unchanged. The fix only ensures that the intended shim is actually executed and that captured diagnostics are readable.

The timeout still terminates the spawned `cmd.exe` process. No shell mode is enabled, and no user-provided command string is passed directly to `spawn` without the existing tokenization and quoting boundary.

## Testing

Focused tests will cover:

- `.cmd` launch resolution includes `cmd.exe`, the safely quoted `call` payload, and verbatim Windows arguments.
- Paths without spaces and paths containing spaces are both represented correctly.
- Existing `.exe` and non-Windows launch results do not request verbatim Windows arguments.
- A Windows-only integration-style test creates a temporary `.cmd` file in a directory containing spaces and verifies it can be launched with the resolved command and options.
- Valid UTF-8 output remains unchanged.
- Invalid UTF-8 bytes representing GBK Chinese diagnostics decode correctly on Windows.

The affected server tests and TypeScript validation should pass. No Electron renderer or packaging behavior is changed.

## Compatibility With Current Worktree

The existing uncommitted PATH-resolution change in `WecliSkillRuntime.ts` and its tests is compatible and will be preserved. The unrelated unresolved merge conflict in `electron/main/app.ts` is outside this change and will not be edited.
