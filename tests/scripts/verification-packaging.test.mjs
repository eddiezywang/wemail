import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isProductionBuildInput } from "../../scripts/desktop-build-inputs.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("production Electron compilation excludes tests", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "electron/tsconfig.build.json"), "utf8"));
  assert.ok(config.exclude.some((entry) => entry.includes("*.test.ts")));
  assert.match(packageJson.scripts["build:desktop"], /tsconfig\.build\.json/);
  assert.match(packageJson.scripts["build:desktop"], /clean-desktop-output\.mjs/);
});

test("desktop build cleans both outputs before the renderer build", () => {
  // A partial/interrupted `react-router build` cannot empty outDir by itself,
  // so the next build would crash on a missing client manifest. The clean must
  // run before the renderer build, not after it.
  const desktop = packageJson.scripts["build:desktop"];
  assert.ok(desktop.startsWith("node scripts/check-production-login-env.mjs"));
  assert.ok(desktop.indexOf("check-production-login-env.mjs") < desktop.indexOf("clean-desktop-output.mjs"));
  assert.ok(desktop.indexOf("clean-desktop-output.mjs") < desktop.indexOf("npm run build:renderer"));
  const cleaner = fs.readFileSync(path.join(root, "scripts/clean-desktop-output.mjs"), "utf8");
  assert.match(cleaner, /"dist-electron"/);
  assert.match(cleaner, /"build"/);
});

test("test-only files do not invalidate production build inputs", () => {
  assert.equal(isProductionBuildInput(root, path.join(root, "app/a.test.tsx")), false);
  assert.equal(isProductionBuildInput(root, path.join(root, "tests/e2e/a.spec.ts")), false);
  assert.equal(isProductionBuildInput(root, path.join(root, "app/a.tsx")), true);
});

test("package and release scripts declare reusable and platform-specific paths", () => {
  assert.match(packageJson.scripts["package:desktop:unpacked:from-build"], /--skip-build/);
  assert.match(packageJson.scripts["package:desktop:dir"], /package:desktop:unpacked/);
  assert.ok(packageJson.scripts["package:release:windows"]);
  assert.ok(packageJson.scripts["package:release:mac:x64"]);
  assert.ok(packageJson.scripts["package:release:mac:arm64"]);
  assert.match(fs.readFileSync(path.join(root, "scripts/ship.mjs"), "utf8"), /package:release:windows/);
  const release = fs.readFileSync(path.join(root, "scripts/package-release.mjs"), "utf8");
  assert.ok(release.indexOf('"scripts/check-production-login-env.mjs"') < release.indexOf("fs.rmSync(outputDirectory"));
  assert.match(release, /scripts\/write-edition-config\.ts/);
});

test("Windows Docker packaging builds the renderer only through build:desktop", () => {
  const script = fs.readFileSync(path.join(root, "scripts/build-windows.sh"), "utf8");
  assert.equal((script.match(/npm run build:renderer/g) ?? []).length, 0);
  assert.equal((script.match(/npm run build:desktop/g) ?? []).length, 1);
  assert.match(script, /--mount type=volume,destination=\/app\/node_modules,volume-nocopy/);
  assert.match(script, /bun install --frozen-lockfile/);
  assert.doesNotMatch(script, /npm ci/);
});

test("packaged app keeps the root #edition-modules binding and verifies its target", () => {
  const script = fs.readFileSync(path.join(root, "scripts/package-desktop-win-dir.mjs"), "utf8");
  // An open cold build has no dist-electron/package.json, so resources/app is
  // the only package scope that can bind #edition-modules to the NO_OP stub.
  assert.match(script, /if \(pkg\.imports\) appManifest\.imports=pkg\.imports/);
  assert.match(script, /missing #edition-modules binding/);
  assert.match(script, /#edition-modules target is not packaged/);
  // Edition builds add a nearer dist-electron scope; verify both scopes.
  assert.match(script, /assertImportTarget\(nearerManifest\)/);
});

test("CI exposes a verification gate and release jobs depend on it", () => {
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(root, ".github/workflows/release-desktop.yml"), "utf8");
  assert.match(ci, /verification-gate:/);
  assert.match(ci, /server unit \(\$\{\{ matrix\.shard \}\}\)/);
  assert.match(ci, /vitest \$\{\{ matrix\.project \}\}/);
  assert.match(release, /verify-green-commit:/);
  assert.match(release, /release-gate-policy\.mjs/);
});
