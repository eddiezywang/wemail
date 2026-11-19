// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { Folders, isSentFolder } from "shared/folders";
import { toast } from "sonner";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import { Skeleton } from "~/components/ui/skeleton";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import MessageSenderBar from "~/components/email-panel/MessageSenderBar";
import SingleMessageView, {
	SingleMessageActions,
} from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import { CreateTodoDialog } from "~/components/email-panel/CreateTodoDialog";
import { AutomationRuleForm } from "~/components/automation/AutomationRuleForm";
import { ArtifactViewer } from "~/components/applicationMessages/ArtifactViewer";
import { EmailIntelligenceSection, QuickReplyPane } from "~/components/email-panel/EmailIntelligenceSection";
import { parseSearchQuery } from "~/lib/search-parser";
import { parseAddressList, splitEmailList } from "~/lib/utils";
import { getUserFacingError, resolvePublicError } from "~/lib/user-facing-error";
import { folderRole } from "~/lib/folderRole";
import api, {
	getApiEndpointRuntimeState,
	subscribeApiEndpointRuntimeState,
} from "~/services/api";
import { releaseAutoRead, requestAutoRead, scheduleIdleTask, useDeleteEmail, useEmail, useMoveEmail, useSendDraft, useThreadReplies, useUpdateEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useFolders } from "~/queries/folders";
import { useCurrentAccount } from "~/queries/currentAccount";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email, Mailbox } from "~/types";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import type { InsightReportSummary } from "shared/wemail/designArtifacts";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";

const DRAFT_BODY_LOAD_TIMEOUT_MS = 10_000;

// DEV-only: stamp when the EmailPanel chunk first evaluates. EmailPanel is
// lazy-loaded (lazy(() => import(...))), so the first open pays a dynamic
// import + parse cost. Pair this t= with the [action] mail-row-click t= to
// see whether the chunk load is the ~150ms "mount" cost. Remove after the
// mail-open latency investigation concludes.
if (import.meta.env.DEV) {
	console.debug(`[email-panel] module-eval t=${Math.round(performance.now())}`);
}

function hasInvoiceContext(email: Email): boolean {
	return email.invoiceDetected === true ||
		email.invoiceStatusState != null ||
		email.invoiceStatus?.tag != null ||
		(email.invoiceStatus?.statuses.length ?? 0) > 0;
}

async function loadCompleteDraft(
	mailboxId: string,
	draft: Email,
	signal: AbortSignal,
): Promise<Email> {
	if (draft.body != null && draft.bodyPending !== true) return draft;
	const database = window.wemailDesktop?.mailDatabase;
	if (!database?.onChanged) {
		const current = await api.getEmail(mailboxId, draft.id, { signal }) as Email;
		if (current.bodyPending !== true) return current;
		throw new Error("draft-body-event-source-unavailable");
	}
	return new Promise<Email>((resolve, reject) => {
		let settled = false;
		let reading = false;
		const finish = (error?: unknown, email?: Email) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
			if (error) reject(error);
			else resolve(email!);
		};
		const readCommittedBody = async () => {
			if (reading || settled) return;
			reading = true;
			try {
				const current = await api.getEmail(mailboxId, draft.id, { signal }) as Email;
				if (current.bodyPending !== true) finish(undefined, current);
			} catch (error) {
				finish(error);
			} finally {
				reading = false;
			}
		};
		const unsubscribe = database.onChanged((event) => {
			if (event.changes.some((change) =>
				change.entityPublicId === draft.id && change.entityType === "content"
			)) void readCommittedBody();
		});
		const timeout = window.setTimeout(
			() => finish(new Error("draft-body-load-timeout")),
			DRAFT_BODY_LOAD_TIMEOUT_MS,
		);
		const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		void api.ensureEmailBody(mailboxId, draft.id).then((result) => {
			if (result.status === "ready") void readCommittedBody();
		}).catch((error) => finish(error));
	});
}

