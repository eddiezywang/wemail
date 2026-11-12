import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNsisInstallerSize,
  assertRuntimePackagePolicy,
  auditRuntimeDependencies,
  collectRuntimeDependencyReferences,
  extractModuleSpecifiers,
  packageNameFromSpecifier,
  productionDependencyCacheKey,
  pruneRuntimeDependencies,
} from "../../scripts/desktop-runtime-audit.mjs";

test("extracts static, dynamic, CommonJS, and scoped imports", () => {
  const source = `
    import value from "plain-package";
    export { value } from "@scope/exported/path";
    const lazy = import("dynamic-package/subpath");
    const legacy = require("commonjs-package");
  `;
  assert.deepEqual(extractModuleSpecifiers(source).sort(), [
    "@scope/exported/path",
    "commonjs-package",
    "dynamic-package/subpath",
    "plain-package",
  ]);
  assert.equal(packageNameFromSpecifier("@scope/exported/path"), "@scope/exported");
  assert.equal(packageNameFromSpecifier("plain-package/subpath"), "plain-package");
});

test("recurses through local modules and ignores builtins and electron", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-audit-"));
  try {
    fs.writeFileSync(path.join(temp, "entry.js"), 'import "./child.js"; import "node:path"; import "electron";');
    fs.writeFileSync(path.join(temp, "child.js"), 'import "@scope/runtime/subpath";');
    const result = collectRuntimeDependencyReferences([path.join(temp, "entry.js")]);
    assert.deepEqual([...result.references.keys()], ["@scope/runtime"]);
    assert.equal(result.visited.size, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("resolves #edition-modules through package-scope imports and traverses the bound target", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-hash-import-"));
  const modules = path.join(temp, "node_modules");
  try {
    // Open cold build: the only package scope is the app root, whose imports
    // map #edition-modules to the committed NO_OP stub.
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({
      name: "wemail",
      type: "module",
      imports: { "#edition-modules": "./dist-electron/server/wemail/bootstrap/editionModules.noop.js" },
    }));
    const mainDir = path.join(temp, "dist-electron", "electron", "main");
    const bootDir = path.join(temp, "dist-electron", "server", "wemail", "bootstrap");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(bootDir, { recursive: true });
    fs.mkdirSync(path.join(modules, "declared-runtime"), { recursive: true });
    fs.writeFileSync(path.join(modules, "declared-runtime", "package.json"), '{"name":"declared-runtime"}');
    fs.writeFileSync(path.join(mainDir, "app.js"), 'import "./local-api.js";');
    fs.writeFileSync(path.join(mainDir, "local-api.js"), 'import "../../server/wemail/bootstrap/AppComposition.js";');
    fs.writeFileSync(path.join(bootDir, "AppComposition.js"), 'import "#edition-modules";');
    // The resolved target has its own dependency: traversal must continue
    // into it instead of merely skipping the "#" name.
    fs.writeFileSync(path.join(bootDir, "editionModules.noop.js"), 'import "declared-runtime/helper.js";');

    const audit = auditRuntimeDependencies({
      entries: [path.join(mainDir, "app.js")],
      dependencies: { "declared-runtime": "1.0.0" },
      modulesDirectory: modules,
    });
    assert.deepEqual(audit.packages, ["declared-runtime"]);
    assert.ok(audit.files.some((file) => file.endsWith("editionModules.noop.js")), "bound target was not traversed");
    assert.ok(!audit.packages.includes("#edition-modules"), "# name was falsely reported as an npm package");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("nearer dist-electron package scope wins over the root imports map", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-nearer-scope-"));
  const modules = path.join(temp, "node_modules");
  try {
    const distElectron = path.join(temp, "dist-electron");
    const bootDir = path.join(distElectron, "server", "wemail", "bootstrap");
    const editionDir = path.join(distElectron, "edition-modules");
    const privateModules = path.join(editionDir, "node_modules");
    fs.mkdirSync(bootDir, { recursive: true });
    fs.mkdirSync(path.join(privateModules, "edition-runtime"), { recursive: true });
    // Edition modules carry their own runtime deps; they are deliberately
    // absent from the open manifest / production dependency cache.
    fs.writeFileSync(path.join(privateModules, "edition-runtime", "package.json"), '{"name":"edition-runtime"}');
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({
      name: "wemail",
      type: "module",
      imports: { "#edition-modules": "./dist-electron/server/wemail/bootstrap/editionModules.noop.js" },
    }));
    // Edition build writes a nearer scope that rebinds to its register module.
    fs.writeFileSync(path.join(distElectron, "package.json"), JSON.stringify({
      type: "module",
      imports: { "#edition-modules": "./edition-modules/register.js" },
    }));
    fs.writeFileSync(path.join(bootDir, "editionModules.js"), 'import "#edition-modules";');
    fs.writeFileSync(path.join(bootDir, "editionModules.noop.js"), 'export const EDITION_MODULES = {};');
    fs.mkdirSync(path.join(editionDir, "office-scene"), { recursive: true });
    fs.writeFileSync(path.join(editionDir, "register.js"), 'import "./office-scene/index.js"; import "edition-runtime";');
    fs.writeFileSync(path.join(editionDir, "office-scene", "index.js"), 'export const ready = true;');
    const audit = auditRuntimeDependencies({
      entries: [path.join(bootDir, "editionModules.js")],
      dependencies: {},
      modulesDirectory: modules,
    });
    assert.deepEqual(audit.packages, []);
    assert.deepEqual(audit.privatePackages, ["edition-runtime"]);
    assert.ok(audit.files.some((file) => file.endsWith("register.js")));
    assert.ok(!audit.files.some((file) => file.endsWith("editionModules.noop.js")), "nearer scope was ignored");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

/** register.js -> directory/index.js -> sm-crypto/pinyin-pro -> jsbn. */
function writeEditionChainFixture(temp, { withJsbn = true } = {}) {
  const openModules = path.join(temp, "node_modules");
  const dist = path.join(temp, "dist-electron");
  const edition = path.join(dist, "edition-modules");
  const privateModules = path.join(edition, "node_modules");
  const mainDir = path.join(dist, "electron", "main");
  const bootDir = path.join(dist, "server", "wemail", "bootstrap");
  for (const dir of [
    path.join(openModules, "declared-runtime"),
    mainDir,
    bootDir,
    path.join(edition, "directory"),
    path.join(privateModules, "sm-crypto", "src", "sm2"),
    path.join(privateModules, "pinyin-pro", "dist"),
  ]) fs.mkdirSync(dir, { recursive: true });
  if (withJsbn) fs.mkdirSync(path.join(privateModules, "jsbn"), { recursive: true });

  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({
    name: "wemail",
    type: "module",
    imports: { "#edition-modules": "./dist-electron/server/wemail/bootstrap/editionModules.noop.js" },
  }));
  // Edition build's nearer scope rebinds to the private register module.
  fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify({
    type: "module",
    imports: { "#edition-modules": "./edition-modules/register.js" },
  }));
  fs.writeFileSync(path.join(openModules, "declared-runtime", "package.json"), '{"name":"declared-runtime"}');
  fs.writeFileSync(path.join(mainDir, "app.js"), 'import "declared-runtime/helper.js"; import "../../server/wemail/bootstrap/editionModules.js";');
  fs.writeFileSync(path.join(bootDir, "editionModules.js"), 'import "#edition-modules";');
  fs.writeFileSync(path.join(bootDir, "editionModules.noop.js"), "export const EDITION_MODULES = {};");
  fs.writeFileSync(path.join(edition, "register.js"), 'import "./directory/index.js";');
  fs.writeFileSync(path.join(edition, "directory", "index.js"), 'import "sm-crypto"; import "pinyin-pro";');
  fs.writeFileSync(path.join(privateModules, "sm-crypto", "package.json"), JSON.stringify({
    name: "sm-crypto", version: "0.4.0", main: "src/index.js", dependencies: { jsbn: "^1.1.0" },
  }));
  fs.writeFileSync(path.join(privateModules, "sm-crypto", "src", "index.js"), 'require("./sm2/index.js");');
  fs.writeFileSync(path.join(privateModules, "sm-crypto", "src", "sm2", "index.js"), 'require("jsbn");');
  fs.writeFileSync(path.join(privateModules, "pinyin-pro", "package.json"), JSON.stringify({
    name: "pinyin-pro", version: "3.28.1", main: "dist/index.js",
  }));
  fs.writeFileSync(path.join(privateModules, "pinyin-pro", "dist", "index.js"), "module.exports = {};");
  if (withJsbn) {
    fs.writeFileSync(path.join(privateModules, "jsbn", "package.json"), JSON.stringify({ name: "jsbn", version: "1.1.0", main: "index.js" }));
    fs.writeFileSync(path.join(privateModules, "jsbn", "index.js"), "module.exports = {};");
  }
  return { openModules, mainDir };
}

test("edition-module private deps resolve from their own node_modules and traverse the full closure", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-private-closure-"));
  try {
    const { openModules, mainDir } = writeEditionChainFixture(temp);
    const audit = auditRuntimeDependencies({
      entries: [path.join(mainDir, "app.js")],
      dependencies: { "declared-runtime": "1.0.0" },
      modulesDirectory: openModules,
    });
    assert.deepEqual(audit.packages, ["declared-runtime"], "open dependencies must still be audited");
    assert.deepEqual(audit.privatePackages, ["jsbn", "pinyin-pro", "sm-crypto"], "private closure was not traversed");
    for (const name of ["jsbn", "pinyin-pro", "sm-crypto"]) {
      assert.ok(!audit.packages.includes(name), `${name} must not be checked against open dependencies`);
    }
    const has = (suffix) => audit.files.some((file) => file.endsWith(suffix));
    assert.ok(has(path.join("edition-modules", "register.js")), "register.js was not traversed");
    assert.ok(has(path.join("edition-modules", "directory", "index.js")), "directory/index.js was not traversed");
    assert.ok(has(path.join("sm-crypto", "src", "index.js")), "private package entry was not traversed");
    assert.ok(has(path.join("jsbn", "index.js")), "transitive jsbn was not traversed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a missing transitive private dependency (jsbn) fails the audit", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-private-missing-"));
  try {
    const { openModules, mainDir } = writeEditionChainFixture(temp, { withJsbn: false });
    assert.throws(
      () => auditRuntimeDependencies({
        entries: [path.join(mainDir, "app.js")],
        dependencies: { "declared-runtime": "1.0.0" },
        modulesDirectory: openModules,
      }),
      /Edition-module dependency "jsbn".*cannot be resolved.*private runtime dependency closure is incomplete/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("edition-module imports of declared open runtime deps fall through to the standard check", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-private-fallback-"));
  try {
    const dist = path.join(temp, "dist-electron");
    const edition = path.join(dist, "edition-modules");
    const privateModules = path.join(edition, "node_modules");
    const openModules = path.join(temp, "node_modules");
    fs.mkdirSync(path.join(privateModules, "private-only"), { recursive: true });
    fs.mkdirSync(path.join(openModules, "declared-runtime"), { recursive: true });
    fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify({
      type: "module",
      imports: { "#edition-modules": "./edition-modules/register.js" },
    }));
    fs.writeFileSync(path.join(edition, "register.js"), 'import "./helper.js";');
    fs.writeFileSync(path.join(edition, "helper.js"), 'import "declared-runtime";');
    fs.writeFileSync(path.join(privateModules, "private-only", "package.json"), '{"name":"private-only"}');
    fs.writeFileSync(path.join(openModules, "declared-runtime", "package.json"), '{"name":"declared-runtime"}');
    const entry = path.join(edition, "register.js");
    const audit = auditRuntimeDependencies({
      entries: [entry],
      dependencies: { "declared-runtime": "1.0.0" },
      modulesDirectory: openModules,
    });
    assert.deepEqual(audit.packages, ["declared-runtime"]);
    assert.deepEqual(audit.privatePackages, []);
    // The fallback is not a skip: an undeclared open dep still fails.
    assert.throws(
      () => auditRuntimeDependencies({ entries: [entry], dependencies: {}, modulesDirectory: openModules }),
      /declared-runtime is imported by .* but is not declared in dependencies/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("rejects import shapes beyond exact relative string bindings", () => {
  const shapes = [
    {
      name: "conditional object (needs active-condition guessing)",
      imports: { "#x": { default: "./actual.js", node: "./other.js" } },
      specifier: "#x",
      error: /conditional objects\/arrays are not supported/,
    },
    {
      name: "array fallback target",
      imports: { "#x": ["./a.js", "./b.js"] },
      specifier: "#x",
      error: /conditional objects\/arrays are not supported/,
    },
    {
      name: "wildcard key and target",
      imports: { "#x/*": "./targets/*.js" },
      specifier: "#x/office",
      error: /wildcard imports "#x\/\*"/,
    },
    {
      name: "parent-relative target",
      imports: { "#x": "../outside.js" },
      specifier: "#x",
      error: /must start with "\.\/" and stay inside/,
    },
    {
      name: "target that escapes the package scope",
      imports: { "#x": "./../outside.js" },
      specifier: "#x",
      error: /escapes the package scope/,
    },
    {
      name: "#-to-# alias",
      imports: { "#x": "#y", "#y": "./y.js" },
      specifier: "#x",
      error: /aliases another # import/,
    },
    {
      name: "bare/external package target",
      imports: { "#x": "some-package" },
      specifier: "#x",
      error: /must start with "\.\/" and stay inside/,
    },
    {
      name: "null (blocked) target",
      imports: { "#x": null },
      specifier: "#x",
      error: /blocked \(null target\)/,
    },
  ];
  for (const shape of shapes) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-import-shape-"));
    try {
      const scope = path.join(temp, "scope");
      fs.mkdirSync(scope, { recursive: true });
      // A real file outside the scope makes the "./../outside.js" shape
      // resolvable, so the containment check (not a missing-file error) fires.
      fs.writeFileSync(path.join(temp, "outside.js"), "export const outside = true;");
      fs.writeFileSync(path.join(scope, "package.json"), JSON.stringify({ type: "module", imports: shape.imports }));
      const entry = path.join(scope, "entry.js");
      fs.writeFileSync(entry, `import ${JSON.stringify(shape.specifier)};`);
      assert.throws(
        () => collectRuntimeDependencyReferences([entry]),
        shape.error,
        `${shape.name} must be rejected instead of guessed`,
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
});

test("a nearer package.json without imports is not bypassed by walking up", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-nearest-scope-"));
  try {
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({
      type: "module",
      imports: { "#x": "./root-target.js" },
    }));
    fs.writeFileSync(path.join(temp, "root-target.js"), "export const x = true;");
    const scope = path.join(temp, "scope");
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(path.join(scope, "package.json"), JSON.stringify({ type: "module" }));
    const entry = path.join(scope, "entry.js");
    fs.writeFileSync(entry, 'import "#x";');
    assert.throws(
      () => collectRuntimeDependencyReferences([entry]),
      /Package import "#x" is not defined by the nearest package scope .*scope[\\/]package\.json/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("an undefined # import fails instead of being reported as an npm package", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-undefined-import-"));
  try {
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module", imports: {} }));
    const entry = path.join(temp, "entry.js");
    fs.writeFileSync(entry, 'import "#missing-binding";');
    assert.throws(
      () => auditRuntimeDependencies({ entries: [entry], dependencies: {}, modulesDirectory: path.join(temp, "node_modules") }),
      /Package import "#missing-binding" is not defined by the nearest package scope/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reports undeclared and uninstalled runtime packages with their importer", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-missing-"));
  const modules = path.join(temp, "node_modules");
  try {
    fs.mkdirSync(modules, { recursive: true });
    const entry = path.join(temp, "entry.js");
    fs.writeFileSync(entry, 'import "missing-runtime";');
    assert.throws(
      () => auditRuntimeDependencies({ entries: [entry], dependencies: {}, modulesDirectory: modules }),
      /missing-runtime is imported by .*entry\.js but is not declared in dependencies/,
    );
    assert.throws(
      () => auditRuntimeDependencies({ entries: [entry], dependencies: { "missing-runtime": "1" }, modulesDirectory: modules }),
      /missing-runtime is declared but cannot be resolved/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("cache key changes with dependency, override, lockfile, or audit inputs", () => {
  const base = { dependencies: { a: "1" }, overrides: { b: "1" }, lockfile: "lock-a" };
  const key = productionDependencyCacheKey(base);
  assert.notEqual(key, productionDependencyCacheKey({ ...base, dependencies: { a: "2" } }));
  assert.notEqual(key, productionDependencyCacheKey({ ...base, overrides: { b: "2" } }));
  assert.notEqual(key, productionDependencyCacheKey({ ...base, lockfile: "lock-b" }));
});

test("rejects renderer-only packages in production node_modules", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-policy-"));
  try {
    fs.mkdirSync(path.join(temp, "@phosphor-icons", "react"), { recursive: true });
    assert.throws(() => assertRuntimePackagePolicy(temp), /Renderer\/build packages leaked.*@phosphor-icons\/react/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("enforces the single-file NSIS installer size gate", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-installer-size-"));
  const installer = path.join(temp, "WeMail Setup.exe");
  try {
    fs.writeFileSync(installer, "installer");
    assert.equal(assertNsisInstallerSize(installer), 9);
    fs.truncateSync(installer, 156 * 1024 * 1024);
    assert.throws(() => assertNsisInstallerSize(installer), /above the 155\.0 MB limit/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("prunes non-runtime maps, declarations, and alternate PDF builds", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-runtime-prune-"));
  try {
    const files = [
      ["pdfjs-dist", "build", "pdf.mjs"],
      ["pdfjs-dist", "legacy", "build", "pdf.mjs"],
      ["pdfjs-dist", "legacy", "build", "pdf.mjs.map"],
      ["pdf-parse", "dist", "pdf-parse", "cjs", "index.cjs"],
      ["pdf-parse", "dist", "pdf-parse", "esm", "index.js"],
      ["some-package", "index.d.ts"],
    ];
    for (const parts of files) {
      const file = path.join(temp, ...parts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "fixture");
    }
    pruneRuntimeDependencies(temp);
    assert.equal(fs.existsSync(path.join(temp, "pdfjs-dist", "build")), false);
    assert.equal(fs.existsSync(path.join(temp, "pdfjs-dist", "legacy", "build", "pdf.mjs")), true);
    assert.equal(fs.existsSync(path.join(temp, "pdfjs-dist", "legacy", "build", "pdf.mjs.map")), false);
    assert.equal(fs.existsSync(path.join(temp, "pdf-parse", "dist", "pdf-parse", "cjs")), false);
    assert.equal(fs.existsSync(path.join(temp, "pdf-parse", "dist", "pdf-parse", "esm", "index.js")), true);
    assert.equal(fs.existsSync(path.join(temp, "some-package", "index.d.ts")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
