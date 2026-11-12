// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import {
	createFreshHomeAgentSession,
	openEmailAgentSession,
	resumeAgentSession,
	type AgentSessionMode,
} from "~/hooks/agentSessionLifecycle";
import type { Email } from "~/types";
import type { MailSceneActionContext } from "shared/wemail/intelligence";

/* ---------- draft-panel persistence ----------
 * Smart-draft panel position survives reload via localStorage. Default
 * mode is "docked" (rendered in EmailPanel's bottom slot). When the
 * user grabs the drag handle, mode flips to "floating" and the panel
 * is portaled to document.body at (x, y).
 */
const DRAFT_PANEL_KEY = "wemail.draftPanel";

export type DraftPanelMode = "docked" | "floating";
export interface DraftPanelPosition {
	x: number;
	y: number;
}

interface PersistedDraftPanel {
	mode: DraftPanelMode;
	position: DraftPanelPosition;
}

function readPersistedDraftPanel(): PersistedDraftPanel {
	const fallback: PersistedDraftPanel = {
		mode: "docked",
		position: { x: 0, y: 0 },
	};
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(DRAFT_PANEL_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<PersistedDraftPanel>;
		return {
			mode: parsed.mode === "floating" ? "floating" : "docked",
			position: {
				x:
					typeof parsed.position?.x === "number"
						? parsed.position.x
						: 0,
				y:
					typeof parsed.position?.y === "number"
						? parsed.position.y
						: 0,
			},
		};
	} catch {
		return fallback;
	}
}

function writePersistedDraftPanel(state: PersistedDraftPanel): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(DRAFT_PANEL_KEY, JSON.stringify(state));
	} catch {
		// localStorage might be full or disabled — ignore; the in-memory
		// state still works for the current session.
	}
}

/* ---------- compose-panel position persistence ----------
 * All compose modes use the same floating window, so we persist a single
 * position. Reads tolerate a legacy `reply` field from earlier builds
 * by ignoring it. */
const COMPOSE_POSITION_KEY = "wemail.composePanelPositions";

/* ---------- floating AI launcher persistence ----------
 * The floating AI launcher is a global affordance shown when the agent
 * panel is closed. Persist its last dragged position so it stays where
 * the user placed it across reloads.
 */
const AI_LAUNCHER_POSITION_KEY = "wemail.aiLauncherPosition";

export type ComposePositionContext = "new";

export interface ComposePosition {
	x: number;
	y: number;
}

export interface AiLauncherPosition {
	x: number;
	y: number;
}

interface PersistedComposePositions {
	new: ComposePosition | null;
}

function readPersistedComposePositions(): PersistedComposePositions {
	const fallback: PersistedComposePositions = { new: null };
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(COMPOSE_POSITION_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<PersistedComposePositions>;
		const sanitize = (
			p: Partial<ComposePosition> | null | undefined,
		): ComposePosition | null => {
			if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
				return null;
			}
			return { x: p.x, y: p.y };
		};
		return {
			new: sanitize(parsed.new),
		};
	} catch {
		return fallback;
	}
}

function writePersistedComposePositions(state: PersistedComposePositions): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(COMPOSE_POSITION_KEY, JSON.stringify(state));
	} catch {
		// best-effort — runtime state still works
	}
}

function readPersistedAiLauncherPosition(): AiLauncherPosition | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(AI_LAUNCHER_POSITION_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<AiLauncherPosition>;
		if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
			return null;
		}
		return { x: parsed.x, y: parsed.y };
	} catch {
		return null;
	}
}

function writePersistedAiLauncherPosition(position: AiLauncherPosition | null): void {
	if (typeof window === "undefined") return;
	try {
		if (!position) {
			window.localStorage.removeItem(AI_LAUNCHER_POSITION_KEY);
			return;
		}
		window.localStorage.setItem(AI_LAUNCHER_POSITION_KEY, JSON.stringify(position));
	} catch {
		// best-effort — runtime state still works
	}
}

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export type OlderThanFilter = "7d" | "30d" | "180d" | null;

export interface MailFilters {
	unread: boolean;
	toMe: boolean;
	ccMe: boolean;
	hasAttachment: boolean;
	olderThan: OlderThanFilter;
}

const DEFAULT_MAIL_FILTERS: MailFilters = {
	unread: false,
	toMe: false,
	ccMe: false,
	hasAttachment: false,
	olderThan: null,
};

export function createDefaultMailFilters(): MailFilters {
	return { ...DEFAULT_MAIL_FILTERS };
}

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
	/**
	 * Optional override for the composer body. Used by Quick Reply chips
	 * (upstream F2) so clicking a variant injects its text into the editor
	 * instead of the default empty/quoted reply skeleton. Markdown text
	 * is wrapped in `<p>…</p>` blocks before being applied.
	 */
	prefilledBody?: string;
	/** Optional recipients used when another workspace opens a new message. */
	prefilledTo?: string;
}

