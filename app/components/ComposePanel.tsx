// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsInSimpleIcon } from "@phosphor-icons/react/ArrowsInSimple";
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react/ArrowsOutSimple";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/DotsSixVertical";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { XIcon } from "@phosphor-icons/react/X";
import SnoozeMenu from "./SnoozeMenu";
import ComposeBody, { type ComposeBodyHeaderState } from "./compose/ComposeBody";
import { useUIStore } from "~/hooks/useUIStore";

const PANEL_WIDTH = 640;
const PANEL_HEIGHT = 640;
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 260;
const MARGIN = 24;
const MAXIMIZED_MARGIN = 10;

export default function ComposePanel() {
	const isComposing = useUIStore((state) => state.isComposing);

	const [mounted, setMounted] = useState(isComposing);
	const [phase, setPhase] = useState<"open" | "closed">(
		isComposing ? "open" : "closed",
	);

	useEffect(() => {
		const open = isComposing;
		if (open) {
			setMounted(true);
			requestAnimationFrame(() => requestAnimationFrame(() => setPhase("open")));
		} else if (mounted) {
			setPhase("closed");
			const timeoutId = window.setTimeout(() => setMounted(false), 220);
			return () => window.clearTimeout(timeoutId);
		}
	}, [isComposing, mounted]);

	if (!mounted) return null;

	return <ComposeWindow phase={phase} />;
}

function ComposeWindow({ phase }: { phase: "open" | "closed" }) {
	const composePositions = useUIStore((state) => state.composePositions);
	const setComposePosition = useUIStore((state) => state.setComposePosition);
	const viewportSize = useViewportSize();
	const panelSize = useMemo(() => {
		const width = Math.min(
			PANEL_WIDTH,
			Math.max(MIN_PANEL_WIDTH, viewportSize.width - MARGIN * 2),
		);
		const height = Math.min(
			PANEL_HEIGHT,
			Math.max(MIN_PANEL_HEIGHT, viewportSize.height - MARGIN * 2),
		);
		return { width, height };
	}, [viewportSize.height, viewportSize.width]);

	const defaultPosition = useMemo(
		() => ({
			x: clampToViewport(
				(viewportSize.width - panelSize.width) / 2,
				panelSize.width,
				viewportSize.width,
				MARGIN,
			),
			y: clampToViewport(
				viewportSize.height - panelSize.height - 48,
				panelSize.height,
				viewportSize.height,
				MARGIN,
			),
		}),
		[panelSize.height, panelSize.width, viewportSize.height, viewportSize.width],
	);

	const [position, setPosition] = useState(
		() => composePositions.new ?? defaultPosition,
	);
	const [maximized, setMaximized] = useState(false);
	const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
	const restoredPositionRef = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		if (maximized) {
			setPosition({ x: MAXIMIZED_MARGIN, y: MAXIMIZED_MARGIN });
			return;
		}
		setPosition((current) => {
			const base = composePositions.new ?? current ?? defaultPosition;
			return {
				x: clampToViewport(
					base.x,
					panelSize.width,
					viewportSize.width,
					MARGIN,
				),
				y: clampToViewport(
					base.y,
					panelSize.height,
					viewportSize.height,
					MARGIN,
				),
			};
		});
	}, [
		composePositions.new,
		defaultPosition,
		maximized,
		panelSize.height,
		panelSize.width,
		viewportSize.height,
		viewportSize.width,
	]);

	const beginDrag = (clientX: number, clientY: number) => {
		if (maximized) return;
		dragOffsetRef.current = {
			x: clientX - position.x,
			y: clientY - position.y,
		};
	};

	const moveDrag = (clientX: number, clientY: number) => {
		const offset = dragOffsetRef.current;
		if (!offset || maximized) return;
		setPosition({
			x: clampToViewport(
				clientX - offset.x,
				panelSize.width,
				viewportSize.width,
				MARGIN,
			),
			y: clampToViewport(
				clientY - offset.y,
				panelSize.height,
				viewportSize.height,
				MARGIN,
			),
		});
	};

	const endDrag = () => {
		if (!dragOffsetRef.current) return;
		dragOffsetRef.current = null;
		setComposePosition("new", position);
	};

	const handleDragPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
		beginDrag(event.clientX, event.clientY);
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handleDragPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
		moveDrag(event.clientX, event.clientY);
	};

	const handleDragPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		endDrag();
	};

	const handleHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest("button, input, textarea, select, a")) return;
		beginDrag(event.clientX, event.clientY);
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handleHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		moveDrag(event.clientX, event.clientY);
	};

	const handleHeaderPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		endDrag();
	};

	const toggleMaximized = () => {
		if (maximized) {
			setMaximized(false);
			const restored = restoredPositionRef.current ?? defaultPosition;
			const next = {
				x: clampToViewport(
					restored.x,
					panelSize.width,
					viewportSize.width,
					MARGIN,
				),
				y: clampToViewport(
					restored.y,
					panelSize.height,
					viewportSize.height,
					MARGIN,
				),
			};
			setPosition(next);
			setComposePosition("new", next);
			return;
		}
		restoredPositionRef.current = position;
		dragOffsetRef.current = null;
		setMaximized(true);
	};

	const windowStyle = maximized
		? {
				top: MAXIMIZED_MARGIN,
				left: MAXIMIZED_MARGIN,
				width: Math.max(320, viewportSize.width - MAXIMIZED_MARGIN * 2),
				height: Math.max(260, viewportSize.height - MAXIMIZED_MARGIN * 2),
			}
		: {
				top: position.y,
				left: position.x,
				width: panelSize.width,
				height: panelSize.height,
			};

	const renderHeader = (state: ComposeBodyHeaderState) => (
		<div
			onPointerDown={handleHeaderPointerDown}
			onPointerMove={handleHeaderPointerMove}
			onPointerUp={handleHeaderPointerUp}
			onPointerCancel={handleHeaderPointerUp}
			className={`flex items-center gap-1 px-2 py-2 border-b border-edge shrink-0 touch-none ${
				maximized ? "cursor-default" : "cursor-grab active:cursor-grabbing"
			}`}
		>
			<button
				type="button"
				onPointerDown={handleDragPointerDown}
				onPointerMove={handleDragPointerMove}
				onPointerUp={handleDragPointerUp}
				onPointerCancel={handleDragPointerUp}
				aria-label="拖动写信窗口"
				data-testid="compose-drag-handle"
				disabled={maximized}
				className={`inline-flex h-9 w-7 items-center justify-center rounded text-ink-3 hover:text-ink hover:bg-paper-3 touch-none transition-colors ${
					maximized ? "cursor-default opacity-40" : "cursor-grab active:cursor-grabbing"
				}`}
			>
				<DotsSixVerticalIcon size={14} weight="bold" />
			</button>
			<button
				type="button"
				onClick={state.closeCompose}
				disabled={state.isSending}
				className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-paper-3 transition-colors disabled:opacity-40"
				aria-label="关闭写信窗口"
			>
				<XIcon size={14} />
			</button>
			<span className="text-xs font-medium text-ink-2 truncate flex-1 ml-1">
				{state.formTitle}
			</span>
			<button
				type="button"
				onClick={toggleMaximized}
				className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-paper-3 transition-colors"
				aria-label={maximized ? "还原写信窗口" : "最大化写信窗口"}
				data-testid="compose-maximize"
			>
				{maximized ? (
					<ArrowsInSimpleIcon size={14} />
				) : (
					<ArrowsOutSimpleIcon size={14} />
				)}
			</button>
			<UnifiedSendButton
				formId={state.formId}
				isSending={state.isSending}
				disabled={state.isSavingDraft}
				onSchedule={state.handleSchedule}
				suggestedSendAt={state.suggestedSendAt}
			/>
		</div>
	);

	return (
		<div
			data-testid="compose-window"
			data-state={phase}
			style={windowStyle}
			className={`fixed z-40 bg-paper-2 border border-edge rounded-xl shadow-[var(--shadow-3)]
				flex flex-col overflow-hidden
				transition-[opacity,transform] duration-200 ease-[cubic-bezier(.2,.8,.2,1)]
				data-[state=open]:opacity-100 data-[state=open]:translate-x-0 data-[state=open]:translate-y-0 data-[state=open]:scale-100
				data-[state=closed]:opacity-0 data-[state=closed]:translate-x-2 data-[state=closed]:translate-y-6 data-[state=closed]:scale-[.97]`}
		>
			<ComposeBody renderHeader={renderHeader} />
		</div>
	);
}

