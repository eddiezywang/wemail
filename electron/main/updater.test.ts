import { describe, expect, it, vi } from "vitest";
import type {
  AvailableUpdate,
  UpdateProgress,
} from "../../shared/wemail/update.js";
import type {
  UpdaterAdapter,
  UpdaterAdapterEventMap,
} from "./electron-updater-adapter.js";
import { classifyUpdateError, createUpdateController } from "./updater.js";

function createAdapterHarness() {
  const handlers = new Map<
    keyof UpdaterAdapterEventMap,
    Set<(...args: never[]) => void>
  >();
  const adapter: UpdaterAdapter = {
    on: vi.fn((event, handler) => {
      let eventHandlers = handlers.get(event);
      if (!eventHandlers) {
        eventHandlers = new Set();
        handlers.set(event, eventHandlers);
      }
      eventHandlers.add(handler as (...args: never[]) => void);
    }),
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    cancelDownload: vi.fn(),
    quitAndInstall: vi.fn(),
  };

  function emit<Event extends keyof UpdaterAdapterEventMap>(
    event: Event,
    ...args: UpdaterAdapterEventMap[Event]
  ) {
    for (const handler of handlers.get(event) ?? []) {
      handler(...(args as never[]));
    }
  }

  return { adapter, emit };
}

const availableUpdate: AvailableUpdate = {
  version: "1.1.0",
  releaseName: "WeMail 1.1.0",
  releaseNotes: "Security and stability fixes",
  size: 1024,
};

function createHarness(enabled = true) {
  const updater = createAdapterHarness();
  const log = vi.fn();
  const requestQuitForInstall = vi.fn();
  const armInstallOnExit = vi.fn();
  const controller = createUpdateController({
    enabled,
    currentVersion: "1.0.0",
    adapter: updater.adapter,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    log,
    requestQuitForInstall,
    armInstallOnExit,
  });
  return {
    ...updater,
    armInstallOnExit,
    controller,
    log,
    requestQuitForInstall,
  };
}

async function makeAvailable(harness: ReturnType<typeof createHarness>) {
  await harness.controller.check("manual");
  harness.emit("update-available", availableUpdate);
}

async function makeDownloaded(harness: ReturnType<typeof createHarness>) {
  await makeAvailable(harness);
  await harness.controller.download();
  harness.emit("update-downloaded");
}

