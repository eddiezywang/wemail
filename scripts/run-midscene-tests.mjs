#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(projectRoot, ".playwright-browsers");
process.env.TEMP = resolve(projectRoot, ".tmp");
process.env.TMP = process.env.TEMP;

const args = process.argv.slice(2);
const skipBuildIndex = args.indexOf("--skip-build");
const skipBuild = skipBuildIndex >= 0;
if (skipBuild) args.splice(skipBuildIndex, 1);

if (!skipBuild) {
  const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:renderer"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  [resolve(projectRoot, "node_modules", "playwright", "cli.js"), "test", "--config", "playwright.midscene.config.ts", ...args],
  { cwd: projectRoot, stdio: "inherit", env: process.env },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
