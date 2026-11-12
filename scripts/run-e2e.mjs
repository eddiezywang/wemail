#!/usr/bin/env node
// Skips the E2E run when the Electron binary is not installed (common in
// locked-down networks where postinstall can't reach github releases).
// Run `node node_modules/electron/install.js` once connectivity is available.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const bin = "node_modules/electron/dist/electron";
if (!fs.existsSync(bin) && !fs.existsSync(bin + ".exe")) {
  console.log(
    "[skip] test:e2e — electron binary not installed. " +
      "Run: node node_modules/electron/install.js",
  );
  process.exit(0);
}

const forwardedArgs = process.argv.slice(2);
const skipBuildIndex = forwardedArgs.indexOf("--skip-build");
const skipBuild = skipBuildIndex >= 0;
if (skipBuild) forwardedArgs.splice(skipBuildIndex, 1);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

function rebuildBetterSqliteForElectron() {
  console.log("[e2e] rebuilding better-sqlite3 for Electron runtime");
  return run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["rebuild", "better-sqlite3"],
    {
      shell: process.platform === "win32",
      env: {
        ...process.env,
        npm_config_runtime: "electron",
        npm_config_target: "41.3.0",
        npm_config_disturl: "https://electronjs.org/headers",
      },
    },
  );
}

function rebuildBetterSqliteForNode() {
  console.log("[e2e] restoring better-sqlite3 for Node runtime");
  const env = { ...process.env };
  delete env.npm_config_runtime;
  delete env.npm_config_target;
  delete env.npm_config_disturl;
  return run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["rebuild", "better-sqlite3"],
    {
      shell: process.platform === "win32",
      env,
    },
  );
}

if (!skipBuild) {
  console.log("[e2e] building production renderer and Electron main");
  const build = run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:desktop"], {
    shell: process.platform === "win32",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const electronRebuild = rebuildBetterSqliteForElectron();
if (electronRebuild.status !== 0) {
  process.exit(electronRebuild.status ?? 1);
}

const result = run(process.execPath, [
  path.join("node_modules", "playwright", "cli.js"),
  "test",
  ...forwardedArgs,
]);

const nodeRebuild = rebuildBetterSqliteForNode();
process.exit(result.status ?? nodeRebuild.status ?? 1);
