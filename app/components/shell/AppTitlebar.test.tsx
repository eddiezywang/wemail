import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTitlebar } from "./AppTitlebar";

describe("AppTitlebar", () => {
	afterEach(() => {
		delete window.wemailDesktop;
	});

	it("shows a quiet WeMail wordmark with a small inline brand mark and no brand image", async () => {
		window.wemailDesktop = {
			platform: "win32",
			window: {
				minimize: vi.fn().mockResolvedValue(undefined),
				toggleMaximize: vi.fn().mockResolvedValue({ maximized: false }),
				close: vi.fn().mockResolvedValue(undefined),
				isMaximized: vi.fn().mockResolvedValue(false),
				onMaximizedChange: vi.fn().mockReturnValue(() => {}),
			},
		};

		render(<AppTitlebar />);

		const titlebar = await screen.findByTestId("app-titlebar");
		expect(titlebar).toHaveTextContent("WeMail");
		expect(titlebar.querySelector("img")).toBeNull();
		// A small inline brand mark (SVG) sits next to the wordmark.
		expect(titlebar.querySelector("svg")).not.toBeNull();
	});

	it("offers minimize-to-tray and exit choices when close behavior is tray", async () => {
		const close = vi.fn().mockResolvedValue(undefined);
		const quit = vi.fn().mockResolvedValue(undefined);
		window.wemailDesktop = {
			platform: "win32",
			window: {
				minimize: vi.fn().mockResolvedValue(undefined),
				toggleMaximize: vi.fn().mockResolvedValue({ maximized: false }),
				close,
				quit,
				getCloseBehavior: vi.fn().mockResolvedValue("tray"),
				onCloseBehaviorChange: vi.fn().mockReturnValue(() => {}),
				isMaximized: vi.fn().mockResolvedValue(false),
				onMaximizedChange: vi.fn().mockReturnValue(() => {}),
			},
		};

		render(<AppTitlebar />);
		// Close button (tray mode) toggles a choice popover.
		fireEvent.click(await screen.findByRole("button", { name: "最小化到系统托盘" }));

		// Both choices are present and labelled with the incumbent copy.
		expect(await screen.findByText("退出 WeMail")).toBeInTheDocument();
		expect(screen.getByText("继续在后台同步邮件")).toBeInTheDocument();
		expect(screen.getByText("停止后台同步并退出应用")).toBeInTheDocument();

		// Picking exit routes through the dedicated quit IPC, not close.
		fireEvent.click(screen.getByText("退出 WeMail").closest("button")!);
		expect(quit).toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it("quits directly from the close button when close behavior is exit", async () => {
		const quit = vi.fn().mockResolvedValue(undefined);
		const close = vi.fn().mockResolvedValue(undefined);
		window.wemailDesktop = {
			platform: "win32",
			window: {
				minimize: vi.fn().mockResolvedValue(undefined),
				toggleMaximize: vi.fn().mockResolvedValue({ maximized: false }),
				close,
				quit,
				getCloseBehavior: vi.fn().mockResolvedValue("exit"),
				onCloseBehaviorChange: vi.fn().mockReturnValue(() => {}),
				isMaximized: vi.fn().mockResolvedValue(false),
				onMaximizedChange: vi.fn().mockReturnValue(() => {}),
			},
		};

		render(<AppTitlebar />);
		// In exit mode there is no popover; the X quits immediately.
		expect(screen.queryByText("继续在后台同步邮件")).toBeNull();
		fireEvent.click(await screen.findByRole("button", { name: "退出 WeMail" }));
		expect(quit).toHaveBeenCalled();
	});
});
