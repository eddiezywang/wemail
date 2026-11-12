import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopUpdateBridge,
  DesktopUpdateState,
} from "../../shared/wemail/update";
import { useDesktopUpdate } from "./useDesktopUpdate";

function updateState(
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState {
  return {
    status: "idle",
    enabled: true,
    currentVersion: "1.0.0",
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    size: null,
    progress: null,
    lastCheckedAt: null,
    checkSource: null,
    errorCode: null,
    promptSuppressed: false,
    ...overrides,
  };
}

function createBridge() {
  let emit: ((state: DesktopUpdateState) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge: DesktopUpdateBridge = {
    getState: vi.fn(async () => updateState()),
    check: vi.fn(async () => updateState({ status: "checking" })),
    download: vi.fn(async () => undefined),
    cancelDownload: vi.fn(async () => undefined),
    retryDownload: vi.fn(async () => undefined),
    dismissAvailableUpdate: vi.fn(async () => undefined),
    installNow: vi.fn(async () => undefined),
    installOnExit: vi.fn(async () => undefined),
    onStateChange: vi.fn((listener) => {
      emit = listener;
      return unsubscribe;
    }),
  };
  return { bridge, emit: (state: DesktopUpdateState) => emit?.(state), unsubscribe };
}

describe("useDesktopUpdate", () => {
  afterEach(() => {
    delete window.wemailDesktop;
  });

  it("hydrates from the main process and applies subscription updates", async () => {
    const harness = createBridge();
    window.wemailDesktop = { update: harness.bridge };

    const { result } = renderHook(() => useDesktopUpdate());
    await waitFor(() => expect(result.current.state.status).toBe("idle"));

    act(() => {
      harness.emit(updateState({
        status: "available",
        availableVersion: "1.1.0",
      }));
    });

    expect(result.current.state).toMatchObject({
      status: "available",
      availableVersion: "1.1.0",
    });
  });

  it("unsubscribes when the hook unmounts", async () => {
    const harness = createBridge();
    window.wemailDesktop = { update: harness.bridge };
    const { unmount } = renderHook(() => useDesktopUpdate());
    await waitFor(() => expect(harness.bridge.getState).toHaveBeenCalledOnce());

    unmount();

    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it("forwards only fixed update actions and uses check results immediately", async () => {
    const harness = createBridge();
    window.wemailDesktop = { update: harness.bridge };
    const { result } = renderHook(() => useDesktopUpdate());
    await waitFor(() => expect(result.current.state.status).toBe("idle"));

    await act(async () => {
      await result.current.check();
      await result.current.download();
      await result.current.cancelDownload();
      await result.current.retryDownload();
      await result.current.dismissAvailableUpdate();
      await result.current.installNow();
      await result.current.installOnExit();
    });

    expect(result.current.state.status).toBe("checking");
    expect(harness.bridge.check).toHaveBeenCalledOnce();
    expect(harness.bridge.download).toHaveBeenCalledOnce();
    expect(harness.bridge.cancelDownload).toHaveBeenCalledOnce();
    expect(harness.bridge.retryDownload).toHaveBeenCalledOnce();
    expect(harness.bridge.dismissAvailableUpdate).toHaveBeenCalledOnce();
    expect(harness.bridge.installNow).toHaveBeenCalledOnce();
    expect(harness.bridge.installOnExit).toHaveBeenCalledOnce();
  });

  it("stays safely disabled outside the desktop shell", () => {
    const { result } = renderHook(() => useDesktopUpdate());

    expect(result.current.state).toMatchObject({
      status: "disabled",
      enabled: false,
    });
  });
});
