#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import yaml from "js-yaml";
import { createReleaseConfig } from "./update-release-config.ts";
import { auditRuntimeDependencies } from "./desktop-runtime-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [platform, arch, ...extra] = process.argv.slice(2);
const supported =
  (platform === "win32" && arch === "x64") ||
  (platform === "darwin" && (arch === "x64" || arch === "arm64"));

if (!supported || extra.length > 0) {
  throw new Error("Usage: package-release.mjs <win32 x64|darwin x64|darwin arm64>");
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for release packaging`);
  return value;
}

if (platform === "win32") {
  requireEnvironment("WEMAIL_WINDOWS_PUBLISHER");
  requireEnvironment("CSC_LINK");
  requireEnvironment("CSC_KEY_PASSWORD");
} else {
  requireEnvironment("APPLE_TEAM_ID");
  requireEnvironment("CSC_LINK");
  requireEnvironment("CSC_KEY_PASSWORD");
  requireEnvironment("APPLE_API_KEY");
  requireEnvironment("APPLE_API_KEY_ID");
  requireEnvironment("APPLE_API_ISSUER");
}

const releaseConfig = createReleaseConfig({
  release: true,
  baseUrl: process.env.WEMAIL_UPDATE_BASE_URL,
  fallbackBaseUrl: process.env.WEMAIL_UPDATE_FALLBACK_BASE_URL,
  platform,
  arch,
  windowsPublisherName: process.env.WEMAIL_WINDOWS_PUBLISHER,
  appleTeamId: process.env.APPLE_TEAM_ID,
});
const platformDirectory = platform === "win32" ? "windows" : "mac";
const outputDirectory = path.join(root, "dist", `release-${platform}-${arch}`);
const feedDirectory = path.join(
  root,
  "dist",
  "update-feed",
  platformDirectory,
  arch,
);
const env = {
  ...process.env,
  WEMAIL_RELEASE_BUILD: "1",
  WEMAIL_TARGET_PLATFORM: platform,
  WEMAIL_TARGET_ARCH: arch,
  WEMAIL_UPDATE_FEED_URL: releaseConfig.feedUrl,
  WEMAIL_RELEASE_OUTPUT_DIR: outputDirectory,
};

function run(command, args, commandEnv = env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnv,
    shell: false,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status ?? 1}`);
  }
}

