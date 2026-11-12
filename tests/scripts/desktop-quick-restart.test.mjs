import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyRestartSnapshot,
  ensureNativeBindingReleased,
  isRepositoryDesktopProcess,
  isRepositoryQuickRendererProcess,
  resolveQuickLaunch,
  resolveWeComReconnectCooldown,
  waitForRepositoryProcessesToExit,
} from "../../scripts/restart-desktop-quick.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const desktopExecutable = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  "WeMailDesktop.exe",
);

test("desktop:restart delegates to the guarded restart script", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["desktop:restart"],
    "node scripts/restart-desktop-quick.mjs",
  );
});

test("restart matches only this repository branded executable", () => {
  assert.equal(
    isRepositoryDesktopProcess(
      { executablePath: desktopExecutable.toUpperCase() },
      desktopExecutable,
    ),
    true,
  );
  assert.equal(
    isRepositoryDesktopProcess(
      { executablePath: "C:\\ProgramData\\Tencent\\WeMail\\WeMailDesktop.exe" },
      desktopExecutable,
    ),
    false,
  );
});

test("restart selects the complete repository development Electron tree", () => {
  const appPath = path.join(root, "dist-electron", "electron", "main");
  const classified = classifyRestartSnapshot(
    {
      desktopProcesses: [
        {
          processId: 20,
          parentProcessId: 1,
          executablePath: "E:\\electron-cache\\electron.exe",
          commandLine: "electron.exe --no-sandbox dist-electron/electron/main/app.js",
        },
        {
          processId: 21,
          parentProcessId: 20,
          executablePath: "E:\\electron-cache\\electron.exe",
          commandLine: `electron.exe --type=renderer --app-path="${appPath}"`,
        },
        {
          processId: 22,
          parentProcessId: 20,
          executablePath: "E:\\electron-cache\\electron.exe",
          commandLine: "electron.exe --type=utility",
        },
        {
          processId: 30,
          parentProcessId: 1,
          executablePath: "C:\\other\\electron.exe",
          commandLine: "electron.exe C:\\other\\app.js",
        },
      ],
      listeners: [],
    },
    { projectRoot: root, desktopExecutable },
  );

  assert.deepEqual(
    classified.desktopProcesses.map((processInfo) => processInfo.processId),
    [20, 21, 22],
  );
});

test("restart recognizes only the repository quick renderer", () => {
  assert.equal(
    isRepositoryQuickRendererProcess(
      {
        commandLine: `node ${root}\\node_modules\\vite\\bin\\vite.js --config vite.desktop-quick.config.ts`,
      },
      root,
    ),
    true,
  );
  assert.equal(
    isRepositoryQuickRendererProcess(
      {
        commandLine:
          `node C:\\Users\\dev\\.codex\\skills\\wemail-desktop-build\\scripts\\serve-built-renderer.mjs ` +
          `--root ${root} --port 5173`,
      },
      root,
    ),
    true,
  );
  assert.equal(
    isRepositoryQuickRendererProcess(
      {
        commandLine:
          `node "${root}\\node_modules\\.bin\\\\..\\@react-router\\dev\\bin.js" ` +
          "dev --port 5173 --strictPort",
      },
      root,
    ),
    true,
  );
  assert.equal(
    isRepositoryQuickRendererProcess(
      { commandLine: "node C:\\other\\vite.js --port 5173" },
      root,
    ),
    false,
  );
});

test("restart classifies unrelated port owners without selecting them", () => {
  const classified = classifyRestartSnapshot(
    {
      desktopProcesses: [
        { processId: 10, executablePath: desktopExecutable },
        {
          processId: 11,
          executablePath: "C:\\ProgramData\\Tencent\\WeMail\\WeMailDesktop.exe",
        },
      ],
      listeners: [
        { processId: 12, commandLine: "node C:\\other\\server.js" },
      ],
    },
    { projectRoot: root, desktopExecutable },
  );

  assert.deepEqual(classified.desktopProcesses.map((processInfo) => processInfo.processId), [10]);
  assert.equal(classified.repositoryListeners.length, 0);
  assert.deepEqual(classified.unexpectedListeners.map((processInfo) => processInfo.processId), [12]);
});

test("restart waits until repository processes release their resources", async () => {
  let calls = 0;
  await waitForRepositoryProcessesToExit({
    projectRoot: root,
    desktopExecutable,
    pollMs: 1,
    timeoutMs: 100,
    snapshot: () => {
      calls += 1;
      if (calls === 1) {
        return {
          desktopProcesses: [{ processId: 10, executablePath: desktopExecutable }],
          listeners: [],
        };
      }
      return { desktopProcesses: [], listeners: [] };
    },
  });
  assert.equal(calls, 2);
});

test("restart rejects an unrelated owner of port 5173", async () => {
  await assert.rejects(
    waitForRepositoryProcessesToExit({
      projectRoot: root,
      desktopExecutable,
      snapshot: () => ({
        desktopProcesses: [],
        listeners: [{ processId: 99, commandLine: "node C:\\other\\server.js" }],
      }),
    }),
    /Port 5173 belongs to a process outside this repository.*PID 99/,
  );
});

test("restart retries locked native bindings and launches desktop:quick", async () => {
  let calls = 0;
  const result = await ensureNativeBindingReleased({
    pollMs: 1,
    timeoutMs: 100,
    ensure: () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      return { rebuilt: false };
    },
  });
  assert.deepEqual(result, { rebuilt: false });
  assert.equal(calls, 2);
  assert.deepEqual(resolveQuickLaunch("win32", { ComSpec: "cmd.exe" }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm run desktop:quick"],
  });
});

test("restart uses a longer cooldown after a forced shutdown", () => {
  assert.equal(resolveWeComReconnectCooldown(false), 8_000);
  assert.equal(resolveWeComReconnectCooldown(true), 15_000);
});