function UnifiedSendButton({
	formId,
	isSending,
	disabled,
	onSchedule,
	suggestedSendAt,
}: {
	formId: string;
	isSending: boolean;
	disabled?: boolean;
	onSchedule?: (at: Date) => void | Promise<void>;
	suggestedSendAt?: Date | null;
}) {
	return (
		<div className="relative">
			<div
				className={`inline-flex items-center rounded-full bg-coral text-paper text-xs font-semibold transition-opacity ${
					disabled ? "opacity-50 pointer-events-none" : "hover:opacity-90"
				}`}
			>
				<button
					type={suggestedSendAt ? "button" : "submit"}
					form={formId}
					onClick={suggestedSendAt ? () => onSchedule?.(suggestedSendAt) : undefined}
					disabled={disabled || isSending}
					className="inline-flex items-center gap-1.5 pl-4 pr-2 py-1.5"
					aria-label={isSending ? "正在发送" : suggestedSendAt ? "定时发送" : "发送"}
					data-testid="compose-send"
				>
					<PaperPlaneTiltIcon size={12} weight="fill" />
					{isSending ? "发送中…" : suggestedSendAt ? "定时发送" : "发送"}
				</button>
				<SnoozeMenu
					title="定时发送"
					align="end"
					customDefault={suggestedSendAt ?? undefined}
					onPick={(at) => onSchedule?.(at)}
				>
					<button
						type="button"
						disabled={disabled || isSending || !onSchedule}
						className="mr-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-paper/10 transition-colors hover:bg-paper/20 disabled:opacity-50"
						aria-label="发送方式"
						data-testid="compose-send-menu-toggle"
					>
						<CaretDownIcon size={10} weight="bold" />
					</button>
				</SnoozeMenu>
			</div>
		</div>
	);
}

function clampToViewport(
	value: number,
	panelSize: number,
	viewportSize: number,
	margin: number,
) {
	const max = Math.max(margin, viewportSize - panelSize - margin);
	return Math.max(margin, Math.min(max, value));
}

function useViewportSize() {
	const [size, setSize] = useState(() => ({
		width:
			typeof window === "undefined"
				? PANEL_WIDTH + MARGIN * 2
				: window.innerWidth,
		height:
			typeof window === "undefined"
				? PANEL_HEIGHT + MARGIN * 2
				: window.innerHeight,
	}));

	useEffect(() => {
		if (typeof window === "undefined") return;
		const update = () => {
			setSize({
				width: window.innerWidth,
				height: window.innerHeight,
			});
		};
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);

	return size;
}
