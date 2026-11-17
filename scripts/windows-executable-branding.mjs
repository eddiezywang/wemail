import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const WEMAIL_EXECUTABLE_BRANDING_VERSION = 3;

export function getDesktopExecutableName() {
  return "WeMailDesktop.exe";
}

export function buildRceditArgs({
  executablePath,
  iconPath,
  internalName,
  originalFilename,
  version,
}) {
  return [
    executablePath,
    "--set-icon",
    iconPath,
      "--set-version-string",
      "FileDescription",
      "WeMail",
      "--set-version-string",
      "ProductName",
      "WeMail",
      "--set-version-string",
      "InternalName",
      internalName,
      "--set-version-string",
      "OriginalFilename",
      originalFilename,
      ...(version
        ? [
            "--set-file-version",
            version,
            "--set-product-version",
            version,
          ]
        : []),
  ];
}

function brandingFingerprint(
  executablePath,
  iconPath,
  internalName,
  originalFilename,
  version,
) {
  // Include the executable's size + mtime so a marker left behind by a prior
  // build can never cause branding to be skipped on an exe that was since
  // replaced (e.g. re-copied from a fresh electron.exe). Without this, rcedit
  // is silently skipped and the exe keeps raw Electron metadata + no icon.
  const stat = fs.statSync(executablePath);
  return crypto
    .createHash("sha256")
    .update(String(WEMAIL_EXECUTABLE_BRANDING_VERSION))
    .update(fs.readFileSync(iconPath))
    .update(internalName)
    .update(originalFilename)
    .update(version ?? "")
    .update(`exe:${stat.size}:${Math.floor(stat.mtimeMs)}`)
    .digest("hex");
}

export function brandWindowsExecutable({
  executablePath,
  iconPath,
  internalName = "WeMail",
  originalFilename = path.basename(executablePath),
  version,
  markerPath = `${executablePath}.wemail-branding.json`,
  platform = process.platform,
  rceditPath,
  spawnSyncImpl = spawnSync,
}) {
  if (platform !== "win32") {
    return { branded: false, skipped: true, markerPath };
  }

  for (const requiredPath of [executablePath, iconPath, rceditPath]) {
    if (!requiredPath || !fs.existsSync(requiredPath)) {
      throw new Error(`required executable branding file not found: ${requiredPath}`);
    }
  }

  const fingerprint = brandingFingerprint(
    executablePath,
    iconPath,
    internalName,
    originalFilename,
    version,
  );
  try {
    const current = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (current.fingerprint === fingerprint) {
      return { branded: false, skipped: false, markerPath };
    }
  } catch {
    // Missing or invalid markers are repaired below.
  }

  const args = buildRceditArgs({
    executablePath,
    iconPath,
    internalName,
    originalFilename,
    version,
  });
  const result = spawnSyncImpl(rceditPath, args, {
    cwd: path.dirname(executablePath),
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `rcedit failed (${result.status ?? "signal"}): ${result.stderr || result.stdout}`,
    );
  }

  // rcedit rewrote the exe (mtime changed); recompute the fingerprint from the
  // now-branded exe so the marker matches on the next run and branding is
  // skipped only while the exe truly stays unchanged.
  const brandedFingerprint = brandingFingerprint(
    executablePath,
    iconPath,
    internalName,
    originalFilename,
    version,
  );
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({ fingerprint: brandedFingerprint, version: WEMAIL_EXECUTABLE_BRANDING_VERSION })}\n`,
  );
  return { branded: true, skipped: false, markerPath };
}
