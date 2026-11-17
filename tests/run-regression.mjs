#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// One-command regression runner:
//   node tests/run-regression.mjs            # hermetic E2E + live UI packs
//   node tests/run-regression.mjs --hermetic # hermetic suite only
//   node tests/run-regression.mjs --live     # live UI packs only
//
// Hermetic: Playwright Electron suite against the repo's own dist-electron
// build (build it first with `npm run build:desktop` / build:desktop:main:quick).
// Live: agent-desktop UI packs against the running logged-in desktop
// instance (requires `agent-desktop` on PATH and WeMail running).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const args = process.argv.slice(2);
const mode = args.includes("--live") ? "live" : args.includes("--hermetic") ? "hermetic" : "all";

let failed = 0;
const started = Date.now();

if (mode === "hermetic" || mode === "all") {
  console.log("=== hermetic E2E suite (Playwright Electron, mocked upstreams) ===");
  const pw = spawnSync("node", ["node_modules/playwright/cli.js", "test"], {
    cwd: repo,
    stdio: "inherit",
    timeout: 45 * 60_000,
  });
  if (pw.status !== 0) failed++;
}

if (mode === "live" || mode === "all") {
  console.log("=== live UI packs (agent-desktop, running logged-in instance) ===");
  const packs = [
    "01-list-detail-navigation.mjs",
    "02-mail-detail.mjs",
    "03-settings-navigation.mjs",
    "04-centers-navigation.mjs",
    "05-notifications-todos.mjs",
  ];
  for (const pack of packs) {
    console.log(`--- live/ui/${pack}`);
    const res = spawnSync(process.execPath, [path.join(here, "live", "ui", pack)], {
      cwd: repo,
      stdio: "inherit",
      timeout: 15 * 60_000,
    });
    if (res.status !== 0) failed++;
  }
}

const minutes = ((Date.now() - started) / 60_000).toFixed(1);
console.log(failed === 0
  ? `\nREGRESSION PASS (${minutes} min)`
  : `\nREGRESSION FAIL — ${failed} suite(s) failed (${minutes} min)`);
process.exit(failed === 0 ? 0 : 1);
