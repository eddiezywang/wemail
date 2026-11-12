// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Adds the `./dist/*` export-map entry to @earendil-works/pi-coding-agent so
// WeMail can import Skill-protocol submodules directly (e.g.
// `.../dist/core/skills.js`) instead of the package barrel. The barrel pulls
// the full agent SDK — pi-ai LLM clients, pi-tui, image processing — into the
// desktop main process, which measurably raises resident memory (~45MB in
// local measurement). The pi-coding-agent package itself does not export its
// dist subpaths, so we patch its package.json exports on install.
//
// Runs via the `postinstall` script; idempotent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const EXPORT_KEY = "./dist/*";
const EXPORT_ENTRY = { types: "./dist/*", import: "./dist/*" };

const rootDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(
  rootDir,
  "node_modules",
  PACKAGE_NAME,
  "package.json",
);

if (!fs.existsSync(packageJsonPath)) {
  console.warn(`[patch-pi-skill-exports] ${PACKAGE_NAME} not found, skipping`);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const exportsMap = pkg.exports ?? {};

if (
  exportsMap[EXPORT_KEY] &&
  JSON.stringify(exportsMap[EXPORT_KEY]) === JSON.stringify(EXPORT_ENTRY)
) {
  console.log("[patch-pi-skill-exports] already patched");
  process.exit(0);
}

if (!exportsMap[EXPORT_KEY]) {
  exportsMap[EXPORT_KEY] = EXPORT_ENTRY;
} else {
  // Keep an existing (possibly newer upstream) entry, but make sure the
  // import condition is present. Prefer not to clobber upstream changes.
  exportsMap[EXPORT_KEY] = { ...EXPORT_ENTRY, ...exportsMap[EXPORT_KEY] };
}

pkg.exports = exportsMap;
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`[patch-pi-skill-exports] patched ${PACKAGE_NAME} exports`);
