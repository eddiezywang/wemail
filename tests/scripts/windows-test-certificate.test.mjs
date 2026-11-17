import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWindowsTestCertificate,
  getWindowsTestCertificatePaths,
  loadWindowsTestSigningConfig,
} from "../../scripts/windows-test-certificate.mjs";

test("uses tracked public and ignored private certificate paths", () => {
  const paths = getWindowsTestCertificatePaths("/repo");

  assert.equal(
    paths.publicCertificate,
    path.join("/repo", "packaging", "windows", "certificates", "WeMail-Test.cer"),
  );
  assert.equal(
    paths.privateCertificate,
    path.join("/repo", "workspace", "signing", "private", "WeMail-Test.pfx"),
  );
  assert.equal(
    paths.config,
    path.join(
      "/repo",
      "workspace",
      "signing",
      "private",
      "windows-test-signing.json",
    ),
  );
});

test("refuses to replace a shared public certificate when its PFX is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-cert-"));
  try {
    const paths = getWindowsTestCertificatePaths(root);
    fs.mkdirSync(path.dirname(paths.publicCertificate), { recursive: true });
    fs.writeFileSync(paths.publicCertificate, "shared-public-certificate");

    assert.throws(
      () => createWindowsTestCertificate({ root }),
      /retrieve the matching private PFX/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loads the ignored signing configuration without exposing its password", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-cert-"));
  try {
    const paths = getWindowsTestCertificatePaths(root);
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(
      paths.config,
      JSON.stringify({
        pfxPath: "workspace/signing/private/WeMail-Test.pfx",
        password: "private-password",
        publisherName: "WeMail Test Publisher",
      }),
    );

    const config = loadWindowsTestSigningConfig({ root });

    assert.equal(config.pfxPath, paths.privateCertificate);
    assert.equal(config.password, "private-password");
    assert.equal(config.publisherName, "WeMail Test Publisher");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loads a signing configuration with a UTF-8 BOM", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-cert-"));
  try {
    const paths = getWindowsTestCertificatePaths(root);
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(
      paths.config,
      `\uFEFF${JSON.stringify({
        pfxPath: "workspace/signing/private/WeMail-Test.pfx",
        password: "private-password",
        publisherName: "WeMail Test Publisher",
      })}`,
    );

    const config = loadWindowsTestSigningConfig({ root });

    assert.equal(config.password, "private-password");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects absolute and escaping signing PFX paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-cert-"));
  try {
    const paths = getWindowsTestCertificatePaths(root);
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    for (const pfxPath of [
      path.join(root, "workspace", "signing", "private", "WeMail-Test.pfx"),
      "../workspace/signing/private/WeMail-Test.pfx",
    ]) {
      fs.writeFileSync(
        paths.config,
        JSON.stringify({
          pfxPath,
          password: "private-password",
          publisherName: "WeMail Test Publisher",
        }),
      );

      assert.throws(
        () => loadWindowsTestSigningConfig({ root }),
        /Invalid Windows test-signing configuration/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
