#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-nsis-preflight-"));
const appDirectory = path.join(temporaryRoot, "app");
const outputDirectory = path.join(temporaryRoot, "out");

try {
  fs.mkdirSync(path.join(appDirectory, "resources"), { recursive: true });
  fs.copyFileSync(
    path.join(process.env.SystemRoot, "System32", "where.exe"),
    path.join(appDirectory, "WeMail.exe"),
  );
  fs.writeFileSync(
    path.join(appDirectory, "package.json"),
    JSON.stringify({ name: "wemail-installer-preflight", version: "0.0.0" }),
  );

  const result = spawnSync(
    process.execPath,
    [
      "node_modules/electron-builder/cli.js",
      "--config",
      "packaging/electron-builder.config.cjs",
      "--config.compression=store",
      "--publish",
      "never",
      "--prepackaged",
      appDirectory,
      "--win",
      "nsis",
      "--x64",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        CSC_KEY_PASSWORD: "",
        CSC_LINK: "",
        WEMAIL_RELEASE_BUILD: "0",
        WEMAIL_RELEASE_OUTPUT_DIR: outputDirectory,
        WEMAIL_SELF_SIGN_AFTER_PACK: "0",
      },
      shell: false,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`Windows installer compile preflight failed with exit ${result.status ?? 1}`);
  }
  console.log("[release] Windows installer compile preflight passed");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
