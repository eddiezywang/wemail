import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const helper = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/production-login-env.mjs")).href;
const loginKeys = ["VITE_DEV_EMAIL", "VITE_DEV_DISPLAY_NAME", "VITE_DEV_PASSWORD", "VITE_DEV_AUTOLOGIN"];

function check(root, overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of loginKeys) if (!(key in overrides)) delete env[key];
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { assertProductionLoginEnv } from ${JSON.stringify(helper)}; assertProductionLoginEnv("production", process.cwd());`], { cwd: root, env, encoding: "utf8" });
}

test("production login preflight checks environment and local files without printing values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-env-check-"));
  try {
    assert.equal(check(dir).status, 0);
    fs.writeFileSync(path.join(dir, ".env.production.local"), "VITE_DEV_PASSWORD=fixture-secret\n");
    const fromFile = check(dir);
    assert.notEqual(fromFile.status, 0);
    assert.match(fromFile.stderr, /VITE_DEV_PASSWORD/);
    assert.doesNotMatch(fromFile.stderr, /fixture-secret/);
    fs.unlinkSync(path.join(dir, ".env.production.local"));
    const fromProcess = check(dir, { VITE_DEV_AUTOLOGIN: "1" });
    assert.notEqual(fromProcess.status, 0);
    assert.match(fromProcess.stderr, /VITE_DEV_AUTOLOGIN/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
