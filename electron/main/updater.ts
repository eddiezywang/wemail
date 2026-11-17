import type {
  DesktopUpdateState,
  UpdateErrorCode,
  UpdateEvent,
} from "../../shared/wemail/update.js";
import {
  createInitialUpdateState,
  isNewerReleaseVersion,
  reduceUpdateState,
} from "../../shared/wemail/update.js";
import type { UpdaterAdapter } from "./electron-updater-adapter.js";

type ClassifiedUpdateError =
  | { kind: "security"; errorCode: "SECURITY_VERIFICATION_FAILED" }
  | { kind: "network"; errorCode: "NETWORK_UNAVAILABLE" }
  | { kind: "server"; errorCode: "UPDATE_SERVER_UNAVAILABLE" }
  | { kind: "metadata"; errorCode: "INVALID_UPDATE_METADATA" }
  | {
      kind: "download";
      errorCode: "INSUFFICIENT_DISK_SPACE" | "DOWNLOAD_FAILED";
    };

export function classifyUpdateError(error: unknown): ClassifiedUpdateError {
  const message = error instanceof Error
    ? `${error.name} ${error.message}`.toLowerCase()
    : String(error).toLowerCase();

  if (
    message.includes("signature") ||
    message.includes("publisher") ||
    message.includes("sha512") ||
    message.includes("checksum") ||
    message.includes("code sign")
  ) {
    return {
      kind: "security",
      errorCode: "SECURITY_VERIFICATION_FAILED",
    };
  }
  if (message.includes("enospc") || message.includes("disk space")) {
    return {
      kind: "download",
      errorCode: "INSUFFICIENT_DISK_SPACE",
    };
  }
  if (
    message.includes("err_internet_disconnected") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("network unavailable")
  ) {
    return { kind: "network", errorCode: "NETWORK_UNAVAILABLE" };
  }
  if (
    /\b(?:http\s*)?(?:404|429|5\d\d)\b/.test(message) ||
    message.includes("server unavailable")
  ) {
    return {
      kind: "server",
      errorCode: "UPDATE_SERVER_UNAVAILABLE",
    };
  }
  if (
    message.includes("yaml") ||
    message.includes("metadata") ||
    message.includes("latest.yml") ||
    message.includes("latest-mac.yml")
  ) {
    return { kind: "metadata", errorCode: "INVALID_UPDATE_METADATA" };
  }
  return { kind: "download", errorCode: "DOWNLOAD_FAILED" };
}

interface CreateUpdateControllerOptions {
  enabled: boolean;
  currentVersion: string;
  adapter: UpdaterAdapter;
  now?: () => Date;
  requestQuitForInstall?: () => void;
  armInstallOnExit?: () => void;
  log: (event: string, data?: Record<string, unknown>) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateController(options: CreateUpdateControllerOptions) {
  let state = createInitialUpdateState(
    options.currentVersion,
    options.enabled,
  );
  let startupChecked = false;
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  const now = () => (options.now?.() ?? new Date()).toISOString();

  const publish = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };
  const apply = (event: UpdateEvent) => {
    state = reduceUpdateState(state, event);
    publish();
    return state;
  };
  const logIgnoredEvent = (event: string) => {
    options.log("update-event-ignored", { event, status: state.status });
  };

  function applyCheckFailure(error: unknown) {
    if (state.status !== "checking") {
      return;
    }
    const classified = classifyUpdateError(error);
    const errorCode: Extract<
      UpdateErrorCode,
      | "NETWORK_UNAVAILABLE"
      | "UPDATE_SERVER_UNAVAILABLE"
      | "INVALID_UPDATE_METADATA"
    > = classified.kind === "network"
      ? "NETWORK_UNAVAILABLE"
      : classified.kind === "metadata"
        ? "INVALID_UPDATE_METADATA"
        : "UPDATE_SERVER_UNAVAILABLE";
    options.log("update-check-failed", {
      errorCode,
      message: errorMessage(error),
    });
    apply({ type: "failed", stage: "check", errorCode, checkedAt: now() });
  }

  function applyDownloadFailure(error: unknown) {
    if (state.status !== "downloading") {
      return;
    }
    const classified = classifyUpdateError(error);
    options.log("update-download-failed", {
      errorCode: classified.errorCode,
      message: errorMessage(error),
    });
    if (classified.kind === "security") {
      apply({
        type: "failed",
        stage: "security",
        errorCode: classified.errorCode,
      });
      return;
    }
    const errorCode = classified.kind === "network"
      ? "NETWORK_UNAVAILABLE"
      : classified.kind === "server"
        ? "UPDATE_SERVER_UNAVAILABLE"
        : classified.kind === "download"
          ? classified.errorCode
          : "DOWNLOAD_FAILED";
    apply({ type: "failed", stage: "download", errorCode });
  }

