import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as executableBranding from "../../scripts/windows-executable-branding.mjs";
import {
  brandWindowsExecutable,
  buildRceditArgs,
} from "../../scripts/windows-executable-branding.mjs";

test("uses a desktop executable name that does not collide with Tencent WeMail", () => {
  assert.equal(
    executableBranding.getDesktopExecutableName?.(),
    "WeMailDesktop.exe",
  );
});

test("builds WeMail executable branding arguments", () => {
  assert.deepEqual(
    buildRceditArgs({
      executablePath: "D:\\WeMail\\WeMail.exe",
      iconPath: "D:\\WeMail\\wemail.ico",
      internalName: "WeMail",
      originalFilename: "WeMail.exe",
      version: "0.2.2",
    }),
    [
        "D:\\WeMail\\WeMail.exe",
        "--set-icon",
        "D:\\WeMail\\wemail.ico",
        "--set-version-string",
        "FileDescription",
        "WeMail",
        "--set-version-string",
        "ProductName",
        "WeMail",
        "--set-version-string",
        "InternalName",
        "WeMail",
        "--set-version-string",
        "OriginalFilename",
        "WeMail.exe",
        "--set-file-version",
        "0.2.2",
        "--set-product-version",
        "0.2.2",
    ],
  );
});

test("brands once and reuses a matching branding marker", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-branding-"));
  try {
    const executablePath = path.join(tempDir, "WeMail.exe");
    const iconPath = path.join(tempDir, "wemail.ico");
    const rceditPath = path.join(tempDir, "rcedit.exe");
    fs.writeFileSync(executablePath, "electron executable");
    fs.writeFileSync(iconPath, "wemail icon");
    fs.writeFileSync(rceditPath, "resource editor");
    const calls = [];
    const spawnSyncImpl = (...args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };

    const first = brandWindowsExecutable({
      executablePath,
      iconPath,
      rceditPath,
      platform: "win32",
      spawnSyncImpl,
    });
    const second = brandWindowsExecutable({
      executablePath,
      iconPath,
      rceditPath,
      platform: "win32",
      spawnSyncImpl,
    });

    assert.equal(first.branded, true);
    assert.equal(second.branded, false);
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(first.markerPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("skips Windows executable branding on other platforms", () => {
  const result = brandWindowsExecutable({
    executablePath: "missing",
    iconPath: "missing",
    rceditPath: "missing",
    platform: "darwin",
  });

  assert.deepEqual(result, {
    branded: false,
    skipped: true,
    markerPath: "missing.wemail-branding.json",
  });
});
