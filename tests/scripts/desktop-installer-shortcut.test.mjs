import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const builderConfig = require(path.join(root, "packaging/electron-builder.config.cjs"));
const installerInclude = fs.readFileSync(
  path.join(root, "packaging", "nsis", "install-update-trust.nsh"),
  "utf8",
);

test("0.2.3 assisted installer lets the user choose a branded desktop shortcut", () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(builderConfig.nsis.oneClick, false);
  assert.equal(builderConfig.nsis.createDesktopShortcut, false);
  assert.equal(builderConfig.nsis.shortcutName, "WeMail");
  assert.equal(builderConfig.win.icon, "packaging/icon.ico");
  assert.equal(builderConfig.nsis.installerIcon, "packaging/icon.ico");
  assert.equal(builderConfig.nsis.uninstallerIcon, "packaging/icon.ico");
  assert.equal(builderConfig.nsis.installerHeaderIcon, "packaging/icon.ico");

  assert.match(installerInclude, /创建桌面快捷方式/);
  assert.match(installerInclude, /\$WeMailCreateDesktopShortcut == \$\{BST_CHECKED\}/);
  assert.match(installerInclude, /CreateShortCut[^\n]+\$\{APP_EXECUTABLE_FILENAME\}/);
  assert.match(installerInclude, /resources\\assets\\wemail\.ico/);
  assert.match(installerInclude, /Delete "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"/);
});
