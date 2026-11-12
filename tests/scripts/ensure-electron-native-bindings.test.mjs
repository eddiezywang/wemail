import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildElectronRebuildArgs,
  getBindingCachePath,
  installElectronBinding,
} from "../../scripts/ensure-electron-native-bindings.mjs";

test("computes an Electron ABI-specific better-sqlite3 cache path", () => {
  const cachePath = getBindingCachePath({
    cacheRoot: "E:\\wemail-build-cache",
    moduleVersion: "12.9.0",
    platform: "win32",
    arch: "x64",
    abi: "145",
  });

  assert.equal(
    cachePath,
    path.join(
      "E:\\wemail-build-cache",
      "native-bindings",
      "better-sqlite3",
      "12.9.0",
      "win32-x64-145",
      "better-sqlite3.node",
    ),
  );
});

test("builds a scoped electron-rebuild command for better-sqlite3", () => {
  assert.deepEqual(buildElectronRebuildArgs("41.3.0"), [
    "node_modules/@electron/rebuild/lib/cli.js",
    "--version",
    "41.3.0",
    "--module-dir",
    ".",
    "--only",
    "better-sqlite3",
    "--force",
  ]);
});

test("installs the cached Electron binding into the runtime lookup path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electron-binding-"));
  try {
    const cachePath = path.join(root, "cache", "better-sqlite3.node");
    const runtimePath = path.join(
      root,
      "node_modules",
      "better-sqlite3",
      "bin",
      "darwin-arm64-145",
      "better-sqlite3.node",
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "electron-binding");

    installElectronBinding({ cachePath, runtimePath });

    assert.equal(fs.readFileSync(runtimePath, "utf8"), "electron-binding");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
