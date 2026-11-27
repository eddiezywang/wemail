// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared workbench helpers used by the `inbox` / `folder` / `message`
 * routes. The chrome is now the responsive 4-column `Workbench` grid
 * (nav · list · detail · agent) from `~/components/layout/Workbench`.
 *
 * `WorkbenchShell` handles the cross-cutting concerns (login gate,
 * Header, agent panel mounting, Compose dialog). Routes provide the
 * `list` and `detail` slot contents — usually `MessageListView` and
 * `MessageDetailView` from this file.
 */

import { hasPendingMailReceiptTrace, recordMailReceiptPaint } from "~/lib/mailReceiptTrace";
import { useAccountSignaturePreference } from "~/hooks/useAccountSignaturePreferences";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArticleIcon } from "@phosphor-icons/react/Article";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { UserIcon } from "@phosphor-icons/react/User";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { FunnelSimpleIcon } from "@phosphor-icons/react/FunnelSimple";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { StarIcon } from "@phosphor-icons/react/Star";
import { TrayIcon } from "@phosphor-icons/react/Tray";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { XIcon } from "@phosphor-icons/react/X";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Suspense,
	lazy,
	type ReactNode,
	type UIEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { Folders, getFolderDisplayName, logicalMailKey } from "shared/folders";
import { formatListDate } from "shared/dates";
import { hasDownloadableAttachments } from "shared/wemail/mail";
import { useMailFilters } from "~/hooks/useMailFilters";
import { beginMailOpenTrace, markMailOpenStage } from "~/lib/mailOpenTrace";
import { toast } from "sonner";
import CommandPaletteRegistrar from "~/components/CommandPaletteRegistrar";
import FloatingAiLauncher from "~/components/FloatingAiLauncher";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { Workbench } from "~/components/layout/Workbench";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { useJobStore } from "~/hooks/useJobStore";
import { zhCN } from "~/copy/zh-CN";
import { cn } from "~/lib/cn";
import { PopNumber } from "~/components/ui/pop-number";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import EmptyState from "~/components/wemail/EmptyState";
import { MailItem, type MailItemTag } from "~/components/wemail/MailItem";
import MailContextMenu from "~/components/wemail/MailContextMenu";
import MailFilterPopover, { MailFilterChips } from "~/components/wemail/MailFilterPopover";
import { useUIStore } from "~/hooks/useUIStore";
import { usePerformanceWatchdog } from "~/hooks/usePerformanceWatchdog";
import { RenderTrace, markAction } from "~/components/dev/RenderTrace";
import { parseSearchQuery } from "~/lib/search-parser";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import { mailCategoryLabel } from "~/lib/mail-categories";
import { getSnippetText } from "~/lib/utils";
import { getUserFacingError, isCredentialError } from "~/lib/user-facing-error";
import { markAllMailRead } from "~/lib/markAllMailRead";
import { folderRole } from "~/lib/folderRole";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useLlmStatus } from "~/queries/llmSettings";
import { queryKeys } from "~/queries/keys";
import { releaseAutoRead, requestAutoRead, scheduleIdleTask, useDeleteEmail, useMoveEmail, useUpdateEmail } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useListCategories, type ListCategory } from "~/queries/listCategories";
import api from "~/services/api";
import { ApiError } from "~/services/api";
import {
	dispatchMailAuthRequired,
	isMailCredentialInvalidBody,
} from "~/lib/mailCredentialEvents";
import type { Email } from "~/types";
import type { UseQueryResult } from "@tanstack/react-query";

const AgentSidebar = lazy(() => import("~/components/AgentSidebar"));
const EmailPanel = lazy(() => import("~/components/EmailPanel"));
const CommandPalette = lazy(() => import("~/components/CommandPalette"));
const ComposeEmail = lazy(() => import("~/components/ComposeEmail"));
const ComposePanel = lazy(() => import("~/components/ComposePanel"));
const loadSettingsDialog = () => import("~/components/settings/SettingsDialog");
const SettingsDialog = lazy(loadSettingsDialog);
const ComposeStyleManagerDialog = lazy(() =>
	import("~/components/compose/ComposeStyleManagerDialog").then((module) => ({
		default: module.ComposeStyleManagerDialog,
	})),
);

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
	unreadCount?: number;
}

type MailListQueryResult = UseQueryResult<EmailListResponse> & {
	hasNextPage?: boolean;
	isFetchingNextPage?: boolean;
	isFetchNextPageError?: boolean;
	fetchNextPage?: () => unknown;
	refreshLatestPage?: () => Promise<unknown>;
};

export function isMessageDetailPath(pathname: string): boolean {
	return /^\/message\/[^/]+\/?$/.test(pathname);
}

/**
 * Route components each mount their own WorkbenchShell. Clear a stale
 * message selection when entering another product context so its main
 * workspace receives the full content width. Explicit message deep
 * links are exempt because their route is responsible for selecting
 * and displaying the requested message.
 */
export function RouteEmailSelectionReset() {
	const location = useLocation();
	const clearSelectedEmail = useUIStore((state) => state.clearSelectedEmail);

	useLayoutEffect(() => {
		if (
			!isMessageDetailPath(location.pathname) &&
			useUIStore.getState().selectedEmailId !== null
		) {
			clearSelectedEmail();
		}
	}, [clearSelectedEmail, location.pathname]);

	return null;
}

/**
 * Auto-opens a contextual agent conversation shortly after an email is
 * selected while the agent panel is open.
 *
 * Isolated into its own component on purpose: it subscribes to the raw
 * `selectedEmailId`, and a mail-row-click flips that id on every click
 * (A→B→C). Were this effect inside `WorkbenchFrame`, every selection
 * change would re-render the heavy `<Workbench>` shell (~350ms/commit).
 * Returning null keeps its own re-renders free, and because React only
 * re-renders the component whose subscription changed, the shell never
 * sees these updates.
 */
