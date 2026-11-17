// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Floating slash-command palette.
 *
 * Anchored to the `/` glyph reported by {@link slashSuggestion}. Mounts
 * inside the editor root via a portal-free absolute container — the
 * editor wrapper already has `relative` / `overflow-visible` so we
 * don't need React Portals (and avoid trapping focus elsewhere).
 *
 * Visual style mirrors {@link BubbleToolbar}: small rounded panel,
 * coral active accent, subtle paper-2 background, shadow-2.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	filterSlashCommands,
	flattenGroups,
	indexInGroups,
	type SlashCommand,
	type SlashGroup,
} from "./slashCommands";

export interface SlashMenuAnchor {
	/** Coords relative to the editor-root element. */
	top: number;
	left: number;
}

export interface SlashCommandMenuProps {
	open: boolean;
	query: string;
	anchor: SlashMenuAnchor | null;
	onSelect: (cmd: SlashCommand) => void;
	onClose: () => void;
	/** Imperative selection handle, so the host can drive Arrow / Enter
	 *  through ProseMirror's `handleKeyDown` rather than dueling
	 *  listeners on `document`. */
	apiRef?: React.MutableRefObject<SlashMenuApi | null>;
}

export interface SlashMenuApi {
	/** Move highlight by `delta` (with wrap-around). */
	move: (delta: number) => void;
	/** Run the currently highlighted command, if any. Returns true if
	 *  a command was executed. */
	commitSelected: () => boolean;
	/** Number of currently visible commands. */
	count: () => number;
}

const MENU_WIDTH = 260;
const MENU_MAX_HEIGHT = 340;

export function SlashCommandMenu({
	open,
	query,
	anchor,
	onSelect,
	onClose,
	apiRef,
}: SlashCommandMenuProps) {
	const groups: SlashGroup[] = useMemo(
		() => filterSlashCommands(query),
		[query],
	);
	const flat = useMemo(() => flattenGroups(groups), [groups]);

	const [activeIndex, setActiveIndex] = useState(0);
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const menuRef = useRef<HTMLDivElement | null>(null);

	// Reset highlight whenever the visible list changes.
	useEffect(() => {
		setActiveIndex(0);
	}, [query, flat.length]);

	useLayoutEffect(() => {
		if (!open) return;
		const el = itemRefs.current[activeIndex];
		// jsdom doesn't implement scrollIntoView — guard so the menu
		// works in tests as well as real browsers.
		if (el && typeof el.scrollIntoView === "function") {
			el.scrollIntoView({ block: "nearest" });
		}
	}, [activeIndex, open]);

	// Imperative API for the host (parent attaches it to the suggestion
	// plugin's keydown handler).
	useEffect(() => {
		if (!apiRef) return;
		apiRef.current = {
			move(delta: number) {
				setActiveIndex((prev) => {
					if (flat.length === 0) return 0;
					const next = (prev + delta + flat.length) % flat.length;
					return next;
				});
			},
			commitSelected() {
				const cmd = flat[activeIndex];
				if (!cmd) return false;
				onSelect(cmd);
				return true;
			},
			count() {
				return flat.length;
			},
		};
		return () => {
			if (apiRef) apiRef.current = null;
		};
	}, [apiRef, flat, activeIndex, onSelect]);

	// Click-outside / blur close.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!menuRef.current) return;
			if (e.target instanceof Node && !menuRef.current.contains(e.target)) {
				onClose();
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open, onClose]);

	if (!open || !anchor) return null;
	if (flat.length === 0) {
		return (
			<div
				ref={menuRef}
				role="listbox"
				data-testid="slash-menu"
				data-empty="true"
				className="absolute z-40 rounded-lg border border-edge bg-paper-2 px-3 py-2 text-xs text-ink-3 shadow-[var(--shadow-2)] motion-safe:animate-[overlay-enter_120ms_ease-out]"
				style={{
					top: anchor.top,
					left: `clamp(8px, ${anchor.left}px, calc(100% - ${MENU_WIDTH + 8}px))`,
					width: `min(${MENU_WIDTH}px, calc(100% - 16px))`,
				}}
			>
				没有匹配的命令
			</div>
		);
	}

	let runningIndex = 0;

	return (
		<div
			ref={menuRef}
			role="listbox"
			aria-label="斜杠命令"
			data-testid="slash-menu"
			className="absolute z-40 overflow-y-auto rounded-lg border border-edge bg-paper-2 py-1 shadow-[var(--shadow-2)] motion-safe:animate-[overlay-enter_120ms_ease-out]"
			style={{
				top: anchor.top,
				left: `clamp(8px, ${anchor.left}px, calc(100% - ${MENU_WIDTH + 8}px))`,
				width: `min(${MENU_WIDTH}px, calc(100% - 16px))`,
				maxHeight: MENU_MAX_HEIGHT,
			}}
			onMouseDown={(e) => {
				// Don't blur the editor while interacting with the menu — we
				// rely on ProseMirror's selection staying valid so that
				// `deleteRange` works after click.
				e.preventDefault();
			}}
		>
			{groups.map((group, gIdx) => {
				const idx = indexInGroups(groups, runningIndex);
				void idx; // index is per-group; we recompute below
				return (
					<div key={group.group} className="py-1">
						<div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3">
							{group.heading}
						</div>
						{group.items.map((cmd) => {
							const myIndex = runningIndex++;
							const isActive = myIndex === activeIndex;
							const Icon = cmd.icon;
							return (
								<button
									key={cmd.id}
									ref={(el) => {
										itemRefs.current[myIndex] = el;
									}}
									type="button"
									role="option"
									aria-selected={isActive}
									data-testid={`slash-item-${cmd.id}`}
									data-active={isActive ? "true" : undefined}
									onMouseEnter={() => setActiveIndex(myIndex)}
									onClick={() => onSelect(cmd)}
									className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
										isActive
											? "bg-coral/15 text-ink"
											: "text-ink-2 hover:bg-paper-3 hover:text-ink"
									}`}
								>
									<span
										className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
											isActive
												? "bg-coral/20 text-coral"
												: "bg-paper-3 text-ink-2"
										}`}
									>
										{Icon ? <Icon size={14} /> : null}
									</span>
									<span className="flex flex-col overflow-hidden">
										<span className="truncate text-xs leading-tight">
											{cmd.title}
										</span>
										{cmd.hint ? (
											<span className="truncate text-xs text-ink-3 leading-tight">
												{cmd.hint}
											</span>
										) : null}
									</span>
								</button>
							);
						})}
						{gIdx < groups.length - 1 ? (
							<div className="my-1 mx-2 h-px bg-edge/60" aria-hidden />
						) : null}
					</div>
				);
			})}
		</div>
	);
}
