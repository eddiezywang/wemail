// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MinusIcon } from "@phosphor-icons/react/Minus";
import { SquareIcon } from "@phosphor-icons/react/Square";
import { XIcon } from "@phosphor-icons/react/X";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { PowerIcon } from "@phosphor-icons/react/Power";
import { useEffect, useState } from "react";
import { zhCN } from "~/copy/zh-CN";
import { BrandMark } from "~/components/shell/BrandMark";
import { cn } from "~/lib/cn";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";

const DRAG_STYLE = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function isDesktopShell() {
	return typeof window !== "undefined" && !!window.wemailDesktop?.window;
}

function isMacShell() {
	return (
		typeof window !== "undefined" && window.wemailDesktop?.platform === "darwin"
	);
}

export function AppTitlebar() {
	const [mounted, setMounted] = useState(false);
	const [maximized, setMaximized] = useState(false);
	const [isMac, setIsMac] = useState(false);
	const [closeBehavior, setCloseBehavior] = useState<"tray" | "exit">("tray");
	const [closeOpen, setCloseOpen] = useState(false);

	useEffect(() => {
		setMounted(true);
		setIsMac(isMacShell());
		const api = window.wemailDesktop?.window;
		if (!api) return;
		api.isMaximized().then(setMaximized).catch(() => undefined);
		if (typeof api.getCloseBehavior === "function") {
			api.getCloseBehavior().then(setCloseBehavior).catch(() => undefined);
		}
		const offMaximized = api.onMaximizedChange((m) => setMaximized(m));
		const offCloseBehavior =
			typeof api.onCloseBehaviorChange === "function"
				? api.onCloseBehaviorChange(setCloseBehavior)
				: () => undefined;
		return () => {
			offMaximized();
			offCloseBehavior();
		};
	}, []);

	if (!mounted || !isDesktopShell()) return null;

	const onMin = () => window.wemailDesktop?.window?.minimize();
	const onMax = () => window.wemailDesktop?.window?.toggleMaximize();
	// Hide to the tray: reuses the close IPC, whose behavior is "tray" here.
	const onMinimizeToTray = () => {
		setCloseOpen(false);
		window.wemailDesktop?.window?.close();
	};
	// Fully quit via the dedicated graceful-exit IPC (mirrors tray "Quit").
	const onExit = () => {
		setCloseOpen(false);
		if (typeof window.wemailDesktop?.window?.quit === "function") {
			void window.wemailDesktop.window.quit();
		} else {
			window.wemailDesktop?.window?.close();
		}
	};

	return (
		<div
			data-testid="app-titlebar"
			className="flex h-9 shrink-0 items-center justify-between bg-sidebar select-none"
			style={DRAG_STYLE}
		>
			<div
				className={`flex h-full items-center gap-1.5 ${isMac ? "pl-20" : "pl-3"}`}
			>
				<BrandMark size={16} className="shrink-0" />
				<span className="text-meta font-medium text-ink-2">
					{zhCN.appName}
				</span>
			</div>

			<div className="flex-1 h-full" />

			{!isMac && (
				<div className="flex h-full items-stretch" style={NO_DRAG_STYLE}>
					<button
						type="button"
						aria-label={zhCN.window.minimize}
						title="最小化"
						onClick={onMin}
						className="flex h-full w-11 items-center justify-center text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink motion-reduce:transition-none"
					>
						<MinusIcon size={14} weight="bold" />
					</button>
					<button
						type="button"
						aria-label={maximized ? zhCN.window.restore : zhCN.window.maximize}
						title={maximized ? zhCN.window.restore : zhCN.window.maximize}
						onClick={onMax}
						className="flex h-full w-11 items-center justify-center text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink motion-reduce:transition-none"
					>
						{maximized ? (
							<CopyIcon size={13} weight="bold" />
						) : (
							<SquareIcon size={13} weight="bold" />
						)}
					</button>
					{closeBehavior === "exit" ? (
						<button
							type="button"
							aria-label={zhCN.window.exit}
							title={zhCN.window.exit}
							onClick={onExit}
							className="flex h-full w-11 items-center justify-center text-ink-3 transition-colors hover:bg-coral hover:text-paper-2 motion-reduce:transition-none"
						>
							<XIcon size={14} weight="bold" />
						</button>
					) : (
						<Popover open={closeOpen} onOpenChange={setCloseOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									aria-label={zhCN.window.minimizeToTray}
									aria-haspopup="menu"
									aria-expanded={closeOpen}
									title="关闭窗口"
									onClick={() => setCloseOpen((v) => !v)}
									className="flex h-full w-11 items-center justify-center text-ink-3 transition-colors hover:bg-coral hover:text-paper-2 motion-reduce:transition-none"
								>
									<XIcon size={14} weight="bold" />
								</button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								sideOffset={6}
								className="w-64 p-1.5"
							>
								<div className="flex flex-col gap-0.5">
									<p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-ink-3">
										关闭窗口
									</p>
									<button
										type="button"
										onClick={onMinimizeToTray}
										className={cn(
											"flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
											closeBehavior === "tray"
												? "bg-coral-bg"
												: "hover:bg-paper-3",
										)}
									>
										<MinusIcon
											size={15}
											weight="bold"
											className={cn("shrink-0", closeBehavior === "tray" ? "text-coral" : "text-ink-3")}
										/>
										<span className="flex flex-col">
											<span className="text-sm font-medium text-ink">{zhCN.window.minimizeToTray}</span>
											<span className="text-xs text-ink-3">继续在后台同步邮件</span>
										</span>
									</button>
									<button
										type="button"
										onClick={onExit}
										className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-paper-3"
									>
										<PowerIcon
											size={15}
											weight="bold"
											className="shrink-0 text-ink-3"
										/>
										<span className="flex flex-col">
											<span className="text-sm font-medium text-ink">{zhCN.window.exit}</span>
											<span className="text-xs text-ink-3">停止后台同步并退出应用</span>
										</span>
									</button>
								</div>
							</PopoverContent>
						</Popover>
					)}
				</div>
			)}
		</div>
	);
}