function AgentConversationAutoOpener() {
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	const selectedEmailId = useUIStore((state) => state.selectedEmailId);
	const openEmailAgentConversation = useUIStore(
		(state) => state.openEmailAgentConversation,
	);
	useEffect(() => {
		if (!isAgentPanelOpen || !selectedEmailId) return;
		let timer: number | undefined;
		const frame = window.requestAnimationFrame(() => {
			timer = window.setTimeout(() => {
				const state = useUIStore.getState();
				if (state.isAgentPanelOpen && state.selectedEmailId === selectedEmailId) {
					openEmailAgentConversation(selectedEmailId);
				}
			}, 300);
		});
		return () => {
			window.cancelAnimationFrame(frame);
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [isAgentPanelOpen, openEmailAgentConversation, selectedEmailId]);
	return null;
}

function WorkbenchFrame({ list, detail }: { list: ReactNode; detail: ReactNode }) {
	useAccountSignaturePreference(undefined);
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	const isAgentPanelExpanded = useUIStore((state) => state.isAgentPanelExpanded);
	// Boolean selector. Zustand v5 bails out of re-rendering via Object.is on
	// the selected slice, so a mail-row-click A→B (both truthy) no longer
	// re-renders the Workbench shell. Only null↔id transitions flip the value,
	// which is exactly when the detail column mounts/unmounts. The raw id is
	// consumed independently by MessageDetailView (detail content) and by
	// AgentConversationAutoOpener above.
	const hasSelection = useUIStore((state) => state.selectedEmailId !== null);
	const agentWasOpenedRef = useRef(isAgentPanelOpen);
	if (isAgentPanelOpen) agentWasOpenedRef.current = true;

	return (
		<>
			<RenderTrace id="workbench">
				<Workbench
					nav={<Sidebar />}
					list={<RenderTrace id="list">{list}</RenderTrace>}
					detail={<RenderTrace id="detail">{detail}</RenderTrace>}
					agent={agentWasOpenedRef.current ? (
						<RenderTrace id="agent">
							<Suspense
								fallback={
									<div className="h-full bg-paper-2 motion-safe:animate-pulse" role="status" aria-label="正在加载 Agent 面板" />
								}
							>
								<AgentSidebar variant={hasSelection ? "docked" : "floating"} />
							</Suspense>
						</RenderTrace>
					) : null}
					agentOpen={isAgentPanelOpen}
					agentExpanded={isAgentPanelExpanded}
					showDetailColumn={hasSelection}
				/>
			</RenderTrace>
			<AgentConversationAutoOpener />
		</>
	);
}

function WorkspaceOverlays() {
	const isComposing = useUIStore((state) => state.isComposing);
	const isComposeModalOpen = useUIStore((state) => state.isComposeModalOpen);
	const isSettingsOpen = useUIStore((state) => state.isSettingsOpen);
	const isCommandPaletteOpen = useUIStore((state) => state.isCommandPaletteOpen);
	const location = useLocation();
	const styleManagerOpen = new URLSearchParams(location.search).get("compose") === "styles";

	useEffect(() => {
		if (isSettingsOpen) return;
		const idle = window.requestIdleCallback(() => void loadSettingsDialog(), { timeout: 2_000 });
		return () => window.cancelIdleCallback(idle);
	}, [isSettingsOpen]);

	return (
		<>
			<Suspense fallback={null}>
				{isComposing ? <ComposePanel /> : null}
				{isComposeModalOpen ? <ComposeEmail /> : null}
				{styleManagerOpen ? <ComposeStyleManagerDialog /> : null}
			</Suspense>
			<Suspense fallback={isSettingsOpen ? (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" role="status" aria-label="正在打开设置">
					<div className="h-[78vh] max-h-[680px] w-[94vw] max-w-[960px] rounded-xl border border-edge bg-paper-2 shadow-3 motion-safe:animate-pulse" />
				</div>
			) : null}>
				{isSettingsOpen ? <SettingsDialog /> : null}
			</Suspense>
			<Suspense fallback={null}>
				{isCommandPaletteOpen ? <CommandPalette /> : null}
			</Suspense>
		</>
	);
}

/**
 * Workbench chrome: login gate + header + Workbench grid + compose
 * dialog. Routes pass slot content via `list` / `detail`.
 */
export function WorkbenchShell({
	list,
	detail,
}: {
	list: ReactNode;
	detail: ReactNode;
}) {
	usePerformanceWatchdog();
	const { data: currentAccount, isLoading } = useCurrentAccount();

	if (isLoading) {
		return (
			<div
				className="flex h-full items-center justify-center bg-paper-2"
				role="status"
				aria-live="polite"
			>
				<span
					aria-hidden="true"
					className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent text-ink-3 motion-reduce:animate-none"
				/>
				<span className="sr-only">正在加载工作区</span>
			</div>
		);
	}

	if (!currentAccount?.account) {
		return <Navigate to="/onboarding" replace />;
	}

	return (
		<div className="relative flex h-full flex-col overflow-visible bg-sidebar">
			<RouteEmailSelectionReset />
			<WorkbenchFrame list={list} detail={detail} />
			<Header />
			<FloatingAiLauncher />
			<WorkspaceOverlays />
			{/* Command palette + global shortcuts. The registrar runs the
			    `useGlobalShortcuts` listener and registers the baseline
			    command set; the palette is a Radix dialog driven by the
			    UI store. */}
			<CommandPaletteRegistrar />
		</div>
	);
}

function folderDisplayName(folder: string): string {
	return folder ? getFolderDisplayName(folder) : "邮件";
}

function MessageListSkeleton() {
	// Delayed: under 300ms the list opens with no loader at all. Shapes mirror
	// real rows (compact 48px) so nothing moves when data lands; one 320px
	// band sweeps the whole list at once (`.skeleton-band`).
	const visible = useDelayedFlag(true);
	if (!visible) return null;
	return (
		<div className="relative p-2" role="status" aria-label={zhCN.waits.loadingMailList}>
			<div className="space-y-1">
				{Array.from({ length: 8 }).map((_, i) => (
					<div key={i} className="flex h-12 items-center gap-3 rounded-md px-3">
						<Skeleton className="h-2 w-2 rounded-full" />
						<div className="min-w-0 flex-1 space-y-1.5">
							<div className="flex items-center justify-between gap-3">
								<Skeleton className="h-3 w-28" />
								<Skeleton className="h-3 w-14" />
							</div>
							<Skeleton className="h-3 w-3/4" />
						</div>
					</div>
				))}
			</div>
			<div aria-hidden="true" className="skeleton-band" />
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
	title,
	description,
	showCompose,
}: {
	folder: string;
	onCompose: () => void;
	title?: string;
	description?: string;
	showCompose?: boolean;
}) {
	const shouldShowCompose = showCompose ?? (
		folder === Folders.INBOX ||
		folder === Folders.SENT ||
		folder === Folders.DRAFT
	);
	return (
		<EmptyState
			icon={<TrayIcon size={22} weight="regular" />}
			title={title ?? `${folderDisplayName(folder)} 暂无邮件`}
			description={description ?? "新邮件到达或移动到这里后，会自动显示在列表中。"}
			actions={
				shouldShowCompose
					? [{ label: "写邮件", onClick: onCompose, variant: "secondary" }]
					: []
			}
		/>
	);
}

function senderLabel(email: Email): string {
	if (email.sender) {
		const match = email.sender.match(/^(.+?)\s*</);
		if (match) return match[1].trim();
		return email.sender.split("@")[0];
	}
	return "(unknown)";
}

function invoiceStatusTagForList(_email: Email, allowanceInvoice: boolean): MailItemTag[] | undefined {
	// P2.6 round 8: the invoice badge semantics (labels + state mapping)
	// moved to the edition module's renderer contribution
	// (`internal/src/allowance/renderer/invoice-display.ts`). The open
	// edition keeps only the feature gate and contributes no badge — legacy
	// rows carrying invoice fields render no invoice tag either way. The
	// edition build re-attaches its contributed renderer behind this gate.
	if (!allowanceInvoice) return undefined;
	return undefined;
}

interface DateBucket {
	key: string;
	label: string;
	emails: Email[];
}

/**
 * Groups a date-descending list strictly by calendar month. The month is
 * the user's navigation unit, so a group can be collapsed without changing
 * the server query or losing the list's stable order.
 */
function bucketEmailsByDate(emails: Email[]): DateBucket[] {
	const thisYear = new Date().getFullYear();
	const buckets = new Map<string, DateBucket>();
	for (const email of emails) {
		const parsed = email.date ? new Date(email.date) : null;
		let key: string;
		let label: string;
		if (!parsed || isNaN(parsed.getTime())) {
			key = "unknown";
			label = "未分类";
		} else {
			const month = parsed.getMonth();
			const year = parsed.getFullYear();
			key = `${year}-${month}`;
			const monthLabel = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"][month] ?? `${month + 1}月`;
			label = year === thisYear ? monthLabel : `${year}年 ${monthLabel}`;
		}
		const existing = buckets.get(key);
		if (existing) {
			existing.emails.push(email);
		} else {
			buckets.set(key, { key, label, emails: [email] });
		}
	}
	return Array.from(buckets.values());
}

type VirtualMailRow =
	| { kind: "header"; key: string; bucketKey: string; label: string; count: number; top: number; height: number; collapsed: boolean }
	| { kind: "mail"; key: string; email: Email; top: number; height: number };

const DATE_HEADER_HEIGHT = 44;
const MAIL_ROW_COMPACT_HEIGHT = 48;
const MAIL_ROW_EXPANDED_HEIGHT = 64;

/** Search scope presets surfaced in the list-toolbar search box. */
const SEARCH_SCOPES: Array<{ value: string; label: string; icon: typeof MagnifyingGlassIcon }> = [
	{ value: "all", label: "全部", icon: MagnifyingGlassIcon },
	{ value: "subject", label: "标题", icon: ArticleIcon },
	{ value: "body", label: "正文", icon: FileTextIcon },
	{ value: "address", label: "联系人", icon: UserIcon },
];

function mailRowHeight(detailOpen: boolean): number {
	// The list density follows the detail column as a whole, not the selected
	// row, so opening a message never makes the neighboring rows jump.
	return detailOpen ? MAIL_ROW_EXPANDED_HEIGHT : MAIL_ROW_COMPACT_HEIGHT;
}

function layoutVirtualMailRows(
	emails: Email[],
	collapsedBuckets: ReadonlySet<string>,
	detailOpen: boolean,
) {
	const rows: VirtualMailRow[] = [];
	let top = 0;
	for (const bucket of bucketEmailsByDate(emails)) {
		rows.push({
			kind: "header",
			key: `header:${bucket.key}`,
			bucketKey: bucket.key,
			label: bucket.label,
			count: bucket.emails.length,
			top,
			height: DATE_HEADER_HEIGHT,
			collapsed: collapsedBuckets.has(bucket.key),
		});
		top += DATE_HEADER_HEIGHT;
		if (collapsedBuckets.has(bucket.key)) continue;
		for (const email of bucket.emails) {
			const height = mailRowHeight(detailOpen);
			rows.push({
				kind: "mail",
				key: email.id,
				email,
				top,
				height,
			});
			top += height;
		}
	}
	return { rows, totalHeight: top };
}

/**
 * Folder-aware message list. Reads the {@link EmailListResponse}
 * returned by `useEmails` and renders rows via the wemail `MailItem`
 * primitive. Selection is owned by the UI store so navigating between
 * routes preserves panel state.
 *
 * Inbox category tabs are backend-driven via {@link useListCategories}.
 * Route hosts opt into the strip explicitly; other mail views use their
 * title and sidebar selection as the sole navigation context.
 */
const ALL_CATEGORY: ListCategory = { id: "all", label: "全部" };
export function MessageListView({
	folder,
	query,
	listTitle,
	showCategoryTabs = false,
	hideCategoryTabs = false,
	digestEnabled = true,
	mailSyncEnabled = true,
	markAllReadParams,
	emptyTitle,
	emptyDescription,
	showComposeInEmptyState,
}: {
	folder: string;
	query: MailListQueryResult;
	listTitle?: string;
	showCategoryTabs?: boolean;
	/** @deprecated Route hosts should leave tabs disabled instead. */
	hideCategoryTabs?: boolean;
	digestEnabled?: boolean;
	mailSyncEnabled?: boolean;
	markAllReadParams?: Record<string, string>;
	emptyTitle?: string;
	emptyDescription?: string;
	showComposeInEmptyState?: boolean;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const { allowanceInvoice } = useEditionFeatures();
	const [searchParams] = useSearchParams();
	const selectedEmailId = useUIStore((state) => state.selectedEmailId);
	const selectEmail = useUIStore((state) => state.selectEmail);
	const closePanel = useUIStore((state) => state.closePanel);
	const startCompose = useUIStore((state) => state.startCompose);
	const toggleAgentPanel = useUIStore((state) => state.toggleAgentPanel);
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const llmStatus = useLlmStatus();
	const llmConfigured = llmStatus.data?.configured === true;
	const canUseDigest = digestEnabled && llmConfigured;
	const openSummaryCenter = useCallback(() => navigate("/digests"), [navigate]);
	const pendingNextPageRef = useRef(false);
	const pullDistanceRef = useRef(0);
	const pullRefreshInFlightRef = useRef(false);
	const listScrollRef = useRef<HTMLDivElement | null>(null);
	const [listViewport, setListViewport] = useState({ scrollTop: 0, height: 720 });
	const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(
		() => new Set(),
	);
	useEffect(() => {
		const element = listScrollRef.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const update = () => setListViewport((current) => ({
			...current,
			height: Math.max(1, element.clientHeight),
		}));
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const handleOpenDigestCenter = () => {
			openSummaryCenter();
		};
		window.addEventListener("wemail:open-digest-center", handleOpenDigestCenter);
		return () => {
			window.removeEventListener(
				"wemail:open-digest-center",
				handleOpenDigestCenter,
			);
		};
	}, [openSummaryCenter]);
	const { data: categoriesData = [] } = useListCategories(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const listCategories = useMemo(
		() => [
			...categoriesData
				.filter((category) => category.system && (category.count ?? 0) > 0)
				.map((category) => ({
					...category,
					label: mailCategoryLabel(category.id, category.label),
				})),
			ALL_CATEGORY,
		],
		[categoriesData],
	);
	const urlQuery = searchParams.get("q") ?? "";
	const urlScope = searchParams.get("scope") ?? "all";
	const urlCategory = searchParams.get("category") ?? "all";
	const [searchInput, setSearchInput] = useState(urlQuery);
	const searchComposingRef = useRef(false);
	// Live search: a paused input commits to the URL `?q=` so results
	// filter as you type. Scheduling is ref-based (not effect-based) so an
	// IME composition end — which may not re-render when the final text
	// equals the onChange value — still submits. Enter submits immediately;
	// composing and open-detail views are checked at fire time.
	const liveSearchTimerRef = useRef<number | null>(null);
	// Scope preview: while typing, a dropdown under the bar lists
	// 全部/标题/正文/联系人 with live hit counts for the paused word;
	// picking a row re-runs the search in that scope.
	const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
	const [scopeActiveIndex, setScopeActiveIndex] = useState(() =>
		Math.max(0, SEARCH_SCOPES.findIndex((s) => s.value === urlScope)));
	const [scopePreviewQuery, setScopePreviewQuery] = useState(urlQuery);
	const cancelLiveSearch = () => {
		if (liveSearchTimerRef.current !== null) {
			window.clearTimeout(liveSearchTimerRef.current);
			liveSearchTimerRef.current = null;
		}
	};
	const scheduleLiveSearch = (value: string) => {
		cancelLiveSearch();
		liveSearchTimerRef.current = window.setTimeout(() => {
			liveSearchTimerRef.current = null;
			if (searchComposingRef.current) return;
			if (useUIStore.getState().selectedEmailId !== null) return;
			if (value.trim() === urlQuery) return;
			submitSearch(value);
		}, 400);
	};
	useEffect(() => {
		cancelLiveSearch();
		setSearchInput(urlQuery);
	}, [urlQuery]);
	useEffect(() => cancelLiveSearch, []);
	const highlightTerms = useMemo(() => {
		if (!urlQuery) return [];
		const parsed = parseSearchQuery(urlQuery);
		return Array.from(
			new Set(
				[parsed.query, parsed.from, parsed.to, parsed.subject]
					.filter((value): value is string => !!value)
					.flatMap((value) => value.trim().split(/\s+/))
					.filter(Boolean),
			),
		);
	}, [urlQuery]);

	// Unified search: keyword runs through the URL `?q=` path
	// (useEmails / useSearchEmails upstream); we always fire the semantic
	// endpoint in parallel for non-empty queries and merge any
	// semantic-only matches into the rendered list. Either side failing
	// silently degrades to the other so search never appears broken.
	const semanticEnabled = urlQuery.length > 0;
	const semanticQuery = useQuery({
		queryKey: ["semantic-search", mailboxId, urlQuery],
		queryFn: () =>
			api.semanticSearchMail(urlQuery, { accountId: mailboxId }),
		enabled: semanticEnabled && !!mailboxId,
		staleTime: 30_000,
	});

	useEffect(() => {
		setScopeActiveIndex(Math.max(0, SEARCH_SCOPES.findIndex((s) => s.value === urlScope)));
	}, [urlScope]);
	const submitSearch = (raw: string, scope = urlScope) => {
		cancelLiveSearch();
		const q = raw.trim();
		setScopePreviewQuery(q);
		const shouldStayOnList =
			location.pathname.startsWith("/folder/") ||
			location.pathname.startsWith("/smart-tags/");
		const target = shouldStayOnList ? location.pathname : "/";
		if (!q) {
			navigate(target, { replace: true });
			return;
		}
		const nextParams = new URLSearchParams();
		nextParams.set("q", q);
		if (scope && scope !== "all") nextParams.set("scope", scope);
		navigate(`${target}?${nextParams.toString()}`, { replace: true });
	};
	const changeSearchScope = (next: string) => {
		if (next === urlScope) return;
		const nextParams = new URLSearchParams(searchParams);
		if (next === "all") nextParams.delete("scope");
		else nextParams.set("scope", next);
		const qs = nextParams.toString();
		navigate(qs ? `${location.pathname}?${qs}` : location.pathname, { replace: true });
	};
	const clearSearch = () => {
		cancelLiveSearch();
		setSearchInput("");
		submitSearch("");
	};
	// Rich search empty state → hand the query to the agent instead of
	// leaving the user with nothing.
	const askAgentAboutSearch = () => {
		const store = useUIStore.getState();
		store.requestAgentComposerInput(`帮我在邮箱里找一找：「${urlQuery}」，先告诉我都有哪些相关邮件。`);
		if (!store.isAgentPanelOpen) store.toggleAgentPanel();
	};
	// Inbox classification is URL-backed so selecting a tab re-fetches the
	// same physical inbox folder with an explicit system-category filter.
	const [activeCategory, setActiveCategory] = useState<string>(urlCategory);
	const activeUrlCategory = listCategories.some((category) => category.id === urlCategory)
		? urlCategory
		: "all";
	useEffect(() => {
		if (activeUrlCategory !== activeCategory) {
			setActiveCategory(activeUrlCategory);
		}
	}, [activeUrlCategory, activeCategory]);
	const handleCategoryChange = useCallback((nextCategory: string) => {
		setActiveCategory(nextCategory);
		closePanel();
		const nextParams = new URLSearchParams(searchParams);
		if (nextCategory === "all") {
			nextParams.delete("category");
		} else {
			nextParams.set("category", nextCategory);
			nextParams.delete("tag");
		}
		const qs = nextParams.toString();
		navigate(qs ? `${location.pathname}?${qs}` : location.pathname, {
			replace: true,
		});
	}, [closePanel, location.pathname, navigate, searchParams]);
	// Gliding tab indicator (Kinetics "Tab Pill Glide"): measure the active
	// trigger's offsetLeft/offsetWidth and glide a shared underline to it,
	// instead of toggling per-trigger borders, so switching categories reads
	// as one continuous motion. The first measurement jumps into place (no
	// glide from 0) by suppressing the transition for one style flush.
	const categoryTabRefs = useRef(new Map<string, HTMLButtonElement>());
	const categoryIndicatorRef = useRef<HTMLSpanElement>(null);
	const categoryIndicatorArmedRef = useRef(false);
	const positionCategoryIndicator = useCallback(() => {
		const indicator = categoryIndicatorRef.current;
		if (!indicator) return;
		const active = categoryTabRefs.current.get(activeCategory);
		if (!active) return;
		if (!categoryIndicatorArmedRef.current) {
			indicator.style.transition = "none";
		}
		indicator.style.left = `${active.offsetLeft}px`;
		indicator.style.width = `${active.offsetWidth}px`;
		if (!categoryIndicatorArmedRef.current) {
			void indicator.offsetWidth;
			indicator.style.transition = "";
			categoryIndicatorArmedRef.current = true;
		}
	}, [activeCategory]);
	useEffect(() => {
		positionCategoryIndicator();
	}, [positionCategoryIndicator, listCategories]);
	useEffect(() => {
		const onResize = () => positionCategoryIndicator();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [positionCategoryIndicator]);
	// Local optimistic mirror of starred IDs. The PATCH round-trip
	// invalidates the email list query, after which `e.starred` is the
	// source of truth — but this set keeps the UI feedback instant
	// during the optimistic window and powers the "星标" segment-tab
	// filter for emails not yet round-tripped.
	const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set());
	const starMutationVersionRef = useRef(new Map<string, number>());
	// S7: per-row optimistic failure — inline reason + Retry on the row,
	// plus a 360ms shake; cleared when a later attempt succeeds.
	const [starErrors, setStarErrors] = useState<Map<string, { message: string; onRetry: () => void }>>(() => new Map());
	const [shakeIds, setShakeIds] = useState<Set<string>>(() => new Set());
	const markStarFailed = useCallback((id: string, message: string, onRetry: () => void) => {
		setStarErrors((prev) => new Map(prev).set(id, { message, onRetry }));
		setShakeIds((prev) => new Set(prev).add(id));
		window.setTimeout(() => {
			setShakeIds((prev) => {
				if (!prev.has(id)) return prev;
				const copy = new Set(prev);
				copy.delete(id);
				return copy;
			});
		}, 400);
	}, []);
	const updateEmail = useUpdateEmail();
	const deleteEmail = useDeleteEmail();
	const moveEmail = useMoveEmail();
	const [bulkActionPending, setBulkActionPending] = useState(false);
	const markAllReadLock = useRef(false);
	const markAllReadController = useRef<AbortController | null>(null);
	const upsertJob = useJobStore((state) => state.upsertJob);
	const completeJob = useJobStore((state) => state.completeJob);
	const [markAllReadStopping, setMarkAllReadStopping] = useState(false);
	useEffect(() => () => markAllReadController.current?.abort(), [mailboxId, folder, location.pathname, location.search]);
	const [markAllReadProgress, setMarkAllReadProgress] = useState<string | null>(null);
	const [isSyncing, setIsSyncing] = useState(false);
	const [refreshQueued, setRefreshQueued] = useState(false);
	useEffect(() => { setRefreshQueued(false); }, [mailboxId]);
	const [contextMenu, setContextMenu] = useState<{
		email: Email;
		position: { x: number; y: number };
	} | null>(null);
	const toggleStar = useCallback((id: string, next: boolean) => {
		if (!mailboxId) return;
		const mutationVersion = (starMutationVersionRef.current.get(id) ?? 0) + 1;
		starMutationVersionRef.current.set(id, mutationVersion);
		// A new attempt (user click or row Retry) starts clean: drop the
		// previous failure strip immediately so the retry never races its
		// own success callback (S7).
		setStarErrors((prev) => {
			if (!prev.has(id)) return prev;
			const copy = new Map(prev);
			copy.delete(id);
			return copy;
		});
		setStarredIds((prev) => {
			const copy = new Set(prev);
			if (next) copy.add(id);
			else copy.delete(id);
			return copy;
		});
		updateEmail.mutate(
			{
				mailboxId,
				id,
				data: { starred: next },
			},
			{
				onSuccess: () => {
					setStarErrors((prev) => {
						if (!prev.has(id)) return prev;
						const copy = new Map(prev);
						copy.delete(id);
						return copy;
					});
				},
				onError: (error) => {
					if (starMutationVersionRef.current.get(id) !== mutationVersion) return;
					setStarredIds((prev) => {
						const copy = new Set(prev);
						if (next) copy.delete(id);
						else copy.add(id);
						return copy;
					});
					toast.error(getUserFacingError(error, "星标状态未能保存，请重试。"));
					markStarFailed(id, getUserFacingError(error, "星标状态未能保存"), () => {
						toggleStarRef.current(id, next);
					});
				},
			},
		);
	}, [mailboxId, updateEmail, markStarFailed]);
	// Late-bound self reference so the row's Retry can re-run the toggle
	// without a dependency cycle between toggleStar and its error handlers.
	const toggleStarRef = useRef<(id: string, next: boolean) => void>(() => {});
	useEffect(() => {
		toggleStarRef.current = toggleStar;
	}, [toggleStar]);

	const isRefreshing = isSyncing;
	const baseEmails = query.data?.emails ?? [];
	// Merge keyword (spine) + semantic-only matches. Prefer full email
	// envelopes from the detail cache, but keep uncached semantic hits as
	// minimal rows so the search endpoint never returns invisible matches.
	const mergedEmails = useMemo(() => {
		if (!urlQuery) return baseEmails;
		const semanticIds = semanticQuery.data?.results ?? [];
		if (semanticIds.length === 0 || !mailboxId) return baseEmails;
		const seen = new Set(baseEmails.map((email) => logicalMailKey({
			id: email.id,
			messageId: email.message_id,
		})));
		const extras: Email[] = [];
		for (const r of semanticIds) {
			const key = logicalMailKey({ id: r.email.id, messageId: r.email.message_id });
			if (seen.has(key)) continue;
			seen.add(key);
			extras.push(r.email);
		}
		return extras.length === 0 ? baseEmails : [...baseEmails, ...extras];
	}, [urlQuery, baseEmails, semanticQuery.data, mailboxId, queryClient]);
	// Apply the active segment-tab filter. "全部" is identity; "星标"
	// keeps only emails the user has flagged (server-persisted via
	// `flagged`, optimistically mirrored in `starredIds` for the
	// instant-feedback window). Smart-tag categories are filtered by the
	// route-level email query via the URL `category` parameter.
	const emails = useMemo(() => {
		return mergedEmails;
	}, [mergedEmails]);
	const emailsRef = useRef(emails);
	emailsRef.current = emails;
	const handleContextMenu = useCallback(
		(id: string, event: React.MouseEvent<HTMLDivElement>) => {
			const target = emailsRef.current.find((email) => email.id === id);
			if (!target) return;
			setContextMenu({
				email: target,
				position: { x: event.clientX, y: event.clientY },
			});
		},
		[],
	);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		const visibleIds = new Set(emails.map((email) => email.id));
		setSelectedIds((current) => {
			const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [emails]);
	const toggleSelected = useCallback((id: string, next: boolean) => {
		setSelectedIds((current) => {
			const selected = new Set(current);
			if (next) selected.add(id);
			else selected.delete(id);
			return selected;
		});
	}, []);
	const selectAllVisible = useCallback(() => {
		setSelectedIds(new Set(emails.map((email) => email.id)));
	}, [emails]);
	const clearSelected = useCallback(() => setSelectedIds(new Set()), []);
	const toggleBucket = useCallback((key: string) => {
		setCollapsedBuckets((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const handleSelectEmail = useCallback(
		(id: string) => {
			const snapshot = emailsRef.current.find((email) => email.id === id);
			markAction("mail-row-click");
			const traceId = beginMailOpenTrace(id, true);
			if (mailboxId && snapshot) {
				const detailKey = queryKeys.emails.detail(mailboxId, id);
				queryClient.setQueryData(
					detailKey,
					(current: Email | undefined) => current ?? { ...snapshot, bodyPending: true },
					// A list summary is only a first-paint placeholder. Mark it stale so
					// the detail query cannot mistake it for a freshly loaded message.
					{ updatedAt: 0 },
				);
				void queryClient.prefetchQuery({
					queryKey: detailKey,
					queryFn: async ({ signal }) => {
						markMailOpenStage(id, "local-query-start", traceId);
						const email = await api.getEmail(mailboxId, id, { signal, traceId }) as Email;
						markMailOpenStage(id, "metadata-ready", traceId);
						return email;
					},
					staleTime: 30_000,
				});
			}
			// The detail column must mount in the same input turn. Deferring the
			// canonical selection to requestAnimationFrame left the optimistic row
			// highlighted while the detail query never mounted on affected systems.
			useUIStore.setState({ selectedEmailId: id, isComposing: false });
		},
		[mailboxId, queryClient],
	);
	const totalEmailCount = query.data?.totalCount ?? baseEmails.length;
	const currentFolderSummary = useMemo(
		() =>
			folders.find(
				(item) => item.id.toLowerCase() === (folder || Folders.INBOX).toLowerCase(),
			),
		[folders, folder],
	);
	const currentFolderUnreadCount = currentFolderSummary?.unreadCount ?? 0;
	const currentViewUnreadCount =
		query.data?.unreadCount ?? currentFolderUnreadCount;

	useEffect(() => {
		if (!query.isFetchingNextPage) {
			pendingNextPageRef.current = false;
		}
	}, [query.isFetchingNextPage, query.data?.emails.length]);
	const handleListScroll = useCallback(
		(event: UIEvent<HTMLDivElement>) => {
			setListViewport({
				scrollTop: event.currentTarget.scrollTop,
				height: Math.max(1, event.currentTarget.clientHeight),
			});
			if (
				!query.hasNextPage ||
				query.isFetchingNextPage ||
				pendingNextPageRef.current
			) {
				return;
			}
			const el = event.currentTarget;
			const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			if (distanceToBottom <= 240) {
				pendingNextPageRef.current = true;
				void query.fetchNextPage?.();
			}
		},
		[query],
	);
	const handleListWheel = useCallback(
		(event: React.WheelEvent<HTMLDivElement>) => {
			const element = event.currentTarget;
			if (element.scrollTop > 0 || event.deltaY >= 0 || pullRefreshInFlightRef.current) {
				pullDistanceRef.current = 0;
				return;
			}
			pullDistanceRef.current += Math.abs(event.deltaY);
			if (pullDistanceRef.current < 64 || !query.refetch) return;
			pullDistanceRef.current = 0;
			pullRefreshInFlightRef.current = true;
			const oldScrollTop = element.scrollTop;
			const oldScrollHeight = element.scrollHeight;
			void (query.refreshLatestPage?.() ?? query.refetch()).finally(() => {
				requestAnimationFrame(() => {
					const newScrollHeight = element.scrollHeight;
					element.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
					pullRefreshInFlightRef.current = false;
				});
			});
		},
		[query],
	);
	const pullStartYRef = useRef<number | null>(null);
	const handleListPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (event.currentTarget.scrollTop === 0 && event.isPrimary) {
			pullStartYRef.current = event.clientY;
		}
	}, []);
	const handleListPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const start = pullStartYRef.current;
		pullStartYRef.current = null;
		if (start === null || event.currentTarget.scrollTop !== 0 || pullRefreshInFlightRef.current) return;
		if (event.clientY - start < 64 || !query.refreshLatestPage) return;
		const element = event.currentTarget;
		const oldScrollTop = element.scrollTop;
		const oldScrollHeight = element.scrollHeight;
		pullRefreshInFlightRef.current = true;
		void query.refreshLatestPage().finally(() => {
			requestAnimationFrame(() => {
				element.scrollTop = oldScrollTop + (element.scrollHeight - oldScrollHeight);
				pullRefreshInFlightRef.current = false;
			});
		});
	}, [query]);
	const virtualMailLayout = useMemo(
		() => layoutVirtualMailRows(emails, collapsedBuckets, selectedEmailId !== null),
		[emails, collapsedBuckets, selectedEmailId],
	);
	const visibleVirtualRows = useMemo(() => {
		const overscan = 240;
		const start = Math.max(0, listViewport.scrollTop - overscan);
		const end = listViewport.scrollTop + listViewport.height + overscan;
		return virtualMailLayout.rows.filter(
			(row) => row.top + row.height >= start && row.top <= end,
		);
	}, [listViewport, virtualMailLayout]);
	useEffect(() => {
		if (!mailboxId || !query.dataUpdatedAt || !hasPendingMailReceiptTrace(mailboxId)) return;
		const ids = visibleVirtualRows.filter((row) => row.kind === "mail" &&
			row.top + row.height > listViewport.scrollTop && row.top < listViewport.scrollTop + listViewport.height,
		).flatMap((row) => row.kind === "mail" ? [row.email.id] : []);
		let secondFrame = 0;
		const frame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => recordMailReceiptPaint(mailboxId, ids, query.dataUpdatedAt));
		});
		return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); };
	}, [mailboxId, visibleVirtualRows, listViewport, query.dataUpdatedAt]);

	// First paint after the skeleton (S3): rows fade in 200ms, 40ms apart,
	// capped to the first screenful so scrolling never re-triggers it.
	const [firstPaintRows, setFirstPaintRows] = useState(0);
	const wasSkeletonRef = useRef(false);
	useEffect(() => {
		if (query.isLoading && emails.length === 0) {
			wasSkeletonRef.current = true;
			return;
		}
		if (wasSkeletonRef.current && emails.length > 0) {
			wasSkeletonRef.current = false;
			setFirstPaintRows(12);
			const timer = window.setTimeout(() => setFirstPaintRows(0), 900);
			return () => window.clearTimeout(timer);
		}
	}, [query.isLoading, emails.length]);

	const autoReadAttemptedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!mailboxId || !selectedEmailId) return;
		if (autoReadAttemptedRef.current === selectedEmailId) return;
		const selectedEmail = emails.find((email) => email.id === selectedEmailId);
		if (!selectedEmail || selectedEmail.read !== false) return;
		// Defer the read write to idle so its db-event (which invalidates the
		// detail query -> refetch -> isFetching toggle -> re-renders) lands
		// after the body paints. requestAutoRead dedupes against the detail
		// panel so only one write ever fires; the lock is taken inside the
		// deferred task so a cancelled schedule holds nothing.
		const cancel = scheduleIdleTask(() => {
			if (!requestAutoRead(mailboxId, selectedEmail.id)) return;
			autoReadAttemptedRef.current = selectedEmail.id;
			updateEmail.mutate(
				{
					mailboxId,
					id: selectedEmail.id,
					data: { read: true },
				},
				{
					onError: () => releaseAutoRead(mailboxId, selectedEmail.id),
					onSettled: () => releaseAutoRead(mailboxId, selectedEmail.id),
				},
			);
		});
		return cancel;
	}, [mailboxId, selectedEmailId, emails, updateEmail]);

	useEffect(() => {
		const selectAdjacentEmail = (direction: "next" | "previous") => {
			if (emails.length === 0) return;
			const currentId = useUIStore.getState().selectedEmailId;
			const currentIndex = currentId
				? emails.findIndex((email) => email.id === currentId)
				: -1;
			const nextIndex =
				currentIndex === -1
					? direction === "next"
						? 0
						: emails.length - 1
					: Math.min(
							emails.length - 1,
							Math.max(0, currentIndex + (direction === "next" ? 1 : -1)),
						);
			const nextId = emails[nextIndex]?.id;
			if (nextId && nextId !== currentId) {
				selectEmail(nextId);
			}
		};
		const handleNext = () => selectAdjacentEmail("next");
		const handlePrevious = () => selectAdjacentEmail("previous");
		window.addEventListener("wemail:nav-next", handleNext);
		window.addEventListener("wemail:nav-prev", handlePrevious);
		return () => {
			window.removeEventListener("wemail:nav-next", handleNext);
			window.removeEventListener("wemail:nav-prev", handlePrevious);
		};
	}, [emails, selectEmail]);

	// Reset selection when folder changes so we don't show a stale email
	// that doesn't belong to the current folder.
	const prevFolderRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (prevFolderRef.current && prevFolderRef.current !== folder) {
			closePanel();
		}
		prevFolderRef.current = folder;
	}, [folder, closePanel]);

	const isEmailStarred = useCallback(
		(email: Email) => email.starred === true || starredIds.has(email.id),
		[starredIds],
	);
	// Archive requires a physical archive folder on the provider; hide the
	// action for mailboxes that have none (mirrors EmailPanel's gating).
	const canArchive = folders.some((folder) => folderRole(folder.id) === "archive");
	const quickArchive = useCallback((id: string) => {
		if (!mailboxId) return;
		moveEmail.mutate(
			{ mailboxId, id, folder: Folders.ARCHIVE },
			{
				onSuccess: () => {
					toast.success("已归档");
					if (useUIStore.getState().selectedEmailId === id) closePanel();
				},
				onError: (error) => toast.error(getUserFacingError(error, "归档失败，请稍后重试。")),
			},
		);
	}, [closePanel, mailboxId, moveEmail]);
	const quickDelete = useCallback((id: string) => {
		if (!mailboxId) return;
		deleteEmail.mutate(
			{ mailboxId, id },
			{
				onSuccess: () => {
					toast.success("已移到回收站");
					if (useUIStore.getState().selectedEmailId === id) closePanel();
				},
				onError: (error) => toast.error(getUserFacingError(error, "移动失败，请稍后重试。")),
			},
		);
	}, [closePanel, deleteEmail, mailboxId]);
	const quickToggleRead = useCallback((id: string, next: boolean) => {
		if (!mailboxId) return;
		updateEmail.mutate({ mailboxId, id, data: { read: next } });
	}, [mailboxId, updateEmail]);
	const quickMarkSpam = useCallback((id: string) => {
		if (!mailboxId) return;
		moveEmail.mutate(
			{ mailboxId, id, folder: Folders.SPAM },
			{
				onSuccess: () => {
					toast.success("已移到垃圾邮件");
					if (useUIStore.getState().selectedEmailId === id) closePanel();
				},
				onError: (error) => toast.error(getUserFacingError(error, "标记垃圾邮件失败，请稍后重试。")),
			},
		);
	}, [closePanel, mailboxId, moveEmail]);
	const openContextCompose = useCallback(
		async (mode: "reply" | "reply-all" | "forward") => {
			const target = contextMenu?.email;
			if (!target) return;
			setContextMenu(null);
			let original = target;
			if (
				mailboxId &&
				!target.body?.trim() &&
				!target.bodyHtml?.trim() &&
				!target.bodyText?.trim()
			) {
				try {
					original = await queryClient.fetchQuery({
						queryKey: queryKeys.emails.detail(mailboxId, target.id),
						queryFn: () => api.getEmail(mailboxId, target.id) as Promise<Email>,
						staleTime: 30_000,
					});
				} catch {
					// The list envelope still has enough metadata to open a reply.
				}
			}
			startCompose({ mode, originalEmail: original });
		},
		[contextMenu, mailboxId, queryClient, startCompose],
	);
	const runBulkAction = useCallback(
		async (action: "read" | "unread" | "archive" | "trash" | "star") => {
			if (!mailboxId || selectedIds.size === 0 || bulkActionPending) return;
			setBulkActionPending(true);
			const ids = Array.from(selectedIds);
			try {
				if (action === "read" || action === "unread") {
					await Promise.all(
						ids.map((id) =>
							updateEmail.mutateAsync({
								mailboxId,
								id,
								data: { read: action === "read" },
							}),
						),
					);
				} else if (action === "star") {
					await Promise.all(
						ids.map((id) =>
							updateEmail.mutateAsync({
								mailboxId,
								id,
								data: { starred: true },
							}),
						),
					);
				} else if (action === "archive") {
					await Promise.all(
						ids.map((id) =>
							moveEmail.mutateAsync({ mailboxId, id, folder: Folders.ARCHIVE }),
						),
					);
				} else {
					await Promise.all(
						ids.map((id) => deleteEmail.mutateAsync({ mailboxId, id })),
					);
				}
				const actionLabel = {
					read: "已标记为已读",
					unread: "已标记为未读",
					star: "已加星标",
					archive: "已归档",
					trash: "已移到回收站",
				}[action];
				toast.success(`${actionLabel} · ${ids.length} 封`);
				clearSelected();
			} catch (error) {
				toast.error(getUserFacingError(error, "批量操作未完成，请重试。"));
			} finally {
				setBulkActionPending(false);
			}
		},
		[
			bulkActionPending,
			clearSelected,
			deleteEmail,
			mailboxId,
			moveEmail,
			selectedIds,
			updateEmail,
		],
	);

	const handleRefresh = async () => {
		if (isSyncing) return;
		setIsSyncing(true);
		setRefreshQueued(false);
		try {
			const result = await api.refreshMail();
			setRefreshQueued(result.status === "queued");
		} catch (error) {
			if (
				((error instanceof ApiError && isMailCredentialInvalidBody(error.body)) ||
					(error instanceof Error &&
						(error.name === "MAIL_CREDENTIAL_INVALID" || isCredentialError(error)))) &&
				mailboxId
			) {
				dispatchMailAuthRequired({
					accountId: mailboxId,
					code: "MAIL_CREDENTIAL_INVALID",
					source: "manual",
				});
				return;
			}
			toast.error(getUserFacingError(error, "刷新失败，请检查网络或邮箱设置。"));
		} finally {
			setIsSyncing(false);
			queryClient.invalidateQueries({
				queryKey: ["emails"],
			});
			if (mailboxId) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.folders.list(mailboxId),
				});
				queryClient.invalidateQueries({
					queryKey: ["list-categories", mailboxId],
				});
			}
		}
	};
	const handleMarkAllRead = async () => {
		if (!mailboxId || !markAllReadParams || markAllReadLock.current || bulkActionPending) return;
		markAllReadLock.current = true;
		const controller = new AbortController();
		markAllReadController.current = controller;
		setMarkAllReadStopping(false);
		setBulkActionPending(true);
		setMarkAllReadProgress("正在准备…");
		// Mirror the bulk run into the persistent job card so it survives
		// navigating away; the card's close mark cancels the same controller.
		const jobStartedAt = Date.now();
		upsertJob({
			id: "mark-all-read",
			title: "正在标记全部已读",
			progress: {},
			onCancel: () => controller.abort(),
		});
		try {
			await queryClient.cancelQueries({ queryKey: ["emails", mailboxId],
				predicate: (query) => typeof query.queryKey[2] === "object" && query.queryKey[2] !== null });
			const result = await markAllMailRead(mailboxId, markAllReadParams, (completed, total) =>
				{ if (controller.signal.aborted) return;
					setMarkAllReadProgress(`正在标记 ${completed}/${total}`);
					const frac = total > 0 ? completed / total : 0;
					const elapsedSec = (Date.now() - jobStartedAt) / 1000;
					const remainingSec = frac > 0.05 && frac < 1 ? Math.max(1, Math.round(elapsedSec / frac - elapsedSec)) : undefined;
					upsertJob({
						id: "mark-all-read",
						title: "正在标记全部已读",
						progress: {
							done: completed,
							total,
							percent: total > 0 ? Math.round(frac * 100) : undefined,
							eta: remainingSec === undefined ? undefined : remainingSec < 60 ? `约 ${remainingSec} 秒` : `约 ${Math.ceil(remainingSec / 60)} 分钟`,
						},
						onCancel: () => controller.abort(),
					});
				}, controller.signal);
			if (result.stopped) {
				toast.info(result.remaining === undefined ? "已终止，尚未修改邮件。"
					: `已终止：已标为已读 ${result.marked} 封，失败 ${result.failed} 封，未处理 ${result.remaining} 封。`);
				completeJob("mark-all-read", "已终止标记", result.marked > 0 ? `已标为已读 ${result.marked} 封` : undefined);
			}
			else if (result.failed) {
				toast.error(`已标为已读 ${result.marked} 封，${result.failed} 封未完成，请重试。`);
				completeJob("mark-all-read", "部分邮件未完成", `已标为已读 ${result.marked} 封，失败 ${result.failed} 封`);
			}
			else {
				toast.success(result.marked ? `已将 ${result.marked} 封邮件标为已读` : "当前范围没有未读邮件");
				completeJob("mark-all-read", result.marked ? `已标为已读 ${result.marked} 封` : "没有未读邮件", "当前范围已全部处理");
			}
		} catch (error) {
			toast.error(getUserFacingError(error, "全部标为已读未完成，请重试。"));
			completeJob("mark-all-read", "标记未完成", getUserFacingError(error, "请稍后重试。"));
		} finally {
			markAllReadLock.current = false;
			markAllReadController.current = null;
			setMarkAllReadStopping(false);
			setBulkActionPending(false);
			setMarkAllReadProgress(null);
			// Unread memberships changed; refresh from page one rather than replaying old cursors.
			queryClient.setQueriesData<{ pages: unknown[]; pageParams: unknown[] }>({ queryKey: ["emails", mailboxId],
				predicate: (query) => typeof query.queryKey[2] === "object" && query.queryKey[2] !== null },
				(current) => current?.pages?.length ? { ...current, pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) } : current);
			void queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			void queryClient.invalidateQueries({ queryKey: ["folders", mailboxId] });
			void queryClient.invalidateQueries({ queryKey: ["list-categories", mailboxId] });
		}
	};

	return (
		<div
			// `view-transition-name` makes this container its own snapshot
			// during route navigations, so the list pane cross-fades
			// independently of the rest of the workbench (sidebar/agent stay
			// put). Paired with `mail-detail` on EmailPanel.
			style={{ viewTransitionName: "mail-list" } as React.CSSProperties}
			data-detail-open={selectedEmailId !== null ? "true" : "false"}
			className="@container/mail-list flex h-full flex-col overflow-hidden bg-transparent"
		>
			{/* upstream-style toolbar: refresh / search / filter, sticky inside the white list card. */}
			<div className="sticky top-0 z-[2] flex h-14 shrink-0 items-center gap-1 rounded-tl-[var(--radius-xl)] border-b border-edge-2 bg-workbench-surface px-2">
				{mailSyncEnabled ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-10 w-10 shrink-0 rounded-full p-0 text-ink-3 hover:bg-paper-3 hover:text-ink"
								onClick={handleRefresh}
								disabled={isRefreshing}
								aria-label="手动刷新"
							>
								<ArrowCounterClockwiseIcon
									size={16}
									className={isRefreshing ? "animate-spin motion-reduce:animate-none" : ""}
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{isRefreshing ? "正在刷新…" : refreshQueued ? "刷新已提交" : "手动刷新"}
						</TooltipContent>
					</Tooltip>
				) : null}
				<div className="relative flex h-10 min-w-0 max-w-[260px] flex-1">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							submitSearch(searchInput);
						}}
						className="group flex h-10 w-full items-center gap-1 rounded-full border border-edge bg-sidebar px-1.5 text-ui text-ink-3 transition-colors focus-within:border-coral focus-within:bg-workbench-surface focus-within:ring-1 focus-within:ring-ring"
					>
						<button
							type="submit"
							aria-label="搜索邮件"
							className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group-focus-within:text-coral-2"
						>
							{urlQuery && query.isFetching ? (
								<CircleNotchIcon size={14} weight="bold" className="animate-spin motion-reduce:animate-none" />
							) : (
								<MagnifyingGlassIcon size={14} weight="bold" />
							)}
						</button>
						<input
							type="text"
							role="searchbox"
							value={searchInput}
							aria-haspopup="listbox"
							aria-expanded={scopeMenuOpen && !!(searchInput.trim() || scopePreviewQuery)}
							onFocus={() => {
								if (searchInput.trim() || scopePreviewQuery) setScopeMenuOpen(true);
							}}
							onBlur={() => setScopeMenuOpen(false)}
							onCompositionStart={() => {
								searchComposingRef.current = true;
							}}
							onCompositionEnd={(e) => {
								searchComposingRef.current = false;
								const value = (e.target as HTMLInputElement).value;
								setSearchInput(value);
								scheduleLiveSearch(value);
							}}
							onChange={(e) => {
								const nextQuery = e.target.value;
								setSearchInput(nextQuery);
								if (!nextQuery && urlQuery) {
									clearSearch();
									return;
								}
								if (nextQuery.trim()) setScopeMenuOpen(true);
								scheduleLiveSearch(nextQuery);
							}}
							onKeyDown={(e) => {
								if (scopeMenuOpen) {
									if (e.key === "ArrowDown") {
										e.preventDefault();
										setScopeActiveIndex((current) => (current + 1) % SEARCH_SCOPES.length);
										return;
									}
									if (e.key === "ArrowUp") {
										e.preventDefault();
										setScopeActiveIndex((current) => (current - 1 + SEARCH_SCOPES.length) % SEARCH_SCOPES.length);
										return;
									}
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										e.preventDefault();
										const scope = SEARCH_SCOPES[scopeActiveIndex];
										setScopeMenuOpen(false);
										submitSearch(searchInput, scope?.value ?? urlScope);
										return;
									}
									if (e.key === "Escape") {
										e.preventDefault();
										setScopeMenuOpen(false);
										return;
									}
								}
								if (e.key === "Escape" && searchInput) {
									clearSearch();
								}
								if (e.key === "Enter") {
									e.preventDefault();
									submitSearch(searchInput);
								}
							}}
							className="min-w-0 flex-1 bg-transparent text-control text-ink focus:outline-none"
						/>
						{searchInput.trim() !== urlQuery && searchInput.trim() ? (
							<span
								aria-hidden
								className="hidden shrink-0 items-center gap-0.5 text-xs text-ink-4 @max-[460px]/mail-list:hidden sm:flex"
							>
								<kbd className="rounded border border-edge-2 bg-paper-2 px-1 py-px font-sans">Enter</kbd>
							</span>
						) : null}
						{urlQuery ? (
							<button
								type="button"
								onClick={clearSearch}
								aria-label="清除搜索"
								title="清除搜索"
								className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<XIcon size={13} weight="bold" />
							</button>
						) : null}
					</form>
					{scopeMenuOpen && (searchInput.trim() || scopePreviewQuery) ? (
						<div
							role="listbox"
							aria-label="选择搜索范围"
							data-testid="search-scope-preview"
							className="absolute left-0 top-full z-30 mt-1.5 w-[300px] overflow-hidden rounded-xl border border-edge bg-paper-2 p-1.5 shadow-[var(--shadow-3)]"
						>
							<div className="px-2 pb-1 pt-1 text-caption font-semibold tracking-wide text-ink-4">
								「{searchInput.trim() || scopePreviewQuery}」· 选择搜索范围
							</div>
							{SEARCH_SCOPES.map((scope, index) => {
								const ScopeIcon = scope.icon;
								const selected = index === scopeActiveIndex;
								const active = scope.value === urlScope;
								return (
									<button
										key={scope.value}
										type="button"
										role="option"
										aria-selected={selected}
										onMouseDown={(event) => event.preventDefault()}
										onClick={() => {
											setScopeActiveIndex(index);
											setScopeMenuOpen(false);
											submitSearch(searchInput || scopePreviewQuery, scope.value);
										}}
										onMouseEnter={() => setScopeActiveIndex(index)}
										className={`flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
											selected ? "bg-paper-3" : "hover:bg-paper-3"
										}`}
									>
										<ScopeIcon size={14} weight="bold" className="shrink-0 text-coral-2" />
										<span className="min-w-0 flex-1 text-ui text-ink">
											按{scope.label}搜索
											{active ? <span className="ml-1.5 text-caption text-ink-4">当前</span> : null}
										</span>
										{selected ? (
											<kbd className="shrink-0 rounded border border-edge-2 bg-paper px-1 py-px font-sans text-xs text-ink-3">Enter</kbd>
										) : null}
									</button>
								);
							})}
							<div className="border-t border-edge px-2 pb-1 pt-1.5 text-caption text-ink-4">
								↑↓ 选择 · Enter 按所选范围搜索
							</div>
						</div>
					) : null}
				</div>
				<div className="shrink-0 whitespace-nowrap text-meta text-ink-3 tabular-nums" data-testid="mail-count-meta">
					{urlQuery ? (
						<span className="text-ink-2">找到 <PopNumber value={totalEmailCount} /> 封匹配</span>
					) : (
						<>
							<span className="@max-[460px]/mail-list:hidden">共 <PopNumber value={totalEmailCount} /> 封 · </span><PopNumber value={currentViewUnreadCount} /> 未读
						</>
					)}
				</div>
				{canUseDigest ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-10 w-10 shrink-0 rounded-full p-0 text-coral-2 transition-colors hover:bg-paper-3 hover:text-coral-strong @max-[380px]/mail-list:hidden"
								onClick={openSummaryCenter}
								aria-label="打开智能中心"
								title="打开智能中心"
							>
								<ArticleIcon size={16} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>智能中心</TooltipContent>
					</Tooltip>
				) : null}
				<MailFilterPopover>
					<Button
						variant="ghost"
						size="sm"
						className="relative ml-auto h-10 w-10 shrink-0 rounded-full p-0 text-ink-3 hover:bg-paper-3 hover:text-ink data-[state=open]:bg-paper-3 data-[state=open]:text-ink"
						aria-label="筛选邮件"
						data-testid="list-filter"
					>
						<FunnelSimpleIcon size={16} />
						<FilterActiveDot />
					</Button>
				</MailFilterPopover>
			</div>
			<MailFilterChips />
			{(markAllReadParams && !urlQuery) || markAllReadProgress !== null ? <div className="flex min-h-9 shrink-0 items-center gap-3 border-b border-edge-2 px-3">
				<span className="truncate text-meta font-medium text-ink">{listTitle ?? folderDisplayName(folder)}</span>
				<button type="button" onClick={() => void handleMarkAllRead()}
					disabled={!mailboxId || bulkActionPending || markAllReadProgress !== null || currentViewUnreadCount === 0}
					className="inline-flex min-h-9 shrink-0 items-center gap-1 text-meta text-coral hover:underline disabled:cursor-default disabled:text-ink-4 disabled:no-underline"
					aria-label="全部标为已读" title="将当前分类和筛选范围内的全部邮件标为已读，包含未加载的邮件">
					{markAllReadProgress !== null ? <CircleNotchIcon size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
					<span role="status">{markAllReadProgress ?? "全部标为已读"}</span>
				</button>
				{markAllReadProgress !== null ? <button type="button" disabled={markAllReadStopping}
					onClick={() => {
						markAllReadController.current?.abort();
						setMarkAllReadStopping(true);
						setMarkAllReadProgress("正在终止，等待当前批次结果…");
					}}
					className="min-h-9 shrink-0 text-meta text-ink-2 hover:text-coral hover:underline disabled:opacity-50">
					{markAllReadStopping ? "正在终止…" : "终止"}
				</button> : null}
			</div> : null}
			{!showCategoryTabs || hideCategoryTabs || urlQuery ? null : (
			<div className="relative h-9 shrink-0 overflow-hidden border-b border-edge-2 px-3">
				<Tabs
					value={activeCategory}
					onValueChange={handleCategoryChange}
				>
					<TabsList className="relative h-9 w-full justify-start gap-0 overflow-x-auto border-b-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
						<span
							ref={categoryIndicatorRef}
							aria-hidden
							data-testid="category-glide-indicator"
							className="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-coral transition-[left,width] duration-[400ms] ease-[cubic-bezier(0.65,0,0.35,1)] motion-reduce:transition-none"
							style={{ left: 0, width: 0 }}
						/>
						{listCategories.map((c) => {
							return (
								<TabsTrigger
									key={c.id}
									value={c.id}
									aria-label={c.label}
									ref={(el) => {
										if (el) categoryTabRefs.current.set(c.id, el);
										else categoryTabRefs.current.delete(c.id);
									}}
									className="h-9 shrink-0 gap-1.5 px-2.5 py-0 text-control font-medium data-[state=active]:font-semibold data-[state=active]:border-transparent"
								>
									<span>{c.label}</span>
								</TabsTrigger>
							);
						})}
					</TabsList>
				</Tabs>
			</div>
			)}

			{selectedIds.size > 0 ? (
				<div
					className="flex h-11 shrink-0 items-center gap-1.5 border-b border-edge-2 bg-paper-3/80 px-3"
					role="toolbar"
					aria-label="批量邮件操作"
					data-testid="mail-selection-toolbar"
				>
					<button
						type="button"
						onClick={selectedIds.size === emails.length ? clearSelected : selectAllVisible}
						className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-control font-medium text-ink-2 transition-colors hover:bg-paper-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-pressed={selectedIds.size === emails.length}
					>
						<span
							aria-hidden
							className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${selectedIds.size === emails.length && emails.length > 0 ? "border-coral bg-coral" : "border-edge-2 bg-paper-2"}`}
						>
							{selectedIds.size === emails.length && emails.length > 0 ? <span className="h-1.5 w-1.5 rounded-sm bg-paper-2" /> : null}
						</span>
						<span>{selectedIds.size} 封已选</span>
					</button>
					<span className="h-5 w-px bg-edge-2" aria-hidden />
					{canArchive ? (
						<Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-ink-2" disabled={bulkActionPending} onClick={() => void runBulkAction("archive")} aria-label="批量归档" title="归档"><ArchiveIcon size={15} /></Button>
					) : null}
					<Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-ink-2" disabled={bulkActionPending} onClick={() => void runBulkAction("read")} aria-label="批量标记为已读" title="标记为已读"><EnvelopeOpenIcon size={15} /></Button>
					<Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-ink-2" disabled={bulkActionPending} onClick={() => void runBulkAction("unread")} aria-label="批量标记为未读" title="标记为未读"><EnvelopeSimpleIcon size={15} /></Button>
					<Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-amber" disabled={bulkActionPending} onClick={() => void runBulkAction("star")} aria-label="批量加星标" title="加星标"><StarIcon size={15} /></Button>
					<Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red" disabled={bulkActionPending} onClick={() => void runBulkAction("trash")} aria-label="批量移到回收站" title="移到回收站"><TrashIcon size={15} /></Button>
					<button type="button" onClick={clearSelected} className="ml-auto rounded-md px-2 py-1 text-control text-ink-3 hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">取消选择</button>
				</div>
			) : null}

			<div
				ref={listScrollRef}
				className="flex-1 min-h-0 overflow-y-auto"
				data-testid="mail-list-scroll"
				onScroll={handleListScroll}
				onWheel={handleListWheel}
				onPointerDown={handleListPointerDown}
				onPointerUp={handleListPointerUp}
			>
				{query.isLoading && emails.length === 0 ? (
					<MessageListSkeleton />
				) : query.isError && emails.length === 0 ? (
					<EmptyState
						icon={<TrayIcon size={28} />}
						title="邮件暂时无法加载"
						description={getUserFacingError(query.error, "请检查网络或邮箱连接后重试。")}
						actions={[{ label: "重新加载", onClick: () => void query.refetch(), variant: "primary" }]}
					/>
				) : emails.length > 0 ? (
					<div
						className="relative"
						style={{
							height: virtualMailLayout.totalHeight + 40,
						}}
						data-testid="virtual-mail-list"
					>
						{visibleVirtualRows.map((row, rowIndex) => row.kind === "header" ? (
							<div
								key={row.key}
								className="absolute left-0 right-0 flex items-center px-3 text-meta font-semibold tracking-[0.01em] text-ink-3"
								style={{ top: row.top, height: row.height }}
							>
								<button
									type="button"
									className="group/month inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-expanded={!row.collapsed}
									aria-label={`${row.collapsed ? "展开" : "收起"}${row.label}邮件`}
									onClick={() => toggleBucket(row.bucketKey)}
								>
									<CaretDownIcon size={12} className={`text-ink-4 transition-transform motion-reduce:transition-none ${row.collapsed ? "-rotate-90" : ""}`} />
									<span>{row.label}</span>
									<span className="font-normal text-ink-4">{row.count}</span>
								</button>
							</div>
						) : (
							<MailItem
								key={row.key}
								className={cn(
									"absolute left-0 right-0",
									rowIndex < firstPaintRows && "skeleton-row-in",
									shakeIds.has(row.email.id) && "wm-shake",
								)}
								style={{ top: row.top, height: row.height, animationDelay: rowIndex < firstPaintRows ? `${rowIndex * 40}ms` : undefined }}
								actionError={starErrors.get(row.email.id)}
								id={row.email.id}
								sender={senderLabel(row.email)}
								subject={row.email.subject}
								snippet={getSnippetText(row.email.snippet)}
								date={formatListDate(row.email.date)}
								unread={row.email.read === false}
								hasAttachment={!!row.email.hasAttachments || hasDownloadableAttachments(row.email.attachments)}
				selected={selectedEmailId === row.email.id}
								selectable
								checkboxSelected={selectedIds.has(row.email.id)}
								onToggleSelect={toggleSelected}
								onArchive={canArchive ? quickArchive : undefined}
								onDelete={quickDelete}
								onToggleRead={quickToggleRead}
								onContextMenu={handleContextMenu}
								starred={isEmailStarred(row.email)}
								onToggleStar={toggleStar}
								onClick={handleSelectEmail}
								highlightTerms={highlightTerms}
								tags={invoiceStatusTagForList(row.email, allowanceInvoice)}
							/>
						))}
						{query.isFetchingNextPage ? (
							<div
								className="absolute left-0 right-0 flex items-center justify-center py-4 text-xs text-ink-3"
								style={{ top: virtualMailLayout.totalHeight }}
								role="status"
								aria-live="polite"
							>
								正在加载更多邮件…
							</div>
						) : null}
						{query.isFetchNextPageError ? (
							<button
								type="button"
								className="absolute left-0 right-0 flex items-center justify-center py-4 text-xs text-red hover:underline"
								style={{ top: virtualMailLayout.totalHeight }}
								onClick={() => void query.fetchNextPage?.()}
							>
								加载失败，点击重试
							</button>
						) : !query.hasNextPage ? (
							<div
								className="absolute left-0 right-0 flex items-center justify-center py-4 text-xs text-ink-3"
								style={{ top: virtualMailLayout.totalHeight }}
								role="status"
							>
								已加载全部邮件
							</div>
						) : null}
					</div>
				) : urlQuery && !query.isLoading ? (
					<EmptyState
						icon={<MagnifyingGlassIcon size={28} />}
						title={`未找到「${urlQuery}」相关邮件`}
						description={
							urlScope !== "all"
								? "当前搜索范围内没有匹配，试试扩大到全部内容，或让 AI 在整个邮箱里帮你找。"
								: "换个关键词或范围试试，也可以让 AI 理解你的意图后再找一遍。"
						}
						actions={[
							...(urlScope !== "all"
								? [{ label: "扩大范围到全部", onClick: () => changeSearchScope("all"), variant: "primary" as const }]
								: []),
							{ label: "清除搜索", onClick: clearSearch },
							{ label: "问问 AI", onClick: askAgentAboutSearch },
						]}
						data-testid="search-empty-state"
					/>
				) : (
					<FolderEmptyState
						folder={folder}
							onCompose={() => startCompose()}
							title={emptyTitle}
							description={emptyDescription}
							showCompose={showComposeInEmptyState}
						/>
				)}
			</div>
			<MailContextMenu
				email={contextMenu?.email ?? null}
				position={contextMenu?.position ?? null}
				accountId={mailboxId}
				onClose={() => setContextMenu(null)}
				onReply={() => void openContextCompose("reply")}
				onReplyAll={() => void openContextCompose("reply-all")}
				onForward={() => void openContextCompose("forward")}
				onToggleRead={() => {
					if (contextMenu) quickToggleRead(contextMenu.email.id, !contextMenu.email.read);
				}}
				onArchive={canArchive ? () => {
					if (contextMenu) quickArchive(contextMenu.email.id);
				} : undefined}
				onMarkSpam={() => {
					if (contextMenu) quickMarkSpam(contextMenu.email.id);
				}}
				onDelete={() => {
					if (contextMenu) quickDelete(contextMenu.email.id);
				}}
			/>
		</div>
	);
}

/**
 * Tiny coral pip drawn on the filter toolbar button when at least one
 * filter is active, mirroring the affordance upstream uses to surface
 * "filtered list" without an explicit chip strip.
 */
function FilterActiveDot() {
	const f = useMailFilters();
	const active =
		f.unread || f.toMe || f.ccMe || f.hasAttachment || f.olderThan !== null;
	if (!active) return null;
	return (
		<span
			aria-hidden
			className="absolute top-1 right-1 inline-block h-1.5 w-1.5 rounded-full bg-coral"
		/>
	);
}

/**
 * Detail slot: renders the selected email or an empty placeholder.
 * Compose is no longer embedded here — the floating ComposePanel is
 * mounted at the WorkbenchShell level so it overlays the entire grid
 * (upstream-style bottom-right window). When a user opens compose with an
 * email selected, the email stays visible behind the floating window
 * for reference.
 */
export function MessageDetailView({
	accountId,
	folderId,
}: {
	accountId?: string;
	folderId?: string;
	} = {}) {
	const selectedEmailId = useUIStore((state) => state.selectedEmailId);
	const navigate = useNavigate();
	const location = useLocation();
	const routeFolderId = location.pathname.startsWith("/folder/")
		? decodeURIComponent(
				location.pathname.slice("/folder/".length).split("/")[0] ?? "",
			)
		: undefined;
	const resolvedFolderId = folderId ?? routeFolderId;
	const openSummaryCenter = useCallback(() => navigate("/digests"), [navigate]);

	if (selectedEmailId) {
		// Wrap the EmailPanel in a tagged container so the detail surface
		// participates in the shared-element view transition. The wrapper
		// is `h-full` so it doesn't collapse the EmailPanel's own height.
		return (
			<div
				style={{ viewTransitionName: "mail-detail" } as React.CSSProperties}
				className="h-full"
			>
				<Suspense
					fallback={
						<div
							className="h-full bg-paper motion-safe:animate-pulse"
							role="status"
							aria-label="正在加载邮件详情"
						/>
					}
				>
					<EmailPanel
						emailId={selectedEmailId}
						accountId={accountId}
						folderId={resolvedFolderId}
						onOpenSummaryCenter={openSummaryCenter}
					/>
				</Suspense>
			</div>
		);
	}
	return (
		<div
			style={{ viewTransitionName: "mail-detail" } as React.CSSProperties}
			className="h-full bg-workbench-surface"
		>
			<EmptyState
				icon={<TrayIcon size={22} weight="regular" />}
				title="选择一封邮件查看详情"
				description="邮件正文、摘要、附件和智能标签会显示在这里。"
				data-testid="message-detail-empty"
			/>
		</div>
	);
}
