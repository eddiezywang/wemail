import { describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../../shared/wemail/update.js";
import {
  createDesktopUpdateBridge,
  getApiBaseUrlFromArgv,
  subscribeDesktopEvent,
} from "./bridge.js";

describe("preload bridge helpers", () => {
  it("resolves the local API base url from process arguments", () => {
    expect(getApiBaseUrlFromArgv(["electron", "--wemail-api-port=8787"])).toBe(
      "http://127.0.0.1:8787",
    );
    expect(getApiBaseUrlFromArgv(["electron"])).toBeUndefined();
  });

  it("subscribes and unsubscribes desktop IPC events", () => {
    const on = vi.fn();
    const off = vi.fn();
    const callback = vi.fn();

    const dispose = subscribeDesktopEvent<[string, { id: string }]>(
      { on, off },
      "mail:changed",
      (event, payload) => callback(event, payload),
    );

    expect(on).toHaveBeenCalledTimes(1);
    const listener = on.mock.calls[0]?.[1];
    listener?.("event", { id: "m-1" });
    expect(callback).toHaveBeenCalledWith("event", { id: "m-1" });

    dispose();
    expect(off).toHaveBeenCalledWith("mail:changed", listener);
  });

  it("exposes fixed update invocations and a disposable state subscription", async () => {
    const on = vi.fn();
    const off = vi.fn();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "update:get-state" || channel === "update:check") {
        return { status: "idle", enabled: true, currentVersion: "1.0.0" };
      }
      return undefined;
    });
    const bridge = createDesktopUpdateBridge({ invoke, on, off });
    const callback = vi.fn<(state: DesktopUpdateState) => void>();

    await bridge.getState();
    await bridge.check();
    await bridge.download();
    await bridge.cancelDownload();
    await bridge.retryDownload();
    await bridge.dismissAvailableUpdate();
    await bridge.installNow();
    await bridge.installOnExit();
    const unsubscribe = bridge.onStateChange(callback);

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "update:get-state",
      "update:check",
      "update:download",
      "update:cancel-download",
      "update:retry-download",
      "update:dismiss",
      "update:install-now",
      "update:install-on-exit",
    ]);
    expect(invoke.mock.calls.every((call) => call.length === 1)).toBe(true);

    const listener = on.mock.calls[0]?.[1];
    const state = {
      status: "available",
      enabled: true,
      currentVersion: "1.0.0",
    } as DesktopUpdateState;
    listener?.({}, state);
    expect(callback).toHaveBeenCalledWith(state);

    unsubscribe();
    expect(off).toHaveBeenCalledWith("update:state-changed", listener);
  });
});
