// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inject `window.wemailDesktop` into the browser page so that
 * `app/services/api.ts` routes requests to the local Hono API
 * instead of cloud endpoints.
 *
 * The shipped renderer reads mail exclusively through the Electron DB
 * Service MessagePort lane (`wemailDesktop.mailDatabase`); there is no
 * `/api/mail/messages` HTTP fallback. A plain Chromium page has no such
 * lane, so the harness injects a browser-side proxy that forwards the
 * DB Service calls to the test-only `/__e2e__/db/:method` routes served
 * by `testServer.ts`. This is a test double, not production code.
 */

import type { Page } from "@playwright/test";

/** Methods proxied 1:1 onto the in-process `MailDatabaseClient`. */
const DB_METHODS = [
  "health",
  "listAccounts",
  "getMailSnapshot",
  "getIntelligenceState",
  "requestIntelligence",
  "listMail",
  "listFolders",
  "listCategories",
  "search",
  "mutateMail",
  "saveDraft",
  "getDraft",
  "listDrafts",
  "listSnoozed",
  "deleteDraft",
  "setSnooze",
  "enqueueSend",
  "listScheduled",
  "listScheduledPage",
  "cancelScheduled",
  "deleteScheduled",
  "getBusinessPreferences",
  "saveBusinessPreferences",
  "listPendingActions",
] as const;

/**
 * Inject the desktop API bridge before the page loads.
 * This makes `isDesktopApi()` return true and `resolveApiUrl()`
 * prefix URLs with `apiBaseUrl`.
 */
export function injectDesktopApi(page: Page, apiBaseUrl: string) {
  page.addInitScript(({ baseUrl, methods }) => {
    const listeners = new Set<(event: unknown) => void>();
    let pollTimer: number | null = null;
    let lastVersion = -1;

    const emitChange = () => {
      const event = {
        changes: [{ entityType: "message", entityPublicId: "*", operation: "update" }],
        resetRequired: false,
      };
      for (const listener of Array.from(listeners)) listener(event);
    };

    const startPolling = () => {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(async () => {
        try {
          const response = await fetch(`${baseUrl}/__e2e__/version`);
          const payload = (await response.json()) as { version: number };
          if (payload.version !== lastVersion) {
            const changed = lastVersion !== -1;
            lastVersion = payload.version;
            if (changed) emitChange();
          }
        } catch {
          // Server may be shutting down between specs.
        }
      }, 400);
    };

    const stopPolling = () => {
      if (pollTimer === null) return;
      window.clearInterval(pollTimer);
      pollTimer = null;
    };

    const call = async (method: string, args: unknown[]) => {
      const response = await fetch(`${baseUrl}/__e2e__/db/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        value?: unknown;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(`[browser-e2e] ${method} failed: ${payload.error ?? response.status}`);
      }
      return payload.value;
    };

    const mailDatabase: Record<string, unknown> = {
      isConnected: () => true,
      cancelRequest: () => undefined,
      onChanged: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        startPolling();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stopPolling();
        };
      },
    };
    for (const method of methods) {
      mailDatabase[method] = async (...args: unknown[]) => {
        const value = await call(method, args);
        // Writer methods must invalidate the renderer's React Query caches.
        if (
          method === "mutateMail" ||
          method === "saveDraft" ||
          method === "deleteDraft" ||
          method === "setSnooze" ||
          method === "requestIntelligence" ||
          method === "saveBusinessPreferences"
        ) {
          emitChange();
        }
        return value;
      };
    }

    const mailCore = {
      isConnected: () => true,
      health: async () => ({
        state: "ready",
        accounts: [],
        runtimeId: "browser-e2e",
      }),
      ensureMailBody: async (_accountId: string, id: string) => ({
        status: "ready",
        emailId: id,
        bodyCached: true,
      }),
      retryMailBody: async (_accountId: string, id: string) => ({
        status: "ready",
        emailId: id,
        bodyCached: true,
      }),
      focusMail: async () => ({ status: "ok" }),
      blurMail: async () => ({ status: "ok" }),
      refreshMail: async (accountId: string) => ({
        status: "queued",
        jobId: "browser-e2e-refresh",
        accountId,
      }),
    };

    const agentDrafts = {
      get: async () => ({ text: "" }),
      save: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
      clearAccount: async () => ({ ok: true }),
    };

    const noopUnsubscribe = () => () => undefined;

    // Shape mirrors shared/wemail/update.ts createInitialUpdateState().
    const updateState = {
      status: "disabled",
      enabled: false,
      currentVersion: "0.0.0",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      size: null,
      progress: null,
      lastCheckedAt: null,
      checkSource: null,
      errorCode: null,
      promptSuppressed: false,
    };

    Object.defineProperty(window, "wemailDesktop", {
      value: {
        apiBaseUrl: baseUrl,
        platform: "browser-e2e",
        mailDatabase,
        mailCore,
        agentDrafts,
        getApiBaseUrl: async () => baseUrl,
        getAppInfo: async () => ({
          name: "WeMail",
          version: "0.0.0",
          platform: "browser-e2e",
          arch: "x64",
          electronVersion: "0.0.0",
          chromeVersion: "0.0.0",
          nodeVersion: "0.0.0",
        }),
        getPathForFile: (file: File) => (file as unknown as { name?: string }).name ?? "",
        openExternal: async () => ({ ok: true }),
        saveDiagnosticsPackage: async () => ({ ok: false, canceled: true }),
        searchDirectoryContacts: async () => ({ ok: true as const, contacts: [], total: 0 }),
        showWindow: async () => ({ ok: true as const }),
        setStartAtLogin: async () => undefined,
        onApiEndpointChanged: noopUnsubscribe,
        onMailChanged: noopUnsubscribe,
        onMailAuthRequired: noopUnsubscribe,
        onNotificationNavigate: noopUnsubscribe,
        notifyAgentRun: () => undefined,
        notifyAgentConfirmation: () => undefined,
        update: {
          getState: async () => updateState,
          check: async () => updateState,
          download: async () => undefined,
          cancelDownload: async () => undefined,
          retryDownload: async () => undefined,
          dismissAvailableUpdate: async () => undefined,
          installNow: async () => undefined,
          installOnExit: async () => undefined,
          onStateChange: noopUnsubscribe,
        },
        telemetry: {
          track: () => undefined,
          getEnabled: async () => false,
          setEnabled: async () => ({ enabled: false }),
        },
        window: {
          minimize: async () => undefined,
          toggleMaximize: async () => ({ maximized: false }),
          close: async () => undefined,
          quit: async () => undefined,
          getCloseBehavior: async () => "exit",
          setCloseBehavior: async () => ({ ok: true, value: "exit" }),
          onCloseBehaviorChange: noopUnsubscribe,
          isMaximized: async () => false,
          onMaximizedChange: noopUnsubscribe,
        },
        storage: {
          getDataDirectory: async () => undefined,
          chooseDataDirectory: async () => ({ canceled: true }),
          migrateDataDirectory: async () => ({ ok: true, restarting: true }),
        },
      },
      writable: false,
      configurable: true,
    });
  }, { baseUrl: apiBaseUrl, methods: [...DB_METHODS] });
}
