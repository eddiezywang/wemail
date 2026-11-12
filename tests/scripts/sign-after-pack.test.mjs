import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { signAfterPack } = require("../../workspace/sign-after-pack.cjs");

test("signs the unpacked Windows executable by current-user certificate thumbprint", async () => {
  let invocation;
  let branding;
  await signAfterPack(
    {
      appOutDir: "C:\\release\\win-unpacked",
      outDir: "C:\\release",
      packager: {
        projectDir: "C:\\source\\wemail",
        appInfo: { productFilename: "WeMail", version: "0.2.2" },
      },
    },
    {
      platform: "win32",
      env: {
        WEMAIL_SELF_SIGN_AFTER_PACK: "1",
        WEMAIL_SIGNING_THUMBPRINT: "ABC123",
        WEMAIL_RCEDIT_PATH: "C:\\tools\\rcedit-x64.exe",
      },
      brand(options) {
        branding = options;
      },
      exec(command, args, options) {
        invocation = { command, args, options };
      },
    },
  );

  assert.equal(branding.executablePath, "C:\\release\\win-unpacked\\WeMail.exe");
  assert.equal(branding.iconPath, "C:\\source\\wemail\\packaging\\icon.ico");
  assert.equal(branding.rceditPath, "C:\\tools\\rcedit-x64.exe");
  assert.equal(branding.version, "0.2.2");
  assert.equal(invocation.command, "signtool.exe");
  assert.deepEqual(invocation.args, [
    "sign",
    "/sha1",
    "ABC123",
    "/s",
    "My",
    "/fd",
    "SHA256",
    path.win32.join("C:\\release\\win-unpacked", "WeMail.exe"),
  ]);
  assert.deepEqual(invocation.options, { stdio: "inherit" });
});