export type SettingsSection =
	| "account"
	| "ai"
	| "model"
	| "mcp"
	/** Legacy values remain accepted so existing callers can migrate safely. */
	| "mail"
	| "notifications"
	| "appearance"
	| "connections"
	| "skills"
	| "about"
	| "advanced";

function normalizeSettingsSection(section: SettingsSection): SettingsSection {
	return section === "mail" || section === "notifications" || section === "appearance"
		? "advanced"
		: section;
}

interface UIState {
	// Side panel state
	selectedEmailId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	selectEmail: (id: string | null) => void;
	clearSelectedEmail: () => void;
	startCompose: (options?: ComposeOptions) => void;
	closePanel: () => void;
	closeCompose: () => void;

	// Compose options
	composeOptions: ComposeOptions;

	// Mobile sidebar
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Agent panel
	isAgentPanelOpen: boolean;
	toggleAgentPanel: () => void;
	isAgentPanelExpanded: boolean;
	toggleAgentPanelExpanded: () => void;
	/** Runtime-only navigation mode for the active agent conversation. */
	agentSessionMode: AgentSessionMode;
	/** Non-null session id consumed directly by AgentPanel. */
	agentSessionId: string;
	startFreshAgentConversation: () => void;
	agentComposerRequest?: {
		id: number;
		text: string;
		agentContext?: MailSceneActionContext;
	};
	requestAgentComposerInput: (
		text: string,
		agentContext?: MailSceneActionContext,
	) => void;
	openEmailAgentConversation: (emailId: string) => void;
	resumeAgentConversation: (conversationId: string) => void;
	/**
	 * Monotonically increasing tick that signals "clear the active chat
	 * surface". The AgentChatConnected hook subscribes via useEffect and
	 * resets its local message list whenever this counter changes. The
	 * current sessionId is rotated at the same time so the next message
	 * starts a brand-new server-side conversation.
	 */
	agentClearTick: number;
	clearAgentConversation: () => void;
	aiLauncherPosition: AiLauncherPosition | null;
	setAiLauncherPosition: (position: AiLauncherPosition) => void;

	// Settings dialog
	isSettingsOpen: boolean;
	settingsSection: SettingsSection;
	settingsConnectionDetail: "wecli" | "feishu" | "wecom";
	openSettings: (
		section?: SettingsSection,
		connectionDetail?: "wecli" | "feishu" | "wecom",
	) => void;
	closeSettings: () => void;
	setSettingsSection: (section: SettingsSection) => void;

	// Command palette (⌘+K)
	isCommandPaletteOpen: boolean;
	openCommandPalette: () => void;
	closeCommandPalette: () => void;
	toggleCommandPalette: () => void;

	// Simplified "create smart tag" dialog (Feature 4). Triggered from
	// the sidebar's "创建智能标签" entry and from the "+" button inside
	// the Smart Tag Picker popover (Feature 3).
	isCreateTagDialogOpen: boolean;
	openCreateTagDialog: () => void;
	closeCreateTagDialog: () => void;

	// Mail-list filter popover state (Feature 2). Booleans are
	// AND-combined; `olderThan` is mutually exclusive across the date
	// presets and combines additionally with the booleans. Filters
	// reset whenever the active mailbox or directory view changes.
	mailFilters: MailFilters;
	mailFilterScope: string | null;
	setMailFilterScope: (scope: string) => void;
	setMailFilter: <K extends keyof MailFilters>(key: K, value: MailFilters[K]) => void;
	clearMailFilters: () => void;

	/**
	 * Snoozed / Scheduled email IDs. UI-only state until durable storage
	 * exists. The number is the unix-ms timestamp the email is snoozed
	 * until (snooze) or scheduled to send at (scheduled). Cleared on
	 * reload — empty states surface this honestly.
	 */
	snoozedIds: Map<string, number>;
	scheduledIds: Map<string, number>;
	starredIds: Set<string>;
	snoozeEmail: (id: string, untilMs: number) => void;
	unsnoozeEmail: (id: string) => void;
	scheduleEmail: (id: string, atMs: number) => void;
	unscheduleEmail: (id: string) => void;
	toggleStar: (id: string, next: boolean) => void;

	// Legacy dialog support (kept for non-split views)
	isComposeModalOpen: boolean;
	openComposeModal: (options?: ComposeOptions) => void;
	closeComposeModal: () => void;

