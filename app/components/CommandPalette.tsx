// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Command palette modal (⌘+K). Lists every command in the registry,
 * filters by a simple `includes` match against the title/section, and
 * runs the selected command on Enter.
 *
 * The shell deliberately does not depend on `cmdk` or any other new
 * package — Radix Dialog + a plain input + a flat list is enough to
 * cover the upstream behaviour we care about.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { cn } from "~/lib/cn";
import {
	listCommands,
	subscribe,
	type Command,
} from "~/lib/commandPalette";
import { useUIStore } from "~/hooks/useUIStore";

function getSnapshot(): Command[] {
	return listCommands();
}

function getServerSnapshot(): Command[] {
	return [];
}

function useCommands(): Command[] {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPhone|iPad/i.test(navigator.platform);
}

/**
 * Render a normalised shortcut string ("mod+shift+t") as a row of
 * keycaps. Keeps the tokeniser identical to `useGlobalShortcuts`.
 */
function ShortcutHint({ shortcut }: { shortcut: string }) {
	const isMac = isMacPlatform();
	const tokens = shortcut
		.toLowerCase()
		.split("+")
		.map((t) => t.trim())
		.filter(Boolean)
		.map((token) => {
			if (token === "mod") return isMac ? "⌘" : "Ctrl";
			if (token === "cmd" || token === "meta") return "⌘";
			if (token === "ctrl" || token === "control") return "Ctrl";
			if (token === "shift") return "⇧";
			if (token === "alt" || token === "option") return isMac ? "⌥" : "Alt";
			if (token === "enter") return "↵";
			if (token === "backspace") return "⌫";
			if (token === "escape" || token === "esc") return "Esc";
			if (token === "space") return "Space";
			if (token === "arrowup") return "↑";
			if (token === "arrowdown") return "↓";
			if (token === "arrowleft") return "←";
			if (token === "arrowright") return "→";
			if (token === ",") return ",";
			if (token === "`") return "`";
			return token.length === 1 ? token.toUpperCase() : token;
		});
	return (
		<span className="flex items-center gap-1">
			{tokens.map((tok, idx) => (
				<span
					key={idx}
					className="inline-flex min-h-7 min-w-7 items-center justify-center rounded border border-edge bg-paper px-1.5 text-xs font-medium text-ink-3"
				>
					{tok}
				</span>
			))}
		</span>
	);
}

interface FilteredItem {
	command: Command;
	enabled: boolean;
}

/**
 * Highlight the directly-matched substring of the query inside a title
 * (approved design section 07). Fuzzy subsequence matches pass through
 * unhighlighted — only plain substring hits get the coral mark.
 */
function highlightTitle(title: string, query: string): React.ReactNode {
	const needle = query.trim().toLowerCase();
	if (!needle) return title;
	const index = title.toLowerCase().indexOf(needle);
	if (index < 0) return title;
	return (
		<>
			{title.slice(0, index)}
			<mark className="rounded-[3px] bg-coral-bg px-0.5 text-coral-2">
				{title.slice(index, index + needle.length)}
			</mark>
			{title.slice(index + needle.length)}
		</>
	);
}

/**
 * Curated fallbacks for the rich empty state: prefer the high-value
 * entry commands by title keyword, then any enabled command, capped at
 * four so the empty state stays a nudge, not a wall.
 */
const EMPTY_STATE_PREFERRED = ["搜索", "撰写", "摘要", "自动化"];

function pickEmptyStateCommands(commands: Command[]): FilteredItem[] {
	const enabled = commands.filter((command) => (command.when ? command.when() : true));
	const preferred: FilteredItem[] = [];
	for (const keyword of EMPTY_STATE_PREFERRED) {
		const match = enabled.find(
			(command) => !preferred.some((item) => item.command.id === command.id) && command.title.includes(keyword),
		);
		if (match) preferred.push({ command: match, enabled: true });
	}
	for (const command of enabled) {
		if (preferred.length >= 4) break;
		if (!preferred.some((item) => item.command.id === command.id)) {
			preferred.push({ command, enabled: true });
		}
	}
	return preferred.slice(0, 4);
}

interface FilteredGroup {
	section: string;
	items: FilteredItem[];
}

function fuzzyMatch(haystack: string, needle: string): boolean {
	if (!needle) return true;
	const h = haystack.toLowerCase();
	const n = needle.toLowerCase();
	if (h.includes(n)) return true;
	// Subsequence fallback: every character of the query must appear in
	// order somewhere in the haystack. Keeps the matcher useful for
	// abbreviations like "rop" -> "Reply Open Panel" without dragging in
	// a fuzzy-search dependency.
	let i = 0;
	for (let j = 0; j < h.length && i < n.length; j++) {
		if (h[j] === n[i]) i++;
	}
	return i === n.length;
}

function filterAndGroup(commands: Command[], query: string): FilteredGroup[] {
	const groups = new Map<string, FilteredItem[]>();
	for (const cmd of commands) {
		const haystack = `${cmd.title} ${cmd.section ?? ""}`;
		if (!fuzzyMatch(haystack, query)) continue;
		const enabled = cmd.when ? cmd.when() : true;
		const section = cmd.section ?? "其他";
		const list = groups.get(section);
		if (list) list.push({ command: cmd, enabled });
		else groups.set(section, [{ command: cmd, enabled }]);
	}
	return Array.from(groups.entries()).map(([section, items]) => ({
		section,
		items,
	}));
}

