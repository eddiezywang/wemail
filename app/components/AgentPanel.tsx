// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { ArrowDownIcon } from "@phosphor-icons/react/ArrowDown";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import {
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import {
	isFarFromBottom as computeFarFromBottom,
} from "~/lib/streamingMarkdown";
import { Button } from "~/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipPortal,
	TooltipProvider,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { useUIStore } from "~/hooks/useUIStore";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import {
	type AgentSuggestion,
	isSemanticHomeSuggestion,
	useAgentSuggestions,
} from "~/queries/agentSuggestions";
import { useAgentConversationState } from "~/queries/agentConversations";
import {
	pendingActionsQueryKey,
	usePendingActions,
	useResolvePendingAction,
} from "~/queries/pendingActions";
import { PendingActionCard } from "~/components/wemail/PendingActionCard";
import { applyActionExecution } from "~/lib/actionExecution";
import AgentActionConfirmDialog from "~/components/wemail/AgentActionConfirmDialog";
import { AgentConversationThread } from "~/components/agent/AgentConversationThread";
import { ConfigurationTaskCard } from "~/components/agent/ConfigurationTaskCard";
import {
	AgentComposer,
	type AgentMailScope,
} from "~/components/agent/AgentComposer";
import { AgentMarkdown } from "~/components/agent/AgentMarkdown";
import { sanitizeAgentDisplayText } from "~/lib/agent-display";
import { getUserFacingError } from "~/lib/user-facing-error";
import api, {
	ApiError,
	type AgentActionExecutionResult,
	type AgentPendingAction,
} from "~/services/api";
import type {
	AgentAttachedMail,
	AgentMessageContext,
	HighRiskActionType,
} from "../../shared/wemail/agent";
import type { ConfigurationTaskSnapshot } from "../../shared/wemail/configuration";
import type { MailSceneActionContext } from "../../shared/wemail/intelligence";
import {
	createConversationState,
	moveConversationFollowup,
	pauseConversationFollowups,
	queueConversationFollowup,
	reduceConversationState,
	removeConversationFollowup,
	resolveConversationConfirmation,
	updateConversationFollowup,
	type ConversationState,
} from "../../shared/wemail/conversationState";
import type { WemailAgentEvent } from "../../shared/wemail/agentProtocol";

export { AgentMarkdown };

