import type {
  CancellationToken,
  ProgressInfo,
  UpdateInfo,
} from "electron-updater";
import { describe, expect, it, vi } from "vitest";
import type {
  AvailableUpdate,
  UpdateProgress,
} from "../../shared/wemail/update.js";
import { createElectronUpdaterAdapter } from "./electron-updater-adapter.js";

type UpdaterEventHandlers = {
  "update-available": (info: UpdateInfo) => void;
  "update-not-available": (info: UpdateInfo) => void;
  "download-progress": (info: ProgressInfo) => void;
  "update-downloaded": (info: UpdateInfo & { downloadedFile: string }) => void;
  "update-cancelled": (info: UpdateInfo) => void;
  error: (error: Error, message?: string) => void;
};

function createUpdateInfo(
  overrides: Partial<UpdateInfo> = {},
): UpdateInfo {
  return {
    version: "2.0.0",
    files: [{ url: "wemail.exe", sha512: "checksum", size: 4096 }],
    path: "wemail.exe",
    sha512: "checksum",
    releaseDate: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function createHarness(options: {
  supportsDisableWebInstaller?: boolean;
  feedUrls?: string[];
} = {}) {
  const handlers = new Map<
    keyof UpdaterEventHandlers,
    UpdaterEventHandlers[keyof UpdaterEventHandlers]
  >();
  const checkResult = { isUpdateAvailable: false };
  const checkForUpdates = vi.fn().mockResolvedValue(checkResult);
  const downloadUpdate = vi.fn().mockResolvedValue([
    "C:\\private\\downloaded-installer.exe",
  ]);
  const quitAndInstall = vi.fn();
  const setFeedURL = vi.fn();
  const updater: Record<string, unknown> = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: keyof UpdaterEventHandlers, handler: never) => {
      handlers.set(event, handler);
      return updater;
    }),
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    setFeedURL,
  };

  if (options.supportsDisableWebInstaller !== false) {
    updater.disableWebInstaller = false;
  }

  const updaterSession = { partition: "electron-updater" };
  Object.defineProperty(updater, "netSession", {
    configurable: true,
    enumerable: true,
    get: () => updaterSession,
  });
  const tokens: Array<CancellationToken & { cancel: ReturnType<typeof vi.fn> }> = [];
  const createCancellationToken = vi.fn(() => {
    const token = {
      cancel: vi.fn(),
    } as unknown as CancellationToken & { cancel: ReturnType<typeof vi.fn> };
    tokens.push(token);
    return token;
  });
  const adapter = createElectronUpdaterAdapter({
    updater: updater as never,
    createCancellationToken,
    feedUrls: options.feedUrls,
  });

  function emit<Event extends keyof UpdaterEventHandlers>(
    event: Event,
    ...args: Parameters<UpdaterEventHandlers[Event]>
  ): void {
    const handler = handlers.get(event) as
      | ((...handlerArgs: never[]) => void)
      | undefined;
    if (!handler) {
      throw new Error(`No handler registered for ${event}`);
    }
    handler(...(args as unknown as never[]));
  }

  return {
    adapter,
    checkForUpdates,
    createCancellationToken,
    downloadUpdate,
    emit,
    quitAndInstall,
    setFeedURL,
    tokens,
    updater,
    updaterSession,
  };
}

