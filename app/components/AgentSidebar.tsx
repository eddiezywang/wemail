// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Right-rail "WeMail AI" panel.
 *
 * the upstream's reference UI puts a single chat surface in the right rail —
 * no Agent / MCP tabs. The brand bar shows the assistant name plus
 * three controls (history, expand, close). The chat area lives below.
 *
 * Header controls:
 *  - 历史 — popover lists past sessions, pick one to set the active
 *    `sessionId` (so future `POST /api/agent/chat` calls resume that
 *    server-side conversation thread). The popover groups conversations
 *    by recency (Today / Yesterday / Past 7 days / Past 30 days /
 *    monthly older buckets) and exposes per-conversation rename and
 *    archive (soft-delete) via a dropdown menu on each row.
 *  - 展开/收起 — toggles `isAgentPanelExpanded` in the UI store; the
 *    workbench grid reads that and widens the agent column.
 *  - 关闭 — toggles `isAgentPanelOpen`.
 */

import { ArrowsInSimpleIcon } from "@phosphor-icons/react/ArrowsInSimple";
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react/ArrowsOutSimple";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/ArrowUUpLeft";
import { BoxArrowDownIcon as ArchiveBoxIcon } from "@phosphor-icons/react/BoxArrowDown";
import { BellRingingIcon } from "@phosphor-icons/react/BellRinging";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { PushPinIcon } from "@phosphor-icons/react/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/PushPinSlash";
import { StarIcon } from "@phosphor-icons/react/Star";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { getUserFacingError } from "~/lib/user-facing-error";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipPortal,
	TooltipProvider,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { useUIStore } from "~/hooks/useUIStore";
import { groupByConversationTime } from "~/lib/utils";
import { useCurrentAccount } from "~/queries/currentAccount";
import {
	useAgentConversations,
	useArchiveAgentConversation,
	useClearAgentConversations,
	usePinAgentConversation,
	useRenameAgentConversation,
	useUnarchiveAgentConversation,
	useUnpinAgentConversation,
	type AgentConversationSummary,
} from "~/queries/agentConversations";
import { usePendingActions } from "~/queries/pendingActions";
import { useAgentAttention } from "~/queries/agentAttention";

function Spinner({ size = 16 }: { size?: number }) {
	return (
		<span
			role="status"
			aria-label="正在加载 Agent"
			className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-ink-3 motion-reduce:animate-none"
			style={{ width: size, height: size }}
		/>
	);
}

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);

	useEffect(() => {
		setLoadError(null);
		import("~/components/AgentPanel")
			.then((mod) => {
				setAgentChat(() => mod.default);
			})
			.catch((err) => {
				console.error("Failed to load AgentPanel:", err);
				setLoadError("Failed to load agent panel");
			});
	}, [loadAttempt]);

	if (loadError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
				<span className="text-xs text-red">Agent 面板暂时无法加载。</span>
				<button
					type="button"
					onClick={() => setLoadAttempt((attempt) => attempt + 1)}
					className="min-h-9 rounded-md border border-edge bg-paper px-3 text-sm text-ink hover:bg-paper-2"
				>
					重新加载 Agent
				</button>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Spinner size={20} />
				<span className="text-xs text-ink-3">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat />;
}

