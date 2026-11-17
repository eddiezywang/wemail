#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WINDOWS_TEST_PUBLISHER = "WeMail Test Publisher";
const PFX_RELATIVE_PATH = path.join(
  "workspace",
  "signing",
  "private",
  "WeMail-Test.pfx",
);

function isExpectedRelativePfxPath(value) {
  if (typeof value !== "string" || path.isAbsolute(value)) return false;
  return path.normalize(value) === PFX_RELATIVE_PATH;
}

export function getWindowsTestCertificatePaths(root = process.cwd()) {
  return {
    publicCertificate: path.join(
      root,
      "packaging",
      "windows",
      "certificates",
      "WeMail-Test.cer",
    ),
    privateCertificate: path.join(root, PFX_RELATIVE_PATH),
    config: path.join(
      root,
      "workspace",
      "signing",
      "private",
      "windows-test-signing.json",
    ),
  };
}

export function loadWindowsTestSigningConfig({ root = process.cwd() } = {}) {
  const paths = getWindowsTestCertificatePaths(root);
  const parsed = JSON.parse(
    fs.readFileSync(paths.config, "utf8").replace(/^\uFEFF/, ""),
  );
  if (
    !isExpectedRelativePfxPath(parsed?.pfxPath) ||
    typeof parsed.password !== "string" ||
    parsed.password.length === 0 ||
    parsed.publisherName !== WINDOWS_TEST_PUBLISHER
  ) {
    throw new Error("Invalid Windows test-signing configuration");
  }
  return {
    pfxPath: paths.privateCertificate,
    password: parsed.password,
    publisherName: parsed.publisherName,
  };
}

function runOpenSsl(args, { password, spawn = spawnSync } = {}) {
  const result = spawn("openssl", args, {
    encoding: "utf8",
    env: password
      ? { ...process.env, WEMAIL_TEST_PFX_PASSWORD: password }
      : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`OpenSSL is required: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `OpenSSL failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
}

export function createWindowsTestCertificate({
  root = process.cwd(),
  randomPassword = () => crypto.randomBytes(24).toString("hex"),
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const paths = getWindowsTestCertificatePaths(root);
  const hasPublic = fs.existsSync(paths.publicCertificate);
  const hasPrivate = fs.existsSync(paths.privateCertificate);
  const hasConfig = fs.existsSync(paths.config);

  if (hasPublic && !hasPrivate) {
    throw new Error(
      "The shared public certificate already exists; retrieve the matching private PFX through the team secret store.",
    );
  }
  if (hasPublic && hasPrivate && hasConfig) {
    loadWindowsTestSigningConfig({ root });
    log(`[windows-test-certificate] ready: ${paths.privateCertificate}`);
    return { ...paths, created: false };
  }
  if (hasPublic || hasPrivate || hasConfig) {
    throw new Error(
      "Incomplete Windows test-signing files; remove the partial private files or restore the matching shared certificate.",
    );
  }

  fs.mkdirSync(path.dirname(paths.publicCertificate), { recursive: true });
  fs.mkdirSync(path.dirname(paths.privateCertificate), { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(
    path.join(path.dirname(paths.privateCertificate), ".generate-"),
  );
  const privateKey = path.join(temporaryDirectory, "private-key.pem");
  const pemCertificate = path.join(temporaryDirectory, "certificate.pem");
  const password = randomPassword();

  try {
    runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-days",
      "825",
      "-nodes",
      "-keyout",
      privateKey,
      "-out",
      pemCertificate,
      "-subj",
      "/CN=WeMail Test Publisher/O=WeMail Development/OU=Internal Testing",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=codeSigning",
    ], { spawn });
    runOpenSsl([
      "pkcs12",
      "-export",
      "-out",
      paths.privateCertificate,
      "-inkey",
      privateKey,
      "-in",
      pemCertificate,
      "-name",
      WINDOWS_TEST_PUBLISHER,
      "-passout",
      "env:WEMAIL_TEST_PFX_PASSWORD",
    ], { password, spawn });
    runOpenSsl([
      "x509",
      "-in",
      pemCertificate,
      "-outform",
      "DER",
      "-out",
      paths.publicCertificate,
    ], { spawn });
    fs.writeFileSync(
      paths.config,
      `${JSON.stringify({
        pfxPath: PFX_RELATIVE_PATH,
        password,
        publisherName: WINDOWS_TEST_PUBLISHER,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    fs.chmodSync(paths.config, 0o600);
    log(`[windows-test-certificate] created: ${paths.privateCertificate}`);
    log(`[windows-test-certificate] public certificate: ${paths.publicCertificate}`);
    return { ...paths, created: true };
  } catch (error) {
    fs.rmSync(paths.privateCertificate, { force: true });
    fs.rmSync(paths.publicCertificate, { force: true });
    fs.rmSync(paths.config, { force: true });
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  createWindowsTestCertificate({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  });
}
