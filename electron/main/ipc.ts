import path from "node:path";
import fs from "node:fs";
import type { App, BrowserWindow } from "electron";
import { createShortcutController } from "./shortcuts.js";
import { clipboard, dialog, ipcMain, safeStorage, screen, shell } from "electron";
import yazl from "yazl";
import {
  createDesktopDirectorySearch,
  type DirectorySearchRuntime,
} from "./directory-search.js";
import { createExternalLinkOpener } from "./external-links.js";
import { setStartAtLogin } from "./startup.js";
import type { TelemetryClient } from "./telemetry/TelemetryClient.js";
import {
  isTelemetryEventName,
  validateTelemetryArgs,
} from "../../shared/wemail/telemetry.js";
import { openWindowsNotificationSettingsWith } from "./windows-notification-settings.js";
import type { NotificationCoordinator } from "./notification-coordinator.js";
import {
  buildAgentConfirmationNotification,
  buildAgentRunNotification,
} from "./renderer-notification-events.js";
import type { McpListenerController } from "../../server/wemail/mcp/McpListenerController.js";
import type { DataDirectoryController } from "./data-directory.js";
import { copyMcpConfigurationWith } from "./mcp-configuration-copy.js";
import {
  WEMAIL_MCP_CONFIGURATION_TARGETS,
  type WemailMcpConfigurationCopyResult,
  type WemailMcpConfigurationTarget,
} from "../../shared/wemail/mcp.js";
import { AgentDraftStore } from "./agent-draft-store.js";

let resolvedApiPort: number | null = null;
export type WindowCloseBehavior = "tray" | "exit";
let windowCloseBehavior: WindowCloseBehavior = "tray";

export function getWindowCloseBehavior(): WindowCloseBehavior {
  return windowCloseBehavior;
}

function desktopPreferencesPath(app: App): string {
  return path.join(app.getPath("userData"), "desktop-preferences.json");
}

function loadWindowCloseBehavior(app: App): WindowCloseBehavior {
  try {
    const value = JSON.parse(fs.readFileSync(desktopPreferencesPath(app), "utf8")) as { windowCloseBehavior?: unknown };
    return value.windowCloseBehavior === "exit" ? "exit" : "tray";
  } catch {
    return "tray";
  }
}

function saveWindowCloseBehavior(app: App, value: WindowCloseBehavior): boolean {
  const target = desktopPreferencesPath(app);
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ windowCloseBehavior: value }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
    windowCloseBehavior = value;
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/** Set by local-api after Hono binds, so the renderer can ask via IPC. */
export function setLocalApiPort(port: number | null) {
  resolvedApiPort = port;
}