function EmailPanelSkeleton({ recovering = false }: { recovering?: boolean }) {
	// Delayed (S1): fast opens skip the skeleton entirely; shapes mirror the
	// real detail layout so nothing jumps when content lands.
	const visible = useDelayedFlag(true);
	if (!visible && !recovering) return null;
	return (
		<div className="h-full overflow-hidden bg-workbench-surface">
			{recovering ? (
				<div className="border-b border-coral/20 bg-coral/5 px-5 py-3 text-sm text-coral">
					邮件服务正在恢复，连接完成后会自动继续加载…
				</div>
			) : null}
			<div className="relative space-y-4 p-5">
				<div className="space-y-4">
					<Skeleton className="h-5 w-2/3" />
					<div className="flex items-center gap-3">
						<Skeleton className="h-10 w-10 rounded-full" />
						<div className="flex-1 space-y-2">
							<Skeleton className="h-3 w-40" />
							<Skeleton className="h-3 w-24" />
						</div>
					</div>
					<div className="space-y-2 pt-4">
						<Skeleton className="h-3 w-full" />
						<Skeleton className="h-3 w-5/6" />
						<Skeleton className="h-3 w-4/6" />
						<Skeleton className="h-3 w-3/4" />
					</div>
				</div>
				<div aria-hidden="true" className="skeleton-band" />
			</div>
		</div>
	);
}

