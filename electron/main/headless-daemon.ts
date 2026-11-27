import { app } from "electron";
import {
  startHeadlessMcp,
  type HeadlessMcpHandle,
} from "../../server/wemail/headless/mcp-main.js";

/** True when this process was launched as the persistent MCP daemon
 *  (`WeMail.exe --mcp-daemon`). Checked before any GUI bootstrap so the
 *  daemon never takes the single-instance lock or creates windows — daemon
 *  and GUI coexist as two processes of the same exe sharing one data dir
 *  (dbx-style: dropboxd + GUI view). */
export function isHeadlessDaemonArgv(argv: string[] = process.argv): boolean {
  return argv.includes("--mcp-daemon");
}

/** Run the headless MCP server in this process until killed.
 *  Exit codes: 0 = clean shutdown, 1 = could not start (MCP disabled in
 *  settings, emergency disable, or the port is taken by another daemon). */
export async function runHeadlessDaemon(dataDir: string): Promise<never> {
  let handle: HeadlessMcpHandle | null = null;
  let exiting = false;
  const shutdown = async (signal: string, code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    console.log(JSON.stringify({ phase: "wemail-daemon-shutdown", signal }));
    try {
      await handle?.close();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  app.on("will-quit", (event) => {
    // Electron-side quit (rare in daemon mode: no windows) goes through the
    // same close path instead of dying with open sqlite handles.
    event.preventDefault();
    void shutdown("will-quit", 0);
  });
  try {
    handle = await startHeadlessMcp({ dataDir });
  } catch (error) {
    console.error(
      JSON.stringify({ phase: "wemail-daemon-start-failed", error: String(error) }),
    );
    process.exit(1);
  }
  if (!handle.endpoint) {
    console.error(
      "wemail-daemon: listener did not start — MCP disabled in settings, emergency disable set, or the configured port is already served by another daemon.",
    );
    await handle.close();
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      phase: "wemail-daemon-listening",
      endpoint: handle.endpoint,
      pid: process.pid,
    }),
  );
  // Electron stays alive with zero windows; nothing else to await.
  return new Promise<never>(() => {});
}
