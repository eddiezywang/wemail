import { describe, expect, it, vi } from "vitest";
import { registerUpdateIpc } from "./update-ipc.js";

function createHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
  const controller = {
    getState: vi.fn(() => ({ status: "idle" })),
    check: vi.fn(async () => ({ status: "up-to-date" })),
    download: vi.fn(async () => undefined),
    cancelDownload: vi.fn(),
    retryDownload: vi.fn(async () => undefined),
    dismissAvailableUpdate: vi.fn(),
    requestInstallNow: vi.fn(),
    selectInstallOnExit: vi.fn(),
  };
  registerUpdateIpc(ipcMain as never, controller as never);
  return { controller, handlers, ipcMain };
}

describe("update ipc", () => {
  it("registers only fixed update action channels", () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()]).toEqual([
      "update:get-state",
      "update:check",
      "update:download",
      "update:cancel-download",
      "update:retry-download",
      "update:dismiss",
      "update:install-now",
      "update:install-on-exit",
    ]);
  });

  it("maps channels to controller actions without accepting payloads", async () => {
    const { controller, handlers } = createHarness();
    const event = {};

    await expect(handlers.get("update:get-state")?.(event)).resolves.toEqual({
      status: "idle",
    });
    await expect(handlers.get("update:check")?.(event)).resolves.toEqual({
      status: "up-to-date",
    });
    await expect(handlers.get("update:download")?.(event)).resolves.toBeUndefined();
    await expect(handlers.get("update:cancel-download")?.(event)).resolves.toBeUndefined();
    await expect(handlers.get("update:retry-download")?.(event)).resolves.toBeUndefined();
    await expect(handlers.get("update:dismiss")?.(event)).resolves.toBeUndefined();
    await expect(handlers.get("update:install-now")?.(event)).resolves.toBeUndefined();
    await expect(handlers.get("update:install-on-exit")?.(event)).resolves.toBeUndefined();

    expect(controller.check).toHaveBeenCalledWith("manual");
    expect(controller.download).toHaveBeenCalledOnce();
    expect(controller.cancelDownload).toHaveBeenCalledOnce();
    expect(controller.retryDownload).toHaveBeenCalledOnce();
    expect(controller.dismissAvailableUpdate).toHaveBeenCalledOnce();
    expect(controller.requestInstallNow).toHaveBeenCalledOnce();
    expect(controller.selectInstallOnExit).toHaveBeenCalledOnce();
  });

  it("rejects every renderer-supplied URL, path, or other argument", async () => {
    const { handlers } = createHarness();

    for (const [channel, handler] of handlers) {
      await expect(
        handler({}, { url: "https://evil.test", path: "/tmp/installer" }),
        channel,
      ).rejects.toThrow("Update IPC does not accept arguments");
    }
  });
});