function EmailPanel({
	emailId,
	onOpenSummaryCenter,
	accountId,
	folderId,
}: {
	emailId: string;
	onOpenSummaryCenter?: () => void;
	accountId?: string;
	folderId?: string;
}) {
	// DEV-only: capture the first-render function-start so a mount effect can
	// report total mount→commit time (hooks + JSX render + DOM commit). Combined
	// with [email-panel] module-eval, isolates lazy-import cost from render cost.
	const firstMountStartRef = useRef(performance.now());
	useEffect(() => {
		if (!import.meta.env.DEV) return;
		const start = firstMountStartRef.current;
		if (!start) return;
		firstMountStartRef.current = 0;
		console.debug(
			`[email-panel] first-mount-to-commit=${Math.round(performance.now() - start)}ms`,
		);
	}, []);
	const { folder } = useParams<{ folder: string }>();
	const apiEndpointState = useSyncExternalStore(
		subscribeApiEndpointRuntimeState,
		getApiEndpointRuntimeState,
		getApiEndpointRuntimeState,
	);
	const [searchParams] = useSearchParams();
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = accountId ?? currentAccount?.account?.id;
	const { data: folders = [] } = useFolders(mailboxId);
	const queryClient = useContext(QueryClientContext);
	const emailQuery = useEmail(mailboxId, emailId) as {
		data?: Email;
		traceId?: string;
		status?: string;
		fetchStatus?: string;
		isFetching?: boolean;
		isInvalidated?: boolean;
		dataUpdatedAt?: number;
		bodyPollingExhausted?: boolean;
		bodyWaitTimedOut?: boolean;
		retryBody?: (onDemand?: boolean) => Promise<unknown>;
	};
	const { data: email } = emailQuery;
	const [secondaryReady, setSecondaryReady] = useState(false);
	useEffect(() => {
		setSecondaryReady(false);
		let secondFrame = 0;
		const firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => setSecondaryReady(true));
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			if (secondFrame) cancelAnimationFrame(secondFrame);
		};
	}, [emailId]);
	const { data: threadRepliesRaw } = useThreadReplies(
		mailboxId,
		secondaryReady ? email?.thread_id : undefined,
	) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const autoReadRequestedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!mailboxId || !email || email.read !== false) return;
		if (autoReadRequestedRef.current === email.id) return;
		// Defer the read write to idle. Its db-event invalidates THIS detail
		// query -> refetch -> isFetching toggle -> re-renders that race the
		// iframe body paint. Marking-read isn't urgent, so push the whole
		// cascade past first paint. The dedup lock is acquired INSIDE the
		// deferred task, so a cancelled schedule (email changed before idle)
		// never holds the lock.
		const cancel = scheduleIdleTask(() => {
			if (!requestAutoRead(mailboxId, email.id)) return;
			autoReadRequestedRef.current = email.id;
			updateEmail.mutate(
				{ mailboxId, id: email.id, data: { read: true } },
				{
					onError: () => releaseAutoRead(mailboxId, email.id),
					onSettled: () => releaseAutoRead(mailboxId, email.id),
				},
			);
		});
		return cancel;
	}, [email, mailboxId, updateEmail]);
	const deleteEmailMut = useDeleteEmail();
	const moveEmailMut = useMoveEmail();
	const sendDraftMut = useSendDraft();
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const closePanel = useUIStore((state) => state.closePanel);
	const startCompose = useUIStore((state) => state.startCompose);
	const [reportViewer, setReportViewer] = useState<InsightReportSummary | null>(null);
	useEffect(() => {
		setReportViewer(null);
	}, [emailId]);
	const isSentMail = isSentFolder(folderId) ||
		isSentFolder(email?.folder_id) ||
		isSentFolder(folder);
	const isDraftFolder = folder === Folders.DRAFT;
	const [refreshingInvoiceEmailId, setRefreshingInvoiceEmailId] = useState<string | null>(null);
	const [invoiceRefreshMessages, setInvoiceRefreshMessages] = useState<Record<string, string>>({});
	const draftEditControllerRef = useRef<AbortController | null>(null);
	useEffect(() => () => draftEditControllerRef.current?.abort(), []);
	// P2.6: the invoice-status refresh endpoint is an edition module; the
	// open edition never wires the trigger (the endpoint does not exist).
	const { allowanceInvoice } = useEditionFeatures();
	const refreshInvoiceStatus = async (target: Email) => {
		if (!mailboxId || !allowanceInvoice) return;
		setRefreshingInvoiceEmailId(target.id);
		setInvoiceRefreshMessages((messages) => ({ ...messages, [target.id]: "正在查询发票平台，请稍候…" }));
		try {
			const result = await api.refreshInvoiceStatus(target.id);
			const invoiceStatus = result.invoiceStatus ?? null;
			if (queryClient) {
				queryClient.setQueriesData<Email[]>({ queryKey: ["emails", mailboxId, "thread"] }, (messages) =>
					messages?.map((message) => message.id === target.id ? { ...message, invoiceStatus,
						invoiceStatusTag: invoiceStatus?.tag ?? null, invoiceStatusState: invoiceStatus?.state ?? null } : message));
				queryClient.setQueryData<Email>(
					queryKeys.emails.detail(mailboxId, target.id),
					(current) =>
						current
							? {
									...current,
									invoiceStatus,
									invoiceStatusTag: invoiceStatus?.tag ?? null,
									invoiceStatusState: invoiceStatus?.state ?? null,
								}
							: current,
				);
				void queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
				void queryClient.invalidateQueries({ queryKey: ["intelligence", target.id] });
			}
			const message = result.message ?? (result.partialFailure ? "部分平台状态查询失败，结果可能不完整，请重试。" : "平台查询已完成，附件状态见下方。");
			setInvoiceRefreshMessages((messages) => ({ ...messages, [target.id]: `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · ${message}` }));
			if (result.partialFailure) toast.warning(message);
			else toast.success(message);
		} catch (error) {
			const message = resolvePublicError(error).code === "INVOICE_AUTH_REQUIRED"
				? "发票平台未登录或登录已过期，本次未能刷新。请登录后重试；下方保留的是历史记录。"
				: getUserFacingError(error, "刷新发票平台状态失败，请稍后重试。");
			setInvoiceRefreshMessages((messages) => ({ ...messages, [target.id]: message }));
			toast.error(message);
		} finally {
			setRefreshingInvoiceEmailId(null);
		}
	};
	const [isSending, setIsSending] = useState(false);
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [aiTextViewEmail, setAiTextViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const [todoDialogOpen, setTodoDialogOpen] = useState(false);
	const [filterFormOpen, setFilterFormOpen] = useState(false);
	const [pendingDestructive, setPendingDestructive] = useState<{
		kind: "delete" | "spam" | "discard-draft";
		target: Email;
	} | null>(null);
	useEffect(() => {
		const handler = () => setTodoDialogOpen(true);
		window.addEventListener("wemail:create-todo", handler);
		return () => window.removeEventListener("wemail:create-todo", handler);
	}, []);
	const bodyHighlightTerms = useMemo(() => {
		const q = searchParams.get("q") ?? "";
		if (!q) return [];
		const parsed = parseSearchQuery(q);
		return Array.from(
			new Set(
				[parsed.query, parsed.from, parsed.to, parsed.subject]
					.filter((value): value is string => !!value)
					.flatMap((value) => value.trim().split(/\s+/))
					.filter(Boolean),
			),
		);
	}, [searchParams]);

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}, [email, threadReplies]);
	const hasThread = allMessages.length > 1;
	const hasMultipleRecipients = email
		? new Set([
			...parseAddressList(email.recipient),
			...parseAddressList(email.cc),
		].map((recipient) => recipient.email.trim().toLowerCase())).size > 1
		: false;
	const messageScrollRef = useRef<HTMLDivElement>(null);
	const messageContentRef = useRef<HTMLDivElement>(null);
	const [pinSingleMessageActions, setPinSingleMessageActions] = useState(false);
	useEffect(() => {
		if (hasThread) {
			setPinSingleMessageActions(false);
			return;
		}
		const viewport = messageScrollRef.current;
		const content = messageContentRef.current;
		if (!viewport || !content) return;

		const updatePlacement = () => {
			setPinSingleMessageActions(content.scrollHeight > viewport.clientHeight + 1);
		};
		updatePlacement();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updatePlacement);
		observer.observe(viewport);
		observer.observe(content);
		return () => observer.disconnect();
	}, [email?.id, hasThread, secondaryReady]);

	// Reset expanded state to the message the user actually selected. Thread
	// summaries do not carry hydrated bodies, so expanding the newest sibling
	// could leave a ready selected body folded while the UI showed no content.
	const currentEmailId = email?.id;
	const defaultExpandedMessageId = allMessages.length > 1 ? currentEmailId : undefined;
	useEffect(() => {
		if (!defaultExpandedMessageId) {
			setExpandedMessages(new Set());
			return;
		}
		setExpandedMessages(new Set([defaultExpandedMessageId]));
	}, [currentEmailId, defaultExpandedMessageId]);

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const received = allMessages.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	// Existing detail data stays visible during background reconciliation.
	// Only the body surface reports hydration while cached metadata remains visible.
	const hasMeaningfulBody = [email?.body, email?.bodyHtml, email?.bodyText]
		.some((value) => typeof value === "string" && value.trim().length > 0);
	const readyBodyMissing =
		email?.bodyState === "ready" &&
		!hasMeaningfulBody &&
		!!email?.snippet?.trim();
	const bodyWaiting = !!email && !hasMeaningfulBody && (
		email.bodyPending === true ||
		email.bodyState === "missing" ||
		email.bodyState === "fetching" ||
		readyBodyMissing
	);
	const bodyLoadFailed = (!hasMeaningfulBody && email?.bodyState === "failed") || (
		bodyWaiting &&
		(emailQuery.bodyPollingExhausted === true || emailQuery.bodyWaitTimedOut === true)
	);
	const bodyTooLarge = bodyLoadFailed && email?.bodyErrorCode === "mail-body-too-large";
	const isHydratingBody = !bodyLoadFailed && !!email && (
		!hasMeaningfulBody && (
			email.bodyPending === true ||
			email.bodyState !== "ready" ||
			readyBodyMissing
		)
	);
	useEffect(() => {
		if (!import.meta.env.DEV || !email) return;
		console.debug("[mail-events] email-panel-body-state", JSON.stringify({
			bodyState: email.bodyState ?? "unknown",
			bodyPending: email.bodyPending === true,
			bodyWaiting,
			readyBodyMissing,
			bodyLoadFailed,
			isHydratingBody,
		}));
	}, [email?.id, email?.bodyState, email?.bodyPending, bodyWaiting, readyBodyMissing, bodyLoadFailed, isHydratingBody]);
	// DEV-only render-reason diagnostic. ALWAYS logs a render counter plus the
	// email-query invalidation fields (status / fetchStatus / dataUpdatedAt /
	// isInvalidated) so a db-event-driven refetch can be confirmed even when
	// data+isFetching are unchanged. Then lists which tracked input changed.
	// Remove after the mail-open latency investigation concludes.
	const renderReasonRef = useRef<{ n: number; fields: Record<string, unknown> }>({
		n: 0,
		fields: {},
	});
	if (import.meta.env.DEV) {
		renderReasonRef.current.n += 1;
		const hasBody = !!(email?.body?.trim() || email?.bodyHtml?.trim() || email?.bodyText?.trim());
		const renderReasonCurrent: Record<string, unknown> = {
			emailId,
			"email.id": email?.id,
			"email.bodyState": email?.bodyState,
			"email.bodyPending": email?.bodyPending,
			hasBody,
			"q.status": emailQuery.status,
			"q.fetchStatus": emailQuery.fetchStatus,
			"q.isFetching": emailQuery.isFetching,
			"q.dataUpdatedAt": emailQuery.dataUpdatedAt,
			"q.isInvalidated": emailQuery.isInvalidated,
			"update.pending": updateEmail.isPending,
			secondaryReady,
			threadLen: threadReplies.length,
			mailbox: currentMailbox?.id,
			reportViewer: reportViewer != null,
			sourceView: sourceViewEmail != null,
			aiTextView: aiTextViewEmail != null,
			preview: previewImage != null,
			todoDlg: todoDialogOpen,
			filterDlg: filterFormOpen,
			pendingDestructive: pendingDestructive != null,
			expanded: expandedMessages.size,
			isSending,
		};
		const prevFields = renderReasonRef.current.fields;
		const changedReasons = Object.keys(renderReasonCurrent).filter(
			(k) => renderReasonCurrent[k] !== prevFields[k],
		);
		console.debug(
			`[email-panel render] #${renderReasonRef.current.n}` +
				` q=${emailQuery.status}/${emailQuery.fetchStatus}` +
				` dataUpdatedAt=${emailQuery.dataUpdatedAt}` +
				` invalidated=${emailQuery.isInvalidated}` +
				(changedReasons.length
					? `  changed: ${changedReasons
							.map((k) => `${k}:${JSON.stringify(prevFields[k])}→${JSON.stringify(renderReasonCurrent[k])}`)
							.join("  ")}`
					: "  changed: (none — untracked driver)"),
		);
		renderReasonRef.current.fields = renderReasonCurrent;
	}
	if (!email) return <EmailPanelSkeleton recovering={apiEndpointState === "recovering"} />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	// Archive needs a physical archive folder on the provider; hide the action
	// for mailboxes that have none (mirrors the isDraft hiding below).
	const canArchive = folders.some((folder) => folderRole(folder.id) === "archive");
	const handleDelete = (target: Email = email) => {
		setPendingDestructive({ kind: "delete", target });
	};
	const handleArchive = (target: Email = email) => {
		if (!mailboxId) return;
		moveEmailMut.mutate(
			{ mailboxId, id: target.id, folder: "Archive" },
			{
				onSuccess: () => {
					toast.success("已归档");
					if (target.id === email.id) closePanel();
				},
				onError: (err) => toast.error(getUserFacingError(err, "归档失败，请稍后重试。")),
			},
		);
	};
	const handleMarkSpam = () => {
		if (!mailboxId) return;
		setPendingDestructive({ kind: "spam", target: email });
	};

	const handleEditDraft = async (draftMsg?: Email) => {
		if (!mailboxId || draftEditControllerRef.current) return;
		const controller = new AbortController();
		draftEditControllerRef.current = controller;
		try {
			const target = await loadCompleteDraft(mailboxId, draftMsg || email, controller.signal);
			if (controller.signal.aborted) return;
			if (target.in_reply_to) {
				startCompose({
					mode: "reply",
					originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to),
					draftEmail: target,
				});
			} else {
				startCompose({ mode: "new", originalEmail: undefined, draftEmail: target });
			}
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				toast.error("草稿内容加载失败，请重试");
			}
		} finally {
			if (draftEditControllerRef.current === controller) {
				draftEditControllerRef.current = null;
			}
		}
	};

	const handleDeleteDraft = async (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		setPendingDestructive({ kind: "discard-draft", target });
	};

	const confirmDestructive = () => {
		if (!pendingDestructive || !mailboxId) return;
		const { kind, target } = pendingDestructive;
		const onSuccess = () => {
			toast.success(kind === "spam" ? "已标记为垃圾邮件" : kind === "discard-draft" ? "草稿已丢弃" : "已移到回收站");
			setPendingDestructive(null);
			if (target.id === email.id) closePanel();
		};
		const onError = (err: unknown) => toast.error(getUserFacingError(
			err,
			kind === "discard-draft" ? "草稿丢弃失败，请稍后重试。" : "操作失败，请稍后重试。",
		));
		if (kind === "spam") {
			moveEmailMut.mutate({ mailboxId, id: target.id, folder: "Spam" }, { onSuccess, onError });
		} else {
			deleteEmailMut.mutate({ mailboxId, id: target.id }, { onSuccess, onError });
		}
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox) return;
		setIsSending(true);
		try {
			if (!target.recipient || !target.subject) { try { const fresh = await api.getEmail(mailboxId, target.id) as Email; if (fresh) target = fresh; } catch {} }
			if (!target.recipient) { return; }
			const toAddrs = parseAddressList(target.recipient);
			if (toAddrs.length === 0) { return; }
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			const draft = {
				accountId: mailboxId,
				originalEmailId: originalEmail?.id,
				threadId: target.thread_id || originalEmail?.thread_id || undefined,
				to: toAddrs,
				cc: parseAddressList(target.cc),
				bcc: parseAddressList(target.bcc),
				subject: target.subject || "(no subject)",
				bodyText: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
				bodyHtml: target.body || "",
			};
			await sendDraftMut.mutateAsync(draft);
			await deleteEmailMut.mutateAsync({ mailboxId, id: target.id });
			if (isDraftFolder) closePanel();
		} catch (err) {
			// Silent catch — UI state remains consistent
		} finally { setIsSending(false); }
	};

	return (
		<div
			className="relative flex h-full flex-col overflow-hidden bg-workbench-surface"
			data-testid="email-panel-shell"
			data-email-id={email.id}
		>
			{apiEndpointState === "recovering" ? (
				<div className="border-b border-coral/20 bg-coral/5 px-5 py-2.5 text-sm text-coral">
					邮件服务正在恢复，当前内容会保留，恢复后自动继续加载正文。
				</div>
			) : null}
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				secondaryReady={secondaryReady}
				isDraftFolder={isDraftFolder}
				isSending={isSending}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => void handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onViewSource={() => setSourceViewEmail(email)}
				onViewAiText={() => setAiTextViewEmail(email)}
				onDelete={handleDelete}
				onArchive={canArchive ? handleArchive : undefined}
				onMarkSpam={handleMarkSpam}
				onCreateTodo={() => setTodoDialogOpen(true)}
				onFilterSimilar={() => setFilterFormOpen(true)}
			/>

			<div ref={messageScrollRef} className="flex-1 min-h-0 overflow-y-auto">
				<div ref={messageContentRef}>
				<EmailPanelHeader
					subject={email.subject}
					messageCount={allMessages.length}
					showThreadCount={hasThread}
				/>

				{!hasThread ? (
					<MessageSenderBar
						email={email}
						mailboxEmail={currentMailbox?.email}
						onReply={() =>
							startCompose({
								mode: "reply",
								originalEmail: lastReceivedMessage,
							})
						}
						onReplyAll={() =>
							startCompose({
								mode: "reply-all",
								originalEmail: lastReceivedMessage,
							})
						}
						onForward={() =>
							startCompose({ mode: "forward", originalEmail: email })
						}
						onArchive={canArchive ? handleArchive : undefined}
						onDelete={handleDelete}
						onToggleRead={() => {
							if (mailboxId) {
								updateEmail.mutate({
									mailboxId,
									id: email.id,
									data: { read: !email.read },
								});
							}
						}}
						onViewSource={() => setSourceViewEmail(email)}
						onViewAiText={() => setAiTextViewEmail(email)}
					/>
				) : null}

				<EmailIntelligenceSection
					emailId={emailId}
					mailboxId={mailboxId}
					enabled={secondaryReady}
					isSentMail={isSentMail}
					email={email}
					onViewReport={setReportViewer}
					onOpenSummaryCenter={onOpenSummaryCenter}
				/>

				{email.sentArchiveState === "failed" && (
					<div role="status" className="mx-4 my-2 rounded border border-edge bg-paper-2 p-3 text-sm text-ink-2">邮件已发送，但服务器“已发送”存档失败或结果不明；请在其他邮件客户端核查。</div>
				)}
				{hasThread ? (
					allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								traceId={msg.id === email.id ? emailQuery.traceId : undefined}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								highlightTerms={bodyHighlightTerms}
								isLast={idx === allMessages.length - 1}
								isDraft={isDraft}
								onRefreshInvoiceStatus={allowanceInvoice && hasInvoiceContext(msg)
									? () => void refreshInvoiceStatus(msg)
									: undefined}
								isRefreshingInvoiceStatus={refreshingInvoiceEmailId === msg.id}
								invoiceRefreshMessage={invoiceRefreshMessages[msg.id]}
								isBodyLoading={msg.id === email.id && isHydratingBody}
								bodyLoadFailed={msg.id === email.id && bodyLoadFailed}
								bodyTooLarge={msg.id === email.id && bodyTooLarge}
								onRetryBody={() => void emailQuery.retryBody?.()}
								onLoadBody={() => void emailQuery.retryBody?.(true)}
								bodyRetryable={email.bodyRetryable !== false}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => void handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onViewAiText={() => setAiTextViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
								onReply={
									isDraft
										? undefined
										: () =>
												startCompose({ mode: "reply", originalEmail: msg })
								}
								onReplyAll={
									isDraft
										? undefined
										: () =>
												startCompose({ mode: "reply-all", originalEmail: msg })
								}
								onForward={
									isDraft
										? undefined
										: () =>
												startCompose({ mode: "forward", originalEmail: msg })
								}
								onToggleRead={
									isDraft || !mailboxId
										? undefined
										: () =>
												updateEmail.mutate({
													mailboxId,
													id: msg.id,
													data: { read: !msg.read },
												})
								}
								onArchive={isDraft || !canArchive ? undefined : () => handleArchive(msg)}
								onDelete={isDraft ? undefined : () => handleDelete(msg)}
							/>
						);
					})
				) : (
					<>
						<SingleMessageView
							email={email}
							traceId={emailQuery.traceId}
							mailboxId={mailboxId}
							onRefreshInvoiceStatus={allowanceInvoice && hasInvoiceContext(email)
								? () => void refreshInvoiceStatus(email)
								: undefined}
							isRefreshingInvoiceStatus={refreshingInvoiceEmailId === email.id}
							invoiceRefreshMessage={invoiceRefreshMessages[email.id]}
							isBodyLoading={isHydratingBody}
							bodyLoadFailed={bodyLoadFailed}
							bodyTooLarge={bodyTooLarge}
							onRetryBody={() => void emailQuery.retryBody?.()}
							onLoadBody={() => void emailQuery.retryBody?.(true)}
							bodyRetryable={email.bodyRetryable !== false}
							highlightTerms={bodyHighlightTerms}
							onPreviewImage={(url, filename) =>
								setPreviewImage({ url, filename })
							}
						/>
					</>
				)}
				</div>

				{!hasThread && !pinSingleMessageActions ? (
					<SingleMessageActions
						onReply={() =>
							startCompose({
								mode: "reply",
								originalEmail: lastReceivedMessage,
							})
						}
						onReplyAll={hasMultipleRecipients
						? () =>
							startCompose({
								mode: "reply-all",
								originalEmail: lastReceivedMessage,
							})
						: undefined}
						onForward={() =>
							startCompose({ mode: "forward", originalEmail: email })
						}
					/>
				) : null}

			</div>

			<QuickReplyPane
				emailId={emailId}
				enabled={secondaryReady}
				isSentMail={isSentMail}
				lastReceivedMessage={lastReceivedMessage}
			/>

			{!hasThread && pinSingleMessageActions ? (
				<SingleMessageActions
					onReply={() =>
						startCompose({
							mode: "reply",
							originalEmail: lastReceivedMessage,
						})
					}
					onReplyAll={hasMultipleRecipients
					? () =>
						startCompose({
							mode: "reply-all",
							originalEmail: lastReceivedMessage,
						})
					: undefined}
					onForward={() =>
						startCompose({ mode: "forward", originalEmail: email })
					}
				/>
			) : null}

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				aiTextViewEmail={aiTextViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onCloseAiText={() => setAiTextViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
			{reportViewer && mailboxId ? (
				<ArtifactViewer
					accountId={mailboxId}
					message={{
						id: reportViewer.applicationMessageId,
						title: reportViewer.title,
						artifact: {
							id: reportViewer.id,
							version: reportViewer.currentVersion,
							kind: "report",
							contentHash: "",
						},
					}}
					onClose={() => setReportViewer(null)}
				/>
			) : null}

			<CreateTodoDialog
				open={todoDialogOpen}
				onOpenChange={setTodoDialogOpen}
				accountId={mailboxId}
				emailId={email.id}
				defaultTitle={email.subject || ""}
			/>
			<ConfirmActionDialog
				open={pendingDestructive !== null}
				onOpenChange={(open) => !open && setPendingDestructive(null)}
				title={pendingDestructive?.kind === "spam" ? "标记为垃圾邮件？" : pendingDestructive?.kind === "discard-draft" ? "丢弃草稿？" : "移到回收站？"}
				description={`目标：${pendingDestructive?.target.subject || "无主题邮件"}`}
				confirmLabel={pendingDestructive?.kind === "spam" ? "标记为垃圾邮件" : pendingDestructive?.kind === "discard-draft" ? "丢弃草稿" : "移到回收站"}
				pending={deleteEmailMut.isPending || moveEmailMut.isPending}
				onConfirm={confirmDestructive}
			/>

			<AutomationRuleForm
				open={filterFormOpen}
				onOpenChange={setFilterFormOpen}
				accountId={mailboxId}
				defaults={{
					name: email.sender ? `处理 ${email.sender}` : undefined,
					conditions: { sender: extractEmailAddress(email.sender) },
				}}
			/>
		</div>
	);
}

// Memoize so EmailPanel skips re-renders driven purely by its parent
// (MessageDetailView / the workbench tree) when its own props are unchanged.
// Its props are all stable primitives + one useCallback (onOpenSummaryCenter),
// so a shallow compare is sufficient. Internal hook/subscription changes
// (useEmail, useMailbox, secondaryReady, …) still re-render normally.
const EmailPanelMemo = memo(EmailPanel);
EmailPanelMemo.displayName = "EmailPanel";
export default EmailPanelMemo;

function extractEmailAddress(combined: string | undefined): string | undefined {
	if (!combined) return undefined;
	const match = combined.match(/<([^>]+)>/);
	if (match) return match[1].trim();
	return combined.trim();
}
