#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getWindowsTestCertificatePaths,
  loadWindowsTestSigningConfig,
} from "./windows-test-certificate.mjs";

export function loadWindowsSelfSignedBuildEnvironment({
  root = process.cwd(),
  env = process.env,
} = {}) {
  const paths = getWindowsTestCertificatePaths(root);
  if (
    !fs.existsSync(paths.config) ||
    !fs.existsSync(paths.privateCertificate) ||
    !fs.existsSync(paths.publicCertificate)
  ) {
    throw new Error(
      "Windows test-signing files are missing; run npm run certificate:windows:test or retrieve the shared PFX through the team secret store.",
    );
  }
  const config = loadWindowsTestSigningConfig({ root });
  const publicCertificate = new crypto.X509Certificate(
    fs.readFileSync(paths.publicCertificate),
  );
  return {
    CSC_LINK: config.pfxPath,
    CSC_KEY_PASSWORD: config.password,
    WEMAIL_WINDOWS_PUBLISHER: config.publisherName,
    WEMAIL_UPDATE_BASE_URL:
      env.WEMAIL_UPDATE_BASE_URL ?? "https://updates.example.com/downloads/",
    WEMAIL_UPDATE_FALLBACK_BASE_URL:
      env.WEMAIL_UPDATE_FALLBACK_BASE_URL ??
      "https://updates.example.com/downloads/",
    WEMAIL_SELF_SIGN_AFTER_PACK: "1",
    WEMAIL_SIGNING_THUMBPRINT: publicCertificate.fingerprint.replaceAll(":", ""),
  };
}

function findWindowsSigntool() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "electron-builder",
    "Cache",
    "winCodeSign",
  );
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;

  const queue = [cacheRoot];
  const candidates = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (
        entry.name.toLowerCase() === "signtool.exe" &&
        fullPath.toLowerCase().includes(`${path.sep}windows-10${path.sep}x64${path.sep}`)
      ) {
        candidates.push(fullPath);
      }
    }
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

/**
 * Locate rcedit-x64.exe shipped with the winCodeSign toolset. The `rcedit.exe`
 * vendored inside electron-winstaller is an old build that cannot commit
 * combined icon + version-string edits on the raw Electron 41 executable
 * ("Fatal error: Unable to commit changes"), so prefer the toolset copy.
 */
function findWindowsRcedit() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "electron-builder",
    "Cache",
    "winCodeSign",
  );
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;
  const queue = [cacheRoot];
  const candidates = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.name.toLowerCase() === "rcedit-x64.exe") {
        candidates.push(fullPath);
      }
    }
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function findWindowsNsisResources() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "electron-builder",
    "Cache",
    "nsis",
  );
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;

  const queue = [cacheRoot];
  const candidates = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const plugin = path.join(current, "plugins", "x86-unicode", "StdUtils.dll");
    if (fs.existsSync(plugin)) candidates.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "plugins") {
        queue.push(path.join(current, entry.name));
      }
    }
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function resolveTsxCli(root) {
  return path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

export function runWindowsSelfSignedBuild({
  root = process.cwd(),
  platform = process.platform,
  noCompress = false,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  if (platform !== "win32") {
    throw new Error(
      "Self-signed Windows release packaging must run on a native Windows host.",
    );
  }
  const signingEnvironment = loadWindowsSelfSignedBuildEnvironment({ root });
  const signtool = findWindowsSigntool();
  const rcedit = findWindowsRcedit();
  const nsisResources = findWindowsNsisResources();
  const PATH = signtool
    ? `${path.dirname(signtool)}${path.delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH;

  log("[windows-self-signed] starting signed internal-test release build");
  log(`[windows-self-signed] nsis compression: ${noCompress ? "store (fast, no LZMA)" : "normal"}`);
  log(`[windows-self-signed] update base: ${signingEnvironment.WEMAIL_UPDATE_BASE_URL}`);
  log(`[windows-self-signed] rcedit: ${rcedit ?? "(none — falling back)"}`);
  const result = spawn(process.execPath, [
    resolveTsxCli(root),
    path.join(root, "scripts", "package-release.mjs"),
    "win32",
    "x64",
  ], {
    cwd: root,
    env: {
      ...process.env,
      ...signingEnvironment,
      PATH,
      ...(noCompress ? { WEMAIL_NSIS_COMPRESSION: "store" } : {}),
      ...(rcedit ? { WEMAIL_RCEDIT_PATH: rcedit } : {}),
      ...(nsisResources
        ? { ELECTRON_BUILDER_NSIS_RESOURCES_DIR: nsisResources }
        : {}),
    },
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`Windows package build could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Windows package build failed with exit ${result.status ?? 1}`);
  }
  return result;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  runWindowsSelfSignedBuild({ root, noCompress: process.argv.includes("--no-compress") });
}