	// Smart-draft panel: docked (in EmailPanel bottom slot) vs floating
	// (portaled to document.body at draftPanelPosition).
	draftPanelMode: DraftPanelMode;
	draftPanelPosition: DraftPanelPosition;
	setDraftPanelDocked: () => void;
	setDraftPanelFloating: (x: number, y: number) => void;
	moveDraftPanel: (x: number, y: number) => void;

	/**
	 * Persisted compose-window position for new-mail compose. `null`
 * means "no user-set position yet" — the panel falls back to the
 * default (middle-bottom of the viewport) on first open and remembers
 * the user's drag for next time.
	 */
	composePositions: PersistedComposePositions;
	setComposePosition: (
		context: ComposePositionContext,
		position: ComposePosition,
	) => void;
}

const persistedDraftPanel = readPersistedDraftPanel();
const persistedComposePositions = readPersistedComposePositions();
const persistedAiLauncherPosition = readPersistedAiLauncherPosition();
const initialAgentSession = createFreshHomeAgentSession();

export const useUIStore = create<UIState>((set, get) => ({
	selectedEmailId: null,
	isComposing: false,
	_previousEmailId: null,
	composeOptions: { mode: "new", originalEmail: null },
	isComposeModalOpen: false,
	isSidebarOpen: false,
	isAgentPanelOpen: true,
	isAgentPanelExpanded: false,
	agentSessionMode: initialAgentSession.agentSessionMode,
	agentSessionId: initialAgentSession.agentSessionId,
	agentComposerRequest: undefined,
	agentClearTick: 0,
	aiLauncherPosition: persistedAiLauncherPosition,
	isSettingsOpen: false,
	settingsSection: "account",
	// P2.5: the open edition has no WeCLI connection entry.
	settingsConnectionDetail: "feishu",
	isCommandPaletteOpen: false,
	isCreateTagDialogOpen: false,
	mailFilters: createDefaultMailFilters(),
	mailFilterScope: null,
	snoozedIds: new Map(),
	scheduledIds: new Map(),
	starredIds: new Set(),
	draftPanelMode: persistedDraftPanel.mode,
	draftPanelPosition: persistedDraftPanel.position,
	composePositions: persistedComposePositions,

	selectEmail: (id) =>
		set((state) => {
			if (state.selectedEmailId === id && !state.isComposing) return state;
			return {
				selectedEmailId: id,
				isComposing: false,
			};
		}),
	clearSelectedEmail: () =>
		set((state) => {
			if (state.selectedEmailId === null && state._previousEmailId === null) return state;
			return {
				selectedEmailId: null,
				_previousEmailId: null,
			};
		}),

	startCompose: (options) =>
		set((state) => {
			const mode = options?.mode || "new";
			const isReplyOrForward = mode === "reply" || mode === "reply-all" || mode === "forward";
			return {
				isComposing: true,
				_previousEmailId: state.selectedEmailId,
				// Keep selectedEmailId when replying/forwarding so the thread stays visible
				selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
				composeOptions: options || { mode: "new", originalEmail: null },
				isSidebarOpen: false,
			};
		}),

	closePanel: () =>
		set((state) => {
			if (
				state.selectedEmailId === null &&
				!state.isComposing &&
				state._previousEmailId === null &&
				state.composeOptions.mode === "new" &&
				state.composeOptions.originalEmail === null
			) return state;
			return {
				selectedEmailId: null,
				isComposing: false,
				_previousEmailId: null,
				composeOptions: { mode: "new" as const, originalEmail: null },
			};
		}),

	closeCompose: () =>
		set((state) => {
			const restoredEmailId = state._previousEmailId;
			return {
				isComposing: false,
				selectedEmailId: restoredEmailId,
				_previousEmailId: null,
				composeOptions: { mode: "new" as const, originalEmail: null },
			};
		}),

	openSidebar: () => set((state) => state.isSidebarOpen ? state : { isSidebarOpen: true }),
	closeSidebar: () => set((state) => state.isSidebarOpen ? { isSidebarOpen: false } : state),
	toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

	toggleAgentPanel: () => set({ isAgentPanelOpen: !get().isAgentPanelOpen }),
	toggleAgentPanelExpanded: () =>
		set({ isAgentPanelExpanded: !get().isAgentPanelExpanded }),
	startFreshAgentConversation: () => set(createFreshHomeAgentSession()),
	requestAgentComposerInput: (text, agentContext) =>
		set((state) => ({
			agentComposerRequest: {
				id: (state.agentComposerRequest?.id ?? 0) + 1,
				text,
				...(agentContext ? { agentContext } : {}),
			},
		})),
	openEmailAgentConversation: (emailId) =>
		set((state) => {
			if (state.agentSessionMode === "email-trace" && state.agentSessionId === emailId) {
				return state;
			}
			return openEmailAgentSession(emailId);
		}),
	resumeAgentConversation: (conversationId) =>
		set(resumeAgentSession(conversationId)),
	clearAgentConversation: () =>
		set((state) => ({
			agentClearTick: state.agentClearTick + 1,
			...createFreshHomeAgentSession(),
		})),
	setAiLauncherPosition: (position) => {
		const current = get().aiLauncherPosition;
		if (current?.x === position.x && current.y === position.y) return;
		writePersistedAiLauncherPosition(position);
		set({ aiLauncherPosition: position });
	},

	openSettings: (section, connectionDetail) =>
		set((state) => {
			const nextSection = normalizeSettingsSection(section ?? state.settingsSection);
			const nextDetail = connectionDetail ?? state.settingsConnectionDetail;
			if (
				state.isSettingsOpen &&
				state.settingsSection === nextSection &&
				state.settingsConnectionDetail === nextDetail
			) return state;
			return {
				isSettingsOpen: true,
				settingsSection: nextSection,
				settingsConnectionDetail: nextDetail,
			};
		}),
	closeSettings: () => set((state) => state.isSettingsOpen ? { isSettingsOpen: false } : state),
	setSettingsSection: (section) =>
		set((state) => {
			const nextSection = normalizeSettingsSection(section);
			return state.settingsSection === nextSection ? state : { settingsSection: nextSection };
		}),

	openCommandPalette: () =>
		set((state) => state.isCommandPaletteOpen ? state : { isCommandPaletteOpen: true }),
	closeCommandPalette: () =>
		set((state) => state.isCommandPaletteOpen ? { isCommandPaletteOpen: false } : state),
	toggleCommandPalette: () =>
		set({ isCommandPaletteOpen: !get().isCommandPaletteOpen }),

	openCreateTagDialog: () =>
		set((state) => state.isCreateTagDialogOpen ? state : { isCreateTagDialogOpen: true }),
	closeCreateTagDialog: () =>
		set((state) => state.isCreateTagDialogOpen ? { isCreateTagDialogOpen: false } : state),

	setMailFilter: (key, value) =>
		set((state) => state.mailFilters[key] === value ? state : ({
			mailFilters: { ...state.mailFilters, [key]: value },
		})),
	setMailFilterScope: (scope) =>
		set((state) => state.mailFilterScope === scope ? state : ({
			mailFilterScope: scope,
			mailFilters: createDefaultMailFilters(),
		})),
	clearMailFilters: () => set({ mailFilters: createDefaultMailFilters() }),

	snoozeEmail: (id, untilMs) =>
		set((state) => {
			const next = new Map(state.snoozedIds);
			next.set(id, untilMs);
			return { snoozedIds: next };
		}),
	unsnoozeEmail: (id) =>
		set((state) => {
			const next = new Map(state.snoozedIds);
			next.delete(id);
			return { snoozedIds: next };
		}),
	scheduleEmail: (id, atMs) =>
		set((state) => {
			const next = new Map(state.scheduledIds);
			next.set(id, atMs);
			return { scheduledIds: next };
		}),
	unscheduleEmail: (id) =>
		set((state) => {
			const next = new Map(state.scheduledIds);
			next.delete(id);
			return { scheduledIds: next };
		}),
	toggleStar: (id, next) =>
		set((state) => {
			const copy = new Set(state.starredIds);
			if (next) copy.add(id);
			else copy.delete(id);
			return { starredIds: copy };
		}),

	openComposeModal: (options) =>
		set({
			composeOptions: options || { mode: "new", originalEmail: null },
			isComposeModalOpen: true,
		}),

	closeComposeModal: () =>
		set({
			isComposeModalOpen: false,
			composeOptions: { mode: "new", originalEmail: null },
		}),

	setDraftPanelDocked: () => {
		writePersistedDraftPanel({
			mode: "docked",
			position: get().draftPanelPosition,
		});
		set({ draftPanelMode: "docked" });
	},
	setDraftPanelFloating: (x, y) => {
		const position = { x, y };
		writePersistedDraftPanel({ mode: "floating", position });
		set({ draftPanelMode: "floating", draftPanelPosition: position });
	},
	moveDraftPanel: (x, y) => {
		const position = { x, y };
		writePersistedDraftPanel({
			mode: get().draftPanelMode,
			position,
		});
		set({ draftPanelPosition: position });
	},

	setComposePosition: (context, position) => {
		const next = { ...get().composePositions, [context]: position };
		writePersistedComposePositions(next);
		set({ composePositions: next });
	},
}));
