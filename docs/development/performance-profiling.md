# Electron Performance Profiling

These workflows are for local WeMail development only. They are not exposed by packaged builds.

## Main-process CPU profile

Start WeMail with the Electron main-process V8 Inspector:

```powershell
npm run dev:desktop:profile
```

Open `chrome://inspect` in Chrome or Edge, select the Electron main process, open the Performance panel, and record only the interaction that reproduces the slowdown. Save the result as a `.cpuprofile` or JSON profile. It can be reopened in DevTools or loaded into [Speedscope](https://www.speedscope.app/).

Override the Inspector port when necessary:

```powershell
$env:WEMAIL_INSPECT_PORT = "9333"
npm run dev:desktop:profile
```

## Multi-process Electron trace

Start a bounded Electron/Chromium trace:

```powershell
npm run dev:desktop:trace
```

The default recording lasts 30 seconds and writes a timestamped JSON trace under `workspace/reports/performance/`. Open the file in [Perfetto](https://ui.perfetto.dev/) or Chrome Trace Viewer.

Optional overrides:

```powershell
$env:WEMAIL_TRACE_DURATION_MS = "60000"
$env:WEMAIL_TRACE_OUTPUT_DIR = "workspace/reports/performance/mail-open"
npm run dev:desktop:trace
```

Use a CPU profile to find hot JavaScript functions in the Electron main process. Use an Electron trace to correlate main, renderer, GPU, Node/V8, and Chromium task timing across processes.

Profiles and traces may contain local paths, URLs, function names, and other development metadata. Review them before sharing and do not commit generated artifacts.
