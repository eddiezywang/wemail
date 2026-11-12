import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopProfileLaunch } from "./desktop-profile-options.mjs";
import "./ensure-wemail-electron-exe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Dev Electron launches a single script from dist-electron/electron/main, so
// app.getAppPath() points there (and app.isPackaged may be true), which makes
// the edition loader's cwd fallback unavailable. Mirror the generated
// edition config next to the appPath so both dev and packaged-style launches
// resolve the same edition instead of silently falling back to open defaults.
const editionSource = path.join(root, "build", "edition", "edition-runtime.json");
if (fs.existsSync(editionSource)) {
  const editionTarget = path.join(
    root, "dist-electron", "electron", "main", "build", "edition", "edition-runtime.json",
  );
  fs.mkdirSync(path.dirname(editionTarget), { recursive: true });
  fs.copyFileSync(editionSource, editionTarget);
}
const debugMode = process.argv.includes("--wemail-debug-mode");
const electronArgs = process.argv.slice(2).filter((arg) => arg !== "--wemail-debug-mode");
const launch = resolveDesktopProfileLaunch(electronArgs, process.env, root);
const command =
  process.platform === "win32"
    ? path.join(root, "node_modules", "electron", "dist", "WeMailDesktop.exe")
    : path.join(root, "node_modules", ".bin", "electron");
const rendererUrl =
  process.env.VITE_DEV_SERVER_URL?.trim() || "http://127.0.0.1:5173";

const child = spawn(
  command,
  [
    ...launch.electronArgs,
    "--js-flags=--max-old-space-size=112",
    `--wemail-renderer-url=${rendererUrl}`,
  ],
  {
    cwd: root,
    env: {
      ...launch.childEnv,
      ...(debugMode ? { WEMAIL_DEBUG_MODE: "1" } : {}),
      VITE_DEV_SERVER_URL: rendererUrl,
    },
    stdio: "inherit",
    windowsHide: false,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
