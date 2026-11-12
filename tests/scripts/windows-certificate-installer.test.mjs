import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("ships a click-to-run certificate installer in the Windows install root", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const builderConfig = require("../../electron-builder.config.cjs");

  const expectedExtraFile = {
    from: "packaging/windows/install-wemail-certificate.cmd",
    to: "install-wemail-certificate.cmd",
  };

  assert.deepEqual(packageJson.build.extraFiles, [expectedExtraFile]);
  assert.deepEqual(builderConfig.extraFiles, [expectedExtraFile]);
  assert.equal(
    fs.existsSync(path.resolve(expectedExtraFile.from)),
    true,
  );
});

test("certificate installer entrypoint delegates to bundled update-trust script", () => {
  const command = fs.readFileSync(
    "packaging/windows/install-wemail-certificate.cmd",
    "utf8",
  );

  assert.match(command, /resources\\assets\\update-trust\\install-wemail-test-certificate\.ps1/);
  assert.match(command, /WeMailDesktop\.exe/);
  assert.match(command, /WeMail\.exe/);
  assert.match(command, /ExecutionPolicy Bypass/);
});

test("custom win-unpacked packaging copies and verifies the root installer script", () => {
  const script = fs.readFileSync("scripts/package-desktop-win-dir.mjs", "utf8");

  assert.match(script, /packaging", "windows", "install-wemail-certificate\.cmd"/);
  assert.match(script, /fs\.copyFileSync\(certificateInstallerPath,path\.join\(outDir,"install-wemail-certificate\.cmd"\)\)/);
  assert.match(script, /path\.join\(outDir,"install-wemail-certificate\.cmd"\)/);
});

test("NSIS install hook trusts the actual packaged desktop executable", () => {
  const hook = fs.readFileSync(
    "packaging/nsis/install-update-trust.nsh",
    "utf8",
  );

  assert.match(hook, /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/);
  assert.doesNotMatch(hook, /\$INSTDIR\\WeMailDesktop\.exe/);
  assert.doesNotMatch(hook, /\$INSTDIR\\WeMail\.exe/);
});

test("PowerShell trust installer can locate current and legacy executable names", () => {
  const script = fs.readFileSync(
    "electron/assets/update-trust/install-wemail-test-certificate.ps1",
    "utf8",
  );

  assert.match(script, /WeMailDesktop\.exe/);
  assert.match(script, /WeMail\.exe/);
  assert.match(script, /certutil -user -addstore -f Root/);
  assert.match(script, /certutil -user -addstore -f TrustedPublisher/);
});
