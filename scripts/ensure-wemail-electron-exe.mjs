import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandWindowsExecutable } from "./windows-executable-branding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const sourceExe = path.join(electronDist, "electron.exe");
const targetExe = path.join(electronDist, "WeMailDesktop.exe");
const brandingMarker = `${targetExe}.wemail-branding.json`;
const iconPath = path.join(root, "electron", "assets", "wemail.ico");
const rceditExe = path.join(
  root,
  "node_modules",
  "electron-winstaller",
  "vendor",
  "rcedit.exe",
);

function statMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function shouldRefresh() {
  if (!fs.existsSync(targetExe)) return true;
  if (!fs.existsSync(brandingMarker)) return true;
  return (
    statMtime(targetExe) < statMtime(sourceExe) ||
    statMtime(targetExe) < statMtime(iconPath)
  );
}

if (process.platform !== "win32") {
  process.stdout.write("[wemail] non-Windows platform; no dev exe patch needed\n");
} else {
  for (const required of [sourceExe, iconPath, rceditExe]) {
    if (!fs.existsSync(required)) {
      throw new Error(`required file not found: ${required}`);
    }
  }

  if (shouldRefresh()) {
    fs.copyFileSync(sourceExe, targetExe);
    fs.rmSync(brandingMarker, { force: true });
  }
  const branding = brandWindowsExecutable({
    executablePath: targetExe,
    iconPath,
    internalName: "WeMailDesktop",
    originalFilename: "WeMailDesktop.exe",
    markerPath: brandingMarker,
    rceditPath: rceditExe,
  });
  process.stdout.write(
    `[wemail] ${branding.branded ? "prepared" : "ready"} ${targetExe}\n`,
  );
}
