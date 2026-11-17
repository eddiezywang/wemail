import { builtinModules } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_AUDIT_VERSION = 2;
export const MAX_RUNTIME_MODULES_BYTES = 300 * 1024 * 1024;
export const MAX_PACKAGED_APP_BYTES = 450 * 1024 * 1024;
export const MAX_NSIS_ARCHIVE_BYTES = 150 * 1024 * 1024;
export const MAX_NSIS_INSTALLER_BYTES = 155 * 1024 * 1024;

export const FORBIDDEN_RUNTIME_PACKAGES = [
  "@phosphor-icons/react",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-select",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-tooltip",
  "@tanstack/react-query",
  "@tiptap/react",
  "@tiptap/starter-kit",
  "typescript",
];

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export function extractModuleSpecifiers(source) {
  const patterns = [
    /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[^"']*?\s+from\s+)["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const matches = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) matches.push(match[1]);
  }
  // Specifiers containing "${" are capture text from code embedded inside a
  // string (e.g. pdfjs-dist's `const wrapper = `await import("${url}");`),
  // not real module paths — a real specifier can never contain interpolation.
  return [...new Set(matches)].filter((specifier) => !specifier.includes("${"));
}

export function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function resolveLocalModule(importer, specifier) {
  const raw = specifier.split(/[?#]/, 1)[0];
  const base = path.resolve(path.dirname(importer), raw);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
    path.join(base, "index.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

// ---------------------------------------------------------------------------
// `#` package-scope imports: EXACT RELATIVE STRING BINDINGS ONLY.
//
// Supported shape (and the only shape this repository emits):
//   "imports": { "#edition-modules": "./dist-electron/.../editionModules.noop.js" }
// i.e. an exact "#name" key whose value is ONE string starting with "./" that
// points at a real file INSIDE that package scope's own directory. Node
// resolves "#" specifiers through the NEAREST package.json (the first one
// walking up from the importer); we stop there and never guess a farther one.
//
// Deliberately NOT supported — rejected with an explicit error rather than
// guessed at: conditional objects / arrays (active conditions are unknown),
// wildcard keys or targets (prefix-length priority is easy to get wrong),
// bare/external or absolute targets, "#a": "#b" aliases (and therefore alias
// cycles), null (blocked) targets, and targets escaping the scope via "../".
// This is intentionally NOT a general PACKAGE_IMPORTS_RESOLVE implementation:
// a half-correct general resolver would audit a DIFFERENT file than Node
// actually loads. Both the open build and the internal edition build emit only
// the exact string binding above, so restricting the resolver keeps the audit
// honest about what it can prove without weakening the bindings in use.
// ---------------------------------------------------------------------------

function nearestPackageScope(importer) {
  let directory = path.dirname(importer);
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) return { directory, manifestPath };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function resolveExactImportBinding(manifest, scope, specifier, importer) {
  const imports = manifest.imports;
  const hasExact = Boolean(imports) && typeof imports === "object" &&
    !Array.isArray(imports) && Object.hasOwn(imports, specifier);
  if (!hasExact) {
    const importKeys = imports && typeof imports === "object" && !Array.isArray(imports)
      ? Object.keys(imports)
      : [];
    const wildcard = importKeys.find((key) => key.includes("*"));
    if (wildcard) {
      throw new Error(
        `Package import "${specifier}" from ${importer} has no exact binding; wildcard imports "${wildcard}" are not supported (exact relative string bindings only, ${scope.manifestPath})`,
      );
    }
    throw new Error(`Package import "${specifier}" is not defined by the nearest package scope ${scope.manifestPath}`);
  }
  const value = imports[specifier];
  if (value === null) {
    throw new Error(`Package import "${specifier}" from ${importer} is blocked (null target) by ${scope.manifestPath}`);
  }
  if (typeof value !== "string") {
    throw new Error(
      `Package import "${specifier}" from ${importer} must be an exact relative string binding; conditional objects/arrays are not supported (${scope.manifestPath})`,
    );
  }
  if (value.startsWith("#")) {
    throw new Error(
      `Package import "${specifier}" from ${importer} aliases another # import ("${value}"); #-to-# aliases (and alias cycles) are not supported (${scope.manifestPath})`,
    );
  }
  if (!value.startsWith("./")) {
    throw new Error(
      `Package import "${specifier}" from ${importer} target "${value}" must start with "./" and stay inside the package scope; bare/external/absolute/parent-relative targets are not supported (${scope.manifestPath})`,
    );
  }
  const resolved = resolveLocalModule(scope.manifestPath, value);
  if (!resolved) {
    throw new Error(`Cannot resolve package import "${specifier}" target "${value}" from ${scope.manifestPath}`);
  }
  const relative = path.relative(path.resolve(scope.directory), path.resolve(resolved));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Package import "${specifier}" from ${importer} target "${value}" escapes the package scope ${scope.directory}; only in-scope relative targets are supported`,
    );
  }
  return { file: resolved };
}

/** Resolve a "#" specifier to an in-scope local file (traversed). */
export function resolvePackageScopeImport(importer, specifier) {
  const scope = nearestPackageScope(importer);
  if (!scope) {
    throw new Error(`Cannot resolve package import "${specifier}" from ${importer}: no package.json package scope`);
  }
  const manifest = JSON.parse(fs.readFileSync(scope.manifestPath, "utf8"));
  return resolveExactImportBinding(manifest, scope, specifier, importer);
}

// Edition-module files ship their OWN node_modules next to register.js. Bare
// specifiers from those files are resolved through that nearest node_modules
// FIRST: a hit is proven + its declared dependency closure traversed, and is
// never subjected to the open package.json declaration check (the private
// packages are deliberately absent from the open manifest). A miss continues
// Node's upward walk to the app's node_modules, so it falls through to the
// standard open dependency check rather than being skipped — edition modules
// may legitimately use open runtime deps such as hono. Closure deps of a
// private package (sm-crypto -> jsbn) must still be present in the private
// tree; a missing one is a hard error, so hoisted transitive deps cannot be
// silently dropped from a clean package.
function editionModulesPrivateModulesDirectory(file) {
  let directory = path.dirname(file);
  for (;;) {
    if (path.basename(directory) === "edition-modules") {
      return path.join(directory, "node_modules");
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function resolvePrivatePackageEntry(manifestPath, manifest) {
  const candidates = [manifest.main, "index.js", "index.mjs", "index.cjs"]
    .filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    const relative = candidate.startsWith("./") ? candidate : `./${candidate}`;
    const resolved = resolveLocalModule(manifestPath, relative);
    if (resolved) return resolved;
  }
  return null;
}

/** napi-rs per-triple optional package suffix, e.g. "@pkg-win32-x64-msvc". */
const PLATFORM_VARIANT_SUFFIX =
  /-(android|darwin|linux|win32|freebsd|openbsd|sunos|aix|ohos|wasi|wasm32)-[a-z0-9]/i;

/** Name of the private package whose source file this is, or null. */
function enclosingPrivatePackageName(file) {
  const segments = file.split(/[\\/]+/);
  for (let index = segments.length - 1; index >= 0; index--) {
    if (segments[index] === "node_modules") {
      const first = segments[index + 1];
      if (!first) return null;
      return first.startsWith("@") && segments[index + 2]
        ? `${first}/${segments[index + 2]}`
        : first;
    }
  }
  return null;
}

export function collectRuntimeDependencyReferences(entries) {
  const pending = entries.map((entry) => path.resolve(entry));
  const visited = new Set();
  const references = new Map();
  const privatePackages = new Set();
  const record = (packageName, file, specifier) => {
    const packageReferences = references.get(packageName) ?? [];
    packageReferences.push({ file, specifier });
    references.set(packageName, packageReferences);
  };

  /** Prove a private package AND its package.json dependency closure exist. */
  function traversePrivatePackage(packageName, modulesDirectory, importer) {
    if (privatePackages.has(packageName)) return;
    const manifestPath = path.join(modulesDirectory, ...packageName.split("/"), "package.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Edition-module dependency "${packageName}" (imported by ${importer}) cannot be resolved from ${modulesDirectory}; the private runtime dependency closure is incomplete`,
      );
    }
    privatePackages.add(packageName);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // Also walk the package's entry source: literal requires/imports there must
    // resolve too (sm-crypto/src/sm2/index.js requires jsbn at load time).
    const entry = resolvePrivatePackageEntry(manifestPath, manifest);
    if (entry) pending.push(entry);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      traversePrivatePackage(dependency, modulesDirectory, manifestPath);
    }
  }

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`Runtime audit entry is missing: ${file}`);
    visited.add(file);

    const source = fs.readFileSync(file, "utf8");
    const privateModulesDirectory = editionModulesPrivateModulesDirectory(file);
    for (const specifier of extractModuleSpecifiers(source)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        if (
          /\.(node|wasm)$/.test(specifier) ||
          /[-.]wasi/i.test(specifier) ||
          /wasm32/i.test(specifier)
        ) {
          // Platform-optional native loaders (e.g. @napi-rs/canvas's
          // js-binding.js requires "./skia.<triple>.node" for every platform
          // plus a WASI fallback, but only the host triple is ever installed).
          // Binaries/WASM are selected at runtime, so they are not part of the
          // auditable JS closure; the packaged smoke exercises the host one.
          continue;
        }
        const resolved = resolveLocalModule(file, specifier);
        if (!resolved) throw new Error(`Cannot resolve local runtime import "${specifier}" from ${file}`);
        pending.push(resolved);
        continue;
      }
      if (specifier.startsWith("#")) {
        // Resolve the exact package-scope binding and keep walking the ACTUAL
        // target (plus its own dependency graph) instead of treating "#..." as
        // an npm package name. This makes the edition-module binding auditable.
        const resolved = resolvePackageScopeImport(file, specifier);
        pending.push(resolved.file);
        continue;
      }
      if (specifier === "electron" || BUILTINS.has(specifier)) continue;

      const packageName = packageNameFromSpecifier(specifier);
      if (privateModulesDirectory) {
        if (!fs.existsSync(privateModulesDirectory)) {
          throw new Error(
            `Edition-module private node_modules is missing at ${privateModulesDirectory}; bare import "${specifier}" from ${file} cannot be resolved`,
          );
        }
        const privateManifest = path.join(privateModulesDirectory, ...packageName.split("/"), "package.json");
        if (fs.existsSync(privateManifest)) {
          // Shipped with the module: proven + closure traversed, and never
          // checked against the open package.json dependencies.
          traversePrivatePackage(packageName, privateModulesDirectory, file);
          continue;
        }
        // Not shipped with the module: Node keeps walking up from the
        // importing file to the app's node_modules, so this falls through to
        // the standard open declaration check (e.g. the WeCLI route module
        // imports hono). A miss is never silently accepted or skipped...
        // except for napi-rs style loaders, where a package requires its own
        // per-triple optional binary package ("@pkg-win32-x64-msvc") and only
        // the host triple ever installs. Those are platform-optional the same
        // way the "./skia.<triple>.node" relative loaders are.
        const importingPackage = enclosingPrivatePackageName(file);
        if (
          importingPackage !== null &&
          packageName.startsWith(`${importingPackage}-`) &&
          PLATFORM_VARIANT_SUFFIX.test(packageName)
        ) {
          continue;
        }
      }
      record(packageName, file, specifier);
    }
  }

  return { references, visited, privatePackages };
}

