import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadWindowsSelfSignedBuildEnvironment,
  runWindowsSelfSignedBuild,
} from "../../scripts/package-windows-self-signed.mjs";
import { getWindowsTestCertificatePaths } from "../../scripts/windows-test-certificate.mjs";

function createSigningFiles(root) {
  const paths = getWindowsTestCertificatePaths(root);
  fs.mkdirSync(path.dirname(paths.publicCertificate), { recursive: true });
  fs.mkdirSync(path.dirname(paths.privateCertificate), { recursive: true });
  fs.copyFileSync(
    path.resolve("packaging", "windows", "certificates", "WeMail-Test.cer"),
    paths.publicCertificate,
  );
  fs.writeFileSync(paths.privateCertificate, "pfx");
  fs.writeFileSync(
    paths.config,
    JSON.stringify({
      pfxPath: path.join(
        "workspace",
        "signing",
        "private",
        "WeMail-Test.pfx",
      ),
      password: "private-password",
      publisherName: "WeMail Test Publisher",
    }),
  );
  return paths;
}

test("rejects packaging when the ignored signing configuration is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-package-"));
  try {
    assert.throws(
      () => loadWindowsSelfSignedBuildEnvironment({ root }),
      /run npm run certificate:windows:test/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passes the self-signed certificate to the Windows build without logging it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-package-"));
  try {
    const paths = createSigningFiles(root);
    let invocation;
    const logs = [];
    const result = runWindowsSelfSignedBuild({
      root,
      platform: "win32",
      log: (message) => logs.push(message),
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });

    assert.equal(result.status, 0);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [
      path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(root, "scripts", "package-release.mjs"),
      "win32",
      "x64",
    ]);
    assert.equal(invocation.options.env.CSC_LINK, paths.privateCertificate);
    assert.equal(invocation.options.env.CSC_KEY_PASSWORD, "private-password");
    assert.equal(
      invocation.options.env.WEMAIL_WINDOWS_PUBLISHER,
      "WeMail Test Publisher",
    );
    assert.equal(
      invocation.options.env.WEMAIL_UPDATE_BASE_URL,
      "https://updates.example.com/downloads/",
    );
    assert.equal(
      invocation.options.env.WEMAIL_UPDATE_FALLBACK_BASE_URL,
      "https://updates.example.com/downloads/",
    );
    assert.equal(invocation.options.env.WEMAIL_SELF_SIGN_AFTER_PACK, "1");
    assert.match(invocation.options.env.WEMAIL_SIGNING_THUMBPRINT, /^[A-F0-9]{40}$/i);
    assert.doesNotMatch(logs.join("\n"), /private-password/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects native self-signed packaging outside Windows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-package-"));
  try {
    createSigningFiles(root);

    assert.throws(
      () => runWindowsSelfSignedBuild({ root, platform: "linux" }),
      /native Windows host/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not place the certificate password value in Docker command arguments", () => {
  const script = fs.readFileSync(
    path.resolve("scripts", "build-windows.sh"),
    "utf8",
  );

  assert.match(script, /-e CSC_KEY_PASSWORD/);
  assert.doesNotMatch(script, /CSC_KEY_PASSWORD=\$\{CSC_KEY_PASSWORD\}/);
});
