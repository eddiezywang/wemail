import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const builderConfig = fs.readFileSync(path.join(root, "electron-builder.config.cjs"), "utf8");
const legacyConfig = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const desktopPackaging = fs.readFileSync(path.join(root, "scripts/package-desktop-win-dir.mjs"), "utf8");

test("all Electron Builder configs use the canonical versioned artifact name", () => {
  const artifactName = "${productName}-${version}-${arch}.${ext}";
  assert.equal(packageJson.build.artifactName, artifactName);
  // Release config appends an optional -fast suffix for store-compressed
  // test builds; both variants stay on the canonical versioned base name.
  assert.match(
    builderConfig,
    /artifactName: "\$\{productName\}-\$\{version\}-\$\{arch\}"(?: \+ artifactSuffix)? \+ "\.\$\{ext\}"/,
  );
  assert.match(legacyConfig, /artifactName: "\$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}"/);
});

test("desktop packaging exposes descriptive commands and canonical installer output", () => {
  assert.equal(packageJson.scripts["package:desktop"], "npm run package:desktop:unpacked");
  assert.equal(packageJson.scripts["package:desktop:unpacked"], "node scripts/package-desktop-win-dir.mjs");
  assert.match(desktopPackaging, /const artifactName = `WeMail-\$\{pkg\.version\}-x64`/);
  assert.doesNotMatch(desktopPackaging, /WeMail Setup \$\{pkg\.version\}\.exe/);
});

test("release output directories remain separated from the local desktop output", () => {
  const release = fs.readFileSync(path.join(root, "scripts/package-release.mjs"), "utf8");
  assert.match(release, /release-\$\{platform\}-\$\{arch\}/);
  assert.match(release, /"update-feed"/);
  assert.match(release, /platformDirectory = platform === "win32" \? "windows" : "mac"/);
});
