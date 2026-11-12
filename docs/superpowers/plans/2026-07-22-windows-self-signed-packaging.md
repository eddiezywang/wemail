# Windows Self-Signed Test Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and safely reuse a local WeMail Windows test-signing certificate, then pass it into the existing Docker/Wine NSIS packaging flow.

**Architecture:** A Node ESM certificate module owns deterministic paths, OpenSSL invocation, private JSON configuration, and validation. A second Node entry point loads the ignored configuration and invokes the existing Windows build script, while that shell script translates repository-local host certificate paths into the `/app` Docker mount. Production release signing remains unchanged.

**Tech Stack:** Node.js ESM, OpenSSL, Docker/Wine, electron-builder, `node:test`.

---

### Task 1: Certificate Model and Generation

**Files:**
- Create: `scripts/windows-test-certificate.mjs`
- Create: `tests/scripts/windows-test-certificate.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tests**

Cover deterministic public/private/config paths, refusal to replace an existing public certificate when the private PFX is missing, and secure configuration parsing without logging the password.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/scripts/windows-test-certificate.test.mjs`

Expected: FAIL because the certificate module does not exist.

- [ ] **Step 3: Implement certificate generation**

Generate an RSA 3072 SHA-256 self-signed Code Signing certificate with subject `CN=WeMail Test Publisher, O=WeMail Development, OU=Internal Testing`. Write the public DER certificate to `workspace/signing/public/WeMail-Test.cer`, the private PKCS#12 file to `workspace/signing/private/WeMail-Test.pfx`, and an ignored mode-0600 JSON configuration containing the relative PFX path, random password, and publisher name.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/scripts/windows-test-certificate.test.mjs`

Expected: all tests pass.

### Task 2: Self-Signed Packaging Command

**Files:**
- Create: `scripts/package-windows-self-signed.mjs`
- Create: `tests/scripts/package-windows-self-signed.test.mjs`
- Modify: `scripts/build-windows.sh`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Assert that the package runner rejects missing configuration/PFX files and passes `CSC_LINK`, `CSC_KEY_PASSWORD`, and `WEMAIL_WINDOWS_PUBLISHER` to the build process without printing secrets.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/scripts/package-windows-self-signed.test.mjs`

Expected: FAIL because the package runner does not exist.

- [ ] **Step 3: Implement the runner and Docker path translation**

Add `certificate:windows:test` and `package:windows:self-signed` npm scripts. The self-signed runner loads the ignored JSON and invokes `build-windows.sh`. The shell script maps any repository-local `CSC_LINK` to `/app/<relative-path>` and forwards signing variables into Docker.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/scripts/windows-test-certificate.test.mjs tests/scripts/package-windows-self-signed.test.mjs`

Expected: all tests pass.

### Task 3: Generate and Validate the Shared Test Certificate

**Files:**
- Create: `workspace/signing/public/WeMail-Test.cer`
- Create ignored: `workspace/signing/private/WeMail-Test.pfx`
- Create ignored: `workspace/signing/private/windows-test-signing.json`

- [ ] **Step 1: Generate certificate**

Run: `npm run certificate:windows:test`

Expected: public and private files are created without printing the password.

- [ ] **Step 2: Validate certificate and PFX**

Use OpenSSL to confirm the subject, Code Signing extended key usage, and that the PFX opens with the ignored configuration password. Never print the password.

### Task 4: Documentation and Verification

**Files:**
- Modify: `docs/build/windows-build.md`

- [ ] Document generation, secure PFX sharing, public certificate trust installation, packaging command, and the prohibition on production use.
- [ ] Run both focused test files.
- [ ] Run `npm run typecheck:desktop`.
- [ ] Run `git diff --check` and confirm only the public certificate is tracked under `workspace/signing`.
- [ ] Commit with a focused Conventional Commit message.
