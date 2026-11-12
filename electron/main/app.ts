import {
  app,
  BrowserWindow,
  Menu,
  contentTracing,
  crashReporter,
	clipboard,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { BootError } from "../../server/wemail/bootstrap/AppComposition.js";
import { BusinessPreferencesCache } from "./business-preferences-cache.js";
import { getRuntimeIconPath, resolveElectronAsset } from "./assets.js";
import { createBootLogger } from "./boot-log.js";
import { formatProcessLog } from "./process-log.js";
import { safeStreamWrite } from "./safe-stream-write.js";
import { ElectronSecretStore } from "./electron-secret-store.js";
import {
  FileSecretStore,
  type SecretStore,
} from "../../server/wemail/security/SecretStore.js";
import {
  imapPasswordKey,
  smtpPasswordKey,
} from "../../server/wemail/account/AccountTypes.js";
import type { AccountConfig } from "../../shared/wemail/account.js";
import type {
  SummaryResult,
  SummaryThreadResult,
} from "../../shared/wemail/intelligence.js";
import {
  getExternalLinkWindowAction,
  getMainWindowNavigationDecision,
} from "./external-links.js";
import { getWindowCloseBehavior, registerDesktopIpc, setLocalApiPort } from "./ipc.js";
import { startLocalApi, type LocalApi } from "./local-api.js";
import { MailCoreSupervisor, resolveMailCoreEntryPath } from "./mail-core-supervisor.js";
import type { MailRefreshResult } from "../../shared/wemail/mailCoreProtocol.js";
import {
  MailDatabaseSupervisor,
  resolveMailDatabaseEntryPath,
} from "./mail-database-supervisor.js";
import { MailDatabaseProducer } from "../mail-core/mail-database-producer.js";
import { CanonicalAiWorker } from "./canonical-ai-worker.js";
import { AiJobDispatcher } from "./ai-job-dispatcher.js";
import { CanonicalAiWorkerPool } from "./canonical-ai-worker-pool.js";
import { AiCompletionBuffer } from "./ai-completion-buffer.js";
import { AiNetworkCircuitBreaker } from "../../server/wemail/ai/AiNetworkCircuitBreaker.js";
import {
  BotCoreRequestError,
  BotCoreSupervisor,
  resolveBotCoreEntryPath,
} from "./bot-core-supervisor.js";
import { BotChannelTransportError } from "../../server/wemail/channels/BotChannelRuntime.js";
import {
  registerMailChangedBridge,
  registerMailCredentialInvalidBridge,
} from "./mail-events.js";
import {
  configureDesktopNotifications,
  showDesktopNotification,
} from "./notifications.js";
import { NotificationCoordinator } from "./notification-coordinator.js";
import { CustomNotificationWindow } from "./notification-window.js";
import { NotificationDeliveryLedger } from "./notification-ledger.js";
import { routeNotificationActivation } from "./notification-activation.js";
import { projectTaskbarBadge } from "./taskbar-badge.js";
import { NewMailAttentionController } from "./new-mail-attention.js";
import {
  resolveRendererUrl,
  shouldStartPackagedRenderer,
  startPackagedRendererServer,
  type PackagedRendererServer,
} from "./renderer-server.js";
import { enforceSingleInstance } from "./single-instance.js";
import { createTray, type WemailTrayController } from "./tray.js";
import {
  createPerformanceTraceController,
  resolveDeveloperTraceConfig,
  type PerformanceTraceController,
} from "./performance-trace.js";
import { createElectronUpdaterAdapter, type UpdaterAdapter } from "./electron-updater-adapter.js";
import { registerUpdateIpc } from "./update-ipc.js";
import { secureUpdaterSession } from "./update-network.js";
import { loadUpdatePolicy, type UpdatePolicy } from "./update-policy.js";
import { createUpdateQuitCoordinator } from "./update-quit.js";
import {
  applyPendingDataMigration,
  DataDirectoryController,
  ensureDataDirectoryMarker,
  resolveDataDirectory,
} from "./data-directory.js";
import {
  createUpdateController,
  type UpdateController,
} from "./updater.js";
import { ensureWindowsAppShortcut } from "./windows-shortcut.js";
import { loadEditionRuntimeConfig } from "../../shared/wemail/edition.js";
import { ElectronMcpCredentialVault } from "./mcp-credential-vault.js";
import {
  loadTelemetryRuntimeConfig,
  stackFingerprint,
  TelemetryClient,
} from "./telemetry/TelemetryClient.js";

// Bound renderer/utility V8 heaps. Mail bodies and result caches have their
// own explicit limits, so unbounded isolate growth only increases private
// bytes and makes memory-pressure recovery arrive too late.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=96");
// The main process does not inherit `js-flags` (that only reaches
// renderer/utility children), so cap its own isolate explicitly. The main
// process hosts the local API composition; an unbounded heap there would
// grow with mail volume and never shed until the OS applies pressure.
// 192MB leaves ample headroom for the composition root while bounding a
// leak until the next restart.
v8.setFlagsFromString("--max-old-space-size=192");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveTelemetryAppVersion(): string {
  const packageJsonCandidates = [
    path.join(app.getAppPath(), "package.json"),
    path.join(__dirname, "../../../package.json"),
    path.join(process.cwd(), "package.json"),
  ];

  for (const packageJsonPath of packageJsonCandidates) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        version?: unknown;
      };
      if (typeof packageJson.version !== "string") continue;
      const version = packageJson.version.trim().replace(/^v/i, "");
      if (version) return `v${version}`;
    } catch {
      // Try the next application layout candidate.
    }
  }

  const electronVersion = app.getVersion().trim().replace(/^v/i, "");
  return electronVersion ? `v${electronVersion}` : "unknown";
}

app.setPath(
  "userData",
  process.env.WEMAIL_E2E_MODE === "1" && process.env.WEMAIL_DATA_DIR
    ? process.env.WEMAIL_DATA_DIR
    : path.join(app.getPath("appData"), "wemail"),
);
const desktopControlDir = app.getPath("userData");
const inheritedInternalDataDir =
  process.env.WEMAIL_DATA_DIR_SOURCE === "wemail-internal";
if (process.env.WEMAIL_DATA_DIR && !inheritedInternalDataDir) {
  process.env.WEMAIL_DATA_DIR_MANAGED = "1";
} else {
  delete process.env.WEMAIL_DATA_DIR;
  delete process.env.WEMAIL_DATA_DIR_MANAGED;
  applyPendingDataMigration(desktopControlDir);
  process.env.WEMAIL_DATA_DIR = resolveDataDirectory(desktopControlDir);
  process.env.WEMAIL_DATA_DIR_SOURCE = "wemail-internal";
}
const resolvedDesktopDataDir = process.env.WEMAIL_DATA_DIR!;
ensureDataDirectoryMarker(resolvedDesktopDataDir);
const electronSessionDir = path.join(resolvedDesktopDataDir, "electron-session");
const crashDumpsDir = path.join(resolvedDesktopDataDir, "crash-dumps");
fs.mkdirSync(electronSessionDir, { recursive: true });
fs.mkdirSync(crashDumpsDir, { recursive: true });
app.setPath("sessionData", electronSessionDir);
app.setPath("crashDumps", crashDumpsDir);
app.setName("WeMail");
// Crash reporting policy: keep the crashpad handler in development (where
// crashes still need stack traces and the 60MB child is irrelevant), but
// skip it in production — the crashpad child is a pure memory/CPU cost once
// the app is stable, and boot failure diagnostics already ship via
// startup.log + telemetry. `app.isPackaged` is false for dev runs, the E2E
// harness, and `launch-desktop-dev.mjs`; only a packaged release skips it.
if (!app.isPackaged) {
  crashReporter.start({
    productName: "WeMail",
    uploadToServer: false,
    compress: false,
    rateLimit: false,
    globalExtra: {
      component: "wemail-desktop",
    },
  });
}
const desktopAppUserModelId = configureDesktopNotifications(app);

