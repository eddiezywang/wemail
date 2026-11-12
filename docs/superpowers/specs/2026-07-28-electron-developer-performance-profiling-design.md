# Electron Developer Performance Profiling Design

## Goal

Add a command-line-only performance profiling workflow for WeMail developers. The workflow must profile the Electron main process and capture a multi-process Electron/Chromium trace without adding user-facing controls or enabling profiling in packaged builds.

## Scope

The first version provides two developer workflows:

1. Launch the desktop application with the Electron main-process V8 Inspector enabled, allowing a developer to record and save a `.cpuprofile` through `chrome://inspect`.
2. Launch the desktop application with Electron `contentTracing` enabled for a bounded duration, producing a Chrome Trace JSON file for Perfetto or Chrome Trace Viewer.

The implementation does not add an application UI, local diagnostics API, remote control endpoint, bundled profile viewer, automated Chrome DevTools Protocol client, or Windows ETW capture wrapper.

## Commands

Add these repository commands:

```text
npm run dev:desktop:profile
npm run dev:desktop:trace
```

`dev:desktop:profile` starts the existing renderer development server and Electron desktop main process while adding `--inspect=<port>` to the Electron invocation.

`dev:desktop:trace` performs the same development launch, enables the main-process Inspector, and explicitly enables bounded Electron content tracing.

The existing `dev:desktop` behavior remains unchanged.

## Configuration

The developer workflow supports these environment variables:

```text
WEMAIL_INSPECT_PORT=9229
WEMAIL_TRACE_DURATION_MS=30000
WEMAIL_TRACE_OUTPUT_DIR=workspace/reports/performance
```

Defaults are:

- Inspector port: `9229`.
- Trace duration: 30 seconds.
- Trace output directory: `workspace/reports/performance` under the repository root.

An invalid Inspector port should cause the launcher to use the documented default or fail with a clear launcher error before spawning Electron. An invalid trace duration should fall back to 30 seconds and emit a configuration warning. The trace output directory is resolved to an absolute path before being passed to Electron.

## Architecture

### Development launcher

Extend `scripts/launch-desktop-dev.mjs` with developer-only wrapper arguments or equivalent dedicated launch modes. The launcher is responsible for:

- translating the profiling mode into Electron command-line switches and environment variables;
- adding `--inspect=<port>` for profile and trace modes;
- setting an explicit `WEMAIL_DEV_TRACE=1` guard for trace mode;
- resolving the trace output directory;
- preserving the existing renderer URL and desktop launch behavior;
- not changing the ordinary development or packaged launch paths.

The wrapper-specific arguments must not be forwarded to the WeMail application as unknown Electron arguments.

### Main-process trace controller

Add a focused Electron main-process module responsible for content tracing. It owns:

- parsing the trace duration and output configuration;
- checking the development-only guard;
- starting `contentTracing` after Electron is ready;
- selecting the Electron, Node, V8, Blink, compositor/GPU, and top-level task categories needed for performance diagnosis;
- enabling sampling in the trace options;
- stopping after the configured duration;
- flushing an active recording during application shutdown;
- generating a filesystem-safe timestamped output filename;
- reporting success, warnings, and failures with a stable `[performance-trace]` prefix.

The controller exposes a small lifecycle-oriented interface so its behavior can be tested without booting the full application.

### Application integration

`electron/main/app.ts` activates the trace controller only when both conditions are true:

```text
app.isPackaged === false
WEMAIL_DEV_TRACE === "1"
```

The ordinary developer launch, tests, and packaged application do not start a trace timer or write trace files. The packaged application exposes no menu, IPC method, HTTP route, or command that can activate profiling.

The profiling implementation may be present in compiled desktop output, but it remains unreachable in packaged execution because activation requires both the non-packaged runtime and the explicit developer environment guard.

## Data Flow

### CPU profile

```text
npm run dev:desktop:profile
  -> desktop launcher adds --inspect=<port>
  -> Electron main exposes the V8 Inspector
  -> developer connects through chrome://inspect
  -> developer records the relevant interaction
  -> Chrome saves a .cpuprofile
  -> developer opens the profile in Chrome DevTools or Speedscope
```