describe("update controller", () => {
  it("checks only once at startup and never checks when disabled", async () => {
    const enabled = createHarness();
    await enabled.controller.check("startup");
    await enabled.controller.check("startup");
    expect(enabled.adapter.checkForUpdates).toHaveBeenCalledOnce();

    const disabled = createHarness(false);
    await disabled.controller.check("startup");
    expect(disabled.adapter.checkForUpdates).not.toHaveBeenCalled();
    expect(disabled.controller.getState().status).toBe("disabled");
  });

  it("publishes an available update without downloading before confirmation", async () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.controller.subscribe(listener);

    await harness.controller.check("startup");
    harness.emit("update-available", availableUpdate);

    expect(harness.controller.getState()).toMatchObject({
      status: "available",
      availableVersion: "1.1.0",
      lastCheckedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(harness.adapter.downloadUpdate).not.toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith(harness.controller.getState());
  });

  it("rejects same, older, prerelease, and malformed update versions", async () => {
    const harness = createHarness();
    await harness.controller.check("manual");
    harness.emit("update-available", { ...availableUpdate, version: "1.0.0" });

    expect(harness.controller.getState()).toMatchObject({
      status: "check-failed",
      errorCode: "INVALID_UPDATE_METADATA",
      lastCheckedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it("suppresses only the current process prompt after dismissal", async () => {
    const harness = createHarness();
    await makeAvailable(harness);

    expect(harness.controller.shouldPromptForAvailableUpdate()).toBe(true);
    harness.controller.dismissAvailableUpdate();
    expect(harness.controller.shouldPromptForAvailableUpdate()).toBe(false);
    expect(harness.controller.getState().status).toBe("available");
  });

  it("downloads after confirmation, reports progress, and supports cancellation", async () => {
    const harness = createHarness();
    await makeAvailable(harness);
    let resolveDownload: (() => void) | undefined;
    vi.mocked(harness.adapter.downloadUpdate).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveDownload = resolve; }),
    );

    const download = harness.controller.download();
    const progress: UpdateProgress = {
      percent: 25,
      transferred: 256,
      total: 1024,
      bytesPerSecond: 128,
    };
    harness.emit("download-progress", progress);
    harness.controller.cancelDownload();
    harness.emit("update-cancelled");
    resolveDownload?.();
    await download;

    expect(harness.adapter.cancelDownload).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toMatchObject({
      status: "available",
      progress: null,
    });
  });

  it("maps a signature failure during download to a non-bypassable security state", async () => {
    const harness = createHarness();
    await makeAvailable(harness);
    let rejectDownload: ((error: Error) => void) | undefined;
    vi.mocked(harness.adapter.downloadUpdate).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectDownload = reject; }),
    );

    const download = harness.controller.download();
    rejectDownload?.(new Error("publisher could not be verified"));
    await download;

    expect(harness.controller.getState()).toMatchObject({
      status: "security-failed",
      errorCode: "SECURITY_VERIFICATION_FAILED",
    });
  });

  it("does not apply a rejected updater promise twice after an error event", async () => {
    const harness = createHarness();
    await makeAvailable(harness);
    let rejectDownload: ((error: Error) => void) | undefined;
    vi.mocked(harness.adapter.downloadUpdate).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectDownload = reject; }),
    );

    const download = harness.controller.download();
    const error = new Error("sha512 mismatch");
    harness.emit("error", error);
    rejectDownload?.(error);

    await expect(download).resolves.toBeUndefined();
    expect(harness.controller.getState().status).toBe("security-failed");
  });

  it("arms install-on-exit without quitting and requests graceful quit for install-now", async () => {
    const onExit = createHarness();
    await makeDownloaded(onExit);
    onExit.controller.selectInstallOnExit();
    expect(onExit.armInstallOnExit).toHaveBeenCalledOnce();
    expect(onExit.requestQuitForInstall).not.toHaveBeenCalled();
    expect(onExit.controller.getState().status).toBe("install-on-exit");

    const now = createHarness();
    await makeDownloaded(now);
    now.controller.requestInstallNow();
    expect(now.requestQuitForInstall).toHaveBeenCalledOnce();
    expect(now.controller.getState().status).toBe("installing");
  });

  it("delegates verified installation without exposing installer arguments", () => {
    const harness = createHarness();
    harness.controller.quitAndInstall();
    expect(harness.adapter.quitAndInstall).toHaveBeenCalledWith();
  });

  it("records installer launch failures before propagating them to shutdown", async () => {
    const harness = createHarness();
    await makeDownloaded(harness);
    harness.controller.requestInstallNow();
    vi.mocked(harness.adapter.quitAndInstall).mockImplementationOnce(() => {
      throw new Error("installer process could not start");
    });

    expect(() => harness.controller.quitAndInstall()).toThrow(
      "installer process could not start",
    );
    expect(harness.controller.getState()).toMatchObject({
      status: "install-failed",
      errorCode: "INSTALLER_START_FAILED",
    });
  });
});

describe("update error classification", () => {
  it("classifies security, disk, network, server, and fallback failures", () => {
    expect(classifyUpdateError(new Error("sha512 checksum mismatch"))).toEqual({
      kind: "security",
      errorCode: "SECURITY_VERIFICATION_FAILED",
    });
    expect(classifyUpdateError(new Error("ENOSPC: insufficient disk space"))).toEqual({
      kind: "download",
      errorCode: "INSUFFICIENT_DISK_SPACE",
    });
    expect(classifyUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toEqual({
      kind: "network",
      errorCode: "NETWORK_UNAVAILABLE",
    });
    expect(classifyUpdateError(new Error("HTTP 503"))).toEqual({
      kind: "server",
      errorCode: "UPDATE_SERVER_UNAVAILABLE",
    });
    expect(classifyUpdateError(new Error("unexpected stream failure"))).toEqual({
      kind: "download",
      errorCode: "DOWNLOAD_FAILED",
    });
  });
});
