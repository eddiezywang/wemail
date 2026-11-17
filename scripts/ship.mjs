#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFullCiRun, selectReleaseGate } from "./release-gate-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) {
    throw new Error(`[ship] ${command} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  return result.stdout.trim();
}

const command = process.platform === "win32"
  ? "package:release:windows"
  : process.platform === "darwin" && process.arch === "arm64"
    ? "package:release:mac:arm64"
    : process.platform === "darwin"
      ? "package:release:mac:x64"
      : null;

if (!command) throw new Error(`Release packaging is unsupported on ${process.platform}-${process.arch}`);

if (readCommand("git", ["status", "--porcelain", "--untracked-files=normal"])) {
  throw new Error("[ship] Refusing to package an uncommitted working tree; commit or clean changes first.");
}
const commit = readCommand("git", ["rev-parse", "HEAD"]);
const repository = JSON.parse(readCommand("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error("[ship] Could not identify the GitHub repository.");
}
const pages = JSON.parse(readCommand("gh", ["api", "--paginate", "--slurp", `repos/${repository}/commits/${commit}/check-runs?per_page=100`]));
const runId = selectReleaseGate(pages, commit);
const workflow = JSON.parse(readCommand("gh", ["api", `repos/${repository}/actions/runs/${runId}`]));
assertFullCiRun(workflow, commit);

console.log(`[ship] release packaging via npm run ${command}`);
const result = spawnSync(
  process.platform === "win32" ? "cmd.exe" : "npm",
  process.platform === "win32" ? ["/d", "/s", "/c", `npm run ${command}`] : ["run", command],
  { cwd: root, stdio: "inherit", shell: false },
);
process.exit(result.status ?? 1);