CPU profile capture remains manual so the developer can surround an exact reproduction window without adding a Chrome DevTools Protocol automation dependency.

### Electron trace

```text
npm run dev:desktop:trace
  -> launcher sets WEMAIL_DEV_TRACE=1 and trace configuration
  -> Electron reaches app ready
  -> trace controller starts contentTracing
  -> WeMail runs normally during the bounded capture window
  -> timer or application shutdown stops and flushes the trace
  -> timestamped JSON is written under the configured report directory
  -> developer opens the trace in Perfetto or Chrome Trace Viewer
```

Example output:

```text
workspace/reports/performance/
  wemail-electron-trace-2026-07-28T16-45-30.json
```

## Trace Configuration

The capture should include relevant categories for:

- Electron main and child process activity;
- Node and V8 execution;
- Chromium top-level tasks;
- Blink renderer work;
- compositor and GPU work;
- CPU sampling where supported by the Electron runtime.

The implementation should use Electron's supported `contentTracing` API and `enable-sampling` trace option. It should avoid an unrestricted `*` capture when a focused category set provides enough diagnostic value, because unrestricted traces grow quickly and are harder to inspect.

Category selection should tolerate Electron version differences. Unsupported or absent categories must not prevent the application from launching; the controller may inspect available categories or use a conservative supported category filter.

## Error Handling

- Missing output directory: create it recursively before stopping the trace.
- Invalid duration: warn and use 30 seconds.
- Invalid output path: report the error and continue running WeMail without tracing.
- Duplicate start request: do not start a second recording; emit a warning.
- `contentTracing.startRecording` failure: report the failure and leave the application running.
- `contentTracing.stopRecording` or file flush failure: report the failure without crashing the application.
- Application exit during capture: attempt a single stop and flush operation.
- Shutdown flush takes too long: enforce a short bounded wait so profiling cannot indefinitely block application exit.
- Inspector port conflict: surface Electron's Inspector error in the development terminal. No automatic port scanning is required in the first version.

## Security and Privacy

Profiling is restricted to local development execution. Packaged builds do not activate it.

Trace and profile files may contain local paths, URLs, function names, process metadata, and timing information. Developer documentation must state that these files can contain sensitive development context and must not be committed or attached to public issues without inspection.

The default report directory should be ignored by Git if it is not already covered by repository ignore rules.

## Testing

Add focused tests covering:

- default Inspector port and trace duration;
- valid environment overrides;
- invalid port and duration handling;
- absolute output directory resolution;
- filesystem-safe timestamped filenames;
- packaged-mode disablement;
- explicit developer guard requirement;
- start followed by timed stop;
- shutdown flush while recording;
- duplicate start protection;
- start and stop failure degradation.

Use dependency injection or a small adapter so tests can mock Electron `contentTracing`, timers, filesystem operations, and logging.

Verification should include:

```text
npm run typecheck:desktop
```

and the focused Electron main-process tests. A manual acceptance run should confirm that:

1. `dev:desktop:profile` exposes the main process in `chrome://inspect`.
2. A saved `.cpuprofile` opens in Speedscope.
3. `dev:desktop:trace` writes a non-empty timestamped JSON trace.
4. The trace opens in Perfetto and contains Electron process and task tracks.
5. The ordinary `dev:desktop` command creates no profiling output.
6. A packaged build starts without profiling flags, timers, or trace output.

## Documentation

Add a developer guide describing:

- when to use a CPU profile versus an Electron trace;
- how to launch each mode;
- how to attach Chrome to the Electron main process;
- how to record and save a `.cpuprofile`;
- how to inspect profiles with Speedscope;
- how to open Electron traces in Perfetto;
- how to override the Inspector port, duration, and output directory;
- how to capture only the reproduction window needed for a performance issue;
- why generated artifacts must be reviewed before sharing and must not be committed.

## Success Criteria

The design is complete when a WeMail developer can launch the existing desktop development application with one npm command, record a main-process CPU flame profile, or automatically capture a bounded multi-process Electron trace, while the normal development command and packaged application remain unchanged.
