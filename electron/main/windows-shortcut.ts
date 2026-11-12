import type { App } from "electron";
import { shell } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const WEMAIL_APP_USER_MODEL_ID = "com.wemail.app";

interface ShortcutApp {
  isPackaged: boolean;
  getPath: (name: "appData") => string;
  getAppPath?: () => string;
}

interface EnsureWindowsAppShortcutOptions {
  app: ShortcutApp;
  iconPath: string | undefined;
  appUserModelId?: string;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  readShortcutLink?: typeof shell.readShortcutLink;
  removeShortcutLink?: (shortcutPath: string) => void;
  setShortcutIconLocation?: (shortcutPath: string, iconLocation: string) => void;
  writeShortcutLink?: typeof shell.writeShortcutLink;
}

export interface EnsureWindowsAppShortcutResult {
  shortcutPath: string | null;
  written: boolean;
}

export function ensureWindowsAppShortcutWith({
  app,
  iconPath,
  appUserModelId = WEMAIL_APP_USER_MODEL_ID,
  platform = process.platform,
  processExecPath = process.execPath,
  readShortcutLink,
  removeShortcutLink = (shortcutPath) => fs.rmSync(shortcutPath, { force: true }),
  setShortcutIconLocation = setWindowsShortcutIconLocation,
  writeShortcutLink,
}: EnsureWindowsAppShortcutOptions): EnsureWindowsAppShortcutResult {
  if (platform !== "win32") {
    return { shortcutPath: null, written: false };
  }

  const readLink =
    readShortcutLink ??
    shell?.readShortcutLink ??
    (() => {
      throw new Error("Shortcut read is unavailable");
    });
  const writeLink = writeShortcutLink ?? shell.writeShortcutLink;

  const programsPath = path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const packagedShortcutPath = path.join(programsPath, "WeMail.lnk");
  if (!app.isPackaged) {
    try {
      const packagedShortcut = readLink(packagedShortcutPath);
      if (packagedShortcut.appUserModelId === appUserModelId) {
        return { shortcutPath: packagedShortcutPath, written: false };
      }
    } catch {
      // A development identity shortcut is created below when no packaged
      // shortcut already owns the stable AppUserModelID.
    }
  }
  const shortcutPath = app.isPackaged
    ? packagedShortcutPath
    : path.join(programsPath, "WeMail Development.lnk");
  const legacyShortcutPath = path.join(programsPath, "Electron.lnk");
  try {
    const legacy = readLink(legacyShortcutPath);
    if (
      legacy.appUserModelId === WEMAIL_APP_USER_MODEL_ID &&
      path.basename(legacy.target ?? "").toLowerCase() === "electron.exe"
    ) {
      removeShortcutLink(legacyShortcutPath);
    }
  } catch {
    // Missing or unrelated legacy Electron shortcuts need no cleanup.
  }
  const shortcutDetails = {
    appUserModelId,
    cwd: path.dirname(processExecPath),
    icon: iconPath ?? processExecPath,
    iconIndex: 0,
    target: processExecPath,
    ...(!app.isPackaged && app.getAppPath
      ? { args: quoteWindowsArgument(app.getAppPath()) }
      : {}),
  };

  try {
    const existing = readLink(shortcutPath);
    const normalize = (value: string | undefined) =>
      path.normalize(value ?? "").toLowerCase();
    if (
      existing.appUserModelId === shortcutDetails.appUserModelId &&
      normalize(existing.cwd) === normalize(shortcutDetails.cwd) &&
      normalize(existing.icon) === normalize(shortcutDetails.icon) &&
      normalize(existing.target) === normalize(shortcutDetails.target)
    ) {
      if (iconPath) {
        try {
          setShortcutIconLocation(shortcutPath, `${iconPath},0`);
        } catch {
          // Shortcut identity is already correct; icon repair is best-effort.
        }
      }
      return { shortcutPath, written: false };
    }
  } catch {
    // Missing or unreadable shortcuts are repaired below.
  }

  const written = writeLink(shortcutPath, "replace", shortcutDetails);
  if (written && iconPath) {
    try {
      setShortcutIconLocation(shortcutPath, `${iconPath},0`);
    } catch {
      // Icon cache repair is best-effort. The shortcut target/AppUserModelID
      // still matters more and app startup must not be blocked by WSH quirks.
    }
  }

  return { shortcutPath, written };
}

export function ensureWindowsAppShortcut(
  app: App,
  iconPath: string | undefined,
  appUserModelId = WEMAIL_APP_USER_MODEL_ID,
): EnsureWindowsAppShortcutResult {
  return ensureWindowsAppShortcutWith({ app, iconPath, appUserModelId });
}

export function setWindowsShortcutIconLocation(
  shortcutPath: string,
  iconLocation: string,
) {
  const script = [
    "$shortcutPath = $env:WEMAIL_SHORTCUT_PATH",
    "$iconLocation = $env:WEMAIL_SHORTCUT_ICON",
    "$wsh = New-Object -ComObject WScript.Shell",
    "$shortcut = $wsh.CreateShortcut($shortcutPath)",
    "$shortcut.IconLocation = $iconLocation",
    "$shortcut.Save()",
  ].join("\n");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      env: {
        ...process.env,
        WEMAIL_SHORTCUT_ICON: iconLocation,
        WEMAIL_SHORTCUT_PATH: shortcutPath,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll("\"", "\\\"")}"`;
}