// Write every boot phase to BOTH stderr and a startup.log file under
// the userData dir so failures can be diagnosed without the user having
// to describe what they saw. The first boot uses a fallback path until
// app.getPath('userData') is callable (i.e. before whenReady).
const bootLogger = createBootLogger({
  pid: process.pid,
  stderr: process.stderr,
  fs,
});
const developerTraceLogging = process.env.WEMAIL_DEV_TRACE === "1";
// AI intelligence worker concurrency (summary/tags/reply-decision). Each
// worker is an independent CanonicalAiWorker instance; claimJob is atomic so
// they never double-dispatch the same job. N workers = N concurrent LLM
// calls. The count is now resolved from the AI profile settings at pool
// construction (AiProfileSettingsService.getWorkerConcurrency, which falls
// back to WEMAIL_AI_WORKER_CONCURRENCY then AI_WORKER_CONCURRENCY_DEFAULT)
// and is live-resizeable via the settings UI → CanonicalAiWorkerPool.resize.
// Clamp [AI_WORKER_CONCURRENCY_MIN, AI_WORKER_CONCURRENCY_MAX] is enforced in
// the pool and the settings service.
// Reply-decision capability master switch. Defaults OFF: the AI worker will
// not claim ai.reply-decision jobs — existing pending ones stay pending and
// are preserved (not deleted), they simply stop draining. Flip on by setting
// WEMAIL_REPLY_DECISION_ENABLED=1.
const replyDecisionEnabled = process.env.WEMAIL_REPLY_DECISION_ENABLED === "1";
let debugModeLogging = process.env.WEMAIL_DEBUG_MODE === "1";
let debugModeDisableTimer: NodeJS.Timeout | null = null;
function isVerboseDiagnosticLogging(): boolean {
  return developerTraceLogging || debugModeLogging;
}
const traceOnlyBootPhases = new Set([
  "canonical-ai-completed",
  "desktop-notification",
  "mail-changed-dispatched",
  "new-mail-attention",
  "notification-decision",
  "reply-decision-ok",
  "summary-context-built",
  "summary-ok",
  "tags-context-built",
  "tags-ok",
]);
let bootLogPath: string | null = null;
function bootLog(phase: string, extra?: Record<string, unknown>) {
  if (!isVerboseDiagnosticLogging() && (
    traceOnlyBootPhases.has(phase) || extra?.level === "debug"
  )) return;
  bootLogger.log(phase, extra);
}

function databaseServiceLog(phase: string, extra?: Record<string, unknown>) {
  if (
    phase === "mail-database-request"
    && extra?.outcome === "success"
    && !isVerboseDiagnosticLogging()
  ) {
    return;
  }
  bootLog(phase, extra);
}

bootLog("module-loaded", {
  level: "debug",
  cwd: process.cwd(),
  argv: process.argv,
  env: {
    WEMAIL_DATA_DIR: process.env.WEMAIL_DATA_DIR ?? null,
    WEMAIL_E2E_MODE: process.env.WEMAIL_E2E_MODE ?? null,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? null,
    DISPLAY: process.env.DISPLAY ?? null,
    NODE_VERSION: process.version,
  },
});

let mainWindow: BrowserWindow | null = null;
let localApi: LocalApi | null = null;
let rendererServer: PackagedRendererServer | null = null;
let stopping = false;
let quitting = false;
let notificationPreferencesCache: BusinessPreferencesCache | null = null;
let unsubscribeMailChanged: (() => void) | null = null;
let unsubscribeAutomationMailChanged: (() => void) | null = null;
let unsubscribeMailCredentialInvalid: (() => void) | null = null;
let notificationCoordinator: NotificationCoordinator | null = null;
let customNotificationWindow: CustomNotificationWindow | null = null;
let newMailAttentionController: NewMailAttentionController | null = null;
let trayController: WemailTrayController | null = null;
let telemetry: TelemetryClient | null = null;
let mailCoreSupervisor: MailCoreSupervisor | null = null;
let mailDatabaseSupervisor: MailDatabaseSupervisor | null = null;
let aiJobDispatcher: AiJobDispatcher | null = null;
let intelligenceDatabaseProducer: MailDatabaseProducer | null = null;
let aiWorkerPool: CanonicalAiWorkerPool | null = null;
let aiCompletionBuffer: AiCompletionBuffer | null = null;
let canonicalAiCircuitBreaker: AiNetworkCircuitBreaker | null = null;
let unsubscribeCanonicalAiLlmChanged: (() => void) | null = null;
let unsubscribeAiWorkerConcurrencyChanged: (() => void) | null = null;
/**
 * Last LlmRuntime generation we revived terminal ai.* jobs for. The
 * onLlmChanged callback resets failed jobs only when generation advances, so
 * re-applying the same config doesn't churn the queue.
 */
let lastAiResetGeneration: number | null = null;
let unsubscribeMailCoreAccountChanged: (() => void) | null = null;
let unsubscribeMailCoreChanged: (() => void) | null = null;
let unsubscribeMailCoreApiEndpoint: (() => void) | null = null;
let botCoreSupervisor: BotCoreSupervisor | null = null;
let detachBotCoreTransport: (() => void) | null = null;
let unsubscribeBotCoreConfiguration: (() => void) | null = null;
// Self-heal for WeCom duplicate-connection fatal: a hard kill / crash can
// leave a stale long-connection WeCom's server hasn't reaped, so the restarted
// process fights it and trips wecom-duplicate-connection. Instead of staying
// fatal, wait for WeCom to reap the stale connection, then reconnect.
let triggerBotCoreConfigure: (() => void) | null = null;
let wecomDuplicateRetryTimer: NodeJS.Timeout | null = null;
let wecomDuplicateRetryAttempt = 0;
const WECOM_DUPLICATE_RETRY_DELAYS_MS = [45_000, 90_000];

function scheduleWecomDuplicateReconnect(): void {
  if (wecomDuplicateRetryAttempt >= WECOM_DUPLICATE_RETRY_DELAYS_MS.length) return;
  const delay = WECOM_DUPLICATE_RETRY_DELAYS_MS[wecomDuplicateRetryAttempt]!;
  wecomDuplicateRetryAttempt += 1;
  bootLog("bot-core-wecom-duplicate-reconnect-scheduled", {
    delay,
    attempt: wecomDuplicateRetryAttempt,
  });
  if (wecomDuplicateRetryTimer) clearTimeout(wecomDuplicateRetryTimer);
  wecomDuplicateRetryTimer = setTimeout(() => {
    wecomDuplicateRetryTimer = null;
    triggerBotCoreConfigure?.();
  }, delay);
  wecomDuplicateRetryTimer.unref();
}
let updateController: UpdateController | null = null;
let updateIpcRegistered = false;
let recoveryDialogOpen = false;
const pendingSummaryAutomationTimers = new Map<string, NodeJS.Timeout>();