describe("electron updater adapter", () => {
  it("configures the validated packaged feed URL", () => {
    const { setFeedURL } = createHarness({
      feedUrls: ["https://updates.wemail.test/mac/arm64"],
    });

    expect(setFeedURL).toHaveBeenCalledWith(
      "https://updates.wemail.test/mac/arm64",
    );
  });

  it("falls back silently when the primary update server is unavailable", async () => {
    const primaryError = new Error("connect ECONNREFUSED 192.0.2.10");
    const { adapter, checkForUpdates, emit, setFeedURL } = createHarness({
      feedUrls: [
        "http://192.0.2.10/downloads/windows/x64",
        "http://192.0.2.11:12580/downloads/windows/x64",
      ],
    });
    const errorHandler = vi.fn();
    adapter.on("error", errorHandler);
    checkForUpdates
      .mockImplementationOnce(async () => {
        emit("error", primaryError);
        throw primaryError;
      })
      .mockResolvedValueOnce({ isUpdateAvailable: false });

    await expect(adapter.checkForUpdates()).resolves.toBeUndefined();

    expect(setFeedURL).toHaveBeenNthCalledWith(
      1,
      "http://192.0.2.10/downloads/windows/x64",
    );
    expect(setFeedURL).toHaveBeenNthCalledWith(
      2,
      "http://192.0.2.11:12580/downloads/windows/x64",
    );
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it("checks the fallback when the primary server has no update", async () => {
    const { adapter, checkForUpdates, emit } = createHarness({
      feedUrls: [
        "http://192.0.2.10/downloads/windows/x64",
        "http://192.0.2.11:12580/downloads/windows/x64",
      ],
    });
    const availableHandler = vi.fn();
    const notAvailableHandler = vi.fn();
    adapter.on("update-available", availableHandler);
    adapter.on("update-not-available", notAvailableHandler);
    checkForUpdates
      .mockImplementationOnce(async () => {
        emit("update-not-available", createUpdateInfo({ version: "1.0.0" }));
      })
      .mockImplementationOnce(async () => {
        emit("update-available", createUpdateInfo({ version: "1.0.1" }));
      });

    await adapter.checkForUpdates();

    expect(availableHandler).toHaveBeenCalledWith(expect.objectContaining({
      version: "1.0.1",
    }));
    expect(notAvailableHandler).not.toHaveBeenCalled();
  });

  it("configures manual updates without assigning getter-only netSession", () => {
    const { updater, updaterSession } = createHarness();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
    expect(updater.netSession).toBe(updaterSession);
  });

  it("does not add disableWebInstaller when the updater shape lacks it", () => {
    const { updater } = createHarness({ supportsDisableWebInstaller: false });

    expect(updater).not.toHaveProperty("disableWebInstaller");
  });

  it("forwards update lifecycle and error events", () => {
    const { adapter, emit } = createHarness();
    const updateNotAvailable = vi.fn();
    const updateDownloaded = vi.fn();
    const updateCancelled = vi.fn();
    const errorHandler = vi.fn();
    const error = new Error("network unavailable");

    adapter.on("update-not-available", updateNotAvailable);
    adapter.on("update-downloaded", updateDownloaded);
    adapter.on("update-cancelled", updateCancelled);
    adapter.on("error", errorHandler);

    const info = createUpdateInfo();
    emit("update-not-available", info);
    emit("update-downloaded", {
      ...info,
      downloadedFile: "C:\\private\\downloaded-installer.exe",
    });
    emit("update-cancelled", info);
    emit("error", error, "private updater details");

    expect(updateNotAvailable).toHaveBeenCalledWith();
    expect(updateDownloaded).toHaveBeenCalledWith();
    expect(updateCancelled).toHaveBeenCalledWith();
    expect(errorHandler).toHaveBeenCalledWith(error);
  });

  it("normalizes available update metadata with string release notes", () => {
    const { adapter, emit } = createHarness();
    const handler = vi.fn<(update: AvailableUpdate) => void>();
    adapter.on("update-available", handler);

    emit(
      "update-available",
      createUpdateInfo({
        version: "2.1.0",
        releaseName: "Secure update",
        releaseNotes: "Keep this text unchanged.\nIncluding whitespace.",
        files: [
          { url: "first.exe", sha512: "one", size: Number.NaN },
          { url: "second.exe", sha512: "two", size: 8192 },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledWith({
      version: "2.1.0",
      releaseName: "Secure update",
      releaseNotes: "Keep this text unchanged.\nIncluding whitespace.",
      size: 8192,
    });
  });

  it("converts array release notes into readable plain text", () => {
    const { adapter, emit } = createHarness();
    const handler = vi.fn<(update: AvailableUpdate) => void>();
    adapter.on("update-available", handler);

    emit(
      "update-available",
      createUpdateInfo({
        releaseName: undefined,
        releaseNotes: [
          { version: "2.0.0", note: "  Fixed mailbox sync.  " },
          { version: "1.9.0", note: "" },
          { version: "1.8.0", note: null, title: "Security hardening" },
        ] as UpdateInfo["releaseNotes"],
      }),
    );

    expect(handler).toHaveBeenCalledWith({
      version: "2.0.0",
      releaseName: null,
      releaseNotes: "Fixed mailbox sync.\n\nSecurity hardening",
      size: 4096,
    });
  });

  it("uses null for absent notes and invalid file sizes", () => {
    const { adapter, emit } = createHarness();
    const handler = vi.fn<(update: AvailableUpdate) => void>();
    adapter.on("update-available", handler);

    emit(
      "update-available",
      createUpdateInfo({
        releaseNotes: [
          { version: "2.0.0", note: "  " },
          { version: "1.9.0", note: null },
        ],
        files: [
          { url: "negative.exe", sha512: "one", size: -1 },
          { url: "infinite.exe", sha512: "two", size: Number.POSITIVE_INFINITY },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledWith({
      version: "2.0.0",
      releaseName: null,
      releaseNotes: null,
      size: null,
    });
  });

  it("normalizes progress to finite non-negative values and clamps percent", () => {
    const { adapter, emit } = createHarness();
    const handler = vi.fn<(progress: UpdateProgress) => void>();
    adapter.on("download-progress", handler);

    emit("download-progress", {
      percent: 125,
      transferred: -5,
      total: Number.POSITIVE_INFINITY,
      bytesPerSecond: Number.NaN,
      delta: 10,
    });
    emit("download-progress", {
      percent: -1,
      transferred: 50,
      total: 100,
      bytesPerSecond: 25,
      delta: 10,
    });

    expect(handler).toHaveBeenNthCalledWith(1, {
      percent: 100,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      percent: 0,
      transferred: 50,
      total: 100,
      bytesPerSecond: 25,
    });
  });

  it("awaits checks and downloads without returning updater results or paths", async () => {
    const { adapter, checkForUpdates, downloadUpdate } = createHarness();

    await expect(adapter.checkForUpdates()).resolves.toBeUndefined();
    await expect(adapter.downloadUpdate()).resolves.toBeUndefined();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("creates fresh cancellation tokens and cancels only the active token once", async () => {
    const { adapter, createCancellationToken, downloadUpdate, tokens } =
      createHarness();
    let resolveFirst: ((paths: string[]) => void) | undefined;
    let resolveSecond: ((paths: string[]) => void) | undefined;
    downloadUpdate
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const firstDownload = adapter.downloadUpdate();
    const secondDownload = adapter.downloadUpdate();

    expect(createCancellationToken).toHaveBeenCalledTimes(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(downloadUpdate).toHaveBeenNthCalledWith(1, tokens[0]);
    expect(downloadUpdate).toHaveBeenNthCalledWith(2, tokens[1]);

    resolveFirst?.(["C:\\private\\first.exe"]);
    await firstDownload;
    adapter.cancelDownload();
    adapter.cancelDownload();

    expect(tokens[0]?.cancel).not.toHaveBeenCalled();
    expect(tokens[1]?.cancel).toHaveBeenCalledTimes(1);

    resolveSecond?.(["C:\\private\\second.exe"]);
    await secondDownload;
    adapter.cancelDownload();
    expect(tokens[1]?.cancel).toHaveBeenCalledTimes(1);
  });

  it("forwards check and download rejections", async () => {
    const { adapter, checkForUpdates, downloadUpdate } = createHarness();
    const checkError = new Error("check failed");
    const downloadError = new Error("download failed");
    checkForUpdates.mockRejectedValueOnce(checkError);
    downloadUpdate.mockRejectedValueOnce(downloadError);

    await expect(adapter.checkForUpdates()).rejects.toBe(checkError);
    await expect(adapter.downloadUpdate()).rejects.toBe(downloadError);
  });

  it("installs interactively and forces the app to run afterward", () => {
    const { adapter, quitAndInstall } = createHarness();

    adapter.quitAndInstall();

    expect(quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