function formatRelative(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(ms)) return "";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} 天前`;
	return new Date(iso).toLocaleDateString();
}

/**
 * Render a title with the matched substring wrapped in `<mark>`.
 * Falls back to plain text when there is no search term or no match.
 */
function HighlightedTitle({
	title,
	search,
}: {
	title: string;
	search?: string;
}) {
	if (!search) return <>{title}</>;
	const lowerTitle = title.toLowerCase();
	const lowerSearch = search.toLowerCase();
	const idx = lowerTitle.indexOf(lowerSearch);
	if (idx < 0) return <>{title}</>;
	return (
		<>
			{title.slice(0, idx)}
			<mark className="bg-coral/20 text-ink rounded-sm px-0.5">
				{title.slice(idx, idx + search.length)}
			</mark>
			{title.slice(idx + search.length)}
		</>
	);
}

interface ConversationRowProps {
	conversation: AgentConversationSummary;
	isRenaming: boolean;
	searchTerm?: string;
	onResume: (c: AgentConversationSummary) => void;
	onStartRename: (id: string) => void;
	onCancelRename: () => void;
	onSubmitRename: (id: string, title: string) => void;
	onArchive: (id: string) => void;
	onUnarchive: (id: string) => void;
	onPin: (id: string) => void;
	onUnpin: (id: string) => void;
}

function ConversationRow({
	conversation,
	isRenaming,
	searchTerm,
	onResume,
	onStartRename,
	onCancelRename,
	onSubmitRename,
	onArchive,
	onUnarchive,
	onPin,
	onUnpin,
}: ConversationRowProps) {
	const [draft, setDraft] = useState(conversation.title ?? "");
	useEffect(() => {
		if (isRenaming) setDraft(conversation.title ?? "");
	}, [isRenaming, conversation.title]);

	const archived = !!conversation.archivedAt;
	const pinned = !!conversation.pinnedAt;
	const titleText = conversation.title || "（无标题）";

	return (
		<li
			data-testid="agent-conversation-row"
			data-archived={archived ? "true" : "false"}
			data-pinned={pinned ? "true" : "false"}
			className={archived ? "opacity-60" : ""}
		>
			<div className="group flex items-stretch hover:bg-paper-3 transition-colors">
				{isRenaming ? (
					<form
						className="flex-1 min-w-0 px-3 py-2"
						onSubmit={(e) => {
							e.preventDefault();
							const trimmed = draft.trim();
							if (trimmed.length === 0) {
								onCancelRename();
								return;
							}
							onSubmitRename(conversation.id, trimmed);
						}}
					>
						<input
							autoFocus
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onBlur={() => onCancelRename()}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									onCancelRename();
								}
							}}
							maxLength={80}
							className="w-full bg-paper border border-edge rounded px-2 py-1 text-sm text-ink outline-none focus:border-coral"
							aria-label="重命名对话"
							data-testid="agent-conversation-rename-input"
						/>
					</form>
				) : (
					<button
						type="button"
						onClick={() => onResume(conversation)}
						className="flex-1 min-w-0 text-left px-3 py-2"
					>
						<div className="flex items-start gap-2">
							{pinned ? (
								<StarIcon
									size={12}
									weight="fill"
									className="mt-1 text-coral shrink-0"
									aria-label="已置顶"
									data-testid="agent-conversation-pin-indicator"
								/>
							) : (
								<ChatCircleDotsIcon
									size={12}
									weight="regular"
									className="mt-1 text-ink-3 shrink-0"
								/>
							)}
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-1.5">
									{conversation.channelPlatform ? (
										<span
											className="shrink-0 rounded bg-paper-3 px-1 py-px text-xs font-medium text-ink-2"
											data-testid="agent-conversation-channel-badge"
										>
											{conversation.channelPlatform === "wecom"
												? "企微"
												: conversation.channelPlatform === "feishu"
													? "飞书"
													: conversation.channelPlatform}
										</span>
									) : null}
									<span className="min-w-0 flex-1 truncate text-sm text-ink">
										{conversation.title ? (
											<HighlightedTitle
												title={titleText}
												search={searchTerm}
											/>
										) : (
											titleText
										)}
									</span>
								</div>
								<div className="mt-0.5 text-xs text-ink-3">
									{formatRelative(conversation.updatedAt)}
								</div>
							</div>
						</div>
					</button>
				)}
				{!isRenaming ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="px-2 text-ink-3 hover:text-ink opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
								aria-label="对话操作"
								data-testid="agent-conversation-actions"
								onClick={(e) => e.stopPropagation()}
							>
								<DotsThreeIcon size={16} weight="bold" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-40">
							<DropdownMenuItem
								onSelect={(e) => {
									e.preventDefault();
									onStartRename(conversation.id);
								}}
								data-testid="agent-conversation-rename"
							>
								<PencilSimpleIcon size={12} />
								重命名
							</DropdownMenuItem>
							{pinned ? (
								<DropdownMenuItem
									onSelect={(e) => {
										e.preventDefault();
										onUnpin(conversation.id);
									}}
									data-testid="agent-conversation-unpin"
								>
									<PushPinSlashIcon size={12} />
									取消置顶
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									onSelect={(e) => {
										e.preventDefault();
										onPin(conversation.id);
									}}
									data-testid="agent-conversation-pin"
								>
									<PushPinIcon size={12} />
									置顶
								</DropdownMenuItem>
							)}
							{archived ? (
								<DropdownMenuItem
									onSelect={(e) => {
										e.preventDefault();
										onUnarchive(conversation.id);
									}}
									data-testid="agent-conversation-unarchive"
								>
									<ArrowUUpLeftIcon size={12} />
									取消归档
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									onSelect={(e) => {
										e.preventDefault();
										onArchive(conversation.id);
									}}
									data-testid="agent-conversation-archive"
								>
									<ArchiveBoxIcon size={12} />
									归档
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
		</li>
	);
}

/**
 * Debounced state hook. Returns the value after `delay` ms of inactivity.
 * Empty inputs clear immediately so the user gets the unfiltered list back.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		// Empty / falsy values flow through with no delay so that clearing
		// the search box snaps back to the full list.
		if (!value || (typeof value === "string" && value.trim() === "")) {
			setDebounced(value);
			return;
		}
		const handle = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(handle);
	}, [value, delay]);
	return debounced;
}

function HistoryPopover() {
	const [open, setOpen] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [searchInput, setSearchInput] = useState("");
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const debouncedSearch = useDebouncedValue(searchInput, 150);
	const trimmedSearch = debouncedSearch.trim();
	const isSearching = trimmedSearch.length > 0;

	// Account scoping. WeMail desktop is single-account today, so the
	// selector hides itself when only one account exists. The "all" sentinel
	// lets the user widen the scope without re-selecting their own account.
	const { data: currentAccountData } = useCurrentAccount();
	const currentAccountId = currentAccountData?.account?.id;
	// Future-proofing: if multi-account support lands, swap this for a real
	// account list query. For now we expose at most one named account plus
	// the implicit "all" toggle.
	const knownAccounts = useMemo(
		() =>
			currentAccountId
				? [
						{
							id: currentAccountId,
							label:
								currentAccountData?.account?.displayName ||
								currentAccountData?.account?.emailAddress ||
								currentAccountId,
						},
				]
				: [],
		[currentAccountId, currentAccountData],
	);
	const showAccountSelector = knownAccounts.length > 1;
	const [accountFilter, setAccountFilter] = useState<string>("all");

	const resumeAgentConversation = useUIStore((state) => state.resumeAgentConversation);
	const startFreshAgentConversation = useUIStore((state) => state.startFreshAgentConversation);
	const { data: conversations = [], isLoading } = useAgentConversations(
		open,
		{
			includeArchived: showArchived,
			search: trimmedSearch || undefined,
			accountId:
				showAccountSelector && accountFilter !== "all"
					? accountFilter
					: undefined,
		},
	);
	const clearMut = useClearAgentConversations();
	const renameMut = useRenameAgentConversation();
	const archiveMut = useArchiveAgentConversation();
	const unarchiveMut = useUnarchiveAgentConversation();
	const pinMut = usePinAgentConversation();
	const unpinMut = useUnpinAgentConversation();

	const sorted = useMemo(
		() =>
			[...conversations].sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() -
					new Date(a.updatedAt).getTime(),
			),
		[conversations],
	);
	const active = useMemo(
		() => sorted.filter((c) => !c.archivedAt),
		[sorted],
	);
	const archived = useMemo(
		() => sorted.filter((c) => !!c.archivedAt),
		[sorted],
	);
	// Pinned section sits above the time-bucketed groups and is excluded
	// from those buckets. When searching, we collapse all grouping into a
	// flat updated-at-DESC list.
	const pinned = useMemo(
		() => active.filter((c) => !!c.pinnedAt),
		[active],
	);
	const unpinnedActive = useMemo(
		() => active.filter((c) => !c.pinnedAt),
		[active],
	);
	const groups = useMemo(
		() => groupByConversationTime(unpinnedActive, (c) => c.updatedAt),
		[unpinnedActive],
	);

	const handleResume = (c: AgentConversationSummary) => {
		resumeAgentConversation(c.id);
		setOpen(false);
		toast.success("已切换到该会话", { duration: 1200 });
	};

	const handleNew = () => {
		startFreshAgentConversation();
		setOpen(false);
	};

	const handleClear = async () => {
		try {
			await clearMut.mutateAsync();
			if (currentAccountId) {
				await window.wemailDesktop?.agentDrafts?.clearAccount(currentAccountId).catch(() => undefined);
			}
			startFreshAgentConversation();
			setClearConfirmOpen(false);
			toast.success("已清空");
		} catch (err) {
			toast.error(getUserFacingError(err, "清空失败，请稍后重试。"));
		}
	};

	const handleRenameSubmit = async (id: string, title: string) => {
		try {
			await renameMut.mutateAsync({ id, title });
			setRenamingId(null);
		} catch (err) {
			toast.error(getUserFacingError(err, "重命名失败，请稍后重试。"));
		}
	};

	const handleArchive = async (id: string) => {
		try {
			await archiveMut.mutateAsync({ id });
			toast.success("已归档", { duration: 1200 });
		} catch (err) {
			toast.error(getUserFacingError(err, "归档失败，请稍后重试。"));
		}
	};

	const handleUnarchive = async (id: string) => {
		try {
			await unarchiveMut.mutateAsync({ id });
			toast.success("已取消归档", { duration: 1200 });
		} catch (err) {
			toast.error(getUserFacingError(err, "取消归档失败，请稍后重试。"));
		}
	};

	const handlePin = async (id: string) => {
		try {
			await pinMut.mutateAsync({ id });
			toast.success("已置顶", { duration: 1200 });
		} catch (err) {
			toast.error(getUserFacingError(err, "置顶失败，请稍后重试。"));
		}
	};

	const handleUnpin = async (id: string) => {
		try {
			await unpinMut.mutateAsync({ id });
			toast.success("已取消置顶", { duration: 1200 });
		} catch (err) {
			toast.error(getUserFacingError(err, "取消置顶失败，请稍后重试。"));
		}
	};

	return (
		<>
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex h-9 w-9 shrink-0 aspect-square items-center justify-center rounded-full bg-paper-3 text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="对话历史"
							data-testid="agent-history"
						>
							<ClockCounterClockwiseIcon size={14} />
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipPortal>
					<TooltipContent side="bottom">历史</TooltipContent>
				</TooltipPortal>
			</Tooltip>
			<PopoverContent
				align="end"
				className="w-80 p-0 max-h-[480px] flex flex-col"
			>
				<div className="px-3 py-2 border-b border-edge flex items-center justify-between">
					<span className="text-xs font-semibold text-ink">会话历史</span>
					<button
						type="button"
						onClick={handleNew}
						className="inline-flex items-center gap-1 text-xs text-coral hover:text-coral-2 font-medium"
					>
						<PlusIcon size={12} weight="bold" />
						新建会话
					</button>
				</div>
				{showAccountSelector ? (
					<div
						className="px-3 pt-2 flex items-center gap-1 flex-wrap"
						data-testid="agent-account-selector"
					>
						<button
							type="button"
							onClick={() => setAccountFilter("all")}
							className={`min-h-9 px-2 text-xs rounded-full border transition-colors ${
								accountFilter === "all"
									? "bg-coral text-paper border-coral"
									: "bg-paper text-ink-3 border-edge hover:text-ink"
							}`}
							aria-pressed={accountFilter === "all"}
							data-testid="agent-account-chip-all"
						>
							全部账号
						</button>
						{knownAccounts.map((acct) => (
							<button
								key={acct.id}
								type="button"
								onClick={() => setAccountFilter(acct.id)}
								className={`min-h-9 px-2 text-xs rounded-full border transition-colors max-w-[160px] truncate ${
									accountFilter === acct.id
										? "bg-coral text-paper border-coral"
										: "bg-paper text-ink-3 border-edge hover:text-ink"
								}`}
								aria-pressed={accountFilter === acct.id}
								data-testid={`agent-account-chip-${acct.id}`}
							>
								{acct.label}
							</button>
						))}
					</div>
				) : null}
				<div className="px-3 pt-2 pb-2">
					<div className="relative">
						<MagnifyingGlassIcon
							size={12}
							className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
						/>
						<input
							type="search"
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							placeholder="搜索会话…"
							maxLength={80}
							className="w-full bg-paper border border-edge rounded pl-7 pr-2 py-1 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-coral"
							aria-label="搜索对话"
							data-testid="agent-conversation-search"
						/>
					</div>
				</div>
				<div className="flex-1 min-h-0 overflow-y-auto">
					{isLoading ? (
						<div className="px-4 py-6 text-center text-xs text-ink-3">
							加载中…
						</div>
					) : sorted.length === 0 ? (
						<div className="px-4 py-6 text-center text-xs text-ink-3">
							{isSearching ? "未找到匹配的会话。" : "还没有会话历史。"}
						</div>
					) : isSearching ? (
						<section
							data-testid="agent-conversation-search-results"
							data-search-term={trimmedSearch}
						>
							<ul className="divide-y divide-edge-3">
								{sorted.map((c) => (
									<ConversationRow
										key={c.id}
										conversation={c}
										searchTerm={trimmedSearch}
										isRenaming={renamingId === c.id}
										onResume={handleResume}
										onStartRename={(id) => setRenamingId(id)}
										onCancelRename={() => setRenamingId(null)}
										onSubmitRename={handleRenameSubmit}
										onArchive={handleArchive}
										onUnarchive={handleUnarchive}
										onPin={handlePin}
										onUnpin={handleUnpin}
									/>
								))}
							</ul>
						</section>
					) : (
						<>
							{pinned.length > 0 ? (
								<section
									data-testid="agent-conversation-pinned-group"
								>
									<header className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
										置顶
									</header>
									<ul className="divide-y divide-edge-3">
										{pinned.map((c) => (
											<ConversationRow
												key={c.id}
												conversation={c}
												isRenaming={renamingId === c.id}
												onResume={handleResume}
												onStartRename={(id) => setRenamingId(id)}
												onCancelRename={() => setRenamingId(null)}
												onSubmitRename={handleRenameSubmit}
												onArchive={handleArchive}
												onUnarchive={handleUnarchive}
												onPin={handlePin}
												onUnpin={handleUnpin}
											/>
										))}
									</ul>
								</section>
							) : null}
							{groups.map((group) => (
								<section
									key={group.key.id}
									data-testid="agent-conversation-group"
									data-bucket={group.key.bucket}
								>
									<header className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
										{group.key.label}
									</header>
									<ul className="divide-y divide-edge-3">
										{group.items.map((c) => (
											<ConversationRow
												key={c.id}
												conversation={c}
												isRenaming={renamingId === c.id}
												onResume={handleResume}
												onStartRename={(id) => setRenamingId(id)}
												onCancelRename={() => setRenamingId(null)}
												onSubmitRename={handleRenameSubmit}
												onArchive={handleArchive}
												onUnarchive={handleUnarchive}
												onPin={handlePin}
												onUnpin={handleUnpin}
											/>
										))}
									</ul>
								</section>
							))}
							{showArchived && archived.length > 0 ? (
								<section
									data-testid="agent-conversation-archived-group"
								>
									<header className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
										已归档
									</header>
									<ul className="divide-y divide-edge-3">
										{archived.map((c) => (
											<ConversationRow
												key={c.id}
												conversation={c}
												isRenaming={renamingId === c.id}
												onResume={handleResume}
												onStartRename={(id) => setRenamingId(id)}
												onCancelRename={() => setRenamingId(null)}
												onSubmitRename={handleRenameSubmit}
												onArchive={handleArchive}
												onUnarchive={handleUnarchive}
												onPin={handlePin}
												onUnpin={handleUnpin}
											/>
										))}
									</ul>
								</section>
							) : null}
						</>
					)}
				</div>
				<div className="px-3 py-2 border-t border-edge flex items-center justify-between gap-2">
					<label className="inline-flex min-h-9 items-center gap-1.5 text-xs text-ink-3 cursor-pointer select-none">
						<input
							type="checkbox"
							checked={showArchived}
							onChange={(e) => setShowArchived(e.target.checked)}
							className="h-3 w-3 accent-coral"
							data-testid="agent-show-archived"
						/>
						显示已归档
					</label>
					{sorted.length > 0 ? (
						<button
							type="button"
							onClick={() => setClearConfirmOpen(true)}
							disabled={clearMut.isPending}
							className="inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-red transition-colors disabled:opacity-50"
						>
							<TrashIcon size={12} />
							清空所有历史
						</button>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
		<ConfirmActionDialog
			open={clearConfirmOpen}
			onOpenChange={setClearConfirmOpen}
			title="清空所有 AI 会话历史？"
			description="所有当前及已归档会话和未发送的 Agent 草稿都会从本机移除，此操作不可撤销。"
			confirmLabel="清空历史"
			pending={clearMut.isPending}
			onConfirm={() => void handleClear()}
		/>
		</>
	);
}

export function AgentHeader({ onClose }: { onClose: () => void }) {
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	const isAgentPanelExpanded = useUIStore((state) => state.isAgentPanelExpanded);
	const toggleAgentPanelExpanded = useUIStore((state) => state.toggleAgentPanelExpanded);
	const clearAgentConversation = useUIStore((state) => state.clearAgentConversation);
	const resumeAgentConversation = useUIStore((state) => state.resumeAgentConversation);
	const { data: pendingActions = [] } = usePendingActions(undefined, isAgentPanelOpen);
	const account = useCurrentAccount();
	const { data: attention } = useAgentAttention(isAgentPanelOpen && !!account.data?.account?.id);
	const attentionCount =
		(attention?.active.length ?? 0) +
		(attention?.failed.length ?? 0) +
		(attention?.pausedConversationIds.length ?? 0);
	const openNextAttention = () => {
		const failed = attention?.failed[0];
		const active = attention?.active[0];
		const conversationId =
			failed?.conversationId ??
			attention?.pausedConversationIds[0] ??
			active?.conversationId;
		if (!conversationId) return;
		resumeAgentConversation(conversationId);
		const runId = failed?.id ?? active?.id;
		if (runId) window.sessionStorage.setItem("wemail.agent-run-target", runId);
	};
	const openNextPending = () => {
		const action = pendingActions[0];
		if (!action) return;
		if (action.conversationId) resumeAgentConversation(action.conversationId);
		window.sessionStorage.setItem("wemail.pending-action-target", action.id);
		window.setTimeout(() => {
			document.querySelector(`[data-action-id="${CSS.escape(action.id)}"]`)?.scrollIntoView({
				behavior: "smooth",
				block: "center",
			});
		}, 100);
	};
	return (
		<div className="flex shrink-0 items-center justify-end px-5 py-5 min-[1500px]:justify-between">
			{/* The workbench's wide mode starts at 1500px. On smaller windows,
			    keep the action buttons at full size instead of squeezing the
			    brand text into the header. */}
			<span className="hidden shrink-0 whitespace-nowrap font-mono-meta text-panel-title font-semibold leading-none tracking-[0.02em] text-ink min-[1500px]:inline">
				WeMail AI
			</span>
			<div className="flex shrink-0 items-center gap-0.5">
				{attentionCount > 0 ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={openNextAttention}
								className={`relative inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 transition-colors ${
									(attention?.failed.length ?? 0) > 0
										? "bg-red/10 text-red hover:bg-red/15"
										: (attention?.pausedConversationIds.length ?? 0) > 0
											? "bg-amber-bg text-amber hover:opacity-90"
											: "bg-blue-bg text-blue hover:opacity-90"
								}`}
								aria-label={`${attentionCount} agent runs require attention`}
								data-testid="agent-run-attention-count"
							>
								<ChatCircleDotsIcon size={13} weight="duotone" />
								<span className="text-xs font-semibold tabular-nums">{attentionCount}</span>
							</button>
						</TooltipTrigger>
						<TooltipPortal>
							<TooltipContent side="bottom">
								{(attention?.failed.length ?? 0) > 0
									? "查看失败的任务"
									: (attention?.pausedConversationIds.length ?? 0) > 0
										? "查看已暂停的队列"
										: "查看后台运行任务"}
							</TooltipContent>
						</TooltipPortal>
					</Tooltip>
				) : null}
				{pendingActions.length > 0 ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={openNextPending}
								className="relative inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-coral-bg px-2.5 text-coral-2 transition-colors hover:bg-paper-4"
								aria-label={`${pendingActions.length} pending operations`}
								data-testid="agent-pending-count"
							>
								<BellRingingIcon size={13} weight="duotone" />
								<span className="text-xs font-semibold tabular-nums">{pendingActions.length}</span>
							</button>
						</TooltipTrigger>
						<TooltipPortal><TooltipContent side="bottom">查看待确认操作</TooltipContent></TooltipPortal>
					</Tooltip>
				) : null}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => {
								clearAgentConversation();
								toast.success("已清空当前对话");
							}}
							className="inline-flex h-9 w-9 shrink-0 aspect-square items-center justify-center rounded-full bg-paper-3 text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="清空当前对话"
							data-testid="agent-clear"
						>
							<TrashIcon size={14} />
						</button>
					</TooltipTrigger>
					<TooltipPortal>
						<TooltipContent side="bottom">清空当前对话</TooltipContent>
					</TooltipPortal>
				</Tooltip>
				<HistoryPopover />
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={toggleAgentPanelExpanded}
							className="inline-flex h-9 w-9 shrink-0 aspect-square items-center justify-center rounded-full bg-paper-3 text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={isAgentPanelExpanded ? "收起 Agent 面板" : "展开 Agent 面板"}
							data-testid="agent-expand"
						>
							{isAgentPanelExpanded ? (
								<ArrowsInSimpleIcon size={14} />
							) : (
								<ArrowsOutSimpleIcon size={14} />
							)}
						</button>
					</TooltipTrigger>
					<TooltipPortal>
						<TooltipContent side="bottom">
							{isAgentPanelExpanded ? "收起" : "展开"}
						</TooltipContent>
					</TooltipPortal>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={onClose}
							className="inline-flex h-9 w-9 shrink-0 aspect-square items-center justify-center rounded-full bg-paper-3 text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="关闭 Agent 面板"
							data-testid="agent-close"
						>
							<XIcon size={14} />
						</button>
					</TooltipTrigger>
					<TooltipPortal>
						<TooltipContent side="bottom">关闭</TooltipContent>
					</TooltipPortal>
				</Tooltip>
			</div>
		</div>
	);
}

export default function AgentSidebar({
	variant = "docked",
}: {
	variant?: "docked" | "floating";
}) {
	const toggleAgentPanel = useUIStore((state) => state.toggleAgentPanel);
	const shellClassName =
		variant === "floating"
			? "wemail-ai-elevated flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-paper-2 shadow-3"
			: "wemail-ai-elevated flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-paper-2";

	return (
		<TooltipProvider>
			<div
				data-testid="wemail-ai-shell"
				data-variant={variant}
				className={shellClassName}
			>
			<AgentHeader onClose={toggleAgentPanel} />
				<div className="flex-1 min-h-0 overflow-hidden">
					<LazyAgentPanel />
				</div>
			</div>
		</TooltipProvider>
	);
}