export function auditRuntimeDependencies({ entries, dependencies, modulesDirectory }) {
  const { references, visited, privatePackages } = collectRuntimeDependencyReferences(entries);
  const failures = [];

  // Only NON-edition-module imports are checked against the open package.json
  // dependencies and the production dependency cache. Edition-module bare
  // specifiers were already proven against their own shipped node_modules.
  for (const [packageName, packageReferences] of references) {
    if (!Object.hasOwn(dependencies, packageName)) {
      failures.push(`${packageName} is imported by ${packageReferences[0].file} but is not declared in dependencies`);
      continue;
    }
    const manifestPath = path.join(modulesDirectory, ...packageName.split("/"), "package.json");
    if (!fs.existsSync(manifestPath)) {
      failures.push(`${packageName} is declared but cannot be resolved from ${modulesDirectory}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Runtime dependency audit failed:\n- ${failures.join("\n- ")}`);
  }
  return {
    packages: [...references.keys()].sort(),
    privatePackages: [...privatePackages].sort(),
    files: [...visited].sort(),
  };
}

export function productionDependencyCacheKey({ dependencies, overrides, lockfile }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ version: RUNTIME_AUDIT_VERSION, dependencies, overrides }))
    .update(lockfile)
    .digest("hex")
    .slice(0, 16);
}

