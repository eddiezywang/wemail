#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getAbi } from "node-abi";
import { ensureDesktopBuildCacheRoot } from "./desktop-build-cache.mjs";

const MODULE_NAME = "better-sqlite3";
const SOURCE_BINDING_NAME = "better_sqlite3.node";
const CACHE_BINDING_NAME = "better-sqlite3.node";

export function getBindingCachePath({
  cacheRoot,
  moduleVersion,
  platform,
  arch,
  abi,
}) {
  return path.join(
    cacheRoot,
    "native-bindings",
    MODULE_NAME,
    moduleVersion,
    `${platform}-${arch}-${abi}`,
    CACHE_BINDING_NAME,
  );
}

export function buildElectronRebuildArgs(electronVersion) {
  return [
    "node_modules/@electron/rebuild/lib/cli.js",
    "--version",
    electronVersion,
    "--module-dir",
    ".",
    "--only",
    MODULE_NAME,
    "--force",
  ];
}

export function installElectronBinding({ cachePath, runtimePath }) {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.copyFileSync(cachePath, runtimePath);
  return runtimePath;
}

function readPackageJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getInstalledElectronVersion(root) {
  const electronPackagePath = path.join(
    root,
    "node_modules",
    "electron",
    "package.json",
  );
  return readPackageJson(electronPackagePath).version;
}

function getInstalledModuleVersion(root) {
  return readPackageJson(path.join(root, "node_modules", MODULE_NAME, "package.json")).version;
}

function getBuildBindingPath(root) {
  return path.join(
    root,
    "node_modules",
    MODULE_NAME,
    "build",
    "Release",
    SOURCE_BINDING_NAME,
  );
}

function copyFileIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function tryRestoreNodeBinding({ backupPath, buildBindingPath, log, error }) {
  try {
    fs.copyFileSync(backupPath, buildBindingPath);
    log(`[native-bindings] restored Node binding at ${buildBindingPath}`);
  } catch (restoreErr) {
    error(
      "[native-bindings] could not restore the Node binding. " +
        "Close any running WeMail dev servers and run `npm rebuild better-sqlite3`.\n" +
        String(restoreErr),
    );
  }
}

export function ensureElectronNativeBindings({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  log = console.log,
  error = console.error,
} = {}) {
  const electronVersion = getInstalledElectronVersion(root);
  const moduleVersion = getInstalledModuleVersion(root);
  const electronAbi = getAbi(electronVersion, "electron");
  const cacheRoot = ensureDesktopBuildCacheRoot({ root, platform });
  const cachePath = getBindingCachePath({
    cacheRoot,
    moduleVersion,
    platform,
    arch,
    abi: electronAbi,
  });

  const legacy = path.join(root, "node_modules", MODULE_NAME, "bin", `${platform}-${arch}-${electronAbi}`, CACHE_BINDING_NAME);
  if (!fs.existsSync(cachePath) && copyFileIfExists(legacy, cachePath)) log(`[native-bindings] imported ${cachePath}`);

  if (fs.existsSync(cachePath)) {
    installElectronBinding({ cachePath, runtimePath: legacy });
    log(`[native-bindings] restored Electron binding at ${legacy}`);
    log(`[native-bindings] ${MODULE_NAME} Electron ABI ${electronAbi} is ready.`);
    return { rebuilt: false, cachePath, electronVersion, electronAbi };
  }

  const buildBindingPath = getBuildBindingPath(root);
  const nativeTempRoot = path.join(cacheRoot, "temp");
  fs.mkdirSync(nativeTempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(nativeTempRoot, "wemail-native-"));
  const backupPath = path.join(tempDir, SOURCE_BINDING_NAME);
  const hadNodeBinding = copyFileIfExists(buildBindingPath, backupPath);

  log(
    `[native-bindings] rebuilding ${MODULE_NAME} for Electron ${electronVersion} ` +
      `(ABI ${electronAbi})...`,
  );

  const rebuild = spawnSync(process.execPath, buildElectronRebuildArgs(electronVersion), {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, TEMP: nativeTempRoot, TMP: nativeTempRoot, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/" },
  });

  try {
    if (rebuild.status !== 0) {
      error(`[native-bindings] electron rebuild failed with exit ${rebuild.status ?? 1}.`);
      return {
        rebuilt: false,
        cachePath,
        electronVersion,
        electronAbi,
        status: rebuild.status ?? 1,
      };
    }

    if (!fs.existsSync(buildBindingPath)) {
      throw new Error(`Expected rebuilt binding at ${buildBindingPath}`);
    }

    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.copyFileSync(buildBindingPath, cachePath);
    installElectronBinding({ cachePath, runtimePath: legacy });
    log(`[native-bindings] cached Electron binding at ${cachePath}`);

    return { rebuilt: true, cachePath, electronVersion, electronAbi, status: 0 };
  } finally {
    if (hadNodeBinding) {
      tryRestoreNodeBinding({ backupPath, buildBindingPath, log, error });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const result = ensureElectronNativeBindings();
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