// Local spinner — Kumo's <Loader> has no direct WeMail primitive yet.
// Inlined per the design doc's Badge precedent (avoid coupling to future
// changes; promote to a primitive later if reused).
function Spinner({ size = 14, className }: { size?: number; className?: string }) {
	return (
		<span
			role="status"
			aria-label="正在加载 Agent"
			className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-ink-3 motion-reduce:animate-none ${className ?? ""}`}
			style={{ width: size, height: size }}
		/>
	);
}

export function getVisibleAgentSuggestions(
	suggestions: AgentSuggestion[],
): AgentSuggestion[] {
	return suggestions.slice(0, 3);
}

export function digestCenterPath(
	filter?: "pending" | "attention" | "history",
): string {
	const params = new URLSearchParams({ tab: "tasks" });
	// The summary center no longer has a digest-history tab; treat a history
	// intent as the default attention view.
	if (filter && filter !== "history") params.set("filter", filter);
	return `/digests?${params.toString()}`;
}

export function resolveContextSuggestions(
	suggestions: AgentSuggestion[],
	_hasSelectedEmail: boolean,
): AgentSuggestion[] {
	return getVisibleAgentSuggestions(suggestions);
}

export function semanticActionFromSuggestion(
	suggestion: AgentSuggestion,
): AgentSuggestion | undefined {
	return isSemanticHomeSuggestion(suggestion) ? suggestion : undefined;
}

export function buildAgentMessageContext(
	base: Record<string, unknown>,
	semanticAction?: AgentSuggestion,
	agentContext?: MailSceneActionContext,
): Record<string, unknown> {
	return {
		...base,
		...(semanticAction ? { semanticAction } : {}),
		...(agentContext ? { sceneAction: agentContext } : {}),
	};
}

export function buildAgentMessagePresentationContext(
	agentContext?: MailSceneActionContext,
	attachedMail?: AgentAttachedMail,
	mailScope?: AgentMailScope,
	attachedMails?: AgentAttachedMail[],
): AgentMessageContext | undefined {
	const actionTags = agentContext?.kind === "insight-report"
		? agentContext.operation === "edit"
			? ["修改报告格式"]
			: agentContext.operation === "regenerate"
				? agentContext.lookbackPreset
					? ["重新生成报告", "聚合相似邮件"]
					: ["重新生成报告"]
			: agentContext.operation === "aggregate"
				? ["生成洞察报告", "聚合相似邮件"]
				: ["生成洞察报告"]
		: mailScope === "mailbox"
			? ["搜索整个邮箱"]
			: [];
	if (actionTags.length === 0 && !attachedMail && !(attachedMails && attachedMails.length > 0)) {
		return undefined;
	}
	return {
		...(actionTags.length > 0 ? { actionTags } : {}),
		...(attachedMail ? { attachedMail } : {}),
		...(attachedMails && attachedMails.length > 0 ? { attachedMails } : {}),
	};
}

export function resolveAgentConversationId(agentSessionId: string): string {
	return agentSessionId;
}

export function shouldShowAgentSuggestions({
	messageCount,
	hasSelectedEmail,
	isHomeInitial = true,
}: {
	messageCount: number;
	hasSelectedEmail: boolean;
	isHomeInitial?: boolean;
}): boolean {
	return messageCount === 0 && (hasSelectedEmail || isHomeInitial);
}

export function canReplaceHomeSuggestions({
	isHomeInitial,
	isFrozen,
	messageCount,
}: {
	isHomeInitial: boolean;
	isFrozen: boolean;
	messageCount: number;
}): boolean {
	return isHomeInitial && !isFrozen && messageCount === 0;
}

export function AgentAvatar({ size = 16 }: { size?: number }) {
	return (
		<span
			data-testid="agent-avatar"
			aria-hidden="true"
			className="inline-flex shrink-0 items-center justify-center text-ink-3"
		>
			<SparkleIcon size={size} weight="fill" />
		</span>
	);
}

function makeId(prefix: string) {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return `${prefix}-${crypto.randomUUID()}`;
	}
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function sanitizeAssistantText(
	text: string,
	options: { trim?: boolean; preserveWhitespace?: boolean } = {},
): string {
	return sanitizeAgentDisplayText(text, options);
}

function executionFromError(err: unknown): AgentActionExecutionResult | null {
	if (!(err instanceof ApiError)) return null;
	const execution = err.body.execution;
	if (!execution || typeof execution !== "object") return null;
	const candidate = execution as Partial<AgentActionExecutionResult>;
	if (typeof candidate.ok !== "boolean" || typeof candidate.summary !== "string") {
		return null;
	}
	return candidate as AgentActionExecutionResult;
}

interface PendingActionResolutionOutcome {
	ok: boolean;
	execution?: AgentActionExecutionResult;
	error?: string;
}

interface WecliInstallFlow {
	action: AgentPendingAction;
	phase: "installing" | "success" | "error";
	startedAt: number;
	execution?: AgentActionExecutionResult;
	error?: string;
}

export function wecliInstallFailureDetail(
	execution: AgentActionExecutionResult | undefined,
	fallback: string | undefined,
): string | undefined {
	const failedItem = execution?.items?.find((item) => !item.ok);
	if (!failedItem && !fallback) return undefined;
	return getUserFacingError(
		failedItem?.error ?? fallback,
		"安装没有完成。请检查网络或 npm 权限后重试。",
	);
}

function pendingActionFromConfirmation(
	event: Extract<WemailAgentEvent, { type: "confirmation_requested" }>,
): AgentPendingAction {
	return {
		id: event.confirmation.id,
		actionType: event.confirmation.actionType as HighRiskActionType,
		description: event.confirmation.description,
		toolName: "confirmed_agent_action",
		inputJson: JSON.stringify(event.confirmation.parameters),
		riskReason: "此操作需要你明确确认后才能执行。",
		riskLevel: event.confirmation.riskLevel,
		conversationId: event.conversationId,
		parameters: event.confirmation.parameters,
		idempotencyKey: event.confirmation.idempotencyKey,
		expiresAt: event.confirmation.expiresAt,
		status:
			event.confirmation.status === "failed"
				? "confirmed"
				: event.confirmation.status,
		...(event.confirmation.status === "failed"
			? { executionState: "failed" as const }
			: {}),
	};
}

function isAgentPendingAction(value: unknown): value is AgentPendingAction {
	if (!value || typeof value !== "object") return false;
	const action = value as Partial<AgentPendingAction>;
	return (
		typeof action.id === "string" &&
		typeof action.actionType === "string" &&
		typeof action.description === "string" &&
		typeof action.toolName === "string" &&
		typeof action.inputJson === "string" &&
		typeof action.riskReason === "string" &&
		(action.riskLevel === "low" ||
			action.riskLevel === "medium" ||
			action.riskLevel === "high")
	);
}

export function pendingActionFromWemailEvent(
	event: WemailAgentEvent,
): AgentPendingAction | null {
	if (event.type === "confirmation_requested") {
		return pendingActionFromConfirmation(event);
	}
	if (
		event.type !== "tool_execution_completed" &&
		event.type !== "tool_execution_updated"
	) return null;
	const output = event.output;
	if (!output || typeof output !== "object" || Array.isArray(output)) return null;
	const pendingAction = (output as { pendingAction?: unknown }).pendingAction;
	return isAgentPendingAction(pendingAction) ? pendingAction : null;
}

export function configurationTaskFromWemailEvent(
	event: WemailAgentEvent,
): ConfigurationTaskSnapshot | null {
	if (
		event.type !== "tool_execution_completed" &&
		event.type !== "tool_execution_updated"
	) return null;
	const output = event.output;
	if (!output || typeof output !== "object" || Array.isArray(output)) return null;
	const task = (output as { configurationTask?: unknown }).configurationTask;
	if (!task || typeof task !== "object" || Array.isArray(task)) return null;
	const candidate = task as Partial<ConfigurationTaskSnapshot>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.accountId === "string" &&
		typeof candidate.revision === "number" &&
		typeof candidate.status === "string" &&
		Array.isArray(candidate.steps) &&
		Array.isArray(candidate.issues)
	) ? task as ConfigurationTaskSnapshot : null;
}

export function addPendingActionToList(
	existing: AgentPendingAction[] | undefined,
	action: AgentPendingAction,
): AgentPendingAction[] {
	const current = existing ?? [];
	if (current.some((candidate) => candidate.id === action.id)) return current;
	return [...current, action];
}

export function notifyAgentConfirmation(
	accountId: string | undefined,
	action: AgentPendingAction,
	notify:
		| ((input: {
				accountId: string;
				actionId: string;
				description: string;
		  }) => void)
		| undefined,
	suppressDesktop = false,
): void {
	if (!accountId || !notify || suppressDesktop) return;
	notify({
		accountId,
		actionId: action.id,
		description: action.description,
	});
}

function AgentChatConnected({ mailboxId }: { mailboxId: string }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const scrollRef = useRef<HTMLDivElement>(null);
	const scrollContentRef = useRef<HTMLDivElement>(null);
	const followLatestRef = useRef(true);
	const lastTouchYRef = useRef(0);
	const [promotedActionIds, setPromotedActionIds] = useState<string[]>([]);
	const [configurationTasks, setConfigurationTasks] = useState<
		Record<string, ConfigurationTaskSnapshot>
	>({});
	const [conversationState, setConversationState] = useState<ConversationState>(() =>
		createConversationState(mailboxId),
	);
	const conversationStateRef = useRef(conversationState);
	const [isStreaming, setIsStreaming] = useState(false);
	const [mailScope, setMailScope] = useState<AgentMailScope>("focused");
	const [attachedMails, setAttachedMails] = useState<AgentAttachedMail[]>([]);
	const isStreamingRef = useRef(false);
	const streamGenerationRef = useRef(0);
	const hydratedSessionIdRef = useRef<string | null>(null);
	const setStreaming = useCallback((value: boolean) => {
		isStreamingRef.current = value;
		setIsStreaming(value);
	}, []);
	const abortRef = useRef<AbortController | null>(null);
	const composerAgentContextRef = useRef<MailSceneActionContext | undefined>(undefined);
	// Jump-to-latest state. `isFar` is whether the user has scrolled far
	// enough up that we should surface the pill at all. `hasUnseen` is a
	// transient pulse flag we set whenever new content lands while the
	// user is far from the bottom — clears on scroll-back / click.
	const [isFar, setIsFar] = useState(false);
	const [hasUnseen, setHasUnseen] = useState(false);
	const isFarRef = useRef(false);
	const selectEmail = useUIStore((state) => state.selectEmail);
	const openSettings = useUIStore((state) => state.openSettings);
	const selectedEmailId = useUIStore((state) => state.selectedEmailId);
	const agentSessionMode = useUIStore((state) => state.agentSessionMode);
	const agentSessionId = useUIStore((state) => state.agentSessionId);
	const agentClearTick = useUIStore((state) => state.agentClearTick);
	const agentComposerRequest = useUIStore((state) => state.agentComposerRequest);
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	useEffect(() => {
		composerAgentContextRef.current = agentComposerRequest?.agentContext;
		if (agentComposerRequest?.agentContext) setMailScope("focused");
	}, [agentComposerRequest]);
	// The UI store owns every lifecycle transition. The panel consumes
	// its non-null id directly instead of reviving a mailbox-wide fallback.
	const effectiveSessionId = resolveAgentConversationId(agentSessionId);
	useEffect(() => {
		setPromotedActionIds([]);
		followLatestRef.current = true;
	}, [effectiveSessionId]);
	const isHomeInitial = agentSessionMode === "home-fresh";
	const persistedQuery = useAgentConversationState(isAgentPanelOpen ? effectiveSessionId : null);
	// High-risk pending actions for this conversation. Empty most of the
	// time; when populated, the cards render above the chat.
	const pendingActionsQuery = usePendingActions(effectiveSessionId, isAgentPanelOpen);
	const pendingActions = pendingActionsQuery.data ?? [];
	const resolvePendingAction = useResolvePendingAction();
	const [resolvingActionId, setResolvingActionId] = useState<string | null>(null);
	const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
	const [dismissedRecoveryActionId, setDismissedRecoveryActionId] = useState<
		string | null
	>(null);
	const [wecliInstallFlow, setWecliInstallFlow] =
		useState<WecliInstallFlow | null>(null);
	const [wecliInstallElapsedSeconds, setWecliInstallElapsedSeconds] = useState(0);
	// P2.5: the WeCLI install dialog is an edition-only code path. Without
	// the feature no install_wecli action can ever be produced here, so the
	// dialog stays closed and its entire flow is unreachable in open builds.
	const { wecli: wecliEnabled } = useEditionFeatures();
	const pendingWecliInstallAction = wecliEnabled
		? pendingActions.find(
				(action) =>
					action.actionType === "install_wecli" &&
					action.status === "pending" &&
					action.id !== dismissedRecoveryActionId,
			)
		: undefined;
	const wecliInstallAction =
		wecliInstallFlow?.action ?? pendingWecliInstallAction;
	const publishPendingAction = useCallback(
		(action: AgentPendingAction) => {
			queryClient.setQueryData<AgentPendingAction[]>(
				pendingActionsQueryKey(effectiveSessionId),
				(existing) => addPendingActionToList(existing, action),
			);
			void queryClient.invalidateQueries({
				queryKey: pendingActionsQueryKey(effectiveSessionId),
			});
				notifyAgentConfirmation(
					mailboxId,
					action,
					window.wemailDesktop?.notifyAgentConfirmation,
					typeof document !== "undefined" && document.hasFocus(),
				);
		},
		[effectiveSessionId, mailboxId, queryClient],
	);

	useEffect(() => {
		setDismissedRecoveryActionId(null);
		setWecliInstallFlow(null);
		setWecliInstallElapsedSeconds(0);
		setConfigurationTasks({});
	}, [effectiveSessionId]);

	useEffect(() => {
		if (wecliInstallFlow?.phase !== "installing") {
			setWecliInstallElapsedSeconds(0);
			return;
		}
		const updateElapsed = () => {
			setWecliInstallElapsedSeconds(
				Math.max(
					0,
					Math.floor((Date.now() - wecliInstallFlow.startedAt) / 1_000),
				),
			);
		};
		updateElapsed();
		const timer = window.setInterval(updateElapsed, 1_000);
		return () => window.clearInterval(timer);
	}, [wecliInstallFlow]);

	useEffect(() => {
		const targetId = window.sessionStorage.getItem("wemail.pending-action-target");
		if (!targetId || !pendingActions.some((action) => action.id === targetId)) return;
		const target = document.querySelector(`[data-action-id="${CSS.escape(targetId)}"]`);
		if (!target) return;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		window.sessionStorage.removeItem("wemail.pending-action-target");
	}, [pendingActions]);

	useEffect(() => {
		const runId = window.sessionStorage.getItem("wemail.agent-run-target");
		if (!runId) return;
		const target = document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
		if (!target) return;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		window.sessionStorage.removeItem("wemail.agent-run-target");
	}, [conversationState.messageOrder, effectiveSessionId]);

	useEffect(() => {
		const sessionChanged = hydratedSessionIdRef.current !== effectiveSessionId;
		if (sessionChanged) {
			abortRef.current?.abort();
			streamGenerationRef.current += 1;
			setStreaming(false);
			hydratedSessionIdRef.current = effectiveSessionId;
		} else if (isStreamingRef.current) {
			// A follow-up enqueue/refetch can update the persisted snapshot while
			// the current stream is still authoritative. Do not abort that stream
			// or replace its optimistic state with a stale snapshot.
			return;
		}
		const restored = persistedQuery.data ?? createConversationState(effectiveSessionId);
		conversationStateRef.current = restored;
		setConversationState(restored);
	}, [effectiveSessionId, persistedQuery.data, setStreaming]);

	// Brand-bar trash button drops `agentClearTick`. Reset both the
	// in-memory chat surface and any in-flight stream — the matching
	// `agentSessionId` rotation in the store is what kicks off a fresh
	// server-side conversation on the next send.
	useEffect(() => {
		if (agentClearTick === 0) return;
		abortRef.current?.abort();
		const cleared = createConversationState(effectiveSessionId);
		conversationStateRef.current = cleared;
		setConversationState(cleared);
		streamGenerationRef.current += 1;
		setStreaming(false);
	}, [agentClearTick, effectiveSessionId, setStreaming]);
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: selectedEmail } = useEmail(
		mailboxId,
		isAgentPanelOpen ? selectedEmailId ?? undefined : undefined,
	);
	useEffect(() => setMailScope("focused"), [selectedEmailId]);
	// The focused mail renders as the default @-attached chip in the prompt
	// bar; dismissing it (✕) flips the scope to the whole mailbox.
	const focusedMailAttachedEmailId = mailScope === "focused"
		? agentSessionMode === "email-trace"
			? agentSessionId
			: selectedEmailId ?? undefined
		: undefined;
	const focusedMail = focusedMailAttachedEmailId
		? {
				emailId: focusedMailAttachedEmailId,
				subject: selectedEmail?.subject || "当前邮件",
				sender: selectedEmail?.sender || undefined,
				receivedAt: selectedEmail?.date || undefined,
			}
		: undefined;
	const displayName =
		mailbox?.settings?.fromName ||
		mailbox?.name ||
		mailbox?.email?.split("@")[0] ||
		"there";

	// Follow intent survives content growth; only user navigation pauses it.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (followLatestRef.current) {
			el.scrollTop = el.scrollHeight;
			return;
		}
		if (isFarRef.current) {
			setHasUnseen(true);
		}
	}, [conversationState, pendingActions, promotedActionIds]);
	useEffect(() => {
		const el = scrollRef.current;
		const content = scrollContentRef.current;
		if (!el || !content) return;
		const observer = new ResizeObserver(() => {
			if (followLatestRef.current) el.scrollTop = el.scrollHeight;
			else setHasUnseen(true);
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	// Track scroll position so we know when to show / hide the pill.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () => {
			if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) followLatestRef.current = true;
			const far = computeFarFromBottom({
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
			});
			isFarRef.current = far;
			setIsFar(far);
			if (!far) setHasUnseen(false);
		};
		update();
		el.addEventListener("scroll", update, { passive: true });
		return () => {
			el.removeEventListener("scroll", update);
		};
	}, []);

	const handleResolvePendingAction = useCallback(
		async (
			action: AgentPendingAction,
			status: "confirmed" | "rejected",
		): Promise<PendingActionResolutionOutcome> => {
			followLatestRef.current = true;
			setPromotedActionIds((current) => [...current.filter((id) => id !== action.id), action.id]);
			setResolvingActionId(action.id);
			setActionErrors((current) => ({ ...current, [action.id]: "" }));
			try {
				const result = await resolvePendingAction.mutateAsync({
					id: action.id,
					status,
					...(status === "confirmed"
						? {
								idempotencyKey: action.idempotencyKey,
								parameters: action.parameters,
							}
						: {}),
					...(action.actionType === "install_wecli" && status === "confirmed"
						? { timeoutMs: 135_000 }
						: {}),
				});
				if (action.actionType === "configure_automation_rule") {
					try {
						const payload = JSON.parse(action.inputJson) as {
							configurationTaskId?: string;
							configurationTaskRevision?: number;
						};
						if (payload.configurationTaskId) {
							const response = status === "rejected"
								? await api.cancelConfigurationTask(
										payload.configurationTaskId,
										configurationTasks[payload.configurationTaskId]?.revision ??
											payload.configurationTaskRevision ??
											1,
									)
								: await api.getConfigurationTask(payload.configurationTaskId);
							setConfigurationTasks((current) => ({
								...current,
								[response.snapshot.id]: response.snapshot,
							}));
						}
					} catch {
						// The action result remains authoritative; a later snapshot read
						// reconciles a stale or temporarily unavailable card.
					}
				}
				if (result.accepted && result.task) {
					const task = result.task;
					queryClient.setQueryData<AgentPendingAction[]>(pendingActionsQueryKey(effectiveSessionId),
						(current) => current?.map((item) => item.id === action.id ? applyActionExecution(item, task) : item));
					return { ok: true };
				}
				const resolved = resolveConversationConfirmation(
					conversationStateRef.current,
					action.id,
					status,
				);
				conversationStateRef.current = resolved;
				setConversationState(resolved);
				void queryClient.invalidateQueries({
					queryKey: ["agent-conversation-state", effectiveSessionId],
				});
				return {
					ok: true,
					...(result.execution ? { execution: result.execution } : {}),
				};
			} catch (err) {
				if (status === "confirmed" && action.actionType === "upload_allowance_invoices") {
					if (err instanceof ApiError && [400, 403, 404, 409].includes(err.status)) {
						const message = getUserFacingError(typeof err.body.detail === "string" ? err.body.detail : err,
							"确认未被接受，请刷新原确认清单。");
						setActionErrors((current) => ({ ...current, [action.id]: message }));
						return { ok: false, error: message };
					}
					try {
						const { task } = await api.getActionExecution(action.id);
						queryClient.setQueryData<AgentPendingAction[]>(pendingActionsQueryKey(effectiveSessionId),
							(current) => current?.map((item) => item.id === action.id ? applyActionExecution(item, task) : item));
						return { ok: true };
					} catch {
						setActionErrors((current) => ({ ...current, [action.id]: "暂时无法确认提交结果。请刷新原任务状态，不要重新生成上传清单。" }));
					}
				}
				const execution = executionFromError(err);
				const error = getUserFacingError(
					err,
					`操作没有完成：${action.description}`,
				);
				if (action.actionType !== "upload_allowance_invoices") setActionErrors((current) => ({ ...current, [action.id]: error }));
				if (execution) {
					queryClient.setQueryData<AgentPendingAction[]>(
						pendingActionsQueryKey(effectiveSessionId),
						(current) => current?.map((item) => item.id === action.id
							? {
									...item,
									status: "confirmed",
									executionState: "failed",
									executionResult: { ...execution },
								}
							: item),
					);
					const resolved = resolveConversationConfirmation(
						conversationStateRef.current,
						action.id,
						"failed",
					);
					conversationStateRef.current = resolved;
					setConversationState(resolved);
				}
				void queryClient.invalidateQueries({
					queryKey: ["agent-conversation-state", effectiveSessionId],
				});
				return {
					ok: false,
					...(execution ? { execution } : {}),
					error,
				};
			} finally {
				setResolvingActionId(null);
			}
		},
		[
			effectiveSessionId,
			queryClient,
			resolvePendingAction,
			configurationTasks,
		],
	);

	const handleConfirmWecliInstall = useCallback(async () => {
		if (!wecliInstallAction || wecliInstallFlow?.phase === "installing") return;
		const action = wecliInstallAction;
		const startedAt = Date.now();
		setWecliInstallFlow({
			action,
			phase: "installing",
			startedAt,
		});
		const outcome = await handleResolvePendingAction(action, "confirmed");
		if (outcome.ok && outcome.execution?.ok) {
			setWecliInstallFlow({
				action,
				phase: "success",
				startedAt,
				execution: outcome.execution,
			});
			return;
		}
		setWecliInstallFlow({
			action,
			phase: "error",
			startedAt,
			...(outcome.execution ? { execution: outcome.execution } : {}),
			error: outcome.error || getUserFacingError(
				outcome.execution?.summary,
				"安装接口没有返回可确认的成功结果。",
			),
		});
	}, [handleResolvePendingAction, wecliInstallAction, wecliInstallFlow?.phase]);

	const closeWecliInstallDialog = useCallback(() => {
		if (!wecliInstallAction || wecliInstallFlow?.phase === "installing") return;
		if (!wecliInstallFlow) {
			setDismissedRecoveryActionId(wecliInstallAction.id);
			void handleResolvePendingAction(wecliInstallAction, "rejected");
		} else {
			setDismissedRecoveryActionId(wecliInstallAction.id);
			setWecliInstallFlow(null);
			window.setTimeout(() => {
				const composer = document.querySelector<HTMLTextAreaElement>(
					"#agent-chat-input",
				);
				composer?.focus();
			}, 0);
		}
	}, [
		handleResolvePendingAction,
		wecliInstallAction,
		wecliInstallFlow,
	]);

	const jumpToLatest = useCallback(() => {
		followLatestRef.current = true;
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
		setHasUnseen(false);
	}, []);

	const sendMessage = async ({
		text,
		semanticAction,
		agentContext,
		explicitAttachedMails,
	}: {
		text: string;
		semanticAction?: AgentSuggestion;
		agentContext?: MailSceneActionContext;
		explicitAttachedMails?: AgentAttachedMail[];
	}) => {
		const userText = sanitizeAssistantText(text.trim());
		if (!userText) return;
		const userId = makeId("user");
		const assistantId = makeId("assistant");
		const runId = makeId("run");
		const startedAt = new Date().toISOString();
		const controller = new AbortController();
		const streamGeneration = ++streamGenerationRef.current;
		abortRef.current = controller;
		const applyCanonicalEvents = (events: WemailAgentEvent[]) => {
			const next = events.reduce(reduceConversationState, conversationStateRef.current);
			conversationStateRef.current = next;
			startTransition(() => setConversationState(next));
			if (events.some((event) => event.type === "artifact_ready")) {
				void queryClient.invalidateQueries({
					queryKey: ["application-messages", mailboxId],
				});
			}
		};
		// The focused mail is the default attachment (opening a mail detail
		// @'s it); explicit @ picks stack on top of it, deduped by emailId.
		const sentAttachedMails = [
			...(focusedMail ? [focusedMail] : []),
			...(explicitAttachedMails ?? []),
		].filter((mail, index, all) =>
			all.findIndex((item) => (item.emailId ?? item.subject) === (mail.emailId ?? mail.subject)) === index);
		const attachedMail = sentAttachedMails[0];
		const attachedThreadId = sentAttachedMails.length === 1 && focusedMail && attachedMail?.emailId === focusedMail.emailId
			? selectedEmail?.thread_id ?? undefined
			: undefined;
		const messageContext = buildAgentMessagePresentationContext(
			agentContext,
			attachedMail,
			mailScope,
			sentAttachedMails,
		);
		const optimisticState = conversationStateRef.current;
		const withUserMessage: ConversationState = {
			...optimisticState,
			messageOrder: [...optimisticState.messageOrder, userId],
			messages: {
				...optimisticState.messages,
				[userId]: {
					id: userId,
					role: "user",
					state: "completed",
					...(messageContext ? { messageContext } : {}),
					parts: [{
						id: `text:${userId}`,
						type: "text",
						markdown: userText,
						state: "completed",
						citationIds: [],
					}],
					createdAt: startedAt,
					updatedAt: startedAt,
				},
			},
		};
		conversationStateRef.current = withUserMessage;
		followLatestRef.current = true;
		setConversationState(withUserMessage);
		setStreaming(true);

		const upsertAssistantEvent = (event: WemailAgentEvent) => {
			applyCanonicalEvents([event]);
		};

		let completedNormally = false;
		let activeServerRunId: string | undefined;
		try {
			await api.streamAgentChat(
				{
					userText,
					sessionId: effectiveSessionId,
					accountId: mailboxId,
					emailId: attachedMail?.emailId,
					threadId: attachedThreadId,
					attachedMail,
					...(sentAttachedMails.length > 0 ? { attachedMails: sentAttachedMails } : {}),
					messageContext,
					context: buildAgentMessageContext(
						{
							mailboxId,
							accountId: mailboxId,
							emailId: attachedMail?.emailId,
							threadId: attachedThreadId,
							timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							locale: navigator.language,
							mailScope,
						},
						semanticAction,
						agentContext,
					),
				},
				{
					onEvent: (event) => {
						activeServerRunId = event.runId;
						if (
							event.type === "run_failed" &&
							mailboxId &&
							!(typeof document !== "undefined" && document.hasFocus())
						) {
							window.wemailDesktop?.notifyAgentRun?.({
								accountId: mailboxId,
								conversationId: effectiveSessionId,
								runId: event.runId,
								state: "failed",
							});
						}
						const configurationTask = configurationTaskFromWemailEvent(event);
						if (configurationTask) {
							setConfigurationTasks((current) => {
								const previous = current[configurationTask.id];
								if (previous && previous.revision >= configurationTask.revision) return current;
								return { ...current, [configurationTask.id]: configurationTask };
							});
						}
						const pendingAction = pendingActionFromWemailEvent(event);
						if (pendingAction) publishPendingAction(pendingAction);
						upsertAssistantEvent(event);
						if (
							streamGenerationRef.current === streamGeneration &&
							(event.type === "run_settled" ||
								event.type === "run_stopped" ||
								event.type === "run_failed")
						) {
							// The terminal protocol event is authoritative. Do not keep
							// the composer in follow-up mode while the HTTP stream is
							// finishing its final flush.
							setStreaming(false);
						}
					},
				},
				{ signal: controller.signal },
			);
			completedNormally = true;
		} catch (err) {
			if ((err as Error).name !== "AbortError") {
				const failedRunId = activeServerRunId ?? runId;
				const currentRun = conversationStateRef.current.runs[failedRunId];
				const failureEvents: WemailAgentEvent[] = [];
				if (!currentRun) {
					failureEvents.push({
						schemaVersion: 1,
						conversationId: effectiveSessionId,
						runId: failedRunId,
						messageId: assistantId,
						sequence: 0,
						timestamp: new Date().toISOString(),
						type: "run_started",
					});
				}
				failureEvents.push({
					schemaVersion: 1,
					conversationId: effectiveSessionId,
					runId: failedRunId,
					messageId: assistantId,
					sequence: (currentRun?.lastSequence ?? 0) + 1,
					timestamp: new Date().toISOString(),
					type: "run_failed",
					code: "renderer_transport_error",
					message: getUserFacingError(err, "Agent 请求没有完成，请稍后重试。"),
					retryable: true,
				});
				applyCanonicalEvents(failureEvents);
			}
		} finally {
			if (streamGenerationRef.current === streamGeneration) {
				setStreaming(false);
				if (abortRef.current === controller) abortRef.current = null;
				void queryClient.invalidateQueries({
					queryKey: ["agent-conversation-state", effectiveSessionId],
				});
				if (completedNormally) void persistedQuery.refetch();
			}
		}
	};

	const handleSuggestionClick = (suggestion: AgentSuggestion) => {
		if (isStreamingRef.current) return;
		composerAgentContextRef.current = undefined;
		const semanticAction = semanticActionFromSuggestion(suggestion);
		if (semanticAction) {
			void sendMessage({ text: suggestion.prompt, semanticAction });
			return;
		}
		const action = suggestion.action;
		if (action?.type === "open_digest_center") {
			navigate(digestCenterPath(action.filter));
			return;
		}
		if (action?.type === "open_settings") {
			navigate("/digests");
			return;
		}
		if (action?.type === "agent_prompt") {
			void sendMessage({ text: action.prompt });
			return;
		}
		// Keep the prompt fallback for old servers and future unknown actions.
		void sendMessage({ text: suggestion.prompt });
	};

	const stop = () => {
		abortRef.current?.abort();
		const activeRun = Object.values(conversationStateRef.current.runs).find((run) =>
			["queued", "running", "retrying", "stopping"].includes(run.state),
		);
		if (activeRun) {
			const next = reduceConversationState(conversationStateRef.current, {
				schemaVersion: 1,
				conversationId: effectiveSessionId,
				runId: activeRun.id,
				sequence: activeRun.lastSequence + 1,
				timestamp: new Date().toISOString(),
				type: "run_stopped",
				reason: "用户已停止生成",
			});
			conversationStateRef.current = next;
			setConversationState(next);
		}
		const pausedState = pauseConversationFollowups(
			conversationStateRef.current,
			"user_stopped",
		);
		conversationStateRef.current = pausedState;
		setConversationState(pausedState);
		setStreaming(false);
	};

	const updateFollowupState = useCallback(
		(update: (state: ConversationState) => ConversationState) => {
			const next = update(conversationStateRef.current);
			conversationStateRef.current = next;
			setConversationState(next);
		},
		[],
	);

	const handleComposerSubmit = (text: string) => {
		const agentContext = composerAgentContextRef.current;
		composerAgentContextRef.current = undefined;
		if (!isStreamingRef.current) {
			const explicitAttachedMails = attachedMails;
			setAttachedMails([]);
			void sendMessage({ text, agentContext, explicitAttachedMails });
			return;
		}
		const optimisticId = makeId("followup");
		updateFollowupState((state) =>
			queueConversationFollowup(state, { id: optimisticId, text }),
		);
		void api.enqueueAgentFollowup(effectiveSessionId, text, mailboxId)
			.then(() => persistedQuery.refetch())
			.catch(() => {
				updateFollowupState((state) => removeConversationFollowup(state, optimisticId));
			});
	};

	const visibleFollowups = conversationState.followupOrder
		.map((id) => conversationState.followups[id])
		.filter((item) => !!item && item.state !== "removed");

	const handleResumeFollowups = () => {
		void api.resumeAgentFollowups(effectiveSessionId).then(() => persistedQuery.refetch());
	};

	// Suggestions come from the backend (`useAgentSuggestions`). When
	// the backend returns nothing, fall back to a single default chip
	// per the agreed mock contract — no hardcoded multi-chip list.
	const suggestionsQuery = useAgentSuggestions({
		mailboxId,
		emailId: selectedEmailId,
		enabled: isAgentPanelOpen,
	});
	const contextSuggestions = useMemo(() => {
		const data = suggestionsQuery.data?.suggestions ?? [];
		return resolveContextSuggestions(data, !!selectedEmailId);
	}, [selectedEmailId, suggestionsQuery.data]);
	const showSuggestions = shouldShowAgentSuggestions({
		messageCount: conversationState.messageOrder.length,
		hasSelectedEmail: !!selectedEmailId,
		isHomeInitial,
	});
	const renderConfirmationCard = useCallback(
		(confirmationId: string) => {
			const action = pendingActions.find((item) => item.id === confirmationId);
			if (!action || action.actionType === "install_wecli") return null;
			if (promotedActionIds.includes(action.id) || action.executionState === "executing") {
				return <div className="text-meta text-ink-3">操作进度已移至最新对话下方。</div>;
			}
			const status = action.status ?? "pending";
			const executionState = action.executionState ?? "not_started";
			// Only live cards render inline in the thread; settled confirmations
			// fall back to the compact timeline chip.
			const retainedUpload = action.actionType === "upload_allowance_invoices" && (executionState === "failed" || executionState === "outcome_unknown");
			if (!retainedUpload && !action.executionResult?.task && (status !== "pending" || executionState !== "not_started")) {
				return null;
			}
			return (
				<PendingActionCard
					action={action}
					isResolving={resolvingActionId === action.id}
					error={action.executionResult?.task ? undefined : actionErrors[action.id]}
					onRefresh={() => void pendingActionsQuery.refetch()}
					onConfirm={() => void handleResolvePendingAction(action, "confirmed")}
					onReject={() => void handleResolvePendingAction(action, "rejected")}
				/>
			);
		},
		[pendingActions, resolvingActionId, handleResolvePendingAction, actionErrors, pendingActionsQuery.refetch, promotedActionIds],
	);
	// The bottom stack is only for live actions with no conversation anchor
	// (e.g. MCP-origin requests); anchored cards render inside the thread.
	const inlinePendingActions = pendingActions.filter(
		(action) =>
			action.actionType !== "install_wecli" &&
			(!!action.executionResult?.task || ((action.status ?? "pending") === "pending" &&
			((action.executionState ?? "not_started") === "not_started" ||
				action.executionState === "executing"))) &&
			(!conversationState.confirmations[action.id] || promotedActionIds.includes(action.id) || action.executionState === "executing"),
	).sort((a, b) => promotedActionIds.indexOf(a.id) - promotedActionIds.indexOf(b.id));
	const wecliInstallDialogFeedback = wecliInstallFlow
		? wecliInstallFlow.phase === "installing"
			? {
					status: "running" as const,
					title: "正在安装 WeCLI",
					description:
						"安装命令正在执行。完成、失败或达到超时上限后，这里会给出明确结果。",
					progressText: `已等待 ${wecliInstallElapsedSeconds} 秒 · 最长等待 120 秒`,
				}
			: wecliInstallFlow.phase === "success"
				? {
						status: "success" as const,
						title: "WeCLI 安装成功",
						description:
							"安装已经完成。关闭此窗口回到对话后，请重新发送刚才需要 WeCLI 的请求。",
						closeLabel: "返回对话",
					}
				: {
						status: "error" as const,
						title: "WeCLI 安装失败",
						description:
							wecliInstallFlow.error ||
							"安装没有完成。请根据下面的错误信息检查网络或 npm 权限。",
						detail: wecliInstallFailureDetail(
							wecliInstallFlow.execution,
							wecliInstallFlow.error,
						),
						closeLabel: "返回对话",
					}
		: undefined;
	const pendingActionCards =
		inlinePendingActions.length > 0 ? (
			<div className="flex flex-col gap-2" data-testid="pending-actions-stack">
				{inlinePendingActions.map((action) => (
					<PendingActionCard
						key={action.id}
						action={action}
						isResolving={resolvingActionId === action.id}
						error={action.executionResult?.task ? undefined : actionErrors[action.id]}
						onRefresh={() => void pendingActionsQuery.refetch()}
						onConfirm={() =>
							void handleResolvePendingAction(action, "confirmed")
						}
						onReject={() =>
							void handleResolvePendingAction(action, "rejected")
						}
					/>
				))}
			</div>
		) : null;

	return (
		<TooltipProvider>
			<div className="flex h-full flex-col bg-paper-2">
				{/* Messages — wrapped in a relative container so the floating
					"Jump to latest" pill can anchor to the bottom of the scroll
					region without escaping the panel. */}
				<div className="relative flex-1 min-h-0">
				<div ref={scrollRef} className="absolute inset-0 overflow-y-auto px-5 py-4"
					onWheelCapture={(event) => { if (event.deltaY < 0) followLatestRef.current = false; }}
					onPointerDownCapture={(event) => { if (event.target === event.currentTarget) followLatestRef.current = false; }}
					onTouchStartCapture={(event) => { lastTouchYRef.current = event.touches[0]?.clientY ?? 0; }}
					onTouchMoveCapture={(event) => {
						const y = event.touches[0]?.clientY ?? lastTouchYRef.current;
						if (y > lastTouchYRef.current) followLatestRef.current = false;
						lastTouchYRef.current = y;
					}}
					onKeyDownCapture={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) followLatestRef.current = false; }}>
				<div ref={scrollContentRef}>
					{conversationState.messageOrder.length === 0 ? (
						<div className="flex h-full flex-col justify-end pb-8">
							{pendingActionCards ?? (
								<div className="mx-auto flex max-w-[240px] flex-col items-center text-center">
									<div className="mb-3 text-ink-3">
										<AgentAvatar size={24} />
									</div>
									<h3 className="text-title font-semibold leading-tight text-ink">
										你好，{displayName}
									</h3>
									<p className="mt-1.5 text-meta leading-relaxed text-ink-3">
										{suggestionsQuery.data?.contextLine ??
											"可以帮你搜索邮件、生成摘要，或根据当前邮件起草回复。"}
									</p>
								</div>
							)}
						</div>
					) : (
						<div className="flex flex-col gap-3">
							<AgentConversationThread
								state={conversationState}
								isStreaming={isStreaming}
								accountId={mailboxId}
								onOpenEmail={(emailId) => selectEmail(emailId)}
								onFollowup={(text) => sendMessage({ text })}
								renderConfirmationCard={renderConfirmationCard}
							/>
							{pendingActionCards}
							{import.meta.env.VITE_WEMAIL_INLINE_CONFIGURATION !== "0"
								? Object.values(configurationTasks).map((task) => (
								<ConfigurationTaskCard
									key={task.id}
									task={task}
									onAction={(action) => {
										if (action.target && action.type === "open_settings") {
											openSettings("connections");
											return;
										}
										sendMessage({ text: action.label });
									}}
								/>
								))
								: null}
						</div>
					)}
				</div>
				</div>
				{isFar ? (
					<button
						type="button"
						onClick={jumpToLatest}
						aria-label="跳到最新消息"
						data-testid="agent-jump-to-latest"
						className={`agent-jump-pill ${hasUnseen ? "agent-jump-pill-unseen" : ""}`}
					>
						<ArrowDownIcon size={12} weight="bold" />
						<span>最新</span>
						{hasUnseen ? (
							<span className="agent-jump-pill-dot" aria-hidden="true" />
						) : null}
					</button>
				) : null}
				</div>

				{/* Bottom: suggestions + input. Turn context is rendered with the sent message. */}
				<div className="shrink-0 space-y-3 px-5 pb-4 pt-2">
					{showSuggestions ? (
						<div className="flex flex-col items-start gap-2" aria-live="polite">
							{suggestionsQuery.isPending ? (
								<p className="px-1 text-ui text-ink-3">正在分析行动建议…</p>
							) : suggestionsQuery.isError ? (
								<button
									type="button"
									onClick={() => void suggestionsQuery.refetch()}
									className="wemail-pill inline-flex min-h-10 items-center gap-1.5 px-3.5 py-2 text-ui text-ink"
								>
									<MagnifyingGlassIcon size={12} weight="bold" className="shrink-0 text-coral" />
									<span>行动建议暂不可用，重试</span>
								</button>
							) : contextSuggestions.length === 0 ? (
								<button
									type="button"
									disabled={isStreaming}
									onClick={() => void sendMessage({
										text: selectedEmailId
											? "分析当前邮件，并告诉我下一步最值得处理的行动。"
											: "查看当前邮箱，告诉我现在最值得处理的邮件行动。",
									})}
									className="wemail-pill inline-flex min-h-10 max-w-full items-center gap-1.5 px-3.5 py-2 text-ui text-ink disabled:cursor-not-allowed disabled:opacity-50"
								>
									<MagnifyingGlassIcon size={12} weight="bold" className="shrink-0 text-coral" />
									<span className="truncate">
										{selectedEmailId ? "给出下一步建议" : "查看当前需要处理的邮件"}
									</span>
								</button>
							) : contextSuggestions.map((s) => (
								<button
									key={s.id}
									type="button"
									disabled={isStreaming}
									onClick={() => handleSuggestionClick(s)}
									className="wemail-pill inline-flex min-h-10 max-w-full items-center gap-1.5 px-3.5 py-2 text-ui text-ink disabled:cursor-not-allowed disabled:opacity-50"
								>
									<MagnifyingGlassIcon size={12} weight="bold" className="text-coral shrink-0" />
									<span className="truncate">{s.label}</span>
								</button>
							))}
						</div>
					) : null}

					<AgentComposer
						accountId={mailboxId}
						conversationId={effectiveSessionId}
						inputRequest={agentComposerRequest}
						isStreaming={isStreaming}
						focusedMail={focusedMail}
						onDismissFocusedMail={() => setMailScope("mailbox")}
						attachedMails={attachedMails}
						onAttachMail={(mail) => {
							setAttachedMails((current) => {
								const key = mail.emailId ?? mail.subject;
								if (current.some((item) => (item.emailId ?? item.subject) === key)) return current;
								if (current.length >= 10) return current;
								return [...current, mail];
							});
						}}
						onRemoveAttachedMail={(key) => {
							setAttachedMails((current) =>
								current.filter((item) => (item.emailId ?? item.subject) !== key));
						}}
						followups={visibleFollowups}
						onSubmit={handleComposerSubmit}
						onStop={stop}
						onUpdateFollowup={(id, text) => {
							updateFollowupState((state) => updateConversationFollowup(state, id, text));
			void api.updateAgentFollowup(effectiveSessionId, id, text)
								.then(() => persistedQuery.refetch())
								.catch(() => persistedQuery.refetch());
						}}
						onRemoveFollowup={(id) => {
							updateFollowupState((state) => removeConversationFollowup(state, id));
			void api.removeAgentFollowup(effectiveSessionId, id)
								.then(() => persistedQuery.refetch())
								.catch(() => persistedQuery.refetch());
						}}
						onMoveFollowup={(id, direction) => {
							const current = visibleFollowups.findIndex((item) => item.id === id);
							if (current < 0) return;
							updateFollowupState((state) => moveConversationFollowup(state, id, direction));
			void api.moveAgentFollowup(effectiveSessionId, id, current + direction)
								.then(() => persistedQuery.refetch())
								.catch(() => persistedQuery.refetch());
						}}
						onResumeFollowups={handleResumeFollowups}
					/>
				</div>
			</div>
			<AgentActionConfirmDialog
				open={!!wecliInstallAction}
				title={wecliInstallFlow ? "WeCLI 安装" : "安装可选组件 WeCLI？"}
				description={
					wecliInstallFlow
						? "WeMail 本身不依赖 WeCLI；此安装流程只影响需要企业命令的功能。"
						: [
								"WeMail 本身不依赖 WeCLI；暂不安装不会影响邮件、摘要、规则等其他功能。",
								"",
								"确认后将执行：",
								typeof wecliInstallAction?.parameters?.command === "string"
								? wecliInstallAction.parameters.command
								: "企业内网提供的安装命令",
								"",
								"注意：该安装源只能在企业内网环境中使用。",
							].join("\n")
				}
				dangerous={!wecliInstallFlow || wecliInstallFlow.phase === "error"}
				confirmLabel="确认安装"
				cancelLabel="暂不安装"
				feedback={wecliInstallDialogFeedback}
				onConfirm={() => void handleConfirmWecliInstall()}
				onCancel={closeWecliInstallDialog}
			/>
		</TooltipProvider>
	);
}

export default function AgentPanel() {
	const { mailboxId: paramMailboxId } = useParams<{ mailboxId: string }>();
	const { data: currentAccount } = useCurrentAccount();
	// Prefer the URL mailboxId for legacy routes, but the workbench routes
	// don't carry it — fall back to the signed-in account so the AI panel
	// has the right context outside `/mailbox/:mailboxId`.
	const mailboxId = paramMailboxId || currentAccount?.account?.id || "default";
	return <AgentChatConnected mailboxId={mailboxId} />;
}
