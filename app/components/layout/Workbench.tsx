// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	createContext,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";

export type WorkbenchModalId = "compose" | "agent";
export type WorkbenchViewportMode = "wide" | "medium" | "narrow";

export interface ActiveModalContextValue {
	active: WorkbenchModalId | null;
	open: (id: WorkbenchModalId) => void;
	close: () => void;
}

export interface WorkbenchNavigationContextValue {
	collapsed: boolean;
	toggle: () => void;
}

export interface WorkbenchProps {
	nav: ReactNode;
	list: ReactNode;
	detail: ReactNode;
	agent?: ReactNode;
	agentOpen?: boolean;
	agentExpanded?: boolean;
	showDetailColumn?: boolean;
	initialViewportMode?: WorkbenchViewportMode;
}

interface PaneSizeState {
	nav: number;
	list: number;
	agent: number;
}

interface AgentWidthOverride {
	mode: ResizableMode;
	expanded: boolean;
	width: number;
}

type ResizableMode = Exclude<WorkbenchViewportMode, "narrow">;
type PersistedPaneSizes = Partial<
	Record<ResizableMode, Partial<PaneSizeState>>
>;
type AgentPlacement = "closed" | "drawer" | "floating" | "docked";

const ActiveModalContext = createContext<ActiveModalContextValue | null>(null);
const WorkbenchNavigationContext = createContext<WorkbenchNavigationContextValue>({
	collapsed: false,
	toggle: () => {},
});

const NARROW_MAX = 1279;
const WIDE_MIN = 1500;
const RESIZE_STORAGE_KEY = "wemail.workbenchPaneSizes.v2";
const LEGACY_RESIZE_STORAGE_KEY = "wemail.workbenchPaneSizes";
const NAV_COLLAPSED_STORAGE_KEY = "wemail.workbenchNavCollapsed.v1";
// Keep a one-pixel hit area for the navigation resizer without reserving a
// visible strip between the sidebar and the mail list.
const NAV_GUTTER_WIDTH = 1;
const NAV_COLLAPSED_WIDTH = 56;
const DETAIL_DIVIDER_WIDTH = 1;
const AGENT_GAP_WIDTH = 16;

const DEFAULT_PANE_SIZES: Record<ResizableMode, PaneSizeState> = {
	wide: { nav: 180, list: 340, agent: 360 },
	medium: { nav: 180, list: 300, agent: 340 },
};

const DEFAULT_EXPANDED_AGENT_WIDTH: Record<ResizableMode, number> = {
	wide: 640,
	medium: 520,
};

const MIN_NAV_WIDTH: Record<ResizableMode, number> = {
	wide: 148,
	medium: 144,
};

const MAX_NAV_WIDTH: Record<ResizableMode, number> = {
	wide: 208,
	medium: 200,
};

const MIN_LIST_WIDTH: Record<ResizableMode, number> = {
	wide: 260,
	medium: 240,
};

const MAX_LIST_WIDTH: Record<ResizableMode, number> = {
	wide: 620,
	medium: 560,
};

const MIN_AGENT_WIDTH: Record<ResizableMode, number> = {
	wide: 240,
	medium: 240,
};

const MAX_AGENT_WIDTH: Record<ResizableMode, number> = {
	wide: 720,
	medium: 620,
};

const NAVIGATION_PANE_ID = "workbench-navigation-pane";

function getAgentPresetWidth(mode: ResizableMode, expanded: boolean): number {
	return expanded
		? DEFAULT_EXPANDED_AGENT_WIDTH[mode]
		: DEFAULT_PANE_SIZES[mode].agent;
}

