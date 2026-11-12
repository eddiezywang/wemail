#!/usr/bin/env node
/**
 * Public-repo boundary gate.
 *
 * Fails when internal identifiers (org names, internal hostnames, private
 * network addresses, banned upstream names) appear in tracked files, or
 * when their count GROWS beyond the committed baseline. The baseline is a
 * ratchet: extraction phases (internal modules moving to the private
 * overlay repo) may only shrink it. Regenerate deliberately with
 * `--update-baseline` and review the diff — never to silence a new hit.
 *
 * Scope: EVERY git-tracked file is a scan candidate. There is no text
 * extension whitelist, so .log/.py/.patch/.nsh, extensionless files and
 * .env* variants are covered too. Binaries are skipped with a NUL-byte
 * heuristic. The only exemptions are lockfile basenames (base64 integrity
 * hashes randomly contain deny substrings), the gate itself and its
 * baseline — no deny rule is relaxed and no new exemption is introduced.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const DENY_PATTERNS = [
  { name: "org-name", pattern: /webank/gi },
  { name: "internal-host", pattern: /weoa\.com/gi },
  { name: "internal-registry", pattern: /wnpm/gi },
  { name: "internal-brand", pattern: /rcrai/gi },
  { name: "banned-upstream-name", pattern: /filomail/gi },
  { name: "internal-ip", pattern: /\b134\.175\.165\.190\b/g },
  {
    name: "private-ip",
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
];

/** Skipped by basename at any depth — base64 integrity hashes inside
 *  lockfiles can coincidentally contain deny substrings. */
const SKIPPED_BASENAMES = new Set([
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** The gate must not scan itself: its own pattern definitions and the
 *  baseline's file-path keys legitimately contain the deny strings. */
const SKIPPED_FILES = new Set([
  "scripts/check-public-boundary.mjs",
  "scripts/public-boundary-baseline.json",
]);

/** `.env*` variants (`.env.production`, `.env.local.example`, ...) have no
 *  usable extension; recognise them explicitly instead of relying on any
 *  extension list. */
const ENV_FILE_PATTERN = /^\.env/i;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean);
}

/** Only the committed exemptions remove a tracked file from the scan. */
function isScannable(file) {
  if (SKIPPED_FILES.has(file)) return false;
  if (SKIPPED_BASENAMES.has(path.basename(file))) return false;
  return true;
}

/** NUL-byte heuristic skips binaries (images, fonts, certs, installers);
 *  `.env*` variants are explicitly classified as text and always scanned. */
function isTextFile(file, buffer) {
  if (ENV_FILE_PATTERN.test(path.basename(file))) return true;
  return !buffer.includes(0);
}

function countMatches(source) {
  const hits = [];
  for (const rule of DENY_PATTERNS) {
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      hits.push({ line, rule: rule.name, text: match[0] });
    }
  }
  return hits;
}

const baselinePath = path.join(root, "scripts", "public-boundary-baseline.json");
const updateBaseline = process.argv.includes("--update-baseline");
const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : {};

const actual = {};
const violations = [];
let totalHits = 0;
let totalFiles = 0;

for (const file of trackedFiles()) {
  if (!isScannable(file)) continue;
  // A tracked candidate that cannot be read is a gate failure, not a
  // zero-hit pass — silently skipping it would let an unreadable (e.g.
  // deleted-but-still-tracked or locked) file dodge the scan.
  const buffer = fs.readFileSync(path.join(root, file));
  if (!isTextFile(file, buffer)) continue;
  const hits = countMatches(buffer.toString("utf8"));
  if (hits.length === 0) continue;
  actual[file] = hits.length;
  totalFiles += 1;
  totalHits += hits.length;
  const allowed = baseline[file] ?? 0;
  if (hits.length > allowed) {
    const sample = hits
      .slice(allowed)
      .slice(0, 5)
      .map((h) => `  ${file}:${h.line} [${h.rule}] ${h.text}`)
      .join("\n");
    violations.push(
      `${file}: ${hits.length} hits > baseline ${allowed}\n${sample}`,
    );
  }
}

if (updateBaseline) {
  fs.writeFileSync(baselinePath, JSON.stringify(actual, null, 2) + "\n");
  console.log(
    `public-boundary baseline updated: ${totalFiles} files, ${totalHits} hits. ` +
      "Review the diff — growth must be justified or reverted.",
  );
  process.exit(0);
}

if (violations.length > 0) {
  console.error(
    "Public-repo boundary check FAILED — internal identifiers grew or appeared in new files:\n" +
      violations.join("\n") +
      "\nIf this is intentional (it should not be for a public baseline), regenerate with " +
      "`node scripts/check-public-boundary.mjs --update-baseline` and justify it in the PR.",
  );
  process.exit(1);
}

const baselineTotal = Object.values(baseline).reduce((sum, n) => sum + n, 0);
console.log(
  `Public-repo boundary check passed. ${totalFiles} files / ${totalHits} hits ` +
    `(baseline ${baselineTotal}; ratchet only shrinks).`,
);
