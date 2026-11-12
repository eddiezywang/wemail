#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureElectronNativeBindings } from "./ensure-electron-native-bindings.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedDesktopExecutable = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "WeMailDesktop.exe",
);
const quickRendererMarker = "vite.desktop-quick.config.ts";
const builtRendererMarker = "serve-built-renderer.mjs";
const reactRouterDevMarker = "@react-router/dev/bin.js";
const retryableLockErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
const WECOM_GRACEFUL_RECONNECT_COOLDOWN_MS = 8_000;
const WECOM_FORCED_RECONNECT_COOLDOWN_MS = 15_000;

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeWindowsPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function isRepositoryDesktopProcess(
  processInfo,
  expectedExecutable,
  projectRoot = root,
) {
  if (
    normalizeWindowsPath(processInfo?.executablePath) ===
    normalizeWindowsPath(expectedExecutable)
  ) {
    return true;
  }
  const commandLine = normalizeWindowsPath(processInfo?.commandLine);
  const appPath = `${normalizeWindowsPath(projectRoot)}/dist-electron/electron/main`;
  return commandLine.includes(appPath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCommandArgument(commandLine, name, value) {
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(name)}(?:=|\\s+)"?${escapeRegExp(value)}"?(?=\\s|$)`,
  );
  return pattern.test(commandLine);
}

export function isRepositoryQuickRendererProcess(processInfo, projectRoot) {
  const commandLine = normalizeWindowsPath(processInfo?.commandLine);
  const normalizedRoot = normalizeWindowsPath(projectRoot);
  if (
    commandLine.includes(`${normalizedRoot}/node_modules/`) &&
    commandLine.includes(quickRendererMarker)
  ) {
    return true;
  }
  if (
    commandLine.includes(`${normalizedRoot}/node_modules/`) &&
    commandLine.includes(reactRouterDevMarker) &&
    /(?:^|\s)dev(?=\s|$)/.test(commandLine) &&
    hasCommandArgument(commandLine, "--port", "5173") &&
    /(?:^|\s)--strictport(?=\s|$)/.test(commandLine)
  ) {
    return true;
  }
  return (
    commandLine.includes(builtRendererMarker) &&
    hasCommandArgument(commandLine, "--root", normalizedRoot) &&
    hasCommandArgument(commandLine, "--port", "5173")
  );
}

export function classifyRestartSnapshot(
  snapshot,
  {
    projectRoot = root,
    desktopExecutable = expectedDesktopExecutable,
  } = {},
) {
  const allDesktopProcesses = asArray(snapshot?.desktopProcesses);
  const selectedProcessIds = new Set(
    allDesktopProcesses
      .filter((processInfo) =>
        isRepositoryDesktopProcess(processInfo, desktopExecutable, projectRoot),
      )
      .map((processInfo) => Number(processInfo.processId)),
  );
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const processInfo of allDesktopProcesses) {
      const processId = Number(processInfo.processId);
      const parentProcessId = Number(processInfo.parentProcessId);
      if (selectedProcessIds.has(processId) && !selectedProcessIds.has(parentProcessId)) {
        const parent = allDesktopProcesses.find(
          (candidate) => Number(candidate.processId) === parentProcessId,
        );
        if (parent) {
          selectedProcessIds.add(parentProcessId);
          expanded = true;
        }
      }
      if (selectedProcessIds.has(parentProcessId) && !selectedProcessIds.has(processId)) {
        selectedProcessIds.add(processId);
        expanded = true;
      }
    }
  }
  const desktopProcesses = allDesktopProcesses.filter((processInfo) =>
    selectedProcessIds.has(Number(processInfo.processId)),
  );
  const repositoryListeners = [];
  const unexpectedListeners = [];

  for (const listener of asArray(snapshot?.listeners)) {
    if (isRepositoryQuickRendererProcess(listener, projectRoot)) {
      repositoryListeners.push(listener);
    } else {
      unexpectedListeners.push(listener);
    }
  }

  return { desktopProcesses, repositoryListeners, unexpectedListeners };
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, options = {}) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      ...options,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `PowerShell process inspection failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return result.stdout.trim();
}

export function readRestartSnapshot() {
  const output = runPowerShell(`
$ErrorActionPreference = 'Stop'
$desktopProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'WeMailDesktop.exe' OR Name = 'electron.exe'" | ForEach-Object {
  [pscustomobject]@{
    processId = [int]$_.ProcessId
    parentProcessId = [int]$_.ParentProcessId
    name = $_.Name
    executablePath = $_.ExecutablePath
    commandLine = $_.CommandLine
  }
})
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue | ForEach-Object {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue
  [pscustomobject]@{
    processId = [int]$_.OwningProcess
    parentProcessId = if ($owner) { [int]$owner.ParentProcessId } else { 0 }
    name = if ($owner) { $owner.Name } else { $null }
    executablePath = if ($owner) { $owner.ExecutablePath } else { $null }
    commandLine = if ($owner) { $owner.CommandLine } else { $null }
    localAddress = $_.LocalAddress
    localPort = [int]$_.LocalPort
  }
})
[pscustomobject]@{
  desktopProcesses = $desktopProcesses
  listeners = $listeners
} | ConvertTo-Json -Depth 4 -Compress
`);
  return output ? JSON.parse(output) : { desktopProcesses: [], listeners: [] };
}

function describeProcess(processInfo) {
  return `PID ${processInfo.processId} (${processInfo.commandLine || processInfo.executablePath || processInfo.name || "unknown"})`;
}

export function assertNoUnexpectedListeners(classified) {
  if (classified.unexpectedListeners.length === 0) return;
  throw new Error(
    "Port 5173 belongs to a process outside this repository: " +
      classified.unexpectedListeners.map(describeProcess).join(", "),
  );
}

export function stopValidatedProcesses(processes) {
  const processIds = [
    ...new Set(
      processes
        .map((processInfo) => Number(processInfo.processId))
        .filter((processId) => Number.isInteger(processId) && processId > 0),
    ),
  ];
  if (processIds.length === 0) return;

  runPowerShell(
    `Stop-Process -Id ${processIds.join(",")} -Force -ErrorAction SilentlyContinue`,
  );
  console.log(`[desktop-restart] stopped repository process(es): ${processIds.join(", ")}`);
}

function extractApiPort(processes) {
  const pattern = /--wemail-api-port=(\d+)/;
  for (const processInfo of asArray(processes)) {
    const match = pattern.exec(normalizeWindowsPath(processInfo?.commandLine || ""));
    if (match) return Number(match[1]);
  }
  return null;
}

// Ask the running WeMail to shut itself down gracefully so it can close the
// WeCom long-connection cleanly (a hard kill leaves a stale connection the
// restarted process would fight → wecom-duplicate-connection). Best-effort:
// the caller falls back to Stop-Process -Force if this is unavailable, times
// out, or the port can't be discovered.
async function requestGracefulShutdown(processes) {
  const port = extractApiPort(processes);
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    console.log(`[desktop-restart] requested graceful shutdown on port ${port}`);
    return true;
  } catch {
    // Older build without the endpoint, app unresponsive, or stale port — the
    // force-kill fallback below handles it. Same trust boundary as before.
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function resolveWeComReconnectCooldown(forcedShutdown) {
  return forcedShutdown
    ? WECOM_FORCED_RECONNECT_COOLDOWN_MS
    : WECOM_GRACEFUL_RECONNECT_COOLDOWN_MS;
}

export async function waitForRepositoryProcessesToExit({
  snapshot = readRestartSnapshot,
  timeoutMs = 10_000,
  pollMs = 150,
  projectRoot = root,
  desktopExecutable = expectedDesktopExecutable,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const classified = classifyRestartSnapshot(snapshot(), {
      projectRoot,
      desktopExecutable,
    });
    assertNoUnexpectedListeners(classified);
    if (
      classified.desktopProcesses.length === 0 &&
      classified.repositoryListeners.length === 0
    ) {
      return;
    }
    await delay(pollMs);
  }
  throw new Error("Timed out waiting for repository WeMail processes and port 5173 to exit");
}

export async function ensureNativeBindingReleased({
  ensure = ensureElectronNativeBindings,
  timeoutMs = 10_000,
  pollMs = 200,
  projectRoot = root,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return ensure({ root: projectRoot });
    } catch (error) {
      if (!retryableLockErrors.has(error?.code) || Date.now() >= deadline) throw error;
      await delay(pollMs);
    }
  }
}

export function resolveQuickLaunch(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm run desktop:quick"],
    };
  }
  return { command: "npm", args: ["run", "desktop:quick"] };
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("desktop:restart currently supports Windows only");
  }

  const initial = classifyRestartSnapshot(readRestartSnapshot());
  assertNoUnexpectedListeners(initial);
  const hadRepositoryDesktopProcess = initial.desktopProcesses.length > 0;
  let forcedShutdown = hadRepositoryDesktopProcess
    ? !(await requestGracefulShutdown(initial.desktopProcesses))
    : false;
  try {
    await waitForRepositoryProcessesToExit({ timeoutMs: 8_000 });
  } catch {
    // Graceful shutdown didn't finish in time (or wasn't possible) — force
    // kill whatever is still alive and wait again.
    forcedShutdown = true;
    const remaining = classifyRestartSnapshot(readRestartSnapshot());
    stopValidatedProcesses([
      ...remaining.desktopProcesses,
      ...remaining.repositoryListeners,
    ]);
    await waitForRepositoryProcessesToExit();
  }
  await ensureNativeBindingReleased();
  if (hadRepositoryDesktopProcess) {
    const cooldownMs = resolveWeComReconnectCooldown(forcedShutdown);
    console.log(`[desktop-restart] waiting ${cooldownMs}ms for WeCom connection release`);
    await delay(cooldownMs);
  }

  const launch = resolveQuickLaunch();
  console.log("[desktop-restart] resources released; starting npm run desktop:quick");
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: { ...process.env, WEMAIL_DEBUG_MODE: "1" },
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  // The quick launcher compiles Electron TypeScript before spawning the
  // executable. On Windows cold native/TS caches and app startup can exceed
  // 60 seconds even though the app then becomes ready normally.
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const running = classifyRestartSnapshot(readRestartSnapshot());
    assertNoUnexpectedListeners(running);
    if (running.desktopProcesses.length > 0 && running.repositoryListeners.length > 0) {
      console.log("[desktop-restart] WeMail process and renderer are running");
      return;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the restarted WeMail process");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[desktop-restart] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
