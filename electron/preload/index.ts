import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  DirectoryContactQueryOptions,
  DirectoryContactSearchResult,
} from "../../shared/wemail/directory.js";
import type { NotificationTarget } from "../../shared/wemail/notifications.js";
import type {
  TelemetryArgs,
  TelemetryEventName,
} from "../../shared/wemail/telemetry.js";
import type {
  WemailMcpConfigurationCopyResult,
  WemailMcpConfigurationTarget,
} from "../../shared/wemail/mcp.js";
import {
  createDesktopUpdateBridge,
  getApiBaseUrlFromArgv,
  subscribeDesktopEvent,
} from "./bridge.js";
import { MailCoreClient } from "./mail-core-client.js";
import { MailDatabaseClient } from "./mail-database-client.js";

const mailCoreClient = new MailCoreClient();
const mailDatabaseClient = new MailDatabaseClient();
ipcRenderer.on("mail-core:port", (event) => {
  const [port] = event.ports;
  if (port) mailCoreClient.replacePort(port);
});
ipcRenderer.on("mail-database:port", (event) => {
  const [port] = event.ports;
  if (port) mailDatabaseClient.replacePort(port);
});

function getApiBaseUrl(): string | undefined {
  return getApiBaseUrlFromArgv(process.argv);
}

contextBridge.exposeInMainWorld("wemailDesktop", {
  platform: process.platform,
  versions: process.versions,
  apiBaseUrl: getApiBaseUrl(),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  mailCore: {
    isConnected: () => mailCoreClient.isConnected(),
    health: () => mailCoreClient.health(),
    ensureMailBody: (accountId: string, id: string, traceId?: string) =>
      mailCoreClient.ensureMailBody(accountId, id, 2_000, traceId),
    retryMailBody: (accountId: string, id: string, traceId?: string, onDemand?: boolean) =>
      mailCoreClient.retryMailBody(accountId, id, 2_000, traceId, onDemand),
    focusMail: (accountId: string, id: string, traceId?: string) =>
      mailCoreClient.focusMail(accountId, id, 2_000, traceId),
    blurMail: (accountId: string, id: string, traceId?: string) =>
      mailCoreClient.blurMail(accountId, id, 2_000, traceId),
    refreshMail: (accountId: string, traceId?: string) =>
      mailCoreClient.refreshMail(accountId, 2_000, traceId),
  },
  mailDatabase: {
    isConnected: () => mailDatabaseClient.isConnected(),
    health: () => mailDatabaseClient.health(),
    getMailSnapshot: (id: string, traceId?: string, requestId?: string) =>
      mailDatabaseClient.getMailSnapshot(id, 1_000, traceId, requestId),
    cancelRequest: (requestId: string) => mailDatabaseClient.cancelRequest(requestId),
    getIntelligenceState: (id: string) =>
      mailDatabaseClient.getIntelligenceState(id),
    requestIntelligence: (
      params: Parameters<MailDatabaseClient["requestIntelligence"]>[0],
    ) => mailDatabaseClient.requestIntelligence(params),
    listMail: (params: Parameters<MailDatabaseClient["listMail"]>[0]) =>
      mailDatabaseClient.listMail(params),
    listFolders: (accountId: string) =>
      mailDatabaseClient.listFolders(accountId),
    listCategories: (accountId: string) =>
      mailDatabaseClient.listCategories(accountId),
    search: (params: Parameters<MailDatabaseClient["search"]>[0]) =>
      mailDatabaseClient.search(params),
    mutateMail: (
      params: Parameters<MailDatabaseClient["mutateMail"]>[0],
      idempotencyKey: string,
    ) => mailDatabaseClient.mutateMail(params, idempotencyKey),
    saveDraft: (params: Parameters<MailDatabaseClient["saveDraft"]>[0]) =>
      mailDatabaseClient.saveDraft(params),
    getDraft: (params: Parameters<MailDatabaseClient["getDraft"]>[0]) =>
      mailDatabaseClient.getDraft(params),
    listDrafts: (params: Parameters<MailDatabaseClient["listDrafts"]>[0]) =>
      mailDatabaseClient.listDrafts(params),
    listSnoozed: (accountId: string) => mailDatabaseClient.listSnoozed(accountId),
    deleteDraft: (params: Parameters<MailDatabaseClient["deleteDraft"]>[0]) =>
      mailDatabaseClient.deleteDraft(params),
    setSnooze: (params: Parameters<MailDatabaseClient["setSnooze"]>[0]) =>
      mailDatabaseClient.setSnooze(params),
    enqueueSend: (params: Parameters<MailDatabaseClient["enqueueSend"]>[0]) =>
      mailDatabaseClient.enqueueSend(params),
		listScheduled: (accountId: string) => mailDatabaseClient.listScheduled(accountId),
		listScheduledPage: (accountId: string, page?: number, limit?: number) =>
			mailDatabaseClient.listScheduledPage(accountId, page, limit),
    cancelScheduled: (accountId: string, id: string) =>
      mailDatabaseClient.cancelScheduled(accountId, id),
    deleteScheduled: (accountId: string, id: string) =>
      mailDatabaseClient.deleteScheduled(accountId, id),
    onChanged: (listener: Parameters<MailDatabaseClient["onChanged"]>[0]) =>
      mailDatabaseClient.onChanged(listener),
  },
  openExternal: (url: string) => ipcRenderer.invoke("desktop:open-external", url),
  openWindowsNotificationSettings: () =>
    ipcRenderer.invoke("desktop:open-windows-notification-settings") as Promise<{
      ok: boolean;
      supported: boolean;
    }>,
  saveDiagnosticsPackage: (fileName: string) =>
    ipcRenderer.invoke("desktop:save-diagnostics-package", fileName) as Promise<{
      ok: boolean;
      canceled?: boolean;
      filePath?: string;
      error?: string;
    }>,
  getApiBaseUrl: async () => {
    const port = (await ipcRenderer.invoke("desktop:get-api-port")) as
      | number
      | null;
    return port ? `http://127.0.0.1:${port}` : undefined;
  },
  onApiEndpointChanged: (
    callback: (state: {
      state: "recovering" | "ready";
      baseUrl?: string;
      generation: number;
    }) => void,
  ) => {
    // Reserved for a future local-API lifecycle publisher. Mail Core is a
    // separate process and its readiness does not imply a new API port.
    const listener = (
      _event: unknown,
      endpoint: {
        state: "recovering" | "ready";
        port: number | null;
        generation: number;
      },
    ) => callback({
      state: endpoint.state,
      ...(endpoint.port ? { baseUrl: `http://127.0.0.1:${endpoint.port}` } : {}),
      generation: endpoint.generation,
    });
    return subscribeDesktopEvent(
      ipcRenderer,
      "mail-core:api-endpoint-changed",
      listener,
    );
  },
  copyMcpConfiguration: (target: WemailMcpConfigurationTarget) =>
    ipcRenderer.invoke(
      "mcp:copy-configuration",
      target,
    ) as Promise<WemailMcpConfigurationCopyResult>,
  searchDirectoryContacts: (
    query: string,
    options?: DirectoryContactQueryOptions,
  ) =>
    ipcRenderer.invoke("directory:search-contacts", {
      query,
      departmentId: options?.departmentId,
      includeDescendants: options?.includeDescendants,
      limit: options?.limit,
      offset: options?.offset,
    }) as Promise<{ ok: true } & DirectoryContactSearchResult>,
  showWindow: () => ipcRenderer.invoke("desktop:show-window"),
  agentDrafts: {
    get: (accountId: string, conversationId: string) =>
      ipcRenderer.invoke("agent-draft:get", { accountId, conversationId }) as Promise<{ text: string }>,
    save: (accountId: string, conversationId: string, text: string) =>
      ipcRenderer.invoke("agent-draft:save", { accountId, conversationId, text }) as Promise<{ ok: boolean }>,
    delete: (accountId: string, conversationId: string) =>
      ipcRenderer.invoke("agent-draft:delete", { accountId, conversationId }) as Promise<{ ok: boolean }>,
    clearAccount: (accountId: string) =>
      ipcRenderer.invoke("agent-draft:clear-account", accountId) as Promise<{ ok: boolean }>,
  },
  getAppInfo: () => ipcRenderer.invoke("desktop:get-app-info"),
  setStartAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke("desktop:set-start-at-login", enabled),
  storage: {
    getDataDirectory: () => ipcRenderer.invoke("desktop:get-data-directory"),
    chooseDataDirectory: () => ipcRenderer.invoke("desktop:choose-data-directory"),
    migrateDataDirectory: (target: string) =>
      ipcRenderer.invoke("desktop:migrate-data-directory", target),
  },
  update: createDesktopUpdateBridge(ipcRenderer),
  telemetry: {
    track: (event: TelemetryEventName, args?: TelemetryArgs) =>
      ipcRenderer.send("telemetry:track", event, args),
    getEnabled: () => ipcRenderer.invoke("telemetry:get-enabled") as Promise<boolean>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("telemetry:set-enabled", enabled) as Promise<{ enabled: boolean }>,
  },
  onMailChanged: (
    callback: (payload: {
      accountId: string;
      origin: "live-idle" | "live-poll" | "manual";
      insertedCount: number;
      insertedIds: string[];
    }) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: {
        accountId: string;
        origin: "live-idle" | "live-poll" | "manual";
        insertedCount: number;
        insertedIds: string[];
      },
    ) => callback(payload);
    return subscribeDesktopEvent(ipcRenderer, "mail:changed", listener);
  },
  onMailAuthRequired: (
    callback: (payload: {
      accountId: string;
      code: "MAIL_CREDENTIAL_INVALID";
      stage: "imap.login";
    }) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: {
        accountId: string;
        code: "MAIL_CREDENTIAL_INVALID";
        stage: "imap.login";
      },
    ) => callback(payload);
    return subscribeDesktopEvent(ipcRenderer, "mail:auth-required", listener);
  },
  onNotificationNavigate: (
    callback: (target: NotificationTarget) => void,
  ) => {
    const listener = (_event: unknown, target: NotificationTarget) =>
      callback(target);
    return subscribeDesktopEvent(
      ipcRenderer,
      "notification:navigate",
      listener,
    );
  },
  notifyAgentConfirmation: (input: {
    accountId: string;
    actionId: string;
    description: string;
  }) => ipcRenderer.send("notification:agent-confirmation", input),
  notifyAgentRun: (input: {
    accountId: string;
    conversationId: string;
    runId: string;
    state: "failed" | "paused";
  }) => ipcRenderer.send("notification:agent-run", input),
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () =>
      ipcRenderer.invoke("window:toggle-maximize") as Promise<{
        maximized: boolean;
      }>,
    close: () => ipcRenderer.invoke("window:close"),
    quit: () => ipcRenderer.invoke("window:quit"),
	getCloseBehavior: () => ipcRenderer.invoke("window:get-close-behavior") as Promise<"tray" | "exit">,
	setCloseBehavior: (value: "tray" | "exit") => ipcRenderer.invoke("window:set-close-behavior", value) as Promise<{ ok: boolean; value: "tray" | "exit" }>,
	onCloseBehaviorChange: (callback: (value: "tray" | "exit") => void) => {
	  const listener = (_event: unknown, value: "tray" | "exit") => callback(value);
	  return subscribeDesktopEvent(ipcRenderer, "window:close-behavior-changed", listener);
	},
    isMaximized: () =>
      ipcRenderer.invoke("window:is-maximized") as Promise<boolean>,
    onMaximizedChange: (callback: (maximized: boolean) => void) => {
      const listener = (_e: unknown, maximized: boolean) => callback(maximized);
      return subscribeDesktopEvent(
        ipcRenderer,
        "window:maximized-changed",
        listener,
      );
    },
  },
});
