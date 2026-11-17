#!/usr/bin/env node
/**
 * Edition build identity — single source of truth for binding a desktop
 * build's `build/edition/edition-runtime.json` to the edition inputs that
 * produced it (P1 packaging guard).
 *
 * `scripts/write-edition-config.ts` records the identity next to the runtime
 * config every time it regenerates it; `scripts/package-desktop-win-dir.mjs`
 * recomputes the identity the *current* environment expects and refuses to
 * reuse/copy a build recorded for a different edition. Without this, an
 * internal build followed by `npm run package:desktop:unpacked` with
 * WEMAIL_EDITION_OVERLAY cleared would silently ship the internal
 * edition-runtime.json inside an "open" package (and vice versa).
 *
 * Identity = { profile, overlay } where overlay is the sha256 of the overlay
 * file bytes, or the sentinel "open-default" when no overlay is configured.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EDITION_IDENTITY_FILENAME = ".edition-identity.json";
export const OPEN_EDITION_OVERLAY_ID = "open-default";

/**
 * Identity the current environment expects. No WEMAIL_EDITION_OVERLAY (or
 * blank) → the open default; an overlay → internal + sha256 of its bytes.
 * Mirrors the generator's rules exactly (overlay profile must be internal).
 */
export function editionIdentityFromEnv(env = process.env, readFileSync = fs.readFileSync) {
  const overlayPath = env.WEMAIL_EDITION_OVERLAY?.trim();
  if (!overlayPath) {
    return { profile: "open", overlay: OPEN_EDITION_OVERLAY_ID };
  }
  let content;
  try {
    content = readFileSync(overlayPath);
  } catch {
    throw new Error(
      `[edition-identity] WEMAIL_EDITION_OVERLAY points to an unreadable file: ${overlayPath}`,
    );
  }
  return { profile: "internal", overlay: createHash("sha256").update(content).digest("hex") };
}

/** Identity recorded by the last `write-edition-config` run, or null. */
export function recordedEditionIdentity(
  buildEditionDirectory,
  readFileSync = fs.readFileSync,
) {
  let raw;
  try {
    raw = readFileSync(path.join(buildEditionDirectory, EDITION_IDENTITY_FILENAME), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      (parsed.profile === "open" || parsed.profile === "internal") &&
      typeof parsed.overlay === "string" &&
      parsed.overlay.length > 0
    ) {
      return { profile: parsed.profile, overlay: parsed.overlay };
    }
  } catch {
    // Malformed identity files count as "not recorded" — force a rebuild.
  }
  return null;
}

function describeIdentity(identity) {
  return identity.overlay === OPEN_EDITION_OVERLAY_ID
    ? `${identity.profile}/open-default`
    : `${identity.profile}/sha256:${identity.overlay.slice(0, 12)}`;
}

/**
 * Packaging gate: the build being packaged must have been produced for the
 * edition the current environment selects. Returns the verified expected
 * identity; throws (with a re-run build:desktop hint) on any mismatch,
 * missing identity record, or missing edition-runtime.json — before any
 * credential-bearing artifact is copied into the package.
 */
export function assertPackagingEditionIdentity({
  root,
  env = process.env,
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
}) {
  const editionDirectory = path.join(root, "build", "edition");
  const expected = editionIdentityFromEnv(env, readFileSync);
  const runtimeExists = existsSync(path.join(editionDirectory, "edition-runtime.json"));
  const recorded = recordedEditionIdentity(editionDirectory, readFileSync);
  if (!runtimeExists || !recorded) {
    throw new Error(
      `[edition-identity] build/edition has ${
        runtimeExists ? "no recorded edition identity" : "no edition-runtime.json"
      }; re-run \`npm run build:desktop\` (with the intended WEMAIL_EDITION_OVERLAY) before packaging`,
    );
  }
  if (recorded.profile !== expected.profile || recorded.overlay !== expected.overlay) {
    throw new Error(
      `[edition-identity] edition mismatch: cached desktop build is ${describeIdentity(recorded)} ` +
        `but packaging expects ${describeIdentity(expected)}. ` +
        "Re-run `npm run build:desktop` with the same WEMAIL_EDITION_OVERLAY before packaging.",
    );
  }
  return expected;
}
