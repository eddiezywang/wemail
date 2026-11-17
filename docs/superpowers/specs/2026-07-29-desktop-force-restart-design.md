# Desktop Force Restart Design

## Goal

Add `npm run desktop:restart` for local validation when a running WeMail process
still holds `better-sqlite3.node` or port 5173. The command must stop only the
desktop processes owned by this repository, wait for resources to be released,
and then delegate to the existing `desktop:quick` workflow.

## Process Selection

The restart script resolves the repository root and the expected branded
executable path before inspecting processes.

It may terminate only:

- `WeMailDesktop.exe` whose executable path exactly matches
  `node_modules/electron/dist/WeMailDesktop.exe` in this repository.
- The listener on `127.0.0.1:5173` when its command line contains this
  repository path and either `vite.desktop-quick.config.ts` or the known
  `serve-built-renderer.mjs --root <repository> --port 5173` acceptance helper.

It must never terminate processes solely by name. In particular, it must not
touch Tencent WeMail under `C:\ProgramData\Tencent\WeMail`. If port 5173 belongs
to an unrelated process, restart fails with the owning PID and command line.

## Restart Flow

1. Detect and stop matching repository-owned desktop processes.
2. Detect and stop the matching quick-renderer listener, if present.
3. Wait until all matching desktop processes have exited, port 5173 is free,
   and the Electron `better-sqlite3.node` destination can be opened for writing.
4. Spawn `npm run desktop:quick` with inherited terminal input and output.
5. Forward the child exit code and Ctrl+C behavior to the caller.

The normal `desktop:quick` command keeps its current non-destructive behavior.
Forceful process termination is available only through the explicit restart
command.

The quick renderer is launched through a small Node wrapper that passes absolute
Vite entry and configuration paths. This makes repository ownership visible in
the Windows process command line even after npm parent processes have exited.

## Error Handling

The script fails without starting a new instance when:

- a matching process does not exit within the bounded wait period;
- port 5173 is owned by another application;
- the native binding remains locked after the wait period; or
- process inspection cannot establish the executable or command-line owner.

Errors identify the blocked resource and PID where available.

## Testing

Add contract and unit coverage for:

- the new npm command delegating to the restart script;
- exact repository executable matching;
- Tencent WeMail exclusion;
- repository Vite listener matching;
- rejection of unrelated port owners;
- bounded resource-release polling; and
- delegation to `desktop:quick` after cleanup.

Desktop acceptance runs `npm run desktop:restart` while a quick desktop instance
is active, then verifies HTTP 200 plus `loadURL-done` and `ready` in startup.log.
