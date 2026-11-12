import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test(
  "importing the Windows executable preparation script continues on non-Windows platforms",
  { skip: process.platform === "win32" },
  () => {
    const script = path.resolve("scripts/ensure-wemail-electron-exe.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(script)}); process.stdout.write("continued\\n");`,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /continued/);
  },
);
