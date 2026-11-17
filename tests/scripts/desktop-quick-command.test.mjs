import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("desktop:quick uses HMR, incremental main compilation, and branded launch", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const scripts = packageJson.scripts;

  assert.match(scripts["build:desktop:main:quick"], /--incremental/);
  assert.match(scripts["build:desktop:main:quick"], /electron\/tsconfig\.build\.json/);
  assert.match(scripts["desktop:quick"], /dev:renderer:quick/);
  assert.match(scripts["desktop:quick"], /build:desktop:main:quick/);
  assert.doesNotMatch(scripts["desktop:quick"], /build:desktop(?:\s|$)/);
  assert.doesNotMatch(scripts["desktop:quick"], /package:desktop/);
  // Telemetry is startup-configured, not baked by a build-time writer.
  assert.doesNotMatch(scripts["desktop:quick:main"], /write-telemetry-config\.mjs/);
  assert.match(scripts["desktop:quick:main"], /launch-desktop-dev\.mjs/);
  assert.match(scripts["desktop:quick:main"], /127\.0\.0\.1:5173/);
  assert.equal(
    scripts["dev:renderer:quick"],
    "node scripts/start-desktop-quick-renderer.mjs",
  );
});

test("quick renderer launcher gives Vite an absolute repository identity", () => {
  const launcher = fs.readFileSync(
    path.join(root, "scripts", "start-desktop-quick-renderer.mjs"),
    "utf8",
  );

  assert.match(launcher, /path\.join\(root, "node_modules", "vite", "bin", "vite\.js"\)/);
  assert.match(launcher, /path\.join\(root, "vite\.desktop-quick\.config\.ts"\)/);
  assert.match(launcher, /"127\.0\.0\.1"/);
  assert.match(launcher, /"5173"/);
});

test("quick renderer uses an isolated client-only Vite entry with HMR", () => {
  const quickRendererConfig = fs.readFileSync(
    path.join(root, "vite.desktop-quick.config.ts"),
    "utf8",
  );
  const quickRendererEntry = fs.readFileSync(
    path.join(root, "desktop-quick", "main.tsx"),
    "utf8",
  );

  assert.doesNotMatch(quickRendererConfig, /reactRouter\(\)/);
  assert.match(quickRendererConfig, /desktop-quick/);
  assert.match(quickRendererConfig, /react\(\)/);
  assert.match(quickRendererConfig, /tailwindcss\(\)/);
  assert.match(quickRendererEntry, /createBrowserRouter/);
  assert.match(quickRendererEntry, /import\("~\/routes\/inbox"\)/);
  assert.match(quickRendererEntry, /RouterProvider/);
});

test("quick renderer route imports stay aligned with the production route config", () => {
  const productionRoutes = fs.readFileSync(
    path.join(root, "app", "routes.ts"),
    "utf8",
  );
  const quickRendererEntry = fs.readFileSync(
    path.join(root, "desktop-quick", "main.tsx"),
    "utf8",
  );
  // workbench-layout is the production layout wrapper; the quick entry
  // renders its own shell, so only leaf route modules must stay aligned.
  const productionModules = [
    ...productionRoutes.matchAll(/"routes\/([^\"]+)\.tsx"/g),
  ]
    .map((match) => match[1])
    .filter((name) => name !== "workbench-layout");
  const quickModules = [
    ...quickRendererEntry.matchAll(/import\("~\/routes\/([^\"]+)"\)/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(quickModules)].sort(),
    [...new Set(productionModules)].sort(),
  );
});

test("desktop dev launcher defaults to the stable loopback renderer URL", () => {
  const launcher = fs.readFileSync(
    path.join(root, "scripts", "launch-desktop-dev.mjs"),
    "utf8",
  );

  assert.match(launcher, /WeMailDesktop\.exe/);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:5173/);
  assert.doesNotMatch(launcher, /http:\/\/localhost:5173/);
});
