#!/usr/bin/env node

/**
 * Wrapper script for browser E2E tests that sets environment variables
 * before launching Playwright. This ensures browsers are installed on
 * the D: drive (not the space-constrained C: drive) and temp files
 * also go to D:.
 *
 * Usage:
 *   node scripts/run-browser-tests.mjs           # run all
 *   node scripts/run-browser-tests.mjs --headed  # headed mode
 *   node scripts/run-browser-tests.mjs --ui      # Playwright UI
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Set environment variables before spawning Playwright
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(projectRoot, ".playwright-browsers");
process.env.TEMP = resolve(projectRoot, ".tmp");
process.env.TMP = resolve(projectRoot, ".tmp");

const rawArgs = process.argv.slice(2);
const skipBuildIndex = rawArgs.indexOf("--skip-build");
const skipBuild = skipBuildIndex >= 0;
if (skipBuild) rawArgs.splice(skipBuildIndex, 1);

if (!skipBuild) {
  console.log("[run-browser-tests] Building production renderer...\n");
  const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:renderer"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const playwrightCli = resolve(projectRoot, "node_modules", "playwright", "cli.js");
const args = [playwrightCli, "test", "--config", "playwright.browser.config.ts", ...rawArgs];
console.log(`[run-browser-tests] PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
console.log(`[run-browser-tests] TEMP=${process.env.TEMP}`);
console.log(`[run-browser-tests] Running Playwright with config playwright.browser.config.ts\n`);

try {
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch (e) {
  // execSync throws on non-zero exit; we already printed the output
  process.exitCode = 1;
}
