import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../../../shared/wemail/update";
import type { DesktopUpdateHook } from "~/hooks/useDesktopUpdate";
import { DesktopUpdateCenter } from "./DesktopUpdateCenter";

const useDesktopUpdate = vi.fn<() => DesktopUpdateHook>();
vi.mock("~/hooks/useDesktopUpdate", () => ({
  useDesktopUpdate: () => useDesktopUpdate(),
}));

function state(
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

function hook(updateState: DesktopUpdateState): DesktopUpdateHook {
  return {
    state: updateState,
    check: vi.fn(async () => updateState),
    download: vi.fn(async () => undefined),
    cancelDownload: vi.fn(async () => undefined),
    retryDownload: vi.fn(async () => undefined),
    dismissAvailableUpdate: vi.fn(async () => undefined),
    installNow: vi.fn(async () => undefined),
    installOnExit: vi.fn(async () => undefined),
  };
}

describe("DesktopUpdateCenter", () => {
  beforeEach(() => {
    useDesktopUpdate.mockReset();
  });

  it("requires explicit confirmation before downloading an available update", async () => {
    const update = hook(state({
      status: "available",
      availableVersion: "1.1.0",
      releaseName: "WeMail 1.1.0",
      releaseNotes: "Security and stability fixes",
      size: 1024,
      checkSource: "startup",
    }));
    useDesktopUpdate.mockReturnValue(update);
    const user = userEvent.setup();
    render(<DesktopUpdateCenter />);

    expect(update.download).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Security and stability fixes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "立即更新" }));

    expect(update.download).toHaveBeenCalledOnce();
  });

  it("dismisses the process-scoped prompt when the user chooses not now", async () => {
    const update = hook(state({
      status: "available",
      availableVersion: "1.1.0",
    }));
    useDesktopUpdate.mockReturnValue(update);
    const user = userEvent.setup();
    render(<DesktopUpdateCenter />);

    await user.click(screen.getByRole("button", { name: "暂不更新" }));

    expect(update.dismissAvailableUpdate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /发现新版本/ }),
    ).not.toBeInTheDocument();
  });

  it("shows download progress and cancellation", async () => {
    const update = hook(state({
      status: "downloading",
      availableVersion: "1.1.0",
      progress: {
        percent: 42,
        transferred: 420,
        total: 1000,
        bytesPerSecond: 100,
      },
    }));
    useDesktopUpdate.mockReturnValue(update);
    const user = userEvent.setup();
    render(<DesktopUpdateCenter />);

    expect(screen.getByText("42%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消下载" }));
    expect(update.cancelDownload).toHaveBeenCalledOnce();
  });

  it("offers immediate installation and install-on-exit after download", async () => {
    const update = hook(state({
      status: "downloaded",
      availableVersion: "1.1.0",
    }));
    useDesktopUpdate.mockReturnValue(update);
    const user = userEvent.setup();
    render(<DesktopUpdateCenter />);

    await user.click(screen.getByRole("button", { name: /更新已下载/ }));
    await user.click(screen.getByRole("button", { name: "退出时安装" }));
    expect(update.installOnExit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "立即重启安装" }));
    expect(update.installNow).toHaveBeenCalledOnce();
  });

  it("keeps an animated installation status open until restart", async () => {
    useDesktopUpdate.mockReturnValue(hook(state({
      status: "installing",
      availableVersion: "1.1.0",
    })));
    const user = userEvent.setup();

    render(<DesktopUpdateCenter />);

    const installationStatus = screen.getByRole("status");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(installationStatus).toHaveAttribute("aria-busy", "true");
    expect(installationStatus.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByText("正在结束后台任务")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders a security failure with no retry or install bypass", async () => {
    const update = hook(state({
      status: "security-failed",
      availableVersion: "1.1.0",
      errorCode: "SECURITY_VERIFICATION_FAILED",
    }));
    useDesktopUpdate.mockReturnValue(update);
    const user = userEvent.setup();
    render(<DesktopUpdateCenter />);

    await user.click(screen.getByRole("button", { name: /更新安全验证失败/ }));
    expect(
      screen.getByText(/无法验证更新包的发布者或完整性/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重试|安装|更新/ })).not.toBeInTheDocument();
    // The dialog carries both its footer close action and the header X.
    expect(
      screen.getAllByRole("button", { name: "关闭" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps startup check failures silent", () => {
    useDesktopUpdate.mockReturnValue(hook(state({
      status: "check-failed",
      checkSource: "startup",
      errorCode: "NETWORK_UNAVAILABLE",
    })));

    render(<DesktopUpdateCenter />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