  options.adapter.on("update-available", (update) => {
    if (state.status !== "checking") {
      logIgnoredEvent("update-available");
      return;
    }
    if (!isNewerReleaseVersion(state.currentVersion, update.version)) {
      apply({
        type: "failed",
        stage: "check",
        errorCode: "INVALID_UPDATE_METADATA",
        checkedAt: now(),
      });
      return;
    }
    apply({ type: "update-available", update, checkedAt: now() });
  });
  options.adapter.on("update-not-available", () => {
    if (state.status !== "checking") {
      logIgnoredEvent("update-not-available");
      return;
    }
    apply({ type: "update-not-available", checkedAt: now() });
  });
  options.adapter.on("download-progress", (progress) => {
    if (state.status !== "downloading") {
      logIgnoredEvent("download-progress");
      return;
    }
    apply({ type: "download-progress", progress });
  });
  options.adapter.on("update-downloaded", () => {
    if (state.status !== "downloading") {
      logIgnoredEvent("update-downloaded");
      return;
    }
    apply({ type: "download-complete" });
  });
  options.adapter.on("update-cancelled", () => {
    if (state.status !== "downloading") {
      logIgnoredEvent("update-cancelled");
      return;
    }
    apply({ type: "download-cancelled" });
  });
  options.adapter.on("error", (error) => {
    if (state.status === "checking") {
      applyCheckFailure(error);
      return;
    }
    if (state.status === "downloading") {
      applyDownloadFailure(error);
      return;
    }
    if (["downloaded", "install-on-exit", "installing"].includes(state.status)) {
      options.log("update-install-failed", { message: errorMessage(error) });
      apply({
        type: "failed",
        stage: "install",
        errorCode: "INSTALLER_START_FAILED",
      });
      return;
    }
    logIgnoredEvent("error");
  });

  async function download() {
    if (!["available", "download-failed"].includes(state.status)) {
      throw new Error(`Update download is unavailable in state ${state.status}`);
    }
    apply({ type: "download-started" });
    try {
      await options.adapter.downloadUpdate();
    } catch (error) {
      applyDownloadFailure(error);
    }
  }

  return {
    getState: () => state,
    subscribe(listener: (next: DesktopUpdateState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async check(source: "startup" | "manual") {
      if (!options.enabled) {
        return state;
      }
      if (source === "startup" && startupChecked) {
        return state;
      }
      if (["checking", "downloading", "downloaded", "install-on-exit", "installing"].includes(state.status)) {
        return state;
      }
      if (source === "startup") {
        startupChecked = true;
      }
      apply({ type: "check-started", source });
      try {
        await options.adapter.checkForUpdates();
      } catch (error) {
        applyCheckFailure(error);
      }
      return state;
    },
    download,
    cancelDownload() {
      if (state.status !== "downloading") {
        throw new Error(`Update cancellation is unavailable in state ${state.status}`);
      }
      options.adapter.cancelDownload();
    },
    retryDownload() {
      if (state.status !== "download-failed") {
        throw new Error(`Update retry is unavailable in state ${state.status}`);
      }
      return download();
    },
    dismissAvailableUpdate() {
      if (state.status !== "available") {
        throw new Error(`Update dismissal is unavailable in state ${state.status}`);
      }
      apply({ type: "available-dismissed" });
    },
    shouldPromptForAvailableUpdate() {
      return state.status === "available" && !state.promptSuppressed;
    },
    selectInstallOnExit() {
      if (state.status !== "downloaded") {
        throw new Error(`Install-on-exit is unavailable in state ${state.status}`);
      }
      apply({ type: "install-on-exit-selected" });
      options.armInstallOnExit?.();
    },
    requestInstallNow() {
      if (!["downloaded", "install-on-exit"].includes(state.status)) {
        throw new Error(`Immediate install is unavailable in state ${state.status}`);
      }
      apply({ type: "install-started" });
      try {
        options.requestQuitForInstall?.();
      } catch (error) {
        options.log("update-install-failed", { message: errorMessage(error) });
        apply({
          type: "failed",
          stage: "install",
          errorCode: "INSTALLER_START_FAILED",
        });
      }
    },
    quitAndInstall() {
      try {
        options.adapter.quitAndInstall();
      } catch (error) {
        options.log("update-install-failed", { message: errorMessage(error) });
        if (["downloaded", "install-on-exit", "installing"].includes(state.status)) {
          apply({
            type: "failed",
            stage: "install",
            errorCode: "INSTALLER_START_FAILED",
          });
        }
        throw error;
      }
    },
  };
}

export type UpdateController = ReturnType<typeof createUpdateController>;