function createDiagnosticId(prefix: "startup" | "renderer"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function showStartupRecovery(error: unknown): Promise<void> {
  const diagnosticId = createDiagnosticId("startup");
  bootLog("startup-recovery-shown", {
    diagnosticId,
    errorClass: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  });
  if (process.env.WEMAIL_E2E_MODE === "1") {
    app.exit(1);
    return;
  }
	while (true) {
	  const result = await dialog.showMessageBox({
		type: "error",
		title: "WeMail 无法启动",
		message: "WeMail 暂时无法完成启动。",
		detail: `请重启应用后再试。若问题持续，请向支持人员提供诊断编号：${diagnosticId}`,
		buttons: ["重启 WeMail", "复制诊断编号", "退出"],
		defaultId: 0,
		cancelId: 2,
		noLink: true,
	  });
	  if (result.response === 1) {
		clipboard.writeText(diagnosticId);
		continue;
	  }
	  if (result.response === 0) app.relaunch();
	  app.exit(result.response === 0 ? 0 : 1);
	  return;
	}
}

async function showRendererRecovery(details: { reason: string }): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed() || recoveryDialogOpen || quitting) return;
  recoveryDialogOpen = true;
  const diagnosticId = createDiagnosticId("renderer");
  bootLog("renderer-recovery-shown", { diagnosticId, reason: details.reason });
  try {
	while (!win.isDestroyed()) {
	  const result = await dialog.showMessageBox(win, {
		type: "error",
		title: "页面需要恢复",
		message: "WeMail 页面意外停止运行。",
		detail: `可以重新加载页面或重启应用。诊断编号：${diagnosticId}`,
		buttons: ["重新加载", "重启 WeMail", "复制诊断编号", "退出"],
		defaultId: 0,
		cancelId: 3,
		noLink: true,
	  });
	  if (result.response === 2) {
		clipboard.writeText(diagnosticId);
		continue;
	  }
	  if (result.response === 0 && !win.isDestroyed()) {
		win.webContents.reload();
		return;
	  }
	  if (result.response === 1) {
		app.relaunch();
		app.exit(0);
		return;
	  }
	  app.quit();
	  return;
	}
  } finally {
    recoveryDialogOpen = false;
  }
}

function updateDesktopAttentionBadge(count: number): void {
  const win = mainWindow;
  try {
    const taskbarProjected = projectTaskbarBadge(win, count);
    trayController?.setBadgeCount(count);
    bootLog("new-mail-attention", {
      count,
      taskbarProjected,
      trayProjected: !!trayController,
    });
  } catch (error) {
    bootLog("new-mail-attention-projection-failed", {
      count,
      errorClass: error instanceof Error ? error.name : "Error",
    });
  }
}
let performanceTrace: PerformanceTraceController | null = null;
const FORCE_EXIT_WATCHDOG_MS = 5_000;
let forceExitWatchdog: NodeJS.Timeout | null = null;

