#!/usr/bin/env node
/**
 * Generate THIRD_PARTY_LICENSES.md from the committed lockfile and the
 * installed dependency manifests.
 *
 * Inputs (all local, no network, no package manager invocation):
 *   - bun.lock                        resolved package name/version pairs
 *   - package.json                    direct dependency names
 *   - installed package manifests    license / licenses metadata
 *
 * Default output covers direct dependencies plus every resolved package whose
 * declared license is not a plain MIT / Apache-2.0 / ISC / BSD-family license
 * (this includes dual/compound licenses, LGPL, MPL, CC, and packages with no
 * license field). Use --all to emit the complete resolved inventory.
 *
 * Output is byte-stable for identical inputs: LF line endings, deterministic
 * ordering, no timestamps, no absolute paths, no host-specific data.
 *
 * Usage:
 *   node scripts/generate-third-party-licenses.mjs
 *   node scripts/generate-third-party-licenses.mjs --all [--output FILE]
 *   node scripts/generate-third-party-licenses.mjs --check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(ROOT, "bun.lock");
const MANIFEST = path.join(ROOT, "package.json");
const NODE_MODULES = path.join(ROOT, "node_modules");
const DEFAULT_OUTPUT = path.join(ROOT, "licenses", "THIRD_PARTY_LICENSES.md");

const argv = process.argv.slice(2);
const all = argv.includes("--all");
const check = argv.includes("--check");
const outputIdx = argv.indexOf("--output");
const outputPath = outputIdx >= 0 && argv[outputIdx + 1]
  ? path.resolve(ROOT, argv[outputIdx + 1])
  : DEFAULT_OUTPUT;

/** bun.lock is JSON with trailing commas; strip them before JSON.parse. */
function readLock() {
  const text = fs.readFileSync(LOCK, "utf8").replace(/\r\n/g, "\n");
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

/** Map "name@version" -> { name, version } for every resolved lockfile entry. */
function resolvedPackages(lock) {
  const out = new Map();
  for (const value of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    const spec = value[0];
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    out.set(`${name}@${version}`, { name, version });
  }
  return out;
}

function directDependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

/** Collect every installed package.json that declares a name and version. */
function installedManifests() {
  const out = new Map();
  const stack = [NODE_MODULES];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const manifestPath = path.join(child, "package.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (typeof pkg.name === "string" && typeof pkg.version === "string") {
            out.set(`${pkg.name}@${pkg.version}`, {
              name: pkg.name,
              version: pkg.version,
              license: licenseOf(pkg),
              source: path.relative(ROOT, manifestPath).split(path.sep).join("/"),
            });
          }
        } catch {
          // Malformed manifests are reported as missing metadata below.
        }
      }
      stack.push(child);
    }
  }
  return out;
}

/** Normalize the legacy license / licenses shapes into one display string. */
function licenseOf(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === "object") {
    if (typeof pkg.license.type === "string" && pkg.license.type.trim()) return pkg.license.type.trim();
  }
  if (Array.isArray(pkg.licenses)) {
    const parts = pkg.licenses
      .map((entry) => (typeof entry === "string" ? entry : entry && typeof entry.type === "string" ? entry.type : ""))
      .filter(Boolean);
    if (parts.length) return parts.join(" OR ");
  }
  return "UNKNOWN (no license field)";
}

/** SPDX-ish expressions that need no further review for this inventory. */
const PERMISSIVE = new Set([
  "MIT", "MIT-0", "Apache-2.0", "ISC",
  "BSD-2-Clause", "BSD-3-Clause", "BSD-4-Clause", "0BSD",
]);

function isPermissive(license) {
  if (!license || license.startsWith("UNKNOWN")) return false;
  // Compound and dual licenses require an explicit review even when each
  // individual license is permissive; do not silently omit them.
  if (/\b(?:AND|OR|WITH)\b|\/|,/i.test(license)) return false;
  const tokens = license
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s*\/\s*|\s*,\s*/i)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => PERMISSIVE.has(token));
}

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

