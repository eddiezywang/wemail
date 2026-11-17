#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertNoUnexpectedListeners,
  classifyRestartSnapshot,
  readRestartSnapshot,
  stopValidatedProcesses,
  waitForRepositoryProcessesToExit,
} from "./restart-desktop-quick.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const preserveMailboxSecrets = args.includes("--preserve-mailbox-secrets");
const dataDir = resolveDataDir(argument("--data-dir"));
const databaseFiles = [
  "wemail.sqlite",
  "wemail.sqlite-wal",
  "wemail.sqlite-shm",
];
const databaseBackupDirectories = ["backups"];
const blobDirectories = [
  "blobs",
  "blobs-v2",
  "mail-blobs",
  "mail-attachment-cache",
];
const targets = [
  ...databaseFiles.map((name) => path.join(dataDir, name)),
  ...databaseBackupDirectories.map((name) => path.join(dataDir, name)),
  ...blobDirectories.map((name) => path.join(dataDir, name)),
];

if (process.platform !== "win32") {
  throw new Error("reset:demo-data currently supports Windows only");
}
assertSafeDataDir(dataDir);
for (const target of targets) assertDirectChild(dataDir, target);

console.log("[reset-demo-data] DESTRUCTIVE demo reset");
console.log(`[reset-demo-data] data directory: ${dataDir}`);
for (const target of targets) console.log(`[reset-demo-data] target: ${target}`);
console.log(`[reset-demo-data] mailbox secret entries: ${path.join(dataDir, "secrets")}`);

if (!confirmed) {
  console.log("[reset-demo-data] preview only; rerun with --yes to stop WeMail and delete these demo targets");
  process.exit(2);
}

const snapshot = classifyRestartSnapshot(readRestartSnapshot(), { projectRoot: root });
assertNoUnexpectedListeners(snapshot);
stopValidatedProcesses([
  ...snapshot.desktopProcesses,
  ...snapshot.repositoryListeners,
]);
await waitForRepositoryProcessesToExit({ projectRoot: root });

for (const fileName of databaseFiles) {
  removeFile(path.join(dataDir, fileName));
}
for (const directoryName of databaseBackupDirectories) {
  removeDirectory(path.join(dataDir, directoryName));
}
for (const directoryName of blobDirectories) {
  removeDirectory(path.join(dataDir, directoryName));
}
if (!preserveMailboxSecrets) {
  removeMailboxSecrets(path.join(dataDir, "secrets", "encrypted-secrets.json"), false);
  removeMailboxSecrets(path.join(dataDir, "secrets", "secrets.json"), true);
} else {
  console.log("[reset-demo-data] preserving mailbox credentials");
}

console.log("[reset-demo-data] complete; the next desktop start will create the canonical wemail.sqlite");

function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function resolveDataDir(explicit) {
  const appData = process.env.APPDATA;
  const configured = explicit ?? process.env.WEMAIL_DATA_DIR;
  if (configured) return path.resolve(configured);
  if (!appData) throw new Error("APPDATA is unavailable; pass --data-dir explicitly");
  return path.resolve(appData, "wemail", "data");
}

function assertSafeDataDir(candidate) {
  const resolved = path.resolve(candidate);
  const driveRoot = path.parse(resolved).root;
  const forbidden = new Set([
    path.resolve(driveRoot),
    path.resolve(os.homedir()),
    path.resolve(root),
    path.resolve(path.dirname(root)),
  ]);
  if (forbidden.has(resolved)) {
    throw new Error(`refusing broad demo reset target: ${resolved}`);
  }
  if (resolved.length <= driveRoot.length + 8) {
    throw new Error(`demo reset data directory is too broad: ${resolved}`);
  }
}

function assertDirectChild(parent, candidate) {
  if (path.dirname(path.resolve(candidate)) !== path.resolve(parent)) {
    throw new Error(`reset target escaped data directory: ${candidate}`);
  }
}

function removeFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`expected reset file target: ${filePath}`);
  fs.rmSync(filePath, { force: false });
  console.log(`[reset-demo-data] removed file: ${filePath}`);
}

function removeDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) return;
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`expected non-symlink reset directory: ${directoryPath}`);
  }
  fs.rmSync(directoryPath, { recursive: true, force: false });
  console.log(`[reset-demo-data] removed directory: ${directoryPath}`);
}

function removeMailboxSecrets(filePath, hasHeader) {
  if (!fs.existsSync(filePath)) return;
  const original = fs.readFileSync(filePath, "utf8");
  const header = hasHeader && original.startsWith("#")
    ? `${original.slice(0, original.indexOf("\n") + 1)}`
    : "";
  const jsonText = header ? original.slice(header.length) : original;
  const parsed = JSON.parse(jsonText);
  const entries = hasHeader ? parsed : parsed.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`invalid secret envelope: ${filePath}`);
  }
  let removed = 0;
  for (const key of Object.keys(entries)) {
    if (!/^wemail:account:[^:]+:(?:imap|smtp)-password$/.test(key)) continue;
    delete entries[key];
    removed += 1;
  }
  if (removed === 0) return;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = hasHeader
    ? `${header}${JSON.stringify(parsed, null, 2)}\n`
    : `${JSON.stringify(parsed, null, 2)}\n`;
  fs.writeFileSync(temporary, serialized, { mode: 0o600 });
  replaceFile(temporary, filePath);
  console.log(`[reset-demo-data] removed ${removed} mailbox secret entr${removed === 1 ? "y" : "ies"}: ${filePath}`);
}

function replaceFile(temporary, destination) {
  if (process.platform !== "win32" || !fs.existsSync(destination)) {
    fs.renameSync(temporary, destination);
    return;
  }
  const backup = `${destination}.${process.pid}.${Date.now()}.bak`;
  fs.renameSync(destination, backup);
  try {
    fs.renameSync(temporary, destination);
    fs.rmSync(backup);
  } catch (error) {
    if (fs.existsSync(destination)) fs.rmSync(destination);
    fs.renameSync(backup, destination);
    throw error;
  }
}
