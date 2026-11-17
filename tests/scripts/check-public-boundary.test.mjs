/**
 * Regression coverage for scripts/check-public-boundary.mjs.
 *
 * The gate runs against throwaway git repositories, so every fixture is
 * fully synthetic. Deny tokens are assembled from fragments at runtime:
 * this source file never contains a real internal identifier.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const gate = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-public-boundary.mjs",
);

// Fragment-built placeholders matching the org-name and private-ip rules.
const ORG_TOKEN = ["web", "ank"].join("");
const ORG_TOKEN_ZH = ["微众", "银行"].join("");
const IP_TOKEN = ["10.", "1.2.3"].join("");

function runGate(files, untracked = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-boundary-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (contents && !Buffer.isBuffer(contents) && typeof contents === "object" && "symlink" in contents) {
        fs.symlinkSync(contents.symlink, destination);
      } else {
        fs.writeFileSync(destination, contents);
      }
    }
    const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
    // -f: global excludes must not make a fixture invisible to git ls-files.
    const add = spawnSync("git", ["add", "-f", "-A"], { cwd: dir, encoding: "utf8" });
    assert.equal(add.status, 0, `git add failed: ${add.stderr}`);
    for (const [relativePath, contents] of Object.entries(untracked)) {
      const destination = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents);
    }
    return spawnSync(process.execPath, [gate], { cwd: dir, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertCleanPass(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 files \/ 0 hits/);
}

function assertHit(result, fileName, rule) {
  assert.equal(result.status, 1, `expected gate failure for ${fileName}`);
  assert.match(result.stderr, /Public-repo boundary check FAILED/);
  assert.ok(
    result.stderr.includes(fileName),
    `expected ${fileName} in gate output:\n${result.stderr}`,
  );
  if (rule) assert.ok(result.stderr.includes(rule), `expected rule ${rule} in:\n${result.stderr}`);
}

test("clean text tree passes with zero files and zero hits", () => {
  assertCleanPass(
    runGate({
      "docs/notes.txt": "neutral placeholder text\n",
      RUNBOOK: "neutral runbook\n",
    }),
  );
});

test("a .log file containing an internal identifier must be caught", () => {
  const result = runGate({
    "runtime/audit.log": `run 1 actor=${ORG_TOKEN}\n`,
  });
  assertHit(result, "runtime/audit.log", "org-name");
});

test("a Chinese organization name in a public document must be caught", () => {
  assertHit(runGate({ "docs/support.md": `Example: ${ORG_TOKEN_ZH}\n` }), "docs/support.md", "org-name-zh");
});

test(".py and .patch files are no longer skipped", () => {
  const result = runGate({
    "tools/probe.py": `token = "${ORG_TOKEN}"\n`,
    "patches/fix.patch": `+addr = "${IP_TOKEN}"\n`,
  });
  assert.equal(result.status, 1);
  assertHit(result, "tools/probe.py", "org-name");
  assert.ok(result.stderr.includes("patches/fix.patch"), result.stderr);
  assert.ok(result.stderr.includes("private-ip"), result.stderr);
});

test("all three IPv4 private address ranges are scanned", () => {
  for (const address of [IP_TOKEN, ["172.", "16.2.3"].join(""), ["192.", "168.2.3"].join("")]) {
    assertHit(runGate({ "config.txt": `host=${address}\n` }), "config.txt", "private-ip");
  }
});

test("extensionless files and .env* variants are scanned", () => {
  const result = runGate({
    RUNBOOK: `owner: ${ORG_TOKEN}\n`,
    ".env.production": `HOST=${IP_TOKEN}\n`,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("RUNBOOK"), result.stderr);
  assert.ok(result.stderr.includes(".env.production"), result.stderr);
});

test("binary files carrying deny bytes are skipped by the NUL heuristic", () => {
  assertCleanPass(
    runGate({
      "assets/blob.bin": Buffer.concat([
        Buffer.from(ORG_TOKEN),
        Buffer.from([0]),
        Buffer.from(IP_TOKEN),
      ]),
    }),
  );
});

test("sensitive names in text and binary file paths are checked", () => {
  assertHit(runGate({ [`docs/${ORG_TOKEN}/guide.md`]: "neutral content" }), `docs/${ORG_TOKEN}/guide.md`, "org-name");
  assertHit(runGate({ [`assets/${ORG_TOKEN_ZH}.png`]: Buffer.from([0, 1, 2]) }), `assets/${ORG_TOKEN_ZH}.png`, "org-name-zh");
});

test("symbolic link targets are scanned without following them", { skip: process.platform === "win32" }, () => {
  assertHit(runGate({ "docs/link": { symlink: `/missing/${ORG_TOKEN}/private` } }), "docs/link", "org-name");
  assertCleanPass(runGate({ "docs/link": { symlink: "/missing/neutral" } }));
});

test("lockfile integrity digests are masked at any depth", () => {
  assertCleanPass(
    runGate({
      "bun.lock": `sha512-abc${ORG_TOKEN}123==\n`,
      "nested/package-lock.json": `{ "integrity": "sha256-abc${ORG_TOKEN}123=" }\n`,
    }),
  );
});

test("lockfile registry URLs are still scanned", () => {
  assertHit(runGate({ "nested/package-lock.json": `{ "resolved": "https://${ORG_TOKEN}.example/pkg" }\n` }), "nested/package-lock.json", "org-name");
});

test("non-ignored untracked files are scanned before staging", () => {
  assertHit(runGate({ "tracked.txt": "safe\n" }, { "new/notes.txt": ORG_TOKEN }), "new/notes.txt", "org-name");
});

test("the gate and its baseline remain the only path exemptions", () => {
  assertCleanPass(
    runGate({
      "scripts/check-public-boundary.mjs": ORG_TOKEN,
      "scripts/public-boundary-baseline.json": `{ "note": "${IP_TOKEN}" }\n`,
    }),
  );
});