const lock = readLock();
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const resolved = resolvedPackages(lock);
const direct = directDependencyNames(manifest);
const installed = installedManifests();

const rows = [];
for (const [key, { name, version }] of resolved) {
  const local = installed.get(key);
  const license = local ? local.license : "UNKNOWN (not installed in this checkout)";
  const source = local ? local.source : "bun.lock (no local package.json)";
  const isDirect = direct.has(name);
  const special = !isPermissive(license);
  if (!all && !isDirect && !special) continue;
  rows.push({
    name,
    version,
    license,
    source,
    scope: isDirect && special ? "direct + special" : isDirect ? "direct" : "special",
  });
}

rows.sort((a, b) =>
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
  (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) ||
  (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
);

const specialCount = rows.filter((r) => !isPermissive(r.license)).length;
const scopeNote = all
  ? "Complete resolved inventory: every name/version pair in `bun.lock`."
  : "All direct dependencies (`dependencies` + `devDependencies` in `package.json`) plus every resolved package whose declared license is not a plain MIT / Apache-2.0 / ISC / BSD-family license, is a compound/dual license, or has no license metadata.";

const lines = [
  "# Third-Party Licenses",
  "",
  "> Generated file. Do not edit by hand.",
  ">",
  "> Regenerate: `node scripts/generate-third-party-licenses.mjs`",
  "> Full inventory: `node scripts/generate-third-party-licenses.mjs --all --output THIRD_PARTY_LICENSES.all.md`",
  "> Idempotency check: `node scripts/generate-third-party-licenses.mjs --check`",
  "",
  "## Coverage",
  "",
  scopeNote,
  "",
  `- Resolved packages in \`bun.lock\`: ${resolved.size}`,
  `- Installed manifests read from \`node_modules\`: ${installed.size}`,
  `- Rows in this file: ${rows.length}`,
  `- Rows with non-permissive, compound, dual, or missing license metadata: ${specialCount}`,
  "",
  "Inputs are `bun.lock`, `package.json`, and the `license` / `licenses` fields",
  "of installed `node_modules/**/package.json`. Generation is offline and",
  "deterministic: LF line endings, stable sort by package name / version / source,",
  "no timestamps and no absolute paths.",
  "",
  "A package marked `UNKNOWN` has no usable license field in its installed",
  "manifest (or is resolved by the lockfile but not installed in this checkout,",
  "for example platform-specific optional binaries). The `UNKNOWN` marker is a",
  "request for manual verification against the package's shipped LICENSE file",
  "and upstream source; it is not a claim that the package is unlicensed.",
  "",
  "License text and notices shipped with each package remain authoritative.",
  "See `THIRD_PARTY_NOTICES.md` for distribution-form obligations and for the",
  "bundled JetBrains Mono font license, and",
  "`electron/assets/fonts/jetbrains-mono/OFL.txt` for the OFL 1.1 text.",
  "",
  "## Packages",
  "",
  "| Name | Version | License | Source | Scope |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${cell(r.name)} | ${cell(r.version)} | ${cell(r.license)} | ${cell(r.source)} | ${cell(r.scope)} |`),
  "",
];

const content = lines.join("\n");
// `core.autocrlf` may convert the working copy to CRLF; compare on normalized
// text so a fresh checkout stays idempotent and does not produce a whole-file
// line-ending diff on regeneration.
const normalizeEol = (text) => text.replace(/\r\n/g, "\n");
const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
const unchanged = normalizeEol(existing) === content;

if (check) {
  if (unchanged) {
    console.log(`OK: ${path.relative(ROOT, outputPath)} is up to date (${rows.length} rows).`);
    process.exit(0);
  }
  console.error(`STALE: ${path.relative(ROOT, outputPath)} differs from generated output.`);
  process.exit(1);
}

if (unchanged) {
  console.log(`Unchanged: ${path.relative(ROOT, outputPath)} (${rows.length} rows).`);
} else {
  fs.writeFileSync(outputPath, content, "utf8");
  console.log(`Wrote: ${path.relative(ROOT, outputPath)} (${rows.length} rows, mode: ${all ? "all" : "default"}).`);
}
