#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const [platform, arch, directory, ...extra] = process.argv.slice(2);
const supported =
  (platform === "win32" && arch === "x64") ||
  (platform === "darwin" && (arch === "x64" || arch === "arm64"));
if (!supported || !directory || extra.length > 0) {
  throw new Error("Usage: verify-update-artifacts.mjs <platform> <arch> <feed-directory>");
}

const feedDirectory = path.resolve(directory);
const metadataName = platform === "win32" ? "latest.yml" : "latest-mac.yml";
const metadataPath = path.join(feedDirectory, metadataName);
if (!fs.existsSync(metadataPath)) throw new Error(`Missing metadata: ${metadataPath}`);
const metadata = yaml.load(fs.readFileSync(metadataPath, "utf8"));
if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.files) || metadata.files.length === 0) {
  throw new Error("Update metadata must contain a non-empty files array");
}

const referencedFiles = [];
for (const file of metadata.files) {
  if (!file || typeof file.url !== "string" || typeof file.sha512 !== "string" || !file.sha512) {
    throw new Error("Every metadata file must contain url and sha512");
  }
  const decoded = decodeURIComponent(file.url);
  if (decoded.includes("..") || decoded.includes("/") || decoded.includes("\\") || path.isAbsolute(decoded)) {
    throw new Error(`Unsafe artifact path in metadata: ${file.url}`);
  }
  const artifactPath = path.join(feedDirectory, decoded);
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error(`Metadata references missing artifact: ${decoded}`);
  }
  referencedFiles.push(artifactPath);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw new Error(`${command} is required: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

if (platform === "win32") {
  const installer = referencedFiles.find((file) => file.toLowerCase().endsWith(".exe"));
  if (!installer) throw new Error("Windows metadata must reference an EXE installer");
  const signatureDetails = run("signtool.exe", ["verify", "/pa", "/all", "/v", installer]);
  const expectedPublisher = process.env.WEMAIL_WINDOWS_PUBLISHER;
  if (!expectedPublisher) throw new Error("WEMAIL_WINDOWS_PUBLISHER is required for verification");
  if (!signatureDetails.toLowerCase().includes(expectedPublisher.toLowerCase())) {
    throw new Error(`Unexpected Windows publisher in signtool output: ${signatureDetails}`);
  }
} else {
  const zip = referencedFiles.find((file) => file.toLowerCase().endsWith(".zip"));
  const dmg = fs.readdirSync(feedDirectory)
    .map((name) => path.join(feedDirectory, name))
    .find((file) => file.toLowerCase().endsWith(".dmg"));
  if (!zip || !dmg) throw new Error("macOS feed must contain a referenced ZIP and a DMG");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-update-verify-"));
  try {
    run("ditto", ["-x", "-k", zip, temporaryDirectory]);
    const queue = [temporaryDirectory];
    let appBundle;
    while (queue.length > 0 && !appBundle) {
      const current = queue.shift();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && entry.name.endsWith(".app")) {
          appBundle = fullPath;
          break;
        }
        if (entry.isDirectory()) queue.push(fullPath);
      }
    }
    if (!appBundle) throw new Error("macOS ZIP does not contain an application bundle");
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
    const signingDetails = run("codesign", ["-dv", "--verbose=4", appBundle]);
    const expectedTeamId = process.env.APPLE_TEAM_ID;
    if (!expectedTeamId || !signingDetails.includes(`TeamIdentifier=${expectedTeamId}`)) {
      throw new Error("macOS application Team ID does not match APPLE_TEAM_ID");
    }
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appBundle]);
    run("xcrun", ["stapler", "validate", appBundle]);
    const executableName = run("plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      path.join(appBundle, "Contents", "Info.plist"),
    ]);
    const architectures = run("lipo", [
      "-archs",
      path.join(appBundle, "Contents", "MacOS", executableName),
    ]).split(/\s+/);
    const expectedArchitecture = arch === "x64" ? "x86_64" : "arm64";
    if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
      throw new Error(`Unexpected macOS architectures: ${architectures.join(" ")}`);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

console.log(`[verify] update artifacts valid for ${platform}/${arch}`);