export function directorySize(directory) {
  if (!fs.existsSync(directory)) return 0;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(directory).reduce(
    (total, entry) => total + directorySize(path.join(directory, entry)),
    0,
  );
}

export function largestRuntimePackages(modulesDirectory, limit = 20) {
  const packages = [];
  for (const entry of fs.readdirSync(modulesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const entryPath = path.join(modulesDirectory, entry.name);
    if (entry.name.startsWith("@")) {
      for (const child of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (child.isDirectory()) {
          packages.push({ name: `${entry.name}/${child.name}`, bytes: directorySize(path.join(entryPath, child.name)) });
        }
      }
    } else {
      packages.push({ name: entry.name, bytes: directorySize(entryPath) });
    }
  }
  return packages.sort((left, right) => right.bytes - left.bytes).slice(0, limit);
}

export function pruneRuntimeDependencies(modulesDirectory) {
  const removableDirectories = [
    ["pdfjs-dist", "build"],
    ["pdfjs-dist", "web"],
    ["pdfjs-dist", "types"],
    ["pdf-parse", "bin"],
    ["pdf-parse", "dist", "pdf-parse", "cjs"],
    ["pdf-parse", "dist", "pdf-parse", "web"],
    ["pdf-parse", "dist", "worker"],
  ];
  for (const parts of removableDirectories) {
    fs.rmSync(path.join(modulesDirectory, ...parts), { recursive: true, force: true });
  }

  const removableSuffixes = [".map", ".d.ts", ".d.mts", ".d.cts"];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && removableSuffixes.some((suffix) => entry.name.endsWith(suffix))) fs.rmSync(fullPath, { force: true });
    }
  }
  walk(modulesDirectory);
}

