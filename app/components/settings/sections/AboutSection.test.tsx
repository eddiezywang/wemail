import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../../../../shared/wemail/update";
import type { DesktopUpdateHook } from "~/hooks/useDesktopUpdate";
import { AboutSection, formatUpdateStatus } from "./AboutSection";

const useDesktopUpdate = vi.fn<() => DesktopUpdateHook>();
vi.mock("~/hooks/useDesktopUpdate", () => ({
	useDesktopUpdate: () => useDesktopUpdate(),
}));

function updateState(
	overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState {
	return {
		status: "idle",
		enabled: true,
		currentVersion: "1.2.3",
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

function updateHook(state: DesktopUpdateState): DesktopUpdateHook {
	return {
		state,
		check: vi.fn(async () => state),
		download: vi.fn(async () => undefined),
		cancelDownload: vi.fn(async () => undefined),
		retryDownload: vi.fn(async () => undefined),
		dismissAvailableUpdate: vi.fn(async () => undefined),
		installNow: vi.fn(async () => undefined),
		installOnExit: vi.fn(async () => undefined),
	};
}

describe("AboutSection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useDesktopUpdate.mockReturnValue(updateHook(updateState()));
		window.wemailDesktop = {
			platform: "win32",
			getAppInfo: vi.fn().mockResolvedValue({
				name: "WeMail",
				version: "0.1.0",
				platform: "win32",
				arch: "x64",
				electronVersion: "41",
				chromeVersion: "140",
				nodeVersion: "24",
			}),
		};
	});

	afterEach(() => {
		delete window.wemailDesktop;
		vi.restoreAllMocks();
	});

	it("shows product version, license, update, and diagnostics guidance", async () => {
		render(<AboutSection />);

		expect(await screen.findByText(/版本 0.1.0/)).toBeInTheDocument();
		expect(screen.getByText("Apache 2.0 开源许可")).toBeInTheDocument();
		expect(screen.getByText(/高级设置 → 诊断/)).toBeInTheDocument();
		expect(screen.queryByText(/Electron 41/)).toBeNull();
		expect(screen.queryByRole("button", { name: "安装 WeCLI" })).toBeNull();
		expect(screen.getByRole("button", { name: "检查更新" })).toBeInTheDocument();
	});

	it("shows update status and supports a manual check", async () => {
		const update = updateHook(updateState({
			status: "up-to-date",
			checkSource: "manual",
			lastCheckedAt: "2026-07-18T00:00:00.000Z",
		}));
		useDesktopUpdate.mockReturnValue(update);
		const user = userEvent.setup();
		render(<AboutSection />);

		expect(screen.getByText("版本 1.2.3")).toBeInTheDocument();
		expect(screen.getByText(/已是最新版本/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "检查更新" }));
		expect(update.check).toHaveBeenCalledOnce();
	});

	it("offers update download and retry actions", async () => {
		const available = updateHook(updateState({
			status: "available",
			availableVersion: "1.3.0",
		}));
		useDesktopUpdate.mockReturnValue(available);
		const user = userEvent.setup();
		const view = render(<AboutSection />);

		await user.click(screen.getByRole("button", { name: "立即更新" }));
		expect(available.download).toHaveBeenCalledOnce();

		const failed = updateHook(updateState({
			status: "download-failed",
			availableVersion: "1.3.0",
			errorCode: "DOWNLOAD_FAILED",
		}));
		useDesktopUpdate.mockReturnValue(failed);
		view.rerender(<AboutSection />);
		await user.click(screen.getByRole("button", { name: "重试" }));
		expect(failed.retryDownload).toHaveBeenCalledOnce();
	});

	it("offers both installation choices for a verified update", async () => {
		const update = updateHook(updateState({
			status: "downloaded",
			availableVersion: "1.3.0",
		}));
		useDesktopUpdate.mockReturnValue(update);
		const user = userEvent.setup();
		render(<AboutSection />);

		await user.click(screen.getByRole("button", { name: "退出时安装" }));
		await user.click(screen.getByRole("button", { name: "立即重启安装" }));
		expect(update.installOnExit).toHaveBeenCalledOnce();
		expect(update.installNow).toHaveBeenCalledOnce();
	});

	it("shows an animated status while the installer is starting", () => {
		useDesktopUpdate.mockReturnValue(updateHook(updateState({
			status: "installing",
			availableVersion: "1.3.0",
		})));

		render(<AboutSection />);

		const installationStatus = screen.getByRole("status");
		expect(installationStatus).toHaveAttribute("aria-busy", "true");
		expect(installationStatus.querySelector(".animate-spin")).not.toBeNull();
		expect(screen.getByText("正在退出并启动安装程序…")).toBeInTheDocument();
	});

	it("blocks a security-failed update without an update bypass", () => {
		useDesktopUpdate.mockReturnValue(updateHook(updateState({
			status: "security-failed",
			availableVersion: "1.3.0",
			errorCode: "SECURITY_VERIFICATION_FAILED",
		})));
		render(<AboutSection />);

		expect(screen.getByText(/无法验证更新包的发布者或完整性/)).toBeInTheDocument();
		expect(screen.queryByRole("button", {
			name: /重试|立即更新|立即重启安装|退出时安装/,
		})).not.toBeInTheDocument();
	});

	it("formats update progress and terminal failures", () => {
		expect(formatUpdateStatus(updateState({
			status: "downloading",
			availableVersion: "1.3.0",
			progress: { percent: 48.6, transferred: 1, total: 2, bytesPerSecond: 1 },
		}))).toContain("49%");
		expect(formatUpdateStatus(updateState({
			status: "check-failed",
			checkSource: "manual",
			errorCode: "NETWORK_UNAVAILABLE",
		}))).toContain("网络");
		expect(formatUpdateStatus(updateState({
			status: "install-failed",
			errorCode: "INSTALLER_START_FAILED",
		}))).toContain("安装程序");
	});
});