async function stopDesktopServices() {
  if (stopping && !quitting) return;
  stopping = true;
  quitting = true;
  const api = localApi;
  try {
    notificationPreferencesCache?.dispose();
    notificationPreferencesCache = null;
    unsubscribeMailChanged?.();
    unsubscribeMailChanged = null;
    unsubscribeAutomationMailChanged?.();
    unsubscribeAutomationMailChanged = null;
    for (const timer of pendingSummaryAutomationTimers.values()) {
      clearTimeout(timer);
    }
    pendingSummaryAutomationTimers.clear();
    unsubscribeMailCoreChanged?.();
    unsubscribeMailCoreChanged = null;
    unsubscribeMailCoreAccountChanged?.();
    unsubscribeMailCoreAccountChanged = null;
    unsubscribeMailCredentialInvalid?.();
    unsubscribeMailCredentialInvalid = null;
    detachBotCoreTransport?.();
    detachBotCoreTransport = null;
    unsubscribeBotCoreConfiguration?.();
    unsubscribeBotCoreConfiguration = null;
    await botCoreSupervisor?.stop();
    botCoreSupervisor = null;
    if (wecomDuplicateRetryTimer) {
      clearTimeout(wecomDuplicateRetryTimer);
      wecomDuplicateRetryTimer = null;
    }
    wecomDuplicateRetryAttempt = 0;
    triggerBotCoreConfigure = null;
    notificationCoordinator?.dispose();
    notificationCoordinator = null;
    newMailAttentionController = null;
    trayController = null;
    await mailCoreSupervisor?.stop();
    unsubscribeMailCoreApiEndpoint?.();
    unsubscribeMailCoreApiEndpoint = null;
    mailCoreSupervisor = null;
    // stop() is async: it hard-stops the workers, then drains the shared
    // completion buffer so already-computed (buffered) artifacts are persisted
    // rather than left to lease-expiry replay on the next start.
    aiJobDispatcher?.stop();
    aiJobDispatcher = null;
    await aiWorkerPool?.stop();
    aiCompletionBuffer = null;
    aiWorkerPool = null;
    canonicalAiCircuitBreaker = null;
    unsubscribeCanonicalAiLlmChanged?.();
    unsubscribeCanonicalAiLlmChanged = null;
    unsubscribeAiWorkerConcurrencyChanged?.();
    unsubscribeAiWorkerConcurrencyChanged = null;
    intelligenceDatabaseProducer?.close();
    intelligenceDatabaseProducer = null;
    await mailDatabaseSupervisor?.stop();
    mailDatabaseSupervisor = null;
    await api?.stop();
    await Promise.race([
      performanceTrace?.stop("shutdown") ?? Promise.resolve(null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    if (rendererServer) {
      await rendererServer.close();
      rendererServer = null;
    }
  } finally {
    localApi = null;
    performanceTrace = null;
    telemetry?.markCleanExit();
  }
}

function forceTerminateDesktopWorkers(reason: string): void {
  bootLog("desktop-workers-force-terminate", {
    level: "warn",
    reason,
    botCore: !!botCoreSupervisor,
    mailCore: !!mailCoreSupervisor,
    mailDatabase: !!mailDatabaseSupervisor,
  });
  const terminate = (service: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      bootLog("desktop-worker-force-terminate-failed", {
        level: "warn",
        service,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  terminate("bot-core", () => botCoreSupervisor?.forceTerminate());
  terminate("mail-core", () => mailCoreSupervisor?.forceTerminate());
  terminate("mail-database", () => mailDatabaseSupervisor?.forceTerminate());
  aiJobDispatcher?.stop();
  terminate("canonical-ai", () => aiWorkerPool?.forceTerminate());
}

function armForceExitWatchdog(reason: "normal-quit" | "update-install"): void {
  if (forceExitWatchdog) return;
  forceExitWatchdog = setTimeout(() => {
    try {
      forceTerminateDesktopWorkers(`${reason}-watchdog`);
      bootLog("desktop-force-exit", {
        level: "warn",
        reason,
        timeoutMs: FORCE_EXIT_WATCHDOG_MS,
      });
    } finally {
      app.exit(0);
    }
  }, FORCE_EXIT_WATCHDOG_MS);
}

const updateQuit = createUpdateQuitCoordinator({
  stop: stopDesktopServices,
  quit: () => {
    armForceExitWatchdog("normal-quit");
    app.quit();
  },
  quitAndInstall: () => {
    armForceExitWatchdog("update-install");
    if (updateController) {
      updateController.quitAndInstall();
    } else {
      app.quit();
    }
  },
  stopTimeoutMs: 10_000,
  onStopTimeout: (timeoutMs) => {
    forceTerminateDesktopWorkers("graceful-shutdown-timeout");
    bootLog("desktop-shutdown-timeout", {
      level: "warn",
      timeoutMs,
      installPending: updateController?.getState().status === "installing",
    });
  },
});

function disabledUpdatePolicy(): UpdatePolicy {
  return {
    enabled: false,
    feedUrls: null,
    allowedOrigins: null,
    platform: process.platform,
    arch: process.arch,
  };
}

async function initializeDesktopUpdates() {
  if (updateController) {
    return updateController;
  }

  let policy: UpdatePolicy;
  try {
    policy = await loadUpdatePolicy({ appPath: app.getAppPath() });
  } catch (error) {
    bootLog("update-policy-invalid", {
      message: error instanceof Error ? error.message : String(error),
    });
    policy = disabledUpdatePolicy();
  }

  const currentVersion = resolveTelemetryAppVersion().replace(/^v/i, "");
  // electron-updater's autoUpdater singleton validates app.getVersion() in its
  // constructor; in dev (non-packaged) mode getVersion() returns "0.0" and the
  // import would throw ERR_UPDATER_INVALID_VERSION. Only touch it when updates
  // are actually enabled and use a no-op adapter otherwise.
  const adapter: UpdaterAdapter = policy.enabled
    ? (() => {
        const { autoUpdater, CancellationToken } = electronUpdater;
        secureUpdaterSession(
          autoUpdater.netSession,
          policy.allowedOrigins ?? ["https://disabled.invalid"],
        );
        return createElectronUpdaterAdapter({
          updater: autoUpdater,
          createCancellationToken: () => new CancellationToken(),
          feedUrls: policy.feedUrls,
        });
      })()
    : {
        on: () => undefined,
        checkForUpdates: async () => undefined,
        downloadUpdate: async () => undefined,
        cancelDownload: () => undefined,
        quitAndInstall: () => undefined,
      };

  const controller = createUpdateController({
    enabled: policy.enabled,
    currentVersion,
    adapter,
    requestQuitForInstall: () => {
      updateQuit.armInstallNow();
      app.quit();
    },
    armInstallOnExit: () => updateQuit.armInstallOnExit(),
    log: (event, data) => bootLog(event, data),
  });
  controller.subscribe((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update:state-changed", state);
    }
  });
  updateController = controller;

  if (!updateIpcRegistered) {
    registerUpdateIpc(ipcMain, controller);
    updateIpcRegistered = true;
  }
  bootLog("desktop-updates-initialized", {
    enabled: policy.enabled,
    platform: process.platform,
    arch: process.arch,
  });
  return controller;
}

function getRendererUrl(rendererPort?: number) {
  return resolveRendererUrl({
    env: process.env,
    isPackaged: app.isPackaged,
    rendererPort,
    argv: process.argv,
  });
}

function getPreloadPath() {
  return path.join(__dirname, "../preload/index.js");
}

async function createMainWindow() {
  telemetry?.setSessionPhase("create_window");
  // Honor a caller-supplied WEMAIL_DATA_DIR (E2E harness uses a tmp dir).
  // Default to <userData>/data otherwise.
  if (!process.env.WEMAIL_DATA_DIR) {
    process.env.WEMAIL_DATA_DIR = path.join(app.getPath("userData"), "data");
  }
  // Now that userData is known, point boot logging at it.
  try {
    fs.mkdirSync(process.env.WEMAIL_DATA_DIR, { recursive: true });
    bootLogPath = path.join(process.env.WEMAIL_DATA_DIR, "startup.log");
    bootLogger.setPath(bootLogPath);
    fs.writeFileSync(bootLogPath, ""); // truncate per launch
  } catch (err) {
    safeStreamWrite(
      process.stderr,
      `${formatProcessLog(
        "[wemail-boot]",
        `failed to open startup.log: ${(err as Error).message}`,
        "error",
      )}\n`,
    );
  }
  bootLog("createMainWindow", {
    dataDir: process.env.WEMAIL_DATA_DIR,
    userData: app.getPath("userData"),
    bootLogPath,
  });
  bootLog("crash-reporter-ready", {
    crashDumpsPath: app.getPath("crashDumps"),
    uploadToServer: false,
  });

  const managedMcpCredentials = new ElectronMcpCredentialVault(
    path.join(process.env.WEMAIL_DATA_DIR, "secrets"),
    safeStorage,
  );
  // CI runners have no OS keyring, so Electron safeStorage is unavailable
  // and throws "encrypted-secret-store-unavailable" during composeApp.
  // E2E data dirs are disposable, so use the file-backed store there; real
  // desktop launches keep the encrypted Electron store.
  const secretBaseDir = path.join(process.env.WEMAIL_DATA_DIR, "secrets");
  const accountSecretStore: SecretStore =
    process.env.WEMAIL_E2E_MODE === "1"
      ? new FileSecretStore({ baseDir: secretBaseDir })
      : new ElectronSecretStore(secretBaseDir, safeStorage);
  const configureMailCoreAccount = (account: AccountConfig | null) => {
    if (!account) {
      mailCoreSupervisor?.configureAccountCredential(null);
      return;
    }
    const imapKey = imapPasswordKey(account.id);
    const smtpKey = smtpPasswordKey(account.id);
    const imapPassword = accountSecretStore.getSecret(imapKey);
    if (!imapPassword) {
      mailCoreSupervisor?.configureAccountCredential(null);
      return;
    }
    const smtpPassword = accountSecretStore.getSecret(smtpKey);
    mailCoreSupervisor?.configureAccountCredential({
      version: 1,
      // Both production stores track generations; lightweight stubs may
      // omit the method and fall back to 0.
      generation: Math.max(
        accountSecretStore.getSecretGeneration?.(imapKey) ?? 0,
        accountSecretStore.getSecretGeneration?.(smtpKey) ?? 0,
      ),
      account,
      imapPassword,
      ...(smtpPassword ? { smtpPassword } : {}),
    });
  };
  let apiRuntime: LocalApi | null = null;
  let apiPort: number;
  const mailDatabasePath = path.join(process.env.WEMAIL_DATA_DIR, "wemail.sqlite");
  try {
      mailDatabaseSupervisor = new MailDatabaseSupervisor(
        resolveMailDatabaseEntryPath(__dirname),
        mailDatabasePath,
        databaseServiceLog,
        () => isVerboseDiagnosticLogging(),
      );
    mailDatabaseSupervisor.start();
    // Cold upgrades include a full integrity gate (139s on the real-data copy); query deadlines stay unchanged.
    await mailDatabaseSupervisor.whenReady(180_000);
  } catch (error) {
    bootLog("mail-database-start-failed", {
      databasePath: mailDatabasePath,
      message: error instanceof Error ? error.message : String(error),
    });
    await mailDatabaseSupervisor?.stop().catch(() => undefined);
    mailDatabaseSupervisor = null;
    throw new Error("mail-database-start-failed", { cause: error });
  }
  try {
    if (!mailCoreSupervisor) {
      mailCoreSupervisor = new MailCoreSupervisor(
        resolveMailCoreEntryPath(__dirname),
        (phase, extra) => bootLog(phase, extra),
        managedMcpCredentials,
        () => isVerboseDiagnosticLogging(),
      );
      mailCoreSupervisor.start();
      mailCoreSupervisor.configureDatabaseWriter(
        () => mailDatabaseSupervisor!.createProducerPort(),
      );
    }
    intelligenceDatabaseProducer = new MailDatabaseProducer(
      mailDatabaseSupervisor.createProducerPort("background"),
      (event) => {
        if (event.changes.some((change) =>
          change.entityType === "content" || change.entityType === "ai_job"
        )) {
          aiJobDispatcher?.wake();
        }
      },
    );
    bootLog("startLocalApi-begin");
    apiRuntime = await startLocalApi({
      managedMcpCredentials,
      secretStore: accountSecretStore,
      mailDatabase: intelligenceDatabaseProducer,
      // Dev only: probing build/edition from the cwd lets `dev:desktop` pick
      // up a locally generated edition file. A packaged app must never load
      // edition config from an arbitrary process working directory.
      edition: loadEditionRuntimeConfig(app.getAppPath(), process.resourcesPath, {
        devFallback: !app.isPackaged,
      }),
      quitApp: () => app.quit(),
      onDebugModeChanged: (diagnostics) => {
        debugModeLogging = diagnostics.debugEnabled;
        if (debugModeDisableTimer) clearTimeout(debugModeDisableTimer);
        debugModeDisableTimer = null;
        if (diagnostics.expiresAt) {
          const delayMs = Math.max(0, Date.parse(diagnostics.expiresAt) - Date.now());
          debugModeDisableTimer = setTimeout(() => {
            debugModeLogging = false;
            debugModeDisableTimer = null;
          }, delayMs + 50);
          debugModeDisableTimer.unref?.();
        }
      },
      mailAttachmentGateway: {
        fetchAttachment: (input) => {
          if (!mailCoreSupervisor) {
            const error = new Error("Mail Core is unavailable");
            error.name = "ATTACHMENT_SERVICE_UNAVAILABLE";
            return Promise.reject(error);
          }
          return mailCoreSupervisor.fetchAttachment(input);
        },
      },
      refreshMail: (accountId: string) =>
        mailCoreSupervisor
          ? mailCoreSupervisor.refreshMail(accountId)
          : Promise.resolve({ status: "account-unavailable" } as MailRefreshResult),
      getMailReceipt: (accountId: string) => mailCoreSupervisor?.getMailReceipt(accountId) ?? null,
    });
    const dispatchSummaryNotification = async (
      accountId: string,
      emailId: string,
      summaryOverride?: SummaryResult | SummaryThreadResult,
    ): Promise<void> => {
      const composition = apiRuntime?.composition;
      const database = intelligenceDatabaseProducer;
      if (!composition || !database) return;
      const timer = pendingSummaryAutomationTimers.get(emailId);
      if (timer) {
        clearTimeout(timer);
        pendingSummaryAutomationTimers.delete(emailId);
      }
      try {
        const stored = await database.getIntelligenceState(emailId);
        const summary = summaryOverride ?? stored.summary.result;
        if (!summary || summary.type !== "summary") return;
        const executions = await composition.pipelineAutomationRuleService.runForSummaryCompleted({
          accountId, emailId, summary: summary as SummaryResult | SummaryThreadResult,
          tags: stored.tags.result,
        });
        bootLog("summary-automation-triggered", {
          accountId, emailId, executionCount: executions.length,
          statuses: executions.map((execution) => execution.status),
        });
      } catch (error) {
        bootLog("summary-automation-trigger-failed", {
          accountId, emailId, error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const scheduleSummaryNotification = async (
      accountId: string,
      emailId: string,
      summary: SummaryResult | SummaryThreadResult,
    ): Promise<void> => {
      try {
        const stored = await intelligenceDatabaseProducer?.getIntelligenceState(emailId);
        if (stored?.tags.result?.type === "tags") {
          await dispatchSummaryNotification(accountId, emailId, summary);
          return;
        }
      } catch (error) {
        bootLog("summary-automation-tags-read-failed", {
          accountId, emailId, error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!apiRuntime || pendingSummaryAutomationTimers.has(emailId)) return;
      const timer = setTimeout(() => {
        pendingSummaryAutomationTimers.delete(emailId);
        void dispatchSummaryNotification(accountId, emailId, summary);
      }, 2_000);
      timer.unref?.();
      pendingSummaryAutomationTimers.set(emailId, timer);
    };
    unsubscribeAutomationMailChanged?.();
    unsubscribeAutomationMailChanged = mailCoreSupervisor.onMailChanged((event) => {
      const composition = apiRuntime?.composition;
      const database = intelligenceDatabaseProducer;
      if (!composition || !database) return;
      // Read and dispatch sequentially so a large sync event cannot flood the reader.
      void (async () => {
        for (const inserted of event.inserted) {
          try {
            const { message } = await database.getSnapshot(inserted.id);
            if (!message || message.accountId !== event.accountId) continue;
            await composition.pipelineAutomationRuleService.runForMailReceived(
              event.accountId, message as unknown as Record<string, unknown>,
            ).catch((error) => {
              bootLog("mail-automation-trigger-failed", {
                accountId: event.accountId, emailId: inserted.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            await dispatchSummaryNotification(event.accountId, inserted.id);
          } catch (error) {
            bootLog("mail-automation-trigger-failed", {
              accountId: event.accountId, emailId: inserted.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })();
    });
    canonicalAiCircuitBreaker = new AiNetworkCircuitBreaker({
      // One provider failure is enough to stop the other workers from
      // amplifying a 429/503 storm; the half-open probe decides recovery.
      failureThreshold: 1,
      openDurationMs: 60_000,
      maxOpenDurationMs: 15 * 60_000,
    });
    // Phase B: shared completion buffer. Coalesces bulk-priority (historical /
    // backfill) artifact completions across all workers into periodic
    // batched transactions, cutting single-writer contention. Real-time
    // (user-visible) completions bypass it and write through directly.
    aiCompletionBuffer = new AiCompletionBuffer({
      flush: async (items) => {
        const completed = await intelligenceDatabaseProducer!.completeAiArtifactBatch(items);
        return completed.value.results.map((result) => result.current === true && !result.skipped);
      },
      log: (phase, extra) => bootLog(phase, extra),
    });
    let aiStartupMaintenance: Promise<void> | null = null;
    const runAiStartupMaintenance = (): Promise<void> => {
      aiStartupMaintenance ??= (async () => {
        await intelligenceDatabaseProducer!.reconcileAiJobs(10);
        try {
          await intelligenceDatabaseProducer!.resetTerminalAiJobsForRetry();
        } catch {
          /* best-effort; reconciliation already completed */
        }
      })();
      return aiStartupMaintenance;
    };
    aiJobDispatcher = new AiJobDispatcher({
      database: intelligenceDatabaseProducer!,
      kinds: () => ["ai.summary", "ai.tags", ...(replyDecisionEnabled ? ["ai.reply-decision"] : []), "ai.todo"],
      wake: () => aiWorkerPool?.wake(),
      log: (phase, extra) => bootLog(phase, extra),
    });
    const aiWorkerOptions: ConstructorParameters<typeof CanonicalAiWorker>[0] = {
      dispatcher: aiJobDispatcher,
      database: intelligenceDatabaseProducer!,
      startupMaintenance: runAiStartupMaintenance,
      replyDecisionEnabled,
      circuitBreaker: canonicalAiCircuitBreaker!,
      // Reuse the main-process composition governor (AppComposition.ts creates
      // and stops it); background AI work yields when the machine is under load.
      governor: apiRuntime!.composition.resourceGovernor,
      getLlmSnapshot: () => apiRuntime!.composition.getLlmSnapshot(),
      getUserTags: (accountId) =>
        intelligenceDatabaseProducer!.listUserTags(accountId),
      // The artifact transaction persists suggestions after checking lease and content version.
      persistTodos: (_accountId, _emailId, todos) => todos,
      usage: { record: (input) => intelligenceDatabaseProducer!.recordAiUsage(input) },
      getTodoPrompt: () => intelligenceDatabaseProducer!.getTodoPrompt(),
      log: (phase, extra) => bootLog(phase, extra),
      onLlmFailure: ({ error, kind }) => {
        const health = apiRuntime?.composition.recordLlmFailure(error);
        bootLog("canonical-ai-model-unreachable", {
          level: "warn",
          kind,
          ...(health?.lastError?.status === undefined
            ? {}
            : { status: health.lastError.status }),
          ...(health?.lastError?.code
            ? { code: health.lastError.code }
            : {}),
          ...(health?.lastError?.message
            ? { message: health.lastError.message }
            : {}),
        });
      },
      onLlmSuccess: () => {
        apiRuntime?.composition.recordLlmSuccess();
      },
      onTagsCompleted: ({ accountId, emailId }) => {
        void dispatchSummaryNotification(accountId, emailId);
      },
      onSummaryCompleted: ({ accountId, emailId, summary }) => {
        return scheduleSummaryNotification(accountId, emailId, summary);
      },
      completionBuffer: aiCompletionBuffer,
    };
    aiWorkerPool = new CanonicalAiWorkerPool({
      initialSize: apiRuntime.composition.aiProfileService.getWorkerConcurrency(),
      factory: () => new CanonicalAiWorker(aiWorkerOptions),
      completionBuffer: aiCompletionBuffer,
    });
    unsubscribeCanonicalAiLlmChanged = apiRuntime.composition.onLlmChanged((snapshot) => {
      // A real model/auth change: revive terminal ai.* jobs that died under
      // the old config (auth_unavailable, timeouts, malformed output, …) so
      // the new model reprocesses them. Gated by generation so a no-op
      // re-apply doesn't churn the queue.
      if (snapshot.generation !== lastAiResetGeneration) {
        lastAiResetGeneration = snapshot.generation;
        canonicalAiCircuitBreaker?.reset();
        void intelligenceDatabaseProducer
          ?.resetTerminalAiJobsForRetry()
          .then((revived) => {
            if (revived > 0) {
              bootLog("ai-jobs-revived-on-llm-change", {
                generation: snapshot.generation,
                revived,
              });
            }
          })
          .catch(() => {
            /* best-effort; wake proceeds regardless */
          })
          .finally(() => {
            // Recovery may finish after the first wake cached an empty queue, including partial success before failure.
            aiJobDispatcher?.wake();
          });
      }
      aiJobDispatcher?.wake();
    });
    unsubscribeAiWorkerConcurrencyChanged = apiRuntime.composition.onAiWorkerConcurrencyChanged((concurrency) => {
      // A manual concurrency change is the user's signal to retry immediately:
      // reset the shared circuit breaker so the new worker count can issue LLM
      // calls right away instead of waiting out a provider-outage open period
      // (e.g. lowering the count after hitting rate limits at high concurrency).
      canonicalAiCircuitBreaker?.reset();
      aiWorkerPool?.resize(concurrency);
    });
    aiJobDispatcher?.wake();
    apiPort = apiRuntime.port;
    try {
      await intelligenceDatabaseProducer!.startCjkSearchIndexBuild();
    } catch (error) {
      bootLog("cjk-search-index-start-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    bootLog("startLocalApi-done", { port: apiPort });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    bootLog("startLocalApi-failed", {
      kind: err instanceof BootError ? "BootError" : "Error",
      message: errMsg,
      stack: errStack,
    });
    telemetry?.track("wemail_app_runtime_error", {
      source: "local_api",
      stage: "startup",
      error_class: err instanceof Error ? err.name : "Error",
      reason: err instanceof BootError ? "boot_error" : "other",
      stack_fingerprint: stackFingerprint(err),
    });
    throw new Error("local-api-start-failed", { cause: err });
  }
  localApi = apiRuntime;
  setLocalApiPort(apiPort);
  await mailCoreSupervisor.whenReady().catch((error) => {
    bootLog("mail-core-ready-wait-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  unsubscribeMailCoreAccountChanged?.();
  unsubscribeMailCoreAccountChanged = apiRuntime
    ? apiRuntime.composition.accountService.onAccountChanged((event) => {
        configureMailCoreAccount(event.account);
      })
    : null;
  if (apiRuntime) {
    configureMailCoreAccount(apiRuntime.composition.accountService.getCurrentAccount());
    // Recovery can download attachments only after Mail Core has received account credentials.
    // P2.6: the durable upload executor is an edition module; absent in the
    // open edition there is simply nothing to wake.
    apiRuntime.composition.actionExecutions?.wake();
  }
  unsubscribeMailCoreChanged?.();
  unsubscribeMailCoreChanged = null;
  // The BotCoreSupervisor is the inbound half of the channel runtime; it must
  // start whenever the ChannelWorker does (gated on the same `enabled` flag that
  // local-api.ts forces on in the desktop app). Running the worker without it
  // silently drops every Feishu/WeCom message, so pairing never completes.
  if (
    apiRuntime &&
    apiRuntime.composition.channels.enabled &&
    !botCoreSupervisor
  ) {
    botCoreSupervisor = new BotCoreSupervisor(resolveBotCoreEntryPath(__dirname), {
      log: (phase, extra) => bootLog(phase, extra),
      isDebugLoggingEnabled: () => isVerboseDiagnosticLogging(),
      onInbound: (envelope) => {
        apiRuntime.composition.channels.runtime.ingest(envelope);
      },
      onStatus: (event) => {
        const profile = apiRuntime.composition.channels.connections.getProfile(
          event.profileId,
        );
        if (!profile) return;
        apiRuntime.composition.channels.connections.upsertObservation({
          entryKey: `channel:${profile.platform}:${profile.id}`,
          integrationId: profile.platform,
          profileId: profile.id,
          state:
            event.state === "connected"
              ? profile.onboardingState === "ready"
                ? "connected"
                : "attention"
              : event.state === "connecting"
                ? "unknown"
                : "disconnected",
          ...(event.errorCode ? { reasonCode: event.errorCode } : {}),
          ...(event.state === "disconnected"
            ? { nextAction: botCoreDisconnectedNextAction(event.errorCode) }
            : {}),
        });
        if (event.state === "connected") {
          wecomDuplicateRetryAttempt = 0;
        } else if (
          event.state === "disconnected" &&
          event.errorCode === "wecom-duplicate-connection"
        ) {
          scheduleWecomDuplicateReconnect();
        }
      },
    });
    detachBotCoreTransport =
      apiRuntime.composition.channels.runtime.attachTransport({
        send: async (input) => {
          try {
            await botCoreSupervisor!.send(input);
          } catch (error) {
            throw translateBotCoreError(error);
          }
        },
        setReaction: async (input) => {
          try {
            await botCoreSupervisor!.setReaction(input);
          } catch (error) {
            throw translateBotCoreError(error);
          }
        },
        probe: async (profileId) => {
          try {
            await botCoreSupervisor!.probe(profileId);
          } catch (error) {
            throw translateBotCoreError(error);
          }
        },
        // supervisor.streamFrame already collapses any transport/ready/timeout
        // error to "failed", so no translateBotCoreError wrapping is needed.
        streamFrame: async (input) => botCoreSupervisor!.streamFrame(input),
        feishuStreamStart: async (input) =>
          botCoreSupervisor!.feishuStreamStart(input),
        feishuStreamText: async (input) =>
          botCoreSupervisor!.feishuStreamText(input),
        feishuStreamEnd: async (input) =>
          botCoreSupervisor!.feishuStreamEnd(input),
        feishuStreamAbort: async (input) =>
          botCoreSupervisor!.feishuStreamAbort(input),
      });
    let configureGeneration = 0;
    const transientRetryDelaysMs = [2_000, 5_000, 10_000];
    const applyBotCoreConfiguration = () => {
      const configurations =
        apiRuntime.composition.channels.configurations.resolvedConfigurations();
      const generation = ++configureGeneration;
      // Self-heal transient platform connect failures (network blip, auth
      // timeout) so a startup race or brief outage doesn't leave the bot stuck
      // "disconnected" until the user manually re-detects. Persistent causes
      // (bad credentials, duplicate connection) are surfaced, not retried.
      void (async () => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await botCoreSupervisor?.configure(configurations);
            if (attempt > 0) bootLog("bot-core-configure-recovered", { attempt });
            return;
          } catch (error) {
            const code =
              error instanceof BotCoreRequestError
                ? error.code
                : "bot-core-configure-request-failed";
            bootLog("bot-core-configure-request-failed", {
              errorCode: code,
              configurationCount: configurations.length,
              attempt,
            });
            const delay = transientRetryDelaysMs[attempt];
            const shouldRetry =
              generation === configureGeneration &&
              delay !== undefined &&
              error instanceof BotCoreRequestError &&
              (code === "platform-temporarily-unavailable" ||
                code === "platform-connection-failed");
            if (!shouldRetry) return;
            bootLog("bot-core-configure-retry-scheduled", {
              delay,
              attempt: attempt + 1,
            });
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              timer.unref?.();
            });
            if (generation !== configureGeneration) return; // superseded by a newer config change
          }
        }
      })();
    };
    triggerBotCoreConfigure = applyBotCoreConfiguration;
    unsubscribeBotCoreConfiguration =
      apiRuntime.composition.channels.runtime.onConfigurationChanged(
        applyBotCoreConfiguration,
      );
    applyBotCoreConfiguration();
  }
  const runtimeIconPath = getRuntimeIconPath(app);
  if (shouldStartPackagedRenderer(process.env, app.isPackaged, process.argv)) {
    if (!rendererServer) {
      bootLog("startRendererServer-begin", { appPath: app.getAppPath() });
      rendererServer = await startPackagedRendererServer(app.getAppPath());
      bootLog("startRendererServer-done", { port: rendererServer.port });
    }
  }
  unsubscribeMailChanged?.();
  notificationCoordinator?.dispose();
  newMailAttentionController = new NewMailAttentionController(
    () =>
      !!mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      mainWindow.isFocused(),
    { update: updateDesktopAttentionBadge },
  );
  notificationPreferencesCache?.dispose();
  notificationPreferencesCache = new BusinessPreferencesCache(intelligenceDatabaseProducer!, (error) => {
    bootLog("notification-preferences-load-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await notificationPreferencesCache.start();
  customNotificationWindow =
    process.platform === "win32"
      ? new CustomNotificationWindow({
          htmlPath: resolveElectronAsset(app, "notification-window.html"),
        })
      : null;
  notificationCoordinator = new NotificationCoordinator({
    getPreferences: () => notificationPreferencesCache!.get(),
    iconPath: runtimeIconPath,
    ledger: new NotificationDeliveryLedger({
      filePath: path.join(
        resolvedDesktopDataDir,
        "notification-delivery-ledger.json",
      ),
    }),
    show: (options, handlers) => {
      if (customNotificationWindow) {
        try {
          if (customNotificationWindow.show(options, handlers)) {
            bootLog("desktop-notification", {
              titleLength: options.title?.length ?? 0,
              bodyLength: options.body?.length ?? 0,
              supported: true,
              shown: true,
              source: "custom-window",
            });
            return { supported: true, shown: true };
          }
        } catch (error) {
          bootLog("custom-notification-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const result = showDesktopNotification(options, handlers);
      bootLog("desktop-notification", {
        titleLength: options.title?.length ?? 0,
        bodyLength: options.body?.length ?? 0,
        supported: result.supported,
        shown: result.shown,
        source: "native-toast",
      });
      return result;
    },
    onActivate: (activation) => {
      void routeNotificationActivation(activation, {
        showWindow: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        },
        sendToRenderer: (channel, target) => {
          mainWindow?.webContents.send(channel, target);
        },
        markRead: async (accountId, messageId) => {
          const response = await fetch(
            `http://127.0.0.1:${apiPort}/api/mail/messages/${encodeURIComponent(messageId)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ isRead: true }),
            },
          );
          if (!response.ok) throw new Error("notification-mark-read-failed");
        },
      });
    },
    onOutcome: (outcome) => {
      bootLog("notification-decision", {
        kind: outcome.kind,
        reason: outcome.reason,
        origin: outcome.origin ?? null,
        count: outcome.count,
      });
    },
  });
  unsubscribeMailChanged = registerMailChangedBridge({
    onMailChanged: (listener) => mailCoreSupervisor!.onMailChanged((event) => listener({
      ...event,
      insertedCount: event.inserted.length,
    })),
    recordAttention: (event) => newMailAttentionController?.record(event),
    publishNotification: (event) => notificationCoordinator?.publish(event),
    sendToRenderer: (channel, payload) => {
      bootLog("mail-changed-dispatched", {
        channel,
        accountId: payload.accountId,
        insertedIds: payload.insertedIds,
        windowVisible: mainWindow?.isVisible() ?? false,
        windowDestroyed: mainWindow?.isDestroyed() ?? null,
      });
      mainWindow?.webContents.send(channel, payload);
    },
  });
  unsubscribeMailCredentialInvalid?.();
  unsubscribeMailCredentialInvalid = registerMailCredentialInvalidBridge({
    onMailCredentialInvalid: apiRuntime
      ? apiRuntime.composition.onMailCredentialInvalid
      : (listener) => mailCoreSupervisor!.onMailCredentialInvalid(listener),
    publishNotification: (event) => notificationCoordinator?.publish(event),
    sendToRenderer: (channel, payload) => {
      bootLog("mail-auth-required-dispatched", {
        channel,
        accountId: payload.accountId,
        code: payload.code,
        windowVisible: mainWindow?.isVisible() ?? false,
        windowDestroyed: mainWindow?.isDestroyed() ?? null,
      });
      mainWindow?.webContents.send(channel, payload);
    },
  });

  // In E2E mode, advertise the API port on stdout so the Playwright
  // harness can dial into it without scraping logs. The renderer URL
  // may be unavailable in headless CI — the suite then drives the app
  // purely through the local API.
  if (process.env.WEMAIL_E2E_MODE === "1") {
    safeStreamWrite(process.stdout, `WEMAIL_API_PORT=${apiPort}\n`);
  }

  // Drop the default Electron application menu (File / Edit / View / Window
  // / Help). WeMail is a single-purpose desktop app and surfaces its own
  // chrome inside the renderer; the native menu bar would just take up
  // vertical space. Tray menu in tray.ts is unaffected.
  Menu.setApplicationMenu(null);

  // Frameless window: the renderer paints its own titlebar (AppTitlebar)
  // to match the upstream mail design. macOS keeps the traffic-light overlay
  // via `hiddenInset`; Windows/Linux render the titlebar entirely in React.
  const isMac = process.platform === "darwin";
  const shortcutResult = ensureWindowsAppShortcut(
    app,
    runtimeIconPath,
    desktopAppUserModelId,
  );
  bootLog("windows-shortcut", { ...shortcutResult });
  mainWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: "WeMail",
    icon: runtimeIconPath,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    backgroundColor: "#faf8f4",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--wemail-api-port=${apiPort}`],
    },
  });
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isMaximized()) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    telemetry?.track("wemail_app_runtime_error", {
      source: "renderer",
      stage: "runtime",
      error_class: "RenderProcessGone",
      reason: details.reason.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 96) || "other",
    });
    void showRendererRecovery(details);
  });

  // Power-user shortcut: toggle DevTools with F12. The native menu is removed
  // (above), so the default View → Toggle Developer Tools / Ctrl+Shift+I
  // accelerators are gone; F12 keeps debugging and open-latency triage
  // reachable (the renderer records a `wemail.mail-open` performance trace).
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown" || input.key !== "F12") return;
    const wc = mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  });

  const emitMaximizedChange = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send("window:maximized-changed", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", emitMaximizedChange);
  mainWindow.on("unmaximize", emitMaximizedChange);
  mainWindow.on("focus", () => {
    if (!mainWindow?.isVisible()) return;
    newMailAttentionController?.acknowledgeFocus();
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
	if (getWindowCloseBehavior() === "exit") return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (!message.includes("[mail-events]")) return;
    const rendererLevel = level === 0
      ? "debug"
      : level === 2
        ? "warn"
        : level >= 3
          ? "error"
          : "info";
    if (rendererLevel === "debug" && !isVerboseDiagnosticLogging()) return;
    bootLog("renderer-console", { level: rendererLevel, message });
  });
  mainWindow.webContents.setWindowOpenHandler((details) =>
    getExternalLinkWindowAction(details, shell.openExternal),
  );
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const decision = getMainWindowNavigationDecision(
      url,
      mainWindow?.webContents.getURL() ?? "",
    );
    if (!decision.prevent) return;
    event.preventDefault();
    if (decision.openExternalUrl) {
      void shell.openExternal(decision.openExternalUrl);
    }
  });

  const rendererUrl = getRendererUrl(rendererServer?.port);
  bootLog("loadURL-begin", { rendererUrl });
  try {
    await mainWindow.loadURL(rendererUrl);
    bootLog("loadURL-done");
  } catch (loadErr) {
    const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
    bootLog("loadURL-failed", { rendererUrl, message: errMsg });
    if (process.env.WEMAIL_E2E_MODE === "1") {
      // Renderer isn't available in the hermetic E2E harness — load a
      // blank document so the window is still present for Playwright
      // to attach to. The suite drives the app through the local API.
      await mainWindow.loadURL(
        "data:text/html,<html><body>WeMail E2E harness</body></html>",
      );
      bootLog("loadURL-fallback-data");
    } else {
      throw loadErr;
    }
  }
  // Deliver the mail-core and mail-database ports on every full page load.
  // The renderer's preload re-registers its MessagePort listeners after any
  // reload (e.g. vite optimizeDeps, manual refresh, crash recovery), and a
  // port posted only at initial load would be silently lost — leaving the
  // mail list stuck on "mail database is not connected".
  const attachRendererPorts = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mailCoreSupervisor?.attachRenderer(mainWindow.webContents);
    mailDatabaseSupervisor?.attachRenderer(mainWindow.webContents);
  };
  attachRendererPorts();
  mainWindow.webContents.on("did-finish-load", attachRendererPorts);
  trayController = createTray(app, () => mainWindow);
  newMailAttentionController.refreshProjection();
  void updateController?.check("startup");
  telemetry?.setSessionPhase("ready");
  telemetry?.track("wemail_app_ready", { source: "main" });
  bootLog("ready");
}

function translateBotCoreError(error: unknown): BotChannelTransportError {
  if (error instanceof BotCoreRequestError) {
    return new BotChannelTransportError(error.code, error.retryable);
  }
  return new BotChannelTransportError("bot-core-request-failed", true);
}

/** Human-readable next-step for a Bot Core disconnect, specialised per cause.
 *  A duplicate WeCom connection (same credentials used elsewhere) has a very
 *  different remedy from a generic credential/network failure. */
function botCoreDisconnectedNextAction(errorCode?: string): string {
  if (errorCode === "wecom-duplicate-connection") {
    return "检测到重复连接：该机器人凭据可能在另一实例、企业微信开发者工具或另一台机器上也在使用。请关闭其它连接后重置。";
  }
  if (errorCode === "platform-authentication-failed" || errorCode === "platform-credential-invalid") {
    return "Bot 凭据无效或已过期，请重新填写 Bot ID 与 Secret。";
  }
  if (errorCode === "platform-temporarily-unavailable") {
    return "企业微信暂时不可达（网络或鉴权超时），将自动重试。";
  }
  if (errorCode === "platform-connection-failed") {
    return "无法连接企业微信长连接服务，请检查网络。";
  }
  return "请检查平台机器人凭据与长连接配置";
}

if (enforceSingleInstance(app, () => mainWindow)) {
  bootLog("single-instance-acquired");
  app.whenReady().then(async () => {
    bootLog("whenReady");
    const traceConfig = resolveDeveloperTraceConfig({
      isPackaged: app.isPackaged,
      env: process.env,
      cwd: process.cwd(),
    });
    if (traceConfig) {
      for (const warning of traceConfig.warnings) {
        safeStreamWrite(
          process.stderr,
          `${formatProcessLog("[performance-trace]", warning, "warn")}\n`,
        );
      }
      performanceTrace = createPerformanceTraceController({
        tracing: contentTracing,
        config: traceConfig,
        mkdir: (target) => mkdir(target, { recursive: true }),
        log: (message) => {
          const body = message.replace(/^\[performance-trace\]\s*/, "");
          const level = /failed/i.test(body) ? "error" : "info";
          safeStreamWrite(
            process.stderr,
            `${formatProcessLog("[performance-trace]", body, level)}\n`,
          );
        },
      });
      await performanceTrace.start();
    }
    telemetry = new TelemetryClient({
      userDataDir: resolvedDesktopDataDir,
      appVersion: resolveTelemetryAppVersion(),
      ...loadTelemetryRuntimeConfig(app.getAppPath(), process.resourcesPath),
    });
    telemetry.startSession();
    telemetry.track("wemail_app_started", { source: "main" });
    process.on("uncaughtExceptionMonitor", (error) => {
      telemetry?.track("wemail_app_runtime_error", {
        source: "main",
        stage: "runtime",
        error_class: error.name || "Error",
        reason: "uncaught_exception",
        stack_fingerprint: stackFingerprint(error),
      });
    });
    registerDesktopIpc(
      app,
      () => mainWindow,
      () => localApi,
      telemetry,
      () => notificationCoordinator,
      () => localApi?.mcpController ?? null,
      (target) => mailCoreSupervisor?.getMcpConfiguration(target) ?? Promise.reject(new Error("mcp-not-ready")),
      new DataDirectoryController(app, () => mainWindow, () => {
        setTimeout(() => {
          app.relaunch();
          app.quit();
        }, 250);
      }),
    );
    try {
      await initializeDesktopUpdates();
      await createMainWindow();
    } catch (err) {
      bootLog("createMainWindow-threw", {
        message: err instanceof Error ? err.message : String(err),
      });
      await showStartupRecovery(err);
    }

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          await createMainWindow();
        } catch (error) {
          bootLog("activate-createMainWindow-threw", {
            message: error instanceof Error ? error.message : String(error),
          });
          await showStartupRecovery(error);
        }
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    customNotificationWindow?.dispose();
    if (
      !updateQuit.isStopping() &&
      (
        localApi ||
        mailCoreSupervisor ||
        mailDatabaseSupervisor ||
        performanceTrace?.isRecording()
      )
    ) {
      telemetry?.track("wemail_app_quit_requested", { source: "main" });
      telemetry?.setSessionPhase("stopping");
    }
    void updateQuit.handleBeforeQuit(event);
  });
}