export function assertRuntimePackagePolicy(modulesDirectory) {
  const forbidden = FORBIDDEN_RUNTIME_PACKAGES.filter((name) => fs.existsSync(path.join(modulesDirectory, ...name.split("/"))));
  if (forbidden.length > 0) throw new Error(`Renderer/build packages leaked into runtime: ${forbidden.join(", ")}`);

  const bytes = directorySize(modulesDirectory);
  if (bytes > MAX_RUNTIME_MODULES_BYTES) {
    throw new Error(`Runtime node_modules is ${formatBytes(bytes)}, above the ${formatBytes(MAX_RUNTIME_MODULES_BYTES)} limit`);
  }
  return bytes;
}

export function assertPackagedAppSize(appDirectory) {
  const bytes = directorySize(appDirectory);
  if (bytes > MAX_PACKAGED_APP_BYTES) {
    throw new Error(`Packaged app is ${formatBytes(bytes)}, above the ${formatBytes(MAX_PACKAGED_APP_BYTES)} limit`);
  }
  return bytes;
}

export function assertNsisArchiveSize(archivePath) {
  if (!fs.existsSync(archivePath)) throw new Error(`NSIS application archive is missing: ${archivePath}`);
  const bytes = fs.statSync(archivePath).size;
  if (bytes > MAX_NSIS_ARCHIVE_BYTES) {
    throw new Error(`NSIS application archive is ${formatBytes(bytes)}, above the ${formatBytes(MAX_NSIS_ARCHIVE_BYTES)} limit`);
  }
  return bytes;
}

export function assertNsisInstallerSize(installerPath) {
  if (!fs.existsSync(installerPath)) throw new Error(`NSIS installer is missing: ${installerPath}`);
  const bytes = fs.statSync(installerPath).size;
  if (bytes === 0) throw new Error(`NSIS installer is empty: ${installerPath}`);
  if (bytes > MAX_NSIS_INSTALLER_BYTES) {
    throw new Error(`NSIS installer is ${formatBytes(bytes)}, above the ${formatBytes(MAX_NSIS_INSTALLER_BYTES)} limit`);
  }
  return bytes;
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Direct invocation audits the checked-in desktop build output. Packaging
// always calls auditRuntimeDependencies() itself; this gives the same check a
// standalone, read-only entry point for CI and local verification.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = path.join(root, "dist-electron", "electron", "main", "app.js");
  const audit = auditRuntimeDependencies({
    entries: [entry],
    dependencies: pkg.dependencies,
    modulesDirectory: path.join(root, "node_modules"),
  });
  console.log(
    `[runtime-audit] ${audit.files.length} files, ${audit.packages.length} direct packages: ${audit.packages.join(", ")}`,
  );
  if (audit.privatePackages.length > 0) {
    console.log(`[runtime-audit] edition-module private dependency closure: ${audit.privatePackages.join(", ")}`);
  }
}
