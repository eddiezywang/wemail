import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureWindowsAppShortcutWith } from "./windows-shortcut.js";

// The product builds shortcut paths with the platform-native `path.join`, even
// when the inputs are Windows-style drive paths. Build every fixture and every
// expectation the same way so the Windows-only shortcut logic stays testable
// on Linux CI runners (POSIX `path.join` keeps forward slashes).
const appData = "C:/Users/Administrator/AppData/Roaming";
const packagedDir = "D:/git/wemail/dist/win-unpacked";
const packagedExe = path.join(packagedDir, "WeMail.exe");
const packagedIcon = path.join(packagedDir, "resources", "assets", "wemail.ico");
const devIcon = path.join("D:/git/wemail", "electron", "assets", "wemail.ico");
const devElectronExe = path.join(
  "D:/git/wemail",
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const programsPath = path.join(
  appData,
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
);

describe("windows shortcut", () => {
  it("skips rewriting an existing packaged shortcut when it already points at the app", () => {
    const writeShortcutLink = vi.fn(() => true);
    const setShortcutIconLocation = vi.fn();
    const readShortcutLink = vi.fn(() => ({
      appUserModelId: "com.wemail.app",
      cwd: packagedDir,
      icon: packagedIcon,
      iconIndex: 0,
      target: packagedExe,
    }));

    const result = ensureWindowsAppShortcutWith({
      app: {
        isPackaged: true,
        getPath: () => appData,
      },
      iconPath: packagedIcon,
      platform: "win32",
      processExecPath: packagedExe,
      readShortcutLink,
      setShortcutIconLocation,
      writeShortcutLink,
    });

    expect(result.written).toBe(false);
    expect(readShortcutLink).toHaveBeenCalledWith(result.shortcutPath);
    expect(writeShortcutLink).not.toHaveBeenCalled();
    expect(setShortcutIconLocation).toHaveBeenCalledWith(
      result.shortcutPath,
      `${packagedIcon},0`,
    );
  });

  it("creates a packaged Windows shortcut with the WeMail icon and AppUserModelID", () => {
    const writeShortcutLink = vi.fn(() => true);
    const setShortcutIconLocation = vi.fn();
    const result = ensureWindowsAppShortcutWith({
      app: {
        isPackaged: true,
        getPath: () => appData,
      },
      iconPath: packagedIcon,
      platform: "win32",
      processExecPath: packagedExe,
      setShortcutIconLocation,
      writeShortcutLink,
    });

    expect(result).toEqual({
      shortcutPath: path.join(programsPath, "WeMail.lnk"),
      written: true,
    });
    expect(writeShortcutLink).toHaveBeenCalledWith(result.shortcutPath, "replace", {
      appUserModelId: "com.wemail.app",
      cwd: path.dirname(packagedExe),
      icon: packagedIcon,
      iconIndex: 0,
      target: packagedExe,
    });
    expect(setShortcutIconLocation).toHaveBeenCalledWith(
      result.shortcutPath,
      `${packagedIcon},0`,
    );
  });

  it("reuses a packaged shortcut for the desktop dev shell", () => {
    const writeShortcutLink = vi.fn(() => true);
    const setShortcutIconLocation = vi.fn();
    const readShortcutLink = vi.fn(() => ({
      appUserModelId: "com.wemail.app",
      target: packagedExe,
    }));
    const result = ensureWindowsAppShortcutWith({
      app: {
        isPackaged: false,
        getPath: () => appData,
      },
      iconPath: devIcon,
      platform: "win32",
      processExecPath: devElectronExe,
      readShortcutLink,
      setShortcutIconLocation,
      writeShortcutLink,
    });

    expect(result.shortcutPath).toBe(path.join(programsPath, "WeMail.lnk"));
    expect(result.written).toBe(false);
    expect(writeShortcutLink).not.toHaveBeenCalled();
    expect(setShortcutIconLocation).not.toHaveBeenCalled();
  });

  it("creates a development identity shortcut when no packaged shortcut exists", () => {
    const writeShortcutLink = vi.fn(() => true);
    const result = ensureWindowsAppShortcutWith({
      app: {
        isPackaged: false,
        getPath: () => appData,
        getAppPath: () => "D:\\git\\wemail",
      },
      iconPath: devIcon,
      platform: "win32",
      processExecPath: "D:/electron/electron.exe",
      readShortcutLink: vi.fn(() => {
        throw new Error("missing");
      }),
      setShortcutIconLocation: vi.fn(),
      writeShortcutLink,
    });

    expect(result.shortcutPath).toContain("WeMail Development.lnk");
    expect(writeShortcutLink).toHaveBeenCalledWith(
      result.shortcutPath,
      "replace",
      expect.objectContaining({
        appUserModelId: "com.wemail.app",
        args: '"D:\\git\\wemail"',
        target: "D:/electron/electron.exe",
      }),
    );
  });

  it("does not fail startup when the icon location repair fails", () => {
    const writeShortcutLink = vi.fn(() => true);
    const setShortcutIconLocation = vi.fn(() => {
      throw new Error("shortcut icon cache is locked");
    });

    const result = ensureWindowsAppShortcutWith({
      app: {
        isPackaged: true,
        getPath: () => appData,
      },
      iconPath: packagedIcon,
      platform: "win32",
      processExecPath: packagedExe,
      setShortcutIconLocation,
      writeShortcutLink,
    });

    expect(result.written).toBe(true);
  });

  it("removes the stale Electron shortcut that owns the WeMail AppUserModelID", () => {
    const removeShortcutLink = vi.fn();
    const writeShortcutLink = vi.fn(() => true);
    const legacyElectronExe = path.join(
      "E:/wemail-build-cache",
      "electron",
      "runtime",
      "41.3.0",
      "win32-x64",
      "electron.exe",
    );
    const readShortcutLink = vi.fn((shortcutPath: string) => {
      if (shortcutPath.endsWith("Electron.lnk")) {
        return {
          appUserModelId: "com.wemail.app",
          target: legacyElectronExe,
        };
      }
      throw new Error("missing WeMail shortcut");
    });

    ensureWindowsAppShortcutWith({
      app: {
        isPackaged: true,
        getPath: () => appData,
      },
      appUserModelId: "D:/git/wemail/node_modules/electron/dist/WeMailDesktop.exe",
      iconPath: devIcon,
      platform: "win32",
      processExecPath: "D:/git/wemail/node_modules/electron/dist/WeMailDesktop.exe",
      readShortcutLink,
      removeShortcutLink,
      setShortcutIconLocation: vi.fn(),
      writeShortcutLink,
    });

    expect(removeShortcutLink).toHaveBeenCalledWith(
      path.join(programsPath, "Electron.lnk"),
    );
    expect(writeShortcutLink).toHaveBeenCalledWith(
      expect.any(String),
      "replace",
      expect.objectContaining({
        appUserModelId: "D:/git/wemail/node_modules/electron/dist/WeMailDesktop.exe",
      }),
    );
  });
});