function detectMode(): WorkbenchViewportMode {
	if (typeof window === "undefined") return "wide";
	const width = window.innerWidth;
	if (width >= WIDE_MIN) return "wide";
	if (width > NARROW_MAX) return "medium";
	return "narrow";
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function readPersistedPaneSizes(): PersistedPaneSizes {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(RESIZE_STORAGE_KEY);
		if (raw) {
			return (JSON.parse(raw) as PersistedPaneSizes) ?? {};
		}

		const legacyRaw = window.localStorage.getItem(LEGACY_RESIZE_STORAGE_KEY);
		if (!legacyRaw) return {};
		const legacy = (JSON.parse(legacyRaw) as PersistedPaneSizes) ?? {};
		const migrated: PersistedPaneSizes = {};
		for (const mode of ["wide", "medium"] as const) {
			const saved = legacy[mode];
			if (!saved) continue;
			migrated[mode] = {
				...(typeof saved.list === "number" ? { list: saved.list } : {}),
				...(typeof saved.agent === "number" ? { agent: saved.agent } : {}),
			};
		}
		writePersistedPaneSizes(migrated);
		return migrated;
	} catch {
		return {};
	}
}

function writePersistedPaneSizes(sizes: PersistedPaneSizes) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(RESIZE_STORAGE_KEY, JSON.stringify(sizes));
	} catch {
		// best effort
	}
}

function readPersistedNavigationCollapsed(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function writePersistedNavigationCollapsed(collapsed: boolean) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, String(collapsed));
	} catch {
		// best effort
	}
}

function getResolvedPaneSizes(
	mode: ResizableMode,
	persisted: PersistedPaneSizes,
	agentExpanded: boolean,
): PaneSizeState {
	const saved = persisted[mode];
	return {
		nav: clamp(
			saved?.nav ?? DEFAULT_PANE_SIZES[mode].nav,
			MIN_NAV_WIDTH[mode],
			MAX_NAV_WIDTH[mode],
		),
		list: clamp(
			saved?.list ?? DEFAULT_PANE_SIZES[mode].list,
			MIN_LIST_WIDTH[mode],
			MAX_LIST_WIDTH[mode],
		),
		agent: clamp(
			saved?.agent ??
				(agentExpanded
					? DEFAULT_EXPANDED_AGENT_WIDTH[mode]
					: DEFAULT_PANE_SIZES[mode].agent),
			MIN_AGENT_WIDTH[mode],
			MAX_AGENT_WIDTH[mode],
		),
	};
}

export function useActiveModal(): ActiveModalContextValue {
	const ctx = useContext(ActiveModalContext);
	if (!ctx) {
		throw new Error("useActiveModal must be used inside <Workbench>");
	}
	return ctx;
}

export function useWorkbenchNavigation(): WorkbenchNavigationContextValue {
	return useContext(WorkbenchNavigationContext);
}

