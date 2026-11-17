export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "install-on-exit"
  | "installing"
  | "check-failed"
  | "download-failed"
  | "security-failed"
  | "install-failed";

export type UpdateErrorCode =
  | "NETWORK_UNAVAILABLE"
  | "UPDATE_SERVER_UNAVAILABLE"
  | "INVALID_UPDATE_METADATA"
  | "INSUFFICIENT_DISK_SPACE"
  | "DOWNLOAD_FAILED"
  | "SECURITY_VERIFICATION_FAILED"
  | "INSTALLER_START_FAILED";

export type UpdateCheckSource = "startup" | "manual";

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AvailableUpdate {
  version: string;
  releaseName: string | null;
  releaseNotes: string | null;
  size: number | null;
}

export interface DesktopUpdateState {
  status: UpdateStatus;
  enabled: boolean;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  size: number | null;
  progress: UpdateProgress | null;
  lastCheckedAt: string | null;
  checkSource: UpdateCheckSource | null;
  errorCode: UpdateErrorCode | null;
  promptSuppressed: boolean;
}

export type UpdateEvent =
  | { type: "check-started"; source: UpdateCheckSource }
  | { type: "update-available"; update: AvailableUpdate; checkedAt: string }
  | { type: "update-not-available"; checkedAt: string }
  | { type: "download-started" }
  | { type: "download-progress"; progress: UpdateProgress }
  | { type: "download-complete" }
  | { type: "download-cancelled" }
  | { type: "available-dismissed" }
  | { type: "install-on-exit-selected" }
  | { type: "install-started" }
  | {
      type: "failed";
      stage: "check";
      errorCode:
        | "NETWORK_UNAVAILABLE"
        | "UPDATE_SERVER_UNAVAILABLE"
        | "INVALID_UPDATE_METADATA";
      checkedAt: string;
    }
  | {
      type: "failed";
      stage: "download";
      errorCode:
        | "NETWORK_UNAVAILABLE"
        | "UPDATE_SERVER_UNAVAILABLE"
        | "INSUFFICIENT_DISK_SPACE"
        | "DOWNLOAD_FAILED";
    }
  | {
      type: "failed";
      stage: "security";
      errorCode: "SECURITY_VERIFICATION_FAILED";
    }
  | {
      type: "failed";
      stage: "install";
      errorCode: "INSTALLER_START_FAILED";
    };

type UpdateFailureStage = Extract<UpdateEvent, { type: "failed" }>["stage"];

export interface DesktopUpdateBridge {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  retryDownload(): Promise<void>;
  dismissAvailableUpdate(): Promise<void>;
  installNow(): Promise<void>;
  installOnExit(): Promise<void>;
  onStateChange(listener: (state: DesktopUpdateState) => void): () => void;
}

export function createInitialUpdateState(
  currentVersion: string,
  enabled: boolean,
): DesktopUpdateState {
  return {
    status: enabled ? "idle" : "disabled",
    enabled,
    currentVersion,
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
}

function invalidTransition(state: DesktopUpdateState, event: UpdateEvent): never {
  throw new Error(`Invalid update transition: ${state.status} -> ${event.type}`);
}

function requireStatus(
  state: DesktopUpdateState,
  event: UpdateEvent,
  allowed: UpdateStatus[],
): void {
  if (!allowed.includes(state.status)) {
    invalidTransition(state, event);
  }
}

function clearAvailableUpdate(state: DesktopUpdateState): DesktopUpdateState {
  return {
    ...state,
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    size: null,
    progress: null,
  };
}

export function reduceUpdateState(
  state: DesktopUpdateState,
  event: UpdateEvent,
): DesktopUpdateState {
  switch (event.type) {
    case "check-started": {
      requireStatus(state, event, [
        "idle",
        "up-to-date",
        "available",
        "check-failed",
        "download-failed",
      ]);
      return {
        ...clearAvailableUpdate(state),
        status: "checking",
        checkSource: event.source,
        errorCode: null,
      };
    }
    case "update-available":
      requireStatus(state, event, ["checking"]);
      return {
        ...state,
        status: "available",
        availableVersion: event.update.version,
        releaseName: event.update.releaseName,
        releaseNotes: event.update.releaseNotes,
        size: event.update.size,
        progress: null,
        lastCheckedAt: event.checkedAt,
        errorCode: null,
      };
    case "update-not-available":
      requireStatus(state, event, ["checking"]);
      return {
        ...clearAvailableUpdate(state),
        status: "up-to-date",
        lastCheckedAt: event.checkedAt,
        errorCode: null,
      };
    case "download-started":
      requireStatus(state, event, ["available", "download-failed"]);
      return {
        ...state,
        status: "downloading",
        progress: null,
        errorCode: null,
      };
    case "download-progress":
      requireStatus(state, event, ["downloading"]);
      return { ...state, progress: event.progress };
    case "download-complete":
      requireStatus(state, event, ["downloading"]);
      return { ...state, status: "downloaded", progress: null, errorCode: null };
    case "download-cancelled":
      requireStatus(state, event, ["downloading"]);
      return { ...state, status: "available", progress: null, errorCode: null };
    case "available-dismissed":
      requireStatus(state, event, ["available"]);
      return { ...state, promptSuppressed: true };
    case "install-on-exit-selected":
      requireStatus(state, event, ["downloaded"]);
      return { ...state, status: "install-on-exit", errorCode: null };
    case "install-started":
      requireStatus(state, event, ["downloaded", "install-on-exit"]);
      return { ...state, status: "installing", errorCode: null };
    case "failed": {
      const failureStatus = {
        check: "check-failed",
        download: "download-failed",
        security: "security-failed",
        install: "install-failed",
      } as const;
      const allowedStatus: Record<UpdateFailureStage, UpdateStatus[]> = {
        check: ["checking"],
        download: ["downloading"],
        security: ["downloading"],
        install: ["downloaded", "install-on-exit", "installing"],
      };
      requireStatus(state, event, allowedStatus[event.stage]);
      const failedState = {
        ...state,
        status: failureStatus[event.stage],
        progress: null,
        errorCode: event.errorCode,
      };
      if (event.stage === "check") {
        return { ...failedState, lastCheckedAt: event.checkedAt };
      }
      return failedState;
    }
  }
}

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(version: string): [bigint, bigint, bigint] | null {
  const match = stableVersionPattern.exec(version);
  if (!match) {
    return null;
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

export function isNewerReleaseVersion(current: string, candidate: string): boolean {
  const currentParts = parseStableVersion(current);
  const candidateParts = parseStableVersion(candidate);
  if (!currentParts || !candidateParts) {
    return false;
  }

  for (let index = 0; index < currentParts.length; index += 1) {
    if (candidateParts[index] > currentParts[index]) {
      return true;
    }
    if (candidateParts[index] < currentParts[index]) {
      return false;
    }
  }
  return false;
}
