import assert from "node:assert/strict";
import test from "node:test";
import {
  EDITION_IDENTITY_FILENAME,
  OPEN_EDITION_OVERLAY_ID,
  assertPackagingEditionIdentity,
  editionIdentityFromEnv,
} from "./edition-identity.mjs";

/**
 * Regression coverage for the P1 packaging guard (codex round-4 note):
 * edition identity is derived from env + overlay bytes, and packaging must
 * reject any cached build whose recorded identity does not match the
 * edition the current environment selects — in BOTH directions.
 *
 * Run with: node --test scripts/edition-identity.test.mjs
 */
const overlayPath = "C:/internal/build-overlay.json";
const overlayV1 = Buffer.from('{"profile":"internal","v":1}');
const overlayV2 = Buffer.from('{"profile":"internal","v":2}');
const root = "C:/repo";
const editionDir = `${root}/build/edition`;
const runtimePath = `${editionDir}/edition-runtime.json`;
const identityPath = `${editionDir}/${EDITION_IDENTITY_FILENAME}`;

function overlayHash(content) {
  return editionIdentityFromEnv({ WEMAIL_EDITION_OVERLAY: overlayPath }, () => content).overlay;
}

function harness({ recorded, overlayContent = overlayV1, runtimeExists = true } = {}) {
  const files = new Map([
    [overlayPath, overlayContent],
    [runtimePath, runtimeExists ? "{}" : undefined],
  ]);
  if (recorded !== undefined) {
    files.set(identityPath, JSON.stringify(recorded));
  }
  const readFileSync = (file) => {
    const key = file.replace(/\\/g, "/");
    const value = files.get(key);
    if (value === undefined) throw new Error(`ENOENT: ${key}`);
    return value;
  };
  const existsSync = (file) => {
    const key = file.replace(/\\/g, "/");
    return files.has(key) && files.get(key) !== undefined;
  };
  return { readFileSync, existsSync };
}

const openIdentity = { profile: "open", overlay: OPEN_EDITION_OVERLAY_ID };
function internalIdentity(content = overlayV1) {
  return { profile: "internal", overlay: overlayHash(content) };
}

test("no overlay selects the open-default identity", () => {
  assert.deepEqual(editionIdentityFromEnv({}, () => overlayV1), openIdentity);
  assert.deepEqual(
    editionIdentityFromEnv({ WEMAIL_EDITION_OVERLAY: "   " }, () => overlayV1),
    openIdentity,
  );
});

test("overlay identity hashes the exact overlay bytes", () => {
  const a = editionIdentityFromEnv({ WEMAIL_EDITION_OVERLAY: overlayPath }, () => overlayV1);
  const b = editionIdentityFromEnv({ WEMAIL_EDITION_OVERLAY: overlayPath }, () => overlayV2);
  assert.equal(a.profile, "internal");
  assert.match(a.overlay, /^[a-f0-9]{64}$/);
  assert.notEqual(a.overlay, b.overlay);
});

test("matching identity passes for both editions", () => {
  const open = harness({ recorded: openIdentity });
  assert.deepEqual(
    assertPackagingEditionIdentity({ root, env: {}, ...open }),
    openIdentity,
  );
  const env = { WEMAIL_EDITION_OVERLAY: overlayPath };
  const internal = harness({ recorded: internalIdentity() });
  assert.deepEqual(
    assertPackagingEditionIdentity({ root, env, ...internal }),
    internalIdentity(),
  );
});

test("internal -> open: cached internal build is rejected for open packaging", () => {
  const fsStub = harness({ recorded: internalIdentity() });
  assert.throws(
    () => assertPackagingEditionIdentity({ root, env: {}, ...fsStub }),
    /edition mismatch: cached desktop build is internal\/sha256:.* but packaging expects open\/open-default/,
  );
});

test("open -> internal: cached open build is rejected for internal packaging", () => {
  const env = { WEMAIL_EDITION_OVERLAY: overlayPath };
  const fsStub = harness({ recorded: openIdentity });
  assert.throws(
    () => assertPackagingEditionIdentity({ root, env, ...fsStub }),
    /edition mismatch: cached desktop build is open\/open-default but packaging expects internal\/sha256:/,
  );
});

test("overlay content change invalidates the cached build", () => {
  const env = { WEMAIL_EDITION_OVERLAY: overlayPath };
  // Identity recorded when overlayV1 was active; overlay file now holds v2.
  const fsStub = harness({ recorded: internalIdentity(overlayV1), overlayContent: overlayV2 });
  assert.throws(
    () => assertPackagingEditionIdentity({ root, env, ...fsStub }),
    /edition mismatch/,
  );
});

test("missing or malformed identity record forces a rebuild", () => {
  const env = { WEMAIL_EDITION_OVERLAY: overlayPath };
  const noRecord = harness({ recorded: undefined });
  assert.throws(
    () => assertPackagingEditionIdentity({ root, env, ...noRecord }),
    /no recorded edition identity/,
  );
  // A present-but-corrupt record is treated as missing, not trusted.
  const corrupt = harness({ recorded: undefined });
  corrupt.readFileSync = ((original) => (file) => {
    if (file.replace(/\\/g, "/") === identityPath) return "{not json";
    return original(file);
  })(corrupt.readFileSync);
  assert.throws(
    () => assertPackagingEditionIdentity({ root, env, ...corrupt }),
    /no recorded edition identity/,
  );
});

test("missing edition-runtime.json forces a rebuild", () => {
  const env = { WEMAIL_EDITION_OVERLAY: overlayPath };
  const fsStub = harness({ recorded: internalIdentity(), runtimeExists: false });
  assert.throws(
    () => assertPackagingEditionIdentity({ root, env, ...fsStub }),
    /no edition-runtime.json/,
  );
});

test("unreadable overlay fails closed instead of falling back to open", () => {
  assert.throws(
    () =>
      editionIdentityFromEnv(
        { WEMAIL_EDITION_OVERLAY: overlayPath },
        () => { throw new Error("EACCES"); },
      ),
    /unreadable file/,
  );
});