export function Workbench({
	nav,
	list,
	detail,
	agent,
	agentOpen,
	agentExpanded = false,
	showDetailColumn = true,
	initialViewportMode,
}: WorkbenchProps) {
	const [mode, setMode] = useState<WorkbenchViewportMode>(
		initialViewportMode ?? detectMode,
	);
	const [paneSizes, setPaneSizes] = useState<PersistedPaneSizes>(() =>
		readPersistedPaneSizes(),
	);
	const [navigationCollapsed, setNavigationCollapsed] = useState(
		readPersistedNavigationCollapsed,
	);
	const fallbackNavDragRef = useRef<
		| {
				mode: ResizableMode;
				startX: number;
				startSize: number;
		  }
		| null
	>(null);
	const listDragRef = useRef<
		| {
				mode: ResizableMode;
				startX: number;
				startSize: number;
		  }
		| null
	>(null);
	const dockedAgentDragRef = useRef<
		| {
				mode: ResizableMode;
				startX: number;
				startSize: number;
		  }
		| null
	>(null);
	const floatingAgentDragRef = useRef<
		| {
				mode: ResizableMode;
				startX: number;
				startSize: number;
		  }
		| null
	>(null);
	const [floatingAgentResizing, setFloatingAgentResizing] = useState(false);
	const [agentHost] = useState<HTMLDivElement | null>(() =>
		typeof document === "undefined" ? null : document.createElement("div"),
	);
	const [listHost] = useState<HTMLDivElement | null>(() =>
		typeof document === "undefined" ? null : document.createElement("div"),
	);

	useEffect(() => {
		if (initialViewportMode) return;
		if (typeof window === "undefined") return;
		const update = () => setMode(detectMode());
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, [initialViewportMode]);

	const [active, setActive] = useState<WorkbenchModalId | null>(null);
	const open = useCallback((id: WorkbenchModalId) => setActive(id), []);
	const close = useCallback(() => setActive(null), []);
	const ctx = useMemo<ActiveModalContextValue>(
		() => ({ active, open, close }),
		[active, open, close],
	);
	const toggleNavigation = useCallback(() => {
		setNavigationCollapsed((current) => {
			const next = !current;
			writePersistedNavigationCollapsed(next);
			return next;
		});
	}, []);
	const navigationCtx = useMemo<WorkbenchNavigationContextValue>(
		() => ({ collapsed: navigationCollapsed, toggle: toggleNavigation }),
		[navigationCollapsed, toggleNavigation],
	);

	const isNarrow = mode === "narrow";
	const drawerOpen = isNarrow && active === "agent";
	const hasAgentContent = agent !== undefined && agent !== null;
	const hasAgent = (agentOpen ?? hasAgentContent) && hasAgentContent;
	const agentPlacement: AgentPlacement = !hasAgent
		? "closed"
		: isNarrow
			? "drawer"
			: showDetailColumn
				? "docked"
				: "floating";
	const showAgentColumn = agentPlacement === "docked";
	const showFloatingAgent = agentPlacement === "floating";
	const showAgentInRoot = agentPlacement === "floating" || agentPlacement === "docked";
	const resizableMode = isNarrow ? null : mode;
	const [agentWidthOverride, setAgentWidthOverride] = useState<AgentWidthOverride | null>(null);
	const agentWidth =
		resizableMode &&
		agentWidthOverride?.mode === resizableMode &&
		agentWidthOverride.expanded === agentExpanded
			? agentWidthOverride.width
			: resizableMode
				? getAgentPresetWidth(resizableMode, agentExpanded)
				: null;
	useEffect(() => {
		// A preset toggle always starts from the standard width for that mode;
		// a manually dragged width is only temporary until the next toggle.
		setAgentWidthOverride(null);
	}, [agentExpanded, resizableMode]);
	const resolvedPaneSizes = useMemo(
		() => {
			if (!resizableMode) return null;
			const resolved = getResolvedPaneSizes(resizableMode, paneSizes, agentExpanded);
			return agentWidth === null ? resolved : { ...resolved, agent: agentWidth };
		},
		[agentExpanded, agentWidth, paneSizes, resizableMode],
	);

	const persistPaneSize = useCallback(
		(modeToSave: ResizableMode, next: Partial<PaneSizeState>) => {
			setPaneSizes((prev) => {
				const merged: PersistedPaneSizes = {
					...prev,
					[modeToSave]: {
						...getResolvedPaneSizes(modeToSave, prev, false),
						...next,
					},
				};
				writePersistedPaneSizes(merged);
				return merged;
			});
		},
		[],
	);

	const sizes = resizableMode
		? resolvedPaneSizes ?? getResolvedPaneSizes(resizableMode, paneSizes, agentExpanded)
		: null;
	const setManualAgentWidth = useCallback(
		(modeToSave: ResizableMode, width: number) => {
			setAgentWidthOverride({ mode: modeToSave, expanded: agentExpanded, width });
		},
		[agentExpanded],
	);
	const startFallbackNavResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!resizableMode || !sizes || navigationCollapsed) return;
			event.preventDefault();
			fallbackNavDragRef.current = {
				mode: resizableMode,
				startX: event.clientX,
				startSize: sizes.nav,
			};
		},
		[navigationCollapsed, resizableMode, sizes],
	);
	const startListResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!resizableMode || !sizes || !showDetailColumn) return;
			event.preventDefault();
			listDragRef.current = {
				mode: resizableMode,
				startX: event.clientX,
				startSize: sizes.list,
			};
		},
		[resizableMode, showDetailColumn, sizes],
	);
	const startDockedAgentResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!resizableMode || !sizes || !showAgentColumn) return;
			event.preventDefault();
			dockedAgentDragRef.current = {
				mode: resizableMode,
				startX: event.clientX,
				startSize: sizes.agent,
			};
		},
		[resizableMode, showAgentColumn, sizes],
	);
	const startFloatingAgentResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!resizableMode || !sizes || !showFloatingAgent) return;
			event.preventDefault();
			event.stopPropagation();
			floatingAgentDragRef.current = {
				mode: resizableMode,
				startX: event.clientX,
				startSize: sizes.agent,
			};
			setFloatingAgentResizing(true);
		},
		[resizableMode, showFloatingAgent, sizes],
	);
	const resizeWithKeyboard = useCallback(
		(event: ReactKeyboardEvent<HTMLElement>, panel: "nav" | "list" | "agent") => {
			if (!resizableMode || !sizes) return;
			const min = panel === "nav"
				? MIN_NAV_WIDTH[resizableMode]
				: panel === "list"
					? MIN_LIST_WIDTH[resizableMode]
					: MIN_AGENT_WIDTH[resizableMode];
			const max = panel === "nav"
				? MAX_NAV_WIDTH[resizableMode]
				: panel === "list"
					? MAX_LIST_WIDTH[resizableMode]
					: MAX_AGENT_WIDTH[resizableMode];
			const current = sizes[panel];
			let next: number | null = null;
			if (event.key === "Home") next = min;
			if (event.key === "End") next = max;
			if (event.key === "ArrowLeft") next = current + (panel === "agent" ? 12 : -12);
			if (event.key === "ArrowRight") next = current + (panel === "agent" ? -12 : 12);
			if (next === null) return;
			event.preventDefault();
			const clampedNext = clamp(next, min, max);
			if (panel === "agent") {
				setManualAgentWidth(resizableMode, clampedNext);
			} else {
				persistPaneSize(resizableMode, { [panel]: clampedNext });
			}
		},
		[persistPaneSize, resizableMode, setManualAgentWidth, sizes],
	);
	const attachAgentHost = useCallback(
		(node: HTMLDivElement | null) => {
			if (!node || !agentHost) return;
			if (agentHost.parentElement !== node) {
				node.appendChild(agentHost);
			}
		},
		[agentHost],
	);
	const attachListHost = useCallback(
		(node: HTMLDivElement | null) => {
			if (!node || !listHost) return;
			if (listHost.parentElement !== node) {
				node.appendChild(listHost);
			}
		},
		[listHost],
	);

	const gridTemplateColumns = useMemo(() => {
		if (isNarrow) {
			const narrowNavWidth = navigationCollapsed ? NAV_COLLAPSED_WIDTH : 156;
			return showDetailColumn
				? `${narrowNavWidth}px 320px minmax(0,1fr)`
				: `${narrowNavWidth}px minmax(0,1fr)`;
		}

		const currentMode = resizableMode as ResizableMode;
		const currentSizes =
			sizes ?? getResolvedPaneSizes(currentMode, paneSizes, agentExpanded);

		if (!showDetailColumn) {
			const navWidth = navigationCollapsed ? NAV_COLLAPSED_WIDTH : currentSizes.nav;
			return showFloatingAgent
				? `${navWidth}px ${NAV_GUTTER_WIDTH}px minmax(0,1fr) ${AGENT_GAP_WIDTH}px ${currentSizes.agent}px`
				: `${navWidth}px ${NAV_GUTTER_WIDTH}px minmax(0,1fr)`;
		}

		const navWidth = navigationCollapsed ? NAV_COLLAPSED_WIDTH : currentSizes.nav;
		return showAgentColumn
			? `${navWidth}px ${NAV_GUTTER_WIDTH}px ${currentSizes.list}px ${DETAIL_DIVIDER_WIDTH}px minmax(0,1fr) ${AGENT_GAP_WIDTH}px ${currentSizes.agent}px`
			: `${navWidth}px ${NAV_GUTTER_WIDTH}px ${currentSizes.list}px ${DETAIL_DIVIDER_WIDTH}px minmax(0,1fr)`;
	}, [
		sizes,
		agentExpanded,
		isNarrow,
		navigationCollapsed,
		paneSizes,
		resizableMode,
		showAgentColumn,
		showDetailColumn,
		showFloatingAgent,
	]);

	const gridStyle: CSSProperties = { gridTemplateColumns };
	const mainSurfaceLeft = isNarrow
		? navigationCollapsed
			? NAV_COLLAPSED_WIDTH
			: 156
		: (navigationCollapsed ? NAV_COLLAPSED_WIDTH : sizes?.nav ?? 180) +
			NAV_GUTTER_WIDTH;
	const floatingAgentWidth =
		showFloatingAgent && sizes
			? sizes.agent
			: undefined;

	useEffect(() => {
		const onPointerMove = (event: PointerEvent) => {
			const navDrag = fallbackNavDragRef.current;
			if (navDrag) {
				persistPaneSize(navDrag.mode, {
					nav: clamp(
						navDrag.startSize + (event.clientX - navDrag.startX),
						MIN_NAV_WIDTH[navDrag.mode],
						MAX_NAV_WIDTH[navDrag.mode],
					),
				});
			}

			const listDrag = listDragRef.current;
			if (listDrag) {
				persistPaneSize(listDrag.mode, {
					list: clamp(
						listDrag.startSize + (event.clientX - listDrag.startX),
						MIN_LIST_WIDTH[listDrag.mode],
						MAX_LIST_WIDTH[listDrag.mode],
					),
				});
			}

			const dockedAgentDrag = dockedAgentDragRef.current;
			if (dockedAgentDrag) {
				setManualAgentWidth(
					dockedAgentDrag.mode,
					clamp(
						dockedAgentDrag.startSize -
							(event.clientX - dockedAgentDrag.startX),
						MIN_AGENT_WIDTH[dockedAgentDrag.mode],
						MAX_AGENT_WIDTH[dockedAgentDrag.mode],
					),
				);
			}

			const agentDrag = floatingAgentDragRef.current;
			if (agentDrag) {
				setManualAgentWidth(
					agentDrag.mode,
					clamp(
						agentDrag.startSize - (event.clientX - agentDrag.startX),
						MIN_AGENT_WIDTH[agentDrag.mode],
						MAX_AGENT_WIDTH[agentDrag.mode],
					),
				);
			}
		};

		const stopDrag = () => {
			fallbackNavDragRef.current = null;
			listDragRef.current = null;
			dockedAgentDragRef.current = null;
			floatingAgentDragRef.current = null;
			setFloatingAgentResizing(false);
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", stopDrag);
		window.addEventListener("pointercancel", stopDrag);
		return () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", stopDrag);
			window.removeEventListener("pointercancel", stopDrag);
		};
	}, [persistPaneSize, setManualAgentWidth]);

	useEffect(() => {
		if (showFloatingAgent) return;
		floatingAgentDragRef.current = null;
		setFloatingAgentResizing(false);
	}, [showFloatingAgent]);

	const wideSeparatorClass =
		"wm-col-resize-cursor relative min-h-0 h-full touch-none group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral";
	const navSeparatorClass = `${wideSeparatorClass} z-10 bg-transparent`;
	const dividerSeparatorClass =
		"wm-col-resize-cursor relative min-h-0 h-full touch-none group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral";
	const separatorLineClass = (isActive: boolean) =>
		`absolute inset-y-0 left-0 transition-all duration-150 motion-reduce:transition-none ${
			isActive
				? "w-[3px] rounded-full bg-coral shadow-[0_0_0_4px_var(--color-coral-bg)]"
				: "w-px bg-edge-2 group-hover:w-0.5 group-hover:rounded-full group-hover:bg-ink-4/70"
		}`;
	const quietSeparatorLineClass = (isActive: boolean) =>
		`absolute inset-y-[66px] right-0 transition-all duration-150 motion-reduce:transition-none ${
			isActive
				? "w-[3px] rounded-full bg-coral shadow-[0_0_0_4px_var(--color-coral-bg)]"
				: "w-px bg-transparent group-hover:w-0.5 group-hover:rounded-full group-hover:bg-ink-4/70"
		}`;
	const navSeparatorLineClass = (isActive: boolean) =>
		`absolute right-0 top-1/2 -translate-y-1/2 transition-all duration-150 motion-reduce:transition-none ${
			isActive
				? "h-16 w-[3px] rounded-full bg-coral shadow-[0_0_0_4px_var(--color-coral-bg)]"
				: "h-12 w-px rounded-full bg-transparent group-hover:w-0.5 group-hover:bg-ink-4/70"
		}`;
	const agentPortal =
		hasAgentContent && agentHost ? createPortal(agent, agentHost) : null;
	const listPortal = listHost ? createPortal(list, listHost) : null;

	useEffect(() => {
		if (!agentHost) return;
		agentHost.className = "h-full min-h-0";
		return () => {
			agentHost.remove();
		};
	}, [agentHost]);
	useEffect(() => {
		if (!listHost) return;
		listHost.className = "h-full min-h-0";
		return () => {
			listHost.remove();
		};
	}, [listHost]);
	return (
		<ActiveModalContext.Provider value={ctx}>
			<WorkbenchNavigationContext.Provider value={navigationCtx}>
			<div
				data-testid="workbench"
				data-mode={mode}
				data-drawer={isNarrow ? "true" : "false"}
				data-agent={agentPlacement === "closed" ? "closed" : "open"}
				data-agent-placement={agentPlacement}
				data-detail={showDetailColumn ? "open" : "closed"}
				data-nav-collapsed={navigationCollapsed ? "true" : "false"}
				style={gridStyle}
				className="relative isolate grid flex-1 min-h-0 w-full gap-0 overflow-visible bg-sidebar transition-none"
			>
				<div
					aria-hidden="true"
					data-testid="workbench-main-surface"
					style={{ left: mainSurfaceLeft }}
					className="wemail-main-surface pointer-events-none absolute inset-y-0 right-0 z-0 bg-workbench-surface"
				/>
				<div
					aria-hidden="true"
					data-testid="workbench-main-surface-edge"
					style={{ left: mainSurfaceLeft }}
					className="wemail-main-surface-edge pointer-events-none absolute inset-y-0 right-0 z-[30]"
				/>
				<>
						<div
							id={NAVIGATION_PANE_ID}
							data-testid="workbench-nav"
							className="relative z-10 min-w-0 min-h-0 h-full bg-transparent"
						>
							{nav}
						</div>
						{!isNarrow ? (
							<div
								data-testid="workbench-nav-resizer"
								role="separator"
								aria-orientation="vertical"
								aria-label="调整导航栏宽度"
								aria-controls={NAVIGATION_PANE_ID}
								aria-valuemin={resizableMode ? MIN_NAV_WIDTH[resizableMode] : undefined}
								aria-valuemax={resizableMode ? MAX_NAV_WIDTH[resizableMode] : undefined}
								aria-valuenow={sizes?.nav}
								tabIndex={0}
								onKeyDown={(event) => resizeWithKeyboard(event, "nav")}
								onPointerDown={startFallbackNavResize}
								className={navSeparatorClass}
							>
								<div className={navSeparatorLineClass(false)} />
							</div>
						) : null}
						<div data-testid="workbench-list" className="relative z-10 min-w-0 min-h-0 h-full bg-transparent">
							<div ref={attachListHost} className="h-full min-h-0" />
						</div>
						{!isNarrow && showDetailColumn ? (
							<div
								data-testid="workbench-list-resizer"
								role="separator"
								aria-orientation="vertical"
								aria-label="调整邮件列表宽度"
								aria-valuemin={resizableMode ? MIN_LIST_WIDTH[resizableMode] : undefined}
								aria-valuemax={resizableMode ? MAX_LIST_WIDTH[resizableMode] : undefined}
								aria-valuenow={sizes?.list}
								tabIndex={0}
								onKeyDown={(event) => resizeWithKeyboard(event, "list")}
								onPointerDown={startListResize}
								className={dividerSeparatorClass}
							>
								<div className={separatorLineClass(false)} />
							</div>
						) : null}
						<div
							data-testid="workbench-detail"
							aria-hidden={showDetailColumn ? undefined : "true"}
							className={`relative z-10 min-w-0 min-h-0 h-full bg-transparent transition-opacity duration-200 ease-out motion-reduce:transition-none ${
								showDetailColumn ? "opacity-100" : "hidden opacity-0"
							}`}
						>
							{detail}
						</div>
						{showAgentColumn ? (
							<div
								data-testid="workbench-agent-resizer"
								role="separator"
								aria-orientation="vertical"
								aria-label="调整 Agent 面板宽度"
								aria-controls="workbench-agent-pane"
								aria-valuemin={resizableMode ? MIN_AGENT_WIDTH[resizableMode] : undefined}
								aria-valuemax={resizableMode ? MAX_AGENT_WIDTH[resizableMode] : undefined}
								aria-valuenow={sizes?.agent}
								tabIndex={0}
								onKeyDown={(event) => resizeWithKeyboard(event, "agent")}
								onPointerDown={startDockedAgentResize}
								style={{ gridColumn: "6" }}
								className={dividerSeparatorClass}
							>
								<div className={quietSeparatorLineClass(false)} />
							</div>
						) : null}
				</>
				{showAgentInRoot ? (
					<div
						id="workbench-agent-pane"
						data-testid={showFloatingAgent ? "workbench-agent-floating" : "workbench-agent"}
						style={showFloatingAgent && floatingAgentWidth
							? { width: floatingAgentWidth }
							: showAgentColumn
								? { gridColumn: "7" }
								: undefined}
						className={
							showFloatingAgent
								? "pointer-events-auto absolute right-4 top-4 z-20 h-[calc(100%-2rem)] min-w-0 min-h-0 motion-safe:animate-[slide-in-right_180ms_ease-out]"
								: "relative z-20 min-w-0 min-h-0 h-full pt-3 pb-3 pr-3 motion-safe:animate-[slide-in-right_180ms_ease-out]"
						}
					>
						{showFloatingAgent ? (
							<div
								data-testid="workbench-agent-resizer"
								role="separator"
								aria-orientation="vertical"
								aria-label="调整 Agent 面板宽度"
								aria-controls="workbench-agent-pane"
								aria-valuemin={resizableMode ? MIN_AGENT_WIDTH[resizableMode] : undefined}
								aria-valuemax={resizableMode ? MAX_AGENT_WIDTH[resizableMode] : undefined}
								aria-valuenow={sizes?.agent}
								tabIndex={0}
								onKeyDown={(event) => resizeWithKeyboard(event, "agent")}
								onPointerDown={startFloatingAgentResize}
								className="wm-col-resize-cursor group absolute inset-y-0 left-0 w-4 touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral"
							>
								<div className={`${quietSeparatorLineClass(floatingAgentResizing)} -translate-x-4`} />
							</div>
						) : null}
						<div ref={attachAgentHost} className="h-full min-h-0" />
					</div>
				) : null}
			</div>

			{isNarrow && hasAgent ? (
				<Dialog
					open={drawerOpen}
					onOpenChange={(nextOpen) => (nextOpen ? open("agent") : close())}
				>
					<DialogContent
						data-testid="workbench-agent-drawer"
						className="fixed right-0 top-0 left-auto translate-x-0 translate-y-0 h-full max-w-[400px] w-[90vw] rounded-none rounded-l-lg p-0 grid-rows-[auto_1fr]"
					>
						<DialogTitle className="sr-only">Agent</DialogTitle>
						<DialogDescription className="sr-only">
							Agent panel
						</DialogDescription>
						<div ref={attachAgentHost} className="overflow-hidden h-full" />
					</DialogContent>
				</Dialog>
				) : null}
				{listPortal}
				{agentPortal}
			</WorkbenchNavigationContext.Provider>
		</ActiveModalContext.Provider>
	);
}

export default Workbench;