export function registerDesktopIpc(
  app: App,
  getWindow: () => BrowserWindow | null,
  getDirectoryRuntime: () => DirectorySearchRuntime | null = () => null,
  telemetry?: TelemetryClient,
  getNotificationCoordinator: () => NotificationCoordinator | null = () => null,
  getMcpController: () => McpListenerController | null = () => null,
  getMcpConfiguration: (
    target: WemailMcpConfigurationTarget,
  ) => Promise<string> = async () => { throw new Error("mcp-not-ready"); },
  dataDirectory?: DataDirectoryController,
) {
  windowCloseBehavior = loadWindowCloseBehavior(app);
  const draftStore = new AgentDraftStore(
    path.join(
      process.env.WEMAIL_DATA_DIR ?? path.join(app.getPath("userData"), "data"),
      "agent-drafts",
    ),
    safeStorage,
  );
  const searchDirectory = createDesktopDirectorySearch(
    getDirectoryRuntime,
    () => resolvedApiPort,
  );

  ipcMain.handle("desktop:get-app-info", () => ({
    name: "WeMail",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
  }));

  ipcMain.handle("desktop:get-api-port", () => resolvedApiPort);
  ipcMain.handle("mcp:copy-configuration", async (_event, target: unknown) => {
    const controller = getMcpController();
    if (controller) {
      return copyMcpConfigurationWith({
        target,
        controller,
        writeText: (value) => clipboard.writeText(value),
      });
    }
    const normalized = WEMAIL_MCP_CONFIGURATION_TARGETS.find(
      (candidate) => candidate === target,
    );
    if (!normalized) {
      return { ok: false, target: "codex", error: "unsupported_target" } satisfies WemailMcpConfigurationCopyResult;
    }
    try {
      clipboard.writeText(await getMcpConfiguration(normalized));
      return { ok: true, target: normalized } satisfies WemailMcpConfigurationCopyResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "mcp-not-ready";
      return {
        ok: false,
        target: normalized,
        error: message === "mcp-credential-corrupt"
          ? "credential_corrupt"
          : message === "mcp-credential-unavailable"
            ? "credential_unavailable"
            : "mcp_not_ready",
      } satisfies WemailMcpConfigurationCopyResult;
    }
  });
  ipcMain.handle("directory:search-contacts", (_event, input) =>
    searchDirectory(input),
  );
  ipcMain.handle("desktop:open-external", (_event, url: string) =>
    createExternalLinkOpener(shell.openExternal)(url),
  );
  ipcMain.handle("desktop:open-windows-notification-settings", () =>
    openWindowsNotificationSettingsWith(shell.openExternal),
  );
  ipcMain.handle("desktop:save-diagnostics-package", async (_event, fileName: unknown) => {
    if (
      typeof fileName !== "string" ||
      !/^wemail-diagnostics-[A-Za-z0-9T_-]+\.json$/.test(fileName) ||
      path.basename(fileName) !== fileName
    ) {
      return { ok: false, error: "invalid-file-name" };
    }
    const dataDir = process.env.WEMAIL_DATA_DIR;
    if (!dataDir) return { ok: false, error: "data-directory-unavailable" };
    const source = path.join(dataDir, "logs", "diagnostic-packages", fileName);
    if (!fs.existsSync(source)) return { ok: false, error: "package-not-found" };
    const zipName = fileName.replace(/\.json$/, ".zip");
    const result = await dialog.showSaveDialog({
      title: "保存 WeMail 诊断包",
      defaultPath: path.join(app.getPath("downloads"), zipName),
      filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    try {
      const zip = new yazl.ZipFile();
      zip.addBuffer(fs.readFileSync(source), fileName);
      zip.end();
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(result.filePath);
        zip.outputStream.pipe(output);
        output.on("close", resolve);
        output.on("error", reject);
      });
      return { ok: true, canceled: false, filePath: result.filePath };
    } catch {
      return { ok: false, error: "save-failed" };
    }
  });

  ipcMain.handle("desktop:show-window", () => {
    const win = getWindow();
    if (win) {
      win.show();
      win.focus();
    }
    return { ok: true };
  });

  ipcMain.handle("desktop:set-start-at-login", (_event, enabled: boolean) =>
    setStartAtLogin(app, enabled),
  );
  ipcMain.handle("desktop:get-data-directory", () => dataDirectory?.getInfo());
  ipcMain.handle("desktop:choose-data-directory", () =>
    dataDirectory?.chooseDirectory() ?? Promise.resolve({ canceled: true }),
  );
  ipcMain.handle("desktop:migrate-data-directory", (_event, target: unknown) =>
    dataDirectory?.scheduleMigration(target) ?? {
      ok: false,
      error: "data-directory-not-available",
    },
  );

  const shortcutController = () =>
    createShortcutController({
      desktopPath: app.getPath("desktop"),
      startMenuPath: path.join(
        app.getPath("appData"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      ),
      dataDir: process.env.WEMAIL_DATA_DIR ?? "",
      currentExe:
						process.env.PORTABLE_EXECUTABLE_FILE ??
						process.env.PORTABLE_EXECUTABLE_PATH ??
						process.execPath,
    });
  ipcMain.handle("desktop:get-shortcut-status", async () => {
    if (process.platform !== "win32" || process.env.WEMAIL_E2E_MODE === "1") {
      return {
        ok: true,
        status: { entries: [], prompt: false, dismissed: false, currentExe: "" },
      };
    }
    return { ok: true, status: await shortcutController().status() };
  });
  ipcMain.handle("desktop:fix-shortcuts", async () => {
    if (process.platform !== "win32") return { ok: false };
    await shortcutController().fix();
    return { ok: true };
  });
  ipcMain.handle("desktop:dismiss-shortcut-prompt", () => {
    if (process.platform !== "win32") return { ok: false };
    shortcutController().dismiss();
    return { ok: true };
  });

  ipcMain.on("telemetry:track", (_event, event: unknown, args: unknown) => {
    if (!telemetry || !isTelemetryEventName(event) || !validateTelemetryArgs(args)) return;
    telemetry.track(event, args);
  });
  ipcMain.on("notification:agent-confirmation", (_event, input: unknown) => {
    const notification = buildAgentConfirmationNotification(input);
    if (notification) {
      getNotificationCoordinator()?.publish(notification);
    }
  });
  ipcMain.handle("agent-draft:get", (_event, input: unknown) => {
    const ids = parseAgentDraftIds(input);
    return ids ? { text: draftStore.get(ids.accountId, ids.conversationId) ?? "" } : { text: "" };
  });
  ipcMain.handle("agent-draft:save", (_event, input: unknown) => {
    const ids = parseAgentDraftIds(input);
    const text = input && typeof input === "object" && typeof (input as { text?: unknown }).text === "string"
      ? (input as { text: string }).text
      : undefined;
    if (!ids || text === undefined || text.length > 100_000) return { ok: false };
    return { ok: draftStore.save(ids.accountId, ids.conversationId, text) };
  });
  ipcMain.handle("agent-draft:delete", (_event, input: unknown) => {
    const ids = parseAgentDraftIds(input);
    if (!ids) return { ok: false };
    draftStore.delete(ids.accountId, ids.conversationId);
    return { ok: true };
  });
  ipcMain.handle("agent-draft:clear-account", (_event, accountId: unknown) => {
    if (!isDraftId(accountId)) return { ok: false };
    draftStore.clearAccount(accountId);
    return { ok: true };
  });
  ipcMain.on("notification:agent-run", (_event, input: unknown) => {
    const notification = buildAgentRunNotification(input);
    if (notification) getNotificationCoordinator()?.publish(notification);
  });
  ipcMain.handle("telemetry:get-enabled", () => telemetry?.getEnabled() ?? false);
  ipcMain.handle("telemetry:set-enabled", (_event, enabled: unknown) => {
    if (!telemetry || typeof enabled !== "boolean") {
      return { enabled: telemetry?.getEnabled() ?? false };
    }
    telemetry.setEnabled(enabled);
    return { enabled: telemetry.getEnabled() };
  });

  ipcMain.handle("window:minimize", () => {
    getWindow()?.minimize();
  });
  // Track the pre-maximize bounds so unmaximize on Linux can restore
  // them (setBounds-based maximize doesn't flip isMaximized()).
  let preMaximizeBounds: Electron.Rectangle | null = null;
  let linuxFakeMaximized = false;

  ipcMain.handle("window:toggle-maximize", () => {
    const win = getWindow();
    if (!win) return { maximized: false };

    // On Linux/X11 (incl. WSL2 X-server) some window managers ignore
    // BrowserWindow.maximize() for frameless windows. Fall back to
    // explicitly fitting the primary display's work area.
    if (process.platform === "linux") {
      if (linuxFakeMaximized) {
        if (preMaximizeBounds) win.setBounds(preMaximizeBounds);
        linuxFakeMaximized = false;
        win.webContents.send("window:maximized-changed", false);
        return { maximized: false };
      }
      preMaximizeBounds = win.getBounds();
      const display = screen.getDisplayMatching(preMaximizeBounds);
      win.setBounds(display.workArea);
      linuxFakeMaximized = true;
      win.webContents.send("window:maximized-changed", true);
      return { maximized: true };
    }

    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { maximized: win.isMaximized() };
  });
  ipcMain.handle("window:close", () => {
    getWindow()?.close();
  });
  // One-shot graceful exit. Mirrors the tray "Quit" path (app.quit() →
  // before-quit sets the quitting flag, so the window close handler
  // does not intercept it). Does not change the saved close behavior.
  ipcMain.handle("window:quit", () => {
    app.quit();
  });
	ipcMain.handle("window:get-close-behavior", () => windowCloseBehavior);
	ipcMain.handle("window:set-close-behavior", (_event, value: unknown) => {
	  if (value !== "tray" && value !== "exit") return { ok: false, value: windowCloseBehavior };
	  const ok = saveWindowCloseBehavior(app, value);
	  if (ok) getWindow()?.webContents.send("window:close-behavior-changed", windowCloseBehavior);
	  return { ok, value: windowCloseBehavior };
	});
  ipcMain.handle("window:is-maximized", () => getWindow()?.isMaximized() ?? false);
}

function isDraftId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:@-]{1,160}$/.test(value);
}

function parseAgentDraftIds(
  input: unknown,
): { accountId: string; conversationId: string } | null {
  if (!input || typeof input !== "object") return null;
  const { accountId, conversationId } = input as {
    accountId?: unknown;
    conversationId?: unknown;
  };
  return isDraftId(accountId) && isDraftId(conversationId)
    ? { accountId, conversationId }
    : null;
}