export default function CommandPalette() {
	const isCommandPaletteOpen = useUIStore((state) => state.isCommandPaletteOpen);
	const closeCommandPalette = useUIStore((state) => state.closeCommandPalette);
	const allCommands = useCommands();
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// Reset the query each time the palette opens so users start fresh.
	useEffect(() => {
		if (isCommandPaletteOpen) {
			setQuery("");
			setActiveIndex(0);
		}
	}, [isCommandPaletteOpen]);

	const groups = useMemo(
		() => filterAndGroup(allCommands, query.trim()),
		[allCommands, query],
	);

	// Flatten groups into a single index space for arrow navigation.
	const flatItems = useMemo<FilteredItem[]>(
		() => groups.flatMap((g) => g.items),
		[groups],
	);

	// Clamp activeIndex when the filter changes.
	useEffect(() => {
		if (activeIndex >= flatItems.length) setActiveIndex(0);
	}, [flatItems.length, activeIndex]);

	const runItem = (item: FilteredItem | undefined) => {
		if (!item || !item.enabled) return;
		closeCommandPalette();
		// Defer to next tick so the dialog tear-down doesn't swallow the
		// handler's own focus management (e.g. opening the compose
		// window which itself takes focus).
		queueMicrotask(() => item.command.handler());
	};

	const runActive = () => {
		runItem(flatItems[activeIndex]);
	};
	const moveActive = (direction: 1 | -1) => {
		if (flatItems.length === 0) return;
		let next = activeIndex;
		for (let attempts = 0; attempts < flatItems.length; attempts++) {
			next = (next + direction + flatItems.length) % flatItems.length;
			if (flatItems[next]?.enabled) {
				setActiveIndex(next);
				return;
			}
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveActive(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(-1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			runActive();
			return;
		}
	};

	// Scroll active row into view as the user navigates.
	useEffect(() => {
		const container = listRef.current;
		if (!container) return;
		const activeEl = container.querySelector<HTMLElement>(
			`[data-cmd-index="${activeIndex}"]`,
		);
		if (activeEl) {
			activeEl.scrollIntoView({ block: "nearest" });
		}
	}, [activeIndex]);

	let runningIndex = 0;

	return (
		<DialogPrimitive.Root
			open={isCommandPaletteOpen}
			onOpenChange={(open) => {
				if (!open) closeCommandPalette();
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					className={cn(
						"fixed inset-0 z-50 bg-ink/50",
						"transition-opacity duration-150",
						"data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
					)}
				/>
				<DialogPrimitive.Content
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						inputRef.current?.focus();
					}}
					className={cn(
						"fixed left-1/2 top-[20%] z-50 w-full max-w-xl -translate-x-1/2",
						"bg-paper-2 text-ink border border-edge rounded-xl shadow-[var(--shadow-3)]",
						"overflow-hidden",
						"transition-opacity duration-150",
						"data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
					)}
				>
					<DialogPrimitive.Title className="sr-only">
						命令面板
					</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">
						搜索并运行 WeMail 命令。使用上下方向键导航，回车执行。
					</DialogPrimitive.Description>

					<div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
						<MagnifyingGlassIcon size={16} className="text-ink-3" />
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setActiveIndex(0);
							}}
							onKeyDown={handleKeyDown}
							placeholder="搜索命令…"
							role="combobox"
							aria-autocomplete="list"
							aria-expanded={isCommandPaletteOpen}
							aria-controls="command-palette-options"
							aria-activedescendant={
								flatItems[activeIndex]
									? `command-option-${flatItems[activeIndex].command.id}`
									: undefined
							}
							className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
							data-testid="command-palette-input"
						/>
					</div>

					<div
						id="command-palette-options"
						ref={listRef}
						role="listbox"
						aria-label="命令搜索结果"
						className="max-h-[60vh] overflow-y-auto py-1"
						data-testid="command-palette-list"
					>
						{flatItems.length === 0 ? (
							<div className="px-3 py-3" data-testid="command-palette-empty">
								<p className="px-1 pb-2 text-sm text-ink-3">
									未找到「{query.trim()}」相关的命令，试试这些：
								</p>
								<div className="grid grid-cols-2 gap-2">
									{pickEmptyStateCommands(allCommands).map((item) => (
										<button
											key={item.command.id}
											type="button"
											onClick={() => runItem(item)}
											className="flex min-h-16 items-start gap-2.5 rounded-lg border border-edge bg-paper-2 p-2.5 text-left transition-colors hover:border-edge-2 hover:bg-summary-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" aria-hidden="true" />
											<span className="min-w-0">
												<span className="block truncate text-sm text-ink">{item.command.title}</span>
												<span className="block truncate text-xs text-ink-3">{item.command.section ?? "其他"}</span>
											</span>
										</button>
									))}
								</div>
							</div>
						) : (
							groups.map((group) => (
								<div key={group.section} className="py-1">
									<div className="px-4 py-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
										{group.section}
									</div>
									{group.items.map((item) => {
										const idx = runningIndex++;
										const isActive = idx === activeIndex;
										return (
											<button
												id={`command-option-${item.command.id}`}
												role="option"
												aria-selected={isActive}
												key={item.command.id}
												type="button"
												data-cmd-index={idx}
												data-cmd-id={item.command.id}
												disabled={!item.enabled}
												onMouseEnter={() => setActiveIndex(idx)}
												onClick={() => {
													setActiveIndex(idx);
													runItem(item);
												}}
												className={cn(
													"flex items-center justify-between w-full px-4 py-2 text-left text-sm transition-colors",
													isActive
														? "bg-paper-3 text-ink"
														: "text-ink-2 hover:bg-paper-3",
													!item.enabled && "opacity-40 cursor-not-allowed",
												)}
											>
												<span className="truncate">{highlightTitle(item.command.title, query)}</span>
												{item.command.shortcut ? (
													<ShortcutHint shortcut={item.command.shortcut} />
												) : null}
											</button>
										);
									})}
								</div>
							))
						)}
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
