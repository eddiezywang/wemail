#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");
const viteConfig = path.join(root, "vite.desktop-quick.config.ts");

const child = spawn(
  process.execPath,
  [
    viteEntry,
    "--config",
    viteConfig,
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