function assertOutputParentInsideWorkspace(target) {
  const workspace = fs.realpathSync(root);
  let parent = path.dirname(target);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`Cannot resolve output parent: ${target}`);
    parent = next;
  }
  const resolved = fs.realpathSync(parent);
  const relative = path.relative(workspace, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean output outside workspace: ${target}`);
  }
}

function refreshWindowsInstallerSignature(outputDirectory) {
  const thumbprint = requireEnvironment("WEMAIL_SIGNING_THUMBPRINT");
  const installerName = fs
    .readdirSync(outputDirectory)
    .find((name) => /\.exe$/i.test(name) && !/__uninstaller\.exe$/i.test(name));
  if (!installerName) {
    throw new Error(`Missing Windows installer in ${outputDirectory}`);
  }
  const installerPath = path.join(outputDirectory, installerName);
  run("signtool.exe", [
    "sign",
    "/sha1",
    thumbprint,
    "/s",
    "My",
    "/fd",
    "SHA256",
    installerPath,
  ]);
  return installerPath;
}

function refreshWindowsMetadata(metadataPath, outputDirectory) {
  const metadata = yaml.load(fs.readFileSync(metadataPath, "utf8"));
  const files = metadata.files.map((file) => {
    const artifactPath = path.join(outputDirectory, path.basename(decodeURIComponent(file.url)));
    const content = fs.readFileSync(artifactPath);
    return {
      ...file,
      sha512: crypto.createHash("sha512").update(content).digest("base64"),
      size: content.length,
    };
  });
  const primary = files[0];
  fs.writeFileSync(
    metadataPath,
    yaml.dump({ ...metadata, files, sha512: primary.sha512 }, { lineWidth: -1 }),
  );
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

function auditCompiledRuntime(label) {
  const compiledRoot = path.join(root, "dist-electron");
  const entries = fs
    .readdirSync(compiledRoot, { recursive: true })
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(compiledRoot, name));
  const result = auditRuntimeDependencies({
    entries,
    dependencies: packageJson.dependencies,
    modulesDirectory: path.join(root, "node_modules"),
  });
  console.log(
    `[release] ${label} runtime audit passed: ${result.files.length} files, ${result.packages.length} packages`,
  );
  return result;
}

function resolveTsxCli() {
  return path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

function findFile(directory, name) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return fullPath;
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    }
  }
  return null;
}

function verifyPackagedRuntime(packages) {
  const archivePath = findFile(outputDirectory, "app.asar");
  if (!archivePath) throw new Error(`Packaged app.asar is missing from ${outputDirectory}`);
  const packagedFiles = new Set(
    listPackage(archivePath).map((entry) =>
      entry.replaceAll("\\", "/").replace(/^\/+/, "")
    ),
  );
  const missing = packages.filter(
    (name) => !packagedFiles.has(`node_modules/${name}/package.json`),
  );
  if (missing.length > 0) {
    throw new Error(`Packaged runtime dependencies are missing: ${missing.join(", ")}`);
  }
  console.log(`[release] packaged runtime verified: ${packages.length} packages`);
}

function verifyWindowsInstallerContract() {
  const source = fs.readFileSync(
    path.join(root, "packaging", "nsis", "install-update-trust.nsh"),
    "utf8",
  );
  const pageGuards = source.match(/!insertmacro WeMailSkipIfInstalled/g)?.length ?? 0;
  const required = [
    "!macro customInstallMode",
    'StrCpy $isForceCurrentInstall "1"',
    'StrCpy $isForceMachineInstall "1"',
    '$hasPerUserInstallation == "1"',
    '$hasPerMachineInstallation == "1"',
    "WEMAIL_INSTALL_DIR",
    "StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)",
    "taskkill.exe /PID $$_.ProcessId /T /F",
    "!macro customUnInstallCheck",
    "continuing with in-place upgrade",
    'ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion',
    'DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString',
  ];
  const missing = required.filter((value) => !source.includes(value));
  if (pageGuards !== 2 || missing.length > 0) {
    throw new Error(
      `Windows installer upgrade preflight failed: ${[
        pageGuards === 2 ? null : `expected 2 upgrade page guards, found ${pageGuards}`,
        ...missing.map((value) => `missing ${value}`),
      ].filter(Boolean).join("; ")}`,
    );
  }
  console.log("[release] Windows installer upgrade preflight passed");
}

const startedAt = Date.now();
let phaseStartedAt = startedAt;
function mark(label) {
  const now = Date.now();
  console.log(`[release] ${label}: ${((now - phaseStartedAt) / 1000).toFixed(1)}s`);
  phaseStartedAt = now;
}

if (platform === "win32") {
  verifyWindowsInstallerContract();
  run(process.execPath, ["scripts/verify-windows-installer.mjs"]);
}
mark("installer contract checks");

// Reject development credentials before removing any existing outputs.
run(process.execPath, ["scripts/check-production-login-env.mjs"]);
assertOutputParentInsideWorkspace(outputDirectory);
assertOutputParentInsideWorkspace(feedDirectory);
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.rmSync(feedDirectory, { recursive: true, force: true });
fs.mkdirSync(feedDirectory, { recursive: true });

// Compile the Electron main/preload exactly once (incremental quick profile),
// then run the non-tsc remainder of `build:desktop` (see package.json) — the
// full tsc used to run a second, identical compile over the same sources.
run(process.execPath, ["scripts/clean-desktop-output.mjs"]);
if (process.platform === "win32") {
  run("cmd.exe", ["/d", "/s", "/c", "npm run build:desktop:main:quick"]);
} else {
  run("npm", ["run", "build:desktop:main:quick"]);
}
mark("tsc (electron main/preload)");

auditCompiledRuntime("preflight");
mark("preflight runtime audit");

if (process.platform === "win32") {
  run("cmd.exe", ["/d", "/s", "/c", "npm run build:renderer"]);
} else {
  run("npm", ["run", "build:renderer"]);
}
run(process.execPath, [resolveTsxCli(), "scripts/write-edition-config.ts"]);
run(process.execPath, [resolveTsxCli(), "scripts/write-update-policy.ts"]);
mark("renderer build + runtime configs");

const runtimeAudit = auditCompiledRuntime("final");
mark("final runtime audit");
const builderArguments = [
  "node_modules/electron-builder/cli.js",
  "--config",
  "electron-builder.config.cjs",
  "--publish",
  "never",
];
if (platform === "win32") {
  builderArguments.unshift(
    "--require",
    path.join(root, "scripts", "windows-executable-write-retry.cjs"),
  );
  builderArguments.push("--win", "nsis", "--x64");
} else {
  builderArguments.push("--mac", "dmg", "zip", arch === "arm64" ? "--arm64" : "--x64");
}
const builderEnvironment =
  platform === "win32" && env.WEMAIL_SELF_SIGN_AFTER_PACK === "1"
    ? { ...env, CSC_LINK: "", CSC_KEY_PASSWORD: "" }
    : env;
run(process.execPath, builderArguments, builderEnvironment);
mark("electron-builder (nsis)");

verifyPackagedRuntime(runtimeAudit.packages);
mark("packaged runtime verify");

const metadataName = platform === "win32" ? "latest.yml" : "latest-mac.yml";
const metadataPath = path.join(outputDirectory, metadataName);
if (!fs.existsSync(metadataPath)) {
  throw new Error(`Missing generated update metadata: ${metadataPath}`);
}
if (platform === "win32") {
  refreshWindowsInstallerSignature(outputDirectory);
  refreshWindowsMetadata(metadataPath, outputDirectory);
}
mark("installer signature + update metadata");
const metadata = yaml.load(fs.readFileSync(metadataPath, "utf8"));
if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.files)) {
  throw new Error(`Invalid generated update metadata: ${metadataPath}`);
}
const names = new Set([metadataName]);
for (const file of metadata.files) {
  if (!file || typeof file.url !== "string") {
    throw new Error("Generated update metadata contains an invalid file entry");
  }
  names.add(path.basename(decodeURIComponent(file.url)));
}
for (const entry of fs.readdirSync(outputDirectory)) {
  if (/\.(?:blockmap|dmg|exe|zip)$/i.test(entry)) names.add(entry);
}
for (const name of names) {
  const source = path.join(outputDirectory, name);
  if (!fs.existsSync(source)) throw new Error(`Missing release artifact: ${source}`);
  fs.copyFileSync(source, path.join(feedDirectory, name));
}
mark("update feed copy");

run(process.execPath, [
  "scripts/verify-update-artifacts.mjs",
  platform,
  arch,
  feedDirectory,
]);
mark("verify update artifacts");
console.log(`[release] total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`[release] verified update feed: ${feedDirectory}`);
