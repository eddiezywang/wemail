#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const command = process.platform === "win32"
  ? "package:release:windows"
  : process.platform === "darwin" && process.arch === "arm64"
    ? "package:release:mac:arm64"
    : process.platform === "darwin"
      ? "package:release:mac:x64"
      : null;

if (!command) throw new Error(`Release packaging is unsupported on ${process.platform}-${process.arch}`);

console.log(`[ship] release packaging via npm run ${command}`);
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", command],
  { stdio: "inherit", shell: false },
);
process.exit(result.status ?? 1);
