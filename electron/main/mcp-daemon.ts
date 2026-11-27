import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isWemailDaemonServing } from "../../server/wemail/mcp/daemonProbe.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything the GUI needs to probe/spawn/stop the persistent daemon. */
export interface DaemonControl {
  /** Fresh data dir (the app resolves it lazily at boot). */
  dataDir: () => string;
  /** Fresh bearer token for probes (null = MCP has no usable token yet). */
  fetchToken: () => string | null;
  /** Fresh MCP port (reads shared DB — never caches a stale value). */
  getPort: () => number;
}

export interface DaemonOrchestration {
  ensure: () => Promise<boolean>;
  stop: () => boolean;
  restart: () => Promise<boolean>;
}

async function daemonAlive(control: DaemonControl): Promise<boolean> {
  return isWemailDaemonServing({
    port: control.getPort(),
    fetchToken: control.fetchToken,
  });
}

/** Spawn `--mcp-daemon` (same exe, detached — it must outlive the GUI) and
 *  wait until it actually serves. False = it died or never started listening;
 *  the caller falls back to a self-hosted listener. */
async function ensureDaemon(control: DaemonControl): Promise<boolean> {
  if (await daemonAlive(control)) return true;
  const child = spawn(
    process.execPath,
    app.isPackaged
      ? ["--mcp-daemon"]
      : [app.getAppPath(), "--mcp-daemon"],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  child.on("error", () => {}); // the daemon logs its own failures
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(500);
    if (await daemonAlive(control)) return true;
    if (child.exitCode != null) return false;
  }
  return false;
}

/** Kill the daemon via its pidfile — works across GUI sessions. Returns
 *  whether a daemon was found and signalled. */
function stopDaemon(control: DaemonControl): boolean {
  const pidFile = path.join(control.dataDir(), "mcp-daemon.pid");
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return false; // no pidfile: no daemon to stop
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
  } catch {
    // already gone — fall through to pidfile cleanup
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // pidfile already removed by the daemon's own shutdown
  }
  return true;
}

/** Settings changed (or migration finished): daemon must reload — kill and
 *  respawn so it picks up the new port/settings from the shared database. */
async function restartDaemon(control: DaemonControl): Promise<boolean> {
  stopDaemon(control);
  await sleep(300); // let the port actually release
  return ensureDaemon(control);
}

export function createDaemonOrchestration(control: DaemonControl): DaemonOrchestration {
  return {
    ensure: () => ensureDaemon(control),
    stop: () => stopDaemon(control),
    restart: () => restartDaemon(control),
  };
}
