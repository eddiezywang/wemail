import type {
  CancellationToken,
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import type {
  AvailableUpdate,
  UpdateProgress,
} from "../../shared/wemail/update.js";

export type UpdaterAdapterEventMap = {
  "update-available": [update: AvailableUpdate];
  "update-not-available": [];
  "download-progress": [progress: UpdateProgress];
  "update-downloaded": [];
  "update-cancelled": [];
  error: [error: Error];
};

export interface UpdaterAdapter {
  on<Event extends keyof UpdaterAdapterEventMap>(
    event: Event,
    handler: (...args: UpdaterAdapterEventMap[Event]) => void,
  ): void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  cancelDownload(): void;
  quitAndInstall(): void;
}

type ElectronUpdaterEventMap = {
  "update-available": (info: UpdateInfo) => void;
  "update-not-available": (info: UpdateInfo) => void;
  "download-progress": (info: ProgressInfo) => void;
  "update-downloaded": (event: UpdateDownloadedEvent) => void;
  "update-cancelled": (info: UpdateInfo) => void;
  error: (error: Error, message?: string) => void;
};

interface ElectronUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableWebInstaller?: boolean;
  on<Event extends keyof ElectronUpdaterEventMap>(
    event: Event,
    handler: ElectronUpdaterEventMap[Event],
  ): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(token: CancellationToken): Promise<string[]>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  setFeedURL(url: string): void;
}

interface CreateElectronUpdaterAdapterOptions {
  updater: ElectronUpdaterLike;
  createCancellationToken: () => CancellationToken;
  feedUrls?: readonly string[];
}

type PendingCheckEvent =
  | { type: "available"; update: AvailableUpdate }
  | { type: "not-available" };

type ReleaseNoteWithTitle = {
  note?: string | null;
  title?: string | null;
};

function normalizeReleaseNotes(
  releaseNotes: UpdateInfo["releaseNotes"],
): string | null {
  if (typeof releaseNotes === "string") {
    return releaseNotes;
  }
  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const notes = releaseNotes.flatMap((releaseNote) => {
    const titledReleaseNote = releaseNote as ReleaseNoteWithTitle;
    return [titledReleaseNote.title, titledReleaseNote.note]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n");
  });
  const readableNotes = notes.filter((note) => note.length > 0).join("\n\n");
  return readableNotes.length > 0 ? readableNotes : null;
}

function normalizeAvailableUpdate(info: UpdateInfo): AvailableUpdate {
  const size = info.files
    .map((file) => file.size)
    .find(
      (fileSize): fileSize is number =>
        typeof fileSize === "number" &&
        Number.isFinite(fileSize) &&
        fileSize >= 0,
    );

  return {
    version: info.version,
    releaseName:
      typeof info.releaseName === "string" ? info.releaseName : null,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    size: size ?? null,
  };
}

function normalizeNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeProgress(info: ProgressInfo): UpdateProgress {
  return {
    percent: Math.min(100, normalizeNonNegative(info.percent)),
    transferred: normalizeNonNegative(info.transferred),
    total: normalizeNonNegative(info.total),
    bytesPerSecond: normalizeNonNegative(info.bytesPerSecond),
  };
}

export function createElectronUpdaterAdapter({
  updater,
  createCancellationToken,
  feedUrls = [],
}: CreateElectronUpdaterAdapterOptions): UpdaterAdapter {
  const handlers = new Map<
    keyof UpdaterAdapterEventMap,
    Set<(...args: never[]) => void>
  >();
  let activeCancellationToken: CancellationToken | null = null;
  let checking = false;
  let configuredFeedUrl = feedUrls[0] ?? null;
  let pendingCheckEvent: PendingCheckEvent | null = null;

  function getPendingCheckEvent(): PendingCheckEvent | null {
    return pendingCheckEvent;
  }

  function emit<Event extends keyof UpdaterAdapterEventMap>(
    event: Event,
    ...args: UpdaterAdapterEventMap[Event]
  ): void {
    for (const handler of handlers.get(event) ?? []) {
      handler(...(args as never[]));
    }
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  if ("disableWebInstaller" in updater) {
    updater.disableWebInstaller = true;
  }
  if (configuredFeedUrl) {
    updater.setFeedURL(configuredFeedUrl);
  }

  updater.on("update-available", (info) => {
    const update = normalizeAvailableUpdate(info);
    if (checking) {
      pendingCheckEvent = { type: "available", update };
      return;
    }
    emit("update-available", update);
  });
  updater.on("update-not-available", () => {
    if (checking) {
      pendingCheckEvent = { type: "not-available" };
      return;
    }
    emit("update-not-available");
  });
  updater.on("download-progress", (info) => {
    emit("download-progress", normalizeProgress(info));
  });
  updater.on("update-downloaded", () => {
    emit("update-downloaded");
  });
  updater.on("update-cancelled", () => {
    emit("update-cancelled");
  });
  updater.on("error", (error) => {
    if (!checking) {
      emit("error", error);
    }
  });

  return {
    on(event, handler) {
      let eventHandlers = handlers.get(event);
      if (!eventHandlers) {
        eventHandlers = new Set();
        handlers.set(event, eventHandlers);
      }
      eventHandlers.add(handler as (...args: never[]) => void);
    },
    async checkForUpdates() {
      if (feedUrls.length === 0) {
        await updater.checkForUpdates();
        return;
      }
      checking = true;
      let lastError: unknown;
      let reachedServer = false;
      try {
        for (const feedUrl of feedUrls) {
          pendingCheckEvent = null;
          if (configuredFeedUrl !== feedUrl) {
            updater.setFeedURL(feedUrl);
            configuredFeedUrl = feedUrl;
          }
          try {
            await updater.checkForUpdates();
          } catch (error) {
            lastError = error;
            continue;
          }
          reachedServer = true;
          const checkEvent = getPendingCheckEvent();
          if (checkEvent?.type === "available") {
            emit("update-available", checkEvent.update);
            return;
          }
        }
      } finally {
        checking = false;
        pendingCheckEvent = null;
      }
      if (reachedServer) {
        emit("update-not-available");
        return;
      }
      throw lastError;
    },
    async downloadUpdate() {
      const cancellationToken = createCancellationToken();
      activeCancellationToken = cancellationToken;
      try {
        await updater.downloadUpdate(cancellationToken);
      } finally {
        if (activeCancellationToken === cancellationToken) {
          activeCancellationToken = null;
        }
      }
    },
    cancelDownload() {
      const cancellationToken = activeCancellationToken;
      if (!cancellationToken) {
        return;
      }
      activeCancellationToken = null;
      cancellationToken.cancel();
    },
    quitAndInstall() {
      updater.quitAndInstall(false, true);
    },
  };
}
