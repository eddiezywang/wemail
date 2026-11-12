import { describe, expect, it, vi } from "vitest";
import { createUpdateQuitCoordinator } from "./update-quit.js";

describe("update quit coordinator", () => {
  it("stops services before a normal application quit", async () => {
    const stop = vi.fn(async () => undefined);
    const quit = vi.fn();
    const quitAndInstall = vi.fn();
    const coordinator = createUpdateQuitCoordinator({
      stop,
      quit,
      quitAndInstall,
    });
    const event = { preventDefault: vi.fn() };

    await coordinator.handleBeforeQuit(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0],
    );
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs only after graceful shutdown when install-on-exit is armed", async () => {
    const stop = vi.fn(async () => undefined);
    const quit = vi.fn();
    const quitAndInstall = vi.fn();
    const coordinator = createUpdateQuitCoordinator({
      stop,
      quit,
      quitAndInstall,
    });
    coordinator.armInstallOnExit();

    await coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      quitAndInstall.mock.invocationCallOrder[0],
    );
    expect(quitAndInstall).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("uses the same guarded shutdown for immediate installation", async () => {
    const quitAndInstall = vi.fn();
    const coordinator = createUpdateQuitCoordinator({
      stop: vi.fn(async () => undefined),
      quit: vi.fn(),
      quitAndInstall,
    });
    coordinator.armInstallNow();

    await coordinator.handleBeforeQuit({ preventDefault: vi.fn() });

    expect(quitAndInstall).toHaveBeenCalledOnce();
  });

  it("does not re-enter shutdown when app.quit emits before-quit again", async () => {
    let finishStop: (() => void) | undefined;
    const stop = vi.fn(
      () => new Promise<void>((resolve) => { finishStop = resolve; }),
    );
    const quit = vi.fn();
    const coordinator = createUpdateQuitCoordinator({
      stop,
      quit,
      quitAndInstall: vi.fn(),
    });
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    const firstQuit = coordinator.handleBeforeQuit(firstEvent);
    await coordinator.handleBeforeQuit(repeatedEvent);
    finishStop?.();
    await firstQuit;

    expect(stop).toHaveBeenCalledOnce();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("still selects the requested exit path when service shutdown fails", async () => {
    const quitAndInstall = vi.fn();
    const coordinator = createUpdateQuitCoordinator({
      stop: vi.fn(async () => { throw new Error("database stop failed"); }),
      quit: vi.fn(),
      quitAndInstall,
    });
    coordinator.armInstallOnExit();

    await expect(
      coordinator.handleBeforeQuit({ preventDefault: vi.fn() }),
    ).resolves.toBeUndefined();
    expect(quitAndInstall).toHaveBeenCalledOnce();
  });

  it("starts the installer after the graceful shutdown deadline", async () => {
    vi.useFakeTimers();
    try {
      const quitAndInstall = vi.fn();
      const onStopTimeout = vi.fn();
      const coordinator = createUpdateQuitCoordinator({
        stop: vi.fn(() => new Promise<void>(() => {})),
        quit: vi.fn(),
        quitAndInstall,
        stopTimeoutMs: 5_000,
        onStopTimeout,
      });
      coordinator.armInstallNow();

      const quitting = coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(5_000);
      await quitting;

      expect(onStopTimeout).toHaveBeenCalledWith(5_000);
      expect(quitAndInstall).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a normal quit when the installer cannot launch", async () => {
    const quit = vi.fn();
    const coordinator = createUpdateQuitCoordinator({
      stop: vi.fn(async () => undefined),
      quit,
      quitAndInstall: vi.fn(() => {
        throw new Error("installer launch failed");
      }),
    });
    coordinator.armInstallNow();

    await expect(
      coordinator.handleBeforeQuit({ preventDefault: vi.fn() }),
    ).resolves.toBeUndefined();
    expect(quit).toHaveBeenCalledOnce();
  });
});
