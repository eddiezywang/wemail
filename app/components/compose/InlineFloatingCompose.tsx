// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowBendUpLeftIcon } from "@phosphor-icons/react/ArrowBendUpLeft";
import { ArrowsInSimpleIcon } from "@phosphor-icons/react/ArrowsInSimple";
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react/ArrowsOutSimple";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/DotsSixVertical";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { XIcon } from "@phosphor-icons/react/X";
import SnoozeMenu from "~/components/SnoozeMenu";
import ComposeBody, { type ComposeBodyHeaderState } from "./ComposeBody";
import { useUIStore } from "~/hooks/useUIStore";
import {
	clampComposeRect,
	FLOATING_COMPOSE_MARGIN,
	resizeComposeRect,
	type ComposeRect,
	type ResizeDirection,
} from "./floatingComposeGeometry";

const PANEL_WIDTH = 600;
const PANEL_HEIGHT = 520;
const MAXIMIZED_MARGIN = 10;

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; className: string }> = [
	{ direction: "n", className: "left-3 right-3 top-0 h-2 cursor-ns-resize" },
	{ direction: "ne", className: "right-0 top-0 h-3 w-3 cursor-nesw-resize" },
	{ direction: "e", className: "bottom-3 right-0 top-3 w-2 cursor-ew-resize" },
	{ direction: "se", className: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize" },
	{ direction: "s", className: "bottom-0 left-3 right-3 h-2 cursor-ns-resize" },
	{ direction: "sw", className: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
	{ direction: "w", className: "bottom-3 left-0 top-3 w-2 cursor-ew-resize" },
	{ direction: "nw", className: "left-0 top-0 h-3 w-3 cursor-nwse-resize" },
];

function recipientLabel(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
): string {
	const { mode, originalEmail } = composeOptions;
	if (!originalEmail) return mode === "forward" ? "转发邮件" : "回复邮件";
	const sender = originalEmail.sender ?? "";
	const match = sender.match(/^(.+?)\s*<([^>]+)>/);
	if (match) return match[1].trim() || match[2];
	return sender || originalEmail.subject || "回复";
}

interface InlineFloatingComposeProps {
	containerRef: RefObject<HTMLDivElement | null>;
}

export default function InlineFloatingCompose({
	containerRef,
}: InlineFloatingComposeProps) {
	const isComposing = useUIStore((state) => state.isComposing);
	const composeOptions = useUIStore((state) => state.composeOptions);
	const isReplyOrForward = composeOptions.mode !== "new";

	const [mounted, setMounted] = useState(isComposing && isReplyOrForward);
	const [phase, setPhase] = useState<"open" | "closed">(
		isComposing && isReplyOrForward ? "open" : "closed",
	);

	useEffect(() => {
		const open = isComposing && isReplyOrForward;
		if (open) {
			setMounted(true);
			requestAnimationFrame(() =>
				requestAnimationFrame(() => setPhase("open")),
			);
		} else if (mounted) {
			setPhase("closed");
			const timeoutId = window.setTimeout(() => setMounted(false), 220);
			return () => window.clearTimeout(timeoutId);
		}
	}, [isComposing, isReplyOrForward, mounted]);

	if (!mounted) return null;

	return <FloatingWindow phase={phase} containerRef={containerRef} />;
}

function FloatingWindow({
	phase,
	containerRef,
}: {
	phase: "open" | "closed";
	containerRef: RefObject<HTMLDivElement | null>;
}) {
	const composeOptions = useUIStore((state) => state.composeOptions);
	const label = recipientLabel(composeOptions);
	const viewportSize = useViewportSize();
	const [rect, setRect] = useState<ComposeRect | null>(null);
	const [windowMode, setWindowMode] = useState<"floating" | "maximized">("floating");
	const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
	const restoreRectRef = useRef<ComposeRect | null>(null);
	const resizeSessionRef = useRef<{
		direction: ResizeDirection;
		startX: number;
		startY: number;
		startRect: ComposeRect;
	} | null>(null);
	const maximized = windowMode === "maximized";

	useEffect(() => {
		setRect((current) => {
			if (current) {
				return windowMode === "floating"
					? clampComposeRect(current, viewportSize)
					: current;
			}
			const width = Math.min(PANEL_WIDTH, viewportSize.width - FLOATING_COMPOSE_MARGIN * 2);
			const height = Math.min(PANEL_HEIGHT, viewportSize.height - FLOATING_COMPOSE_MARGIN * 2);
			const canvas = containerRef.current?.getBoundingClientRect();
			return clampComposeRect(
				{
					x: canvas
						? canvas.left + Math.max(FLOATING_COMPOSE_MARGIN, (canvas.width - width) / 2)
						: (viewportSize.width - width) / 2,
					y: canvas
						? canvas.top + Math.max(FLOATING_COMPOSE_MARGIN, canvas.height - height - FLOATING_COMPOSE_MARGIN)
						: viewportSize.height - height - 48,
					width,
					height,
				},
				viewportSize,
			);
		});
	}, [
		containerRef,
		viewportSize.height,
		viewportSize.width,
		windowMode,
	]);

	const handleDragPointerDown = (event: React.PointerEvent<HTMLElement>) => {
		if (!rect || maximized) return;
		dragOffsetRef.current = {
			x: event.clientX - rect.x,
			y: event.clientY - rect.y,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handleDragPointerMove = (event: React.PointerEvent<HTMLElement>) => {
		const offset = dragOffsetRef.current;
		if (!offset) return;
		setRect((current) =>
			current
				? clampComposeRect(
						{ ...current, x: event.clientX - offset.x, y: event.clientY - offset.y },
						viewportSize,
					)
				: current,
		);
	};

	const handleDragPointerUp = (event: React.PointerEvent<HTMLElement>) => {
		dragOffsetRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const handleHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest("button, input, textarea, select, a")) return;
		handleDragPointerDown(event);
	};

	const handleHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		handleDragPointerMove(event);
	};

	const handleHeaderPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		handleDragPointerUp(event);
	};

	const handleResizePointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
		direction: ResizeDirection,
	) => {
		if (!rect || maximized) return;
		event.stopPropagation();
		resizeSessionRef.current = {
			direction,
			startX: event.clientX,
			startY: event.clientY,
			startRect: rect,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handleResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const session = resizeSessionRef.current;
		if (!session) return;
		setRect(
			resizeComposeRect(
				session.startRect,
				session.direction,
				event.clientX - session.startX,
				event.clientY - session.startY,
				viewportSize,
			),
		);
	};

	const handleResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		resizeSessionRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const toggleMaximized = () => {
		if (maximized) {
			setRect((current) =>
				clampComposeRect(restoreRectRef.current ?? current!, viewportSize),
			);
			setWindowMode("floating");
			return;
		}
		if (rect) restoreRectRef.current = { ...rect };
		dragOffsetRef.current = null;
		resizeSessionRef.current = null;
		setWindowMode("maximized");
	};

	if (!rect || typeof document === "undefined") return null;

	const windowStyle = maximized
		? {
				position: "fixed" as const,
				left: MAXIMIZED_MARGIN,
				top: MAXIMIZED_MARGIN,
				width: Math.max(320, viewportSize.width - MAXIMIZED_MARGIN * 2),
				height: Math.max(260, viewportSize.height - MAXIMIZED_MARGIN * 2),
			}
		: {
				position: "fixed" as const,
				left: rect.x,
				top: rect.y,
				width: rect.width,
				height: rect.height,
			};

	const renderHeader = (state: ComposeBodyHeaderState) => (
		<div
			onPointerDown={handleHeaderPointerDown}
			onPointerMove={handleHeaderPointerMove}
			onPointerUp={handleHeaderPointerUp}
			onPointerCancel={handleHeaderPointerUp}
			className={`flex items-center gap-1.5 px-2.5 py-2 border-b border-edge-3 shrink-0 touch-none ${
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
				data-testid="inline-compose-drag-handle"
				className={`inline-flex h-9 w-7 items-center justify-center rounded text-ink-3 hover:text-ink hover:bg-paper-3 touch-none transition-colors ${
					maximized ? "cursor-default opacity-40" : "cursor-grab active:cursor-grabbing"
				}`}
				disabled={maximized}
			>
				<DotsSixVerticalIcon size={14} weight="bold" />
			</button>
			<ArrowBendUpLeftIcon size={14} className="text-ink-3 shrink-0" />
			<span className="mx-1 flex-1 truncate text-control font-semibold text-ink">
				{label}
			</span>
			<button
				type="button"
				onClick={toggleMaximized}
				className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-paper-3 transition-colors"
				aria-label={maximized ? "还原写信窗口" : "最大化写信窗口"}
				data-testid="inline-compose-maximize"
			>
				{maximized ? (
					<ArrowsInSimpleIcon size={14} />
				) : (
					<ArrowsOutSimpleIcon size={14} />
				)}
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
			<InlineSendButton
				formId={state.formId}
				isSending={state.isSending}
				disabled={state.isSavingDraft}
				onSchedule={state.handleSchedule}
				suggestedSendAt={state.suggestedSendAt}
			/>
		</div>
	);

	return createPortal(
		<div
			data-testid="inline-floating-compose"
			data-state={phase}
			data-window-mode={windowMode}
			style={windowStyle}
			className={`z-50 bg-paper-2 border border-coral/30 rounded-xl shadow-[var(--shadow-3)]
				relative flex flex-col overflow-hidden
				transition-[opacity,transform] duration-200 ease-[cubic-bezier(.2,.8,.2,1)]
				data-[state=open]:opacity-100 data-[state=open]:translate-y-0 data-[state=open]:scale-100
				data-[state=closed]:opacity-0 data-[state=closed]:translate-y-4 data-[state=closed]:scale-[.97]`}
		>
			<ComposeBody renderHeader={renderHeader} />
			{!maximized
				? RESIZE_HANDLES.map(({ direction, className }) => (
						<div
							key={direction}
							data-resize-direction={direction}
							onPointerDown={(event) => handleResizePointerDown(event, direction)}
							onPointerMove={handleResizePointerMove}
							onPointerUp={handleResizePointerUp}
							onPointerCancel={handleResizePointerUp}
							className={`absolute z-[60] touch-none ${className}`}
						/>
					))
				: null}
		</div>,
		document.body,
	);
}

function InlineSendButton({
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
				className={`inline-flex items-center rounded-full bg-coral text-paper text-meta font-semibold transition-opacity ${
					disabled ? "opacity-50 pointer-events-none" : "hover:opacity-90"
				}`}
			>
				<button
					type={suggestedSendAt ? "button" : "submit"}
					form={formId}
					onClick={suggestedSendAt ? () => onSchedule?.(suggestedSendAt) : undefined}
					disabled={disabled || isSending}
					className="inline-flex items-center gap-1.5 pl-3.5 pr-2 py-1.5"
					aria-label={isSending ? "正在发送" : suggestedSendAt ? "定时发送" : "发送"}
					data-testid="inline-compose-send"
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
					>
						<CaretDownIcon size={10} weight="bold" />
					</button>
				</SnoozeMenu>
			</div>
		</div>
	);
}

function useViewportSize() {
	const [size, setSize] = useState(() => ({
		width:
			typeof window === "undefined"
				? PANEL_WIDTH + FLOATING_COMPOSE_MARGIN * 2
				: window.innerWidth,
		height:
			typeof window === "undefined"
				? PANEL_HEIGHT + FLOATING_COMPOSE_MARGIN * 2
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
