import type { DesktopUpdateBridge } from "../../shared/wemail/update";
import type { DirectoryContactSearchResult } from "../../shared/wemail/directory";
import type {
  TelemetryArgs,
  TelemetryEventName,
} from "../../shared/wemail/telemetry";

declare global {
  interface Window {
    wemailDesktop?: {
      apiBaseUrl?: string;
      platform?: string;
      versions?: NodeJS.ProcessVersions;
      getPathForFile?: (file: File) => string;
      getAppInfo?: () => Promise<{
        name: string;
        version: string;
        platform: string;
        arch: string;
        electronVersion: string;
        chromeVersion: string;
        nodeVersion: string;
      }>;
      openExternal?: (url: string) => Promise<{
        ok: boolean;
        reason?: "invalid-url" | "open-failed";
      }>;
      saveDiagnosticsPackage?: (fileName: string) => Promise<{
        ok: boolean;
        canceled?: boolean;
        filePath?: string;
        error?: string;
      }>;
      getApiBaseUrl?: () => Promise<string | undefined>;
      searchDirectoryContacts?: (
        query: string,
        options?: { departmentId?: string; limit?: number; offset?: number },
      ) => Promise<{ ok: true } & DirectoryContactSearchResult>;
      showWindow?: () => Promise<{ ok: true }>;
      agentDrafts?: {
        get(accountId: string, conversationId: string): Promise<{ text: string }>;
        save(accountId: string, conversationId: string, text: string): Promise<{ ok: boolean }>;
        delete(accountId: string, conversationId: string): Promise<{ ok: boolean }>;
        clearAccount(accountId: string): Promise<{ ok: boolean }>;
      };
      setStartAtLogin?: (enabled: boolean) => Promise<unknown>;
      shortcuts?: {
        getStatus(): Promise<{
          ok: boolean;
          status?: {
            entries: Array<{
              location: "desktop" | "startMenu";
              path: string;
              exists: boolean;
              target: string;
              correct: boolean;
            }>;
            prompt: boolean;
            dismissed: boolean;
            currentExe: string;
          };
        }>;
        fix(): Promise<{ ok: boolean }>;
        dismiss(): Promise<{ ok: boolean }>;
      };
      storage?: {
        getDataDirectory(): Promise<{
          currentPath: string;
          defaultPath: string;
          custom: boolean;
          managedByEnvironment: boolean;
          lastMigration?: {
            status: "success" | "failed";
            from: string;
            to: string;
            message?: string;
          };
        } | undefined>;
        chooseDataDirectory(): Promise<{ canceled: boolean; path?: string }>;
        migrateDataDirectory(target: string): Promise<
          | { ok: true; restarting: true }
          | { ok: false; error: string }
        >;
      };
      update?: DesktopUpdateBridge;
      telemetry?: {
        track(event: TelemetryEventName, args?: TelemetryArgs): void;
        getEnabled(): Promise<boolean>;
        setEnabled(enabled: boolean): Promise<{ enabled: boolean }>;
      };
      onMailChanged?: (
        callback: (payload: {
          accountId: string;
          origin: "live-idle" | "live-poll";
          insertedCount: number;
          insertedIds: string[];
        }) => void,
      ) => () => void;
      onMailAuthRequired?: (
        callback: (payload: {
          accountId: string;
          code: "MAIL_CREDENTIAL_INVALID";
          stage: "imap.login";
        }) => void,
      ) => () => void;
      window?: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<{ maximized: boolean }>;
        close(): Promise<void>;
        quit?(): Promise<void>;
		getCloseBehavior?(): Promise<"tray" | "exit">;
		setCloseBehavior?(value: "tray" | "exit"): Promise<{ ok: boolean; value: "tray" | "exit" }>;
		onCloseBehaviorChange?(callback: (value: "tray" | "exit") => void): () => void;
        isMaximized(): Promise<boolean>;
        onMaximizedChange(callback: (maximized: boolean) => void): () => void;
      };
    };
  }
}

export {};
