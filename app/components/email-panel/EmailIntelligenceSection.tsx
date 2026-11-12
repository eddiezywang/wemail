// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * EmailIntelligenceSection — owns every intelligence/insight/llm subscription
 * for an open email, isolated from the EmailPanel shell so that intelligence
 * resolving NEVER re-renders the message body or toolbar.
 *
 * EmailPanel (the shell) used to subscribe to useIntelligence/useInsightReport/
 * useLlmStatus directly; any of those resolving re-rendered the whole panel
 * (body + chrome) 5× per open. Moving all of that here means the shell renders
 * only on email-data / UI-state changes, and intelligence updates re-render
 * only this section (a leaf relative to the body).
 *
 * `enabled` is the shell's `secondaryReady` gate (2-rAF deferral) so the
 * intelligence fetch still waits for the body to paint first.
 */

import { memo, useContext, useEffect, useMemo } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import EmailIntelligenceCard from "~/components/wemail/EmailIntelligenceCard";
import QuickReplyChips from "~/components/email-panel/QuickReplyChips";
import {
	intelligenceKeys,
	useIntelligence,
	useLlmStatus,
	useRetrySummary,
	useTriggerReplyDecision,
} from "~/queries/intelligence";
import { useInsightReport } from "~/queries/insightReports";
import { useUIStore } from "~/hooks/useUIStore";
import { getUserFacingError } from "~/lib/user-facing-error";
import type { Email } from "~/types";
import type { IntelligenceStatus as IntelligenceStatusType } from "~/types/wemail";
import type { MailSceneAction } from "shared/wemail/intelligence";
import type { InsightReportSummary } from "shared/wemail/designArtifacts";

function deriveSummaryStatus(
	data: { summary?: { status: IntelligenceStatusType } } | undefined,
	isLoading: boolean,
	isError: boolean,
	llmConfigured: boolean | undefined,
): IntelligenceStatusType {
	if (isError) return "failed";
	if (isLoading) return "pending";
	if (llmConfigured === false) return "skipped";
	return data?.summary?.status ?? "pending";
}

export interface EmailIntelligenceSectionProps {
	emailId: string;
	mailboxId?: string;
	/** secondaryReady gate — defer intelligence until after the body paints. */
	enabled: boolean;
	isSentMail: boolean;
	email: Email;
	onViewReport: (report: InsightReportSummary) => void;
	onOpenSummaryCenter?: () => void;
}

function EmailIntelligenceSectionBase({
	emailId,
	mailboxId,
	enabled,
	isSentMail,
	email,
	onViewReport,
	onOpenSummaryCenter,
}: EmailIntelligenceSectionProps) {
	const queryClient = useContext(QueryClientContext);
	const intelligence = useIntelligence(enabled ? emailId : undefined);
	const insightReportQuery = useInsightReport(mailboxId, enabled ? emailId : undefined);
	const insightReport = insightReportQuery.data ?? null;
	const llmStatus = useLlmStatus();
	const retrySummary = useRetrySummary(emailId);
	const triggerReplyDecision = useTriggerReplyDecision(emailId);
	const openEmailAgentConversation = useUIStore((state) => state.openEmailAgentConversation);
	const requestAgentComposerInput = useUIStore((state) => state.requestAgentComposerInput);
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	const toggleAgentPanel = useUIStore((state) => state.toggleAgentPanel);

	useEffect(() => {
		if (!mailboxId || !enabled || intelligence.data?.summary?.status !== "succeeded") return;
		void queryClient?.invalidateQueries({
			queryKey: ["agent-suggestions", mailboxId, emailId],
		});
	}, [
		emailId,
		enabled,
		intelligence.data?.replyDecision?.status,
		intelligence.data?.summary?.status,
		mailboxId,
		queryClient,
	]);

	const sceneActions = useMemo<MailSceneAction[]>(() => {
		const baseActions = intelligence.data?.sceneActions ?? [];
		const chartAction = baseActions.find((action) => action.id === "monitoring.generate_chart");
		if (!chartAction) return baseActions;
		const aggregationActions: MailSceneAction[] = [
			{
				id: "insight-report.aggregate_24h",
				scene: "insight_report",
				label: "聚合相似邮件并生成洞察报告",
				icon: "chart",
				status: "available",
				risk: "none",
				composerText: "【聚合相似邮件并生成洞察报告】聚合最近 24 小时的相似邮件，并生成洞察报告",
				agentPrompt: "请按动作上下文完成最近 24 小时相似邮件预览与洞察报告生成。",
				agentContext: {
					kind: "insight-report",
					operation: "aggregate",
					lookbackPreset: "24h",
					lookbackDays: 1,
				},
			},
			{
				id: "insight-report.aggregate_7d",
				scene: "insight_report",
				label: "聚合相似邮件并生成洞察报告",
				icon: "chart",
				status: "available",
				risk: "none",
				composerText: "【聚合相似邮件并生成洞察报告】聚合最近 7 天的相似邮件，并生成洞察报告",
				agentPrompt: "请按动作上下文完成最近 7 天相似邮件预览与洞察报告生成。",
				agentContext: {
					kind: "insight-report",
					operation: "aggregate",
					lookbackPreset: "7d",
					lookbackDays: 7,
				},
			},
		];
		const regenerationActions: MailSceneAction[] = [
			{
				id: "insight-report.regenerate",
				scene: "insight_report",
				label: "重新生成报告",
				icon: "chart",
				status: "available",
				risk: "none",
				reportId: insightReport?.id,
				reportVersion: insightReport?.currentVersion,
				composerText: "【重新生成报告】重新生成当前邮件的洞察报告",
				agentPrompt: "请按动作上下文重新生成当前邮件的洞察报告，并创建下一版本。",
				agentContext: {
					kind: "insight-report",
					operation: "regenerate",
					reportId: insightReport?.id,
					reportVersion: insightReport?.currentVersion,
				},
			},
			...aggregationActions.map((action) => ({
				...action,
				id: action.id.replace("aggregate", "regenerate") as MailSceneAction["id"],
				label: "重新生成报告",
				composerText: action.agentContext?.lookbackPreset === "24h"
					? "【重新生成报告】【聚合相似邮件】聚合最近 24 小时的相似邮件，并重新生成洞察报告"
					: "【重新生成报告】【聚合相似邮件】聚合最近 7 天的相似邮件，并重新生成洞察报告",
				agentPrompt: "请按动作上下文关联相似邮件、聚合数据，并为当前洞察报告创建下一版本。",
				agentContext: {
					...action.agentContext!,
					operation: "regenerate" as const,
					reportId: insightReport?.id,
					reportVersion: insightReport?.currentVersion,
				},
			})),
		];
		if (!insightReport) {
			return [
				...baseActions.map((action) => action.id === "monitoring.generate_chart"
					? {
							...action,
							label: "生成洞察报告",
							composerText: "【生成洞察报告】生成当前邮件的洞察报告",
							agentPrompt: "请按动作上下文生成当前邮件的洞察报告。",
							agentContext: {
								kind: "insight-report" as const,
								operation: "generate" as const,
							},
						}
					: action),
				...aggregationActions,
			];
		}
		return [
			{
				id: "insight-report.view",
				scene: "insight_report",
				label: "查看洞察报告",
				icon: "chart",
				status: "available",
				risk: "none",
				reportId: insightReport.id,
				reportVersion: insightReport.currentVersion,
				applicationMessageId: insightReport.applicationMessageId,
			},
			{
				id: "insight-report.edit",
				scene: "insight_report",
				label: "修改报告格式",
				icon: "chart",
				status: "available",
				risk: "none",
				reportId: insightReport.id,
				reportVersion: insightReport.currentVersion,
				composerText: "【修改报告格式】修改当前洞察报告的格式",
				agentPrompt: "请按动作上下文修改当前洞察报告的格式并生成下一版本。",
				agentContext: {
					kind: "insight-report" as const,
					operation: "edit" as const,
					reportId: insightReport.id,
					reportVersion: insightReport.currentVersion,
				},
			},
			...regenerationActions,
			...baseActions.filter((action) => action.id !== "monitoring.generate_chart"),
		];
	}, [insightReport, intelligence.data?.sceneActions]);

	const handleSceneAction = (action: MailSceneAction) => {
		if (action.status !== "available") return;
		if (action.id === "insight-report.view" && insightReport) {
			onViewReport(insightReport);
			return;
		}
		if (!action.agentPrompt && !action.composerText) return;
		openEmailAgentConversation(emailId);
		requestAgentComposerInput(
			action.composerText ?? action.agentPrompt ?? action.label,
			action.agentContext,
		);
		if (!isAgentPanelOpen) toggleAgentPanel();
	};

	// Trigger reply-decision once intelligence is available.
	useEffect(() => {
		if (isSentMail) return;
		if (!intelligence.data) return;
		const status = intelligence.data.replyDecision?.status;
		if (!status || status === "skipped") {
			triggerReplyDecision.mutate();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [emailId, intelligence.data?.replyDecision?.status, isSentMail]);

	// Refresh intelligence once the body is present. (Phase 3 will narrow this
	// to a true bodyPending true→false transition so cached bodies don't
	// trigger a redundant second fetch.)
	useEffect(() => {
		if (
			!enabled ||
			email?.bodyPending !== false ||
			!(email.body || email.bodyHtml || email.bodyText)
		) {
			return;
		}
		void queryClient?.invalidateQueries({
			queryKey: intelligenceKeys.detail(emailId),
		});
	}, [emailId, email?.bodyPending, enabled, queryClient]);

	if (!enabled) return null;
	const extractedLinks = intelligence.data?.linkExtraction?.result;
	const summaryCtas = intelligence.data?.summary?.result?.ctas;
	const hasSummaryCtaDecision = Array.isArray(summaryCtas);
	const selectedCtas = summaryCtas
		?.filter((cta) => cta.confidence !== "l")
		.map((cta) => ({
			url: cta.url,
			actionText: cta.label,
			risk: cta.risk,
			riskReasons: cta.riskReasons,
			category: cta.category,
		})) ?? [];
	const links = hasSummaryCtaDecision
		? selectedCtas.length > 0
			? { type: "linkExtraction" as const, links: selectedCtas, unsubscribeUrl: null }
			: undefined
		: extractedLinks;

	const summaryStatus = deriveSummaryStatus(
		intelligence.data,
		intelligence.isLoading,
		intelligence.isError,
		llmStatus.data?.configured,
	);
	const tagsStatus = llmStatus.data?.configured === false
		? "skipped"
		: intelligence.data?.tags?.status ?? "pending";
	const replyDraftStatus = intelligence.data?.replyDraft?.status ?? (intelligence.isLoading ? "pending" : "pending");

	return (
		<>
			{/* Only surface reply intelligence when it suggests an action. */}
			{!isSentMail && intelligence.data?.replyDecision?.result?.shouldReply ? (
				<div className="flex items-center gap-2 px-6 pb-3">
					<span className="inline-flex min-h-7 items-center gap-1 rounded-full bg-coral/10 px-2 text-xs font-medium text-coral">
						<ChatCircleIcon size={12} weight="bold" />
						建议回复
						{intelligence.data.replyDecision.result.reason ? (
							<span className="text-ink-3 font-normal max-w-[200px] truncate">
								· {intelligence.data.replyDecision.result.reason}
							</span>
						) : null}
					</span>
				</div>
			) : null}

			{!isSentMail ? (
				<div className="px-6 pt-3 pb-4">
					<EmailIntelligenceCard
						emailId={emailId}
						accountId={mailboxId}
						summaryStatus={summaryStatus}
						summary={intelligence.data?.summary?.result ?? null}
						summaryError={
							llmStatus.data?.configured === false
								? "尚未配置 AI 模型，配置后会自动生成摘要。"
								:
							(intelligence.data?.summary?.error
								? getUserFacingError(intelligence.data.summary.error, "邮件分析失败，请稍后重试。")
								: undefined) ??
							(intelligence.error instanceof Error
								? getUserFacingError(intelligence.error, "邮件分析失败，请稍后重试。")
								: undefined)
						}
						summaryJob={intelligence.data?.summary?.job}
						canRetrySummary={
							llmStatus.data?.configured === false
								? false
								: intelligence.data?.summary?.canRetry
						}
						onRetrySummary={() => retrySummary.mutate()}
						onOpenSummaryCenter={onOpenSummaryCenter}
						summaryRetrying={retrySummary.isPending}
						tagsStatus={tagsStatus}
						tags={intelligence.data?.tags?.result ?? null}
						todosStatus={intelligence.data?.todoExtraction?.status}
						todos={intelligence.data?.todoExtraction?.result}
						linksStatus={hasSummaryCtaDecision ? "succeeded" : extractedLinks ? intelligence.data?.linkExtraction?.status : "skipped"}
						links={links}
						sceneActions={sceneActions}
						onSceneAction={handleSceneAction}
					/>
				</div>
			) : null}
		</>
	);
}

// memo so the shell's UI-state renders (opening a dialog, secondaryReady flip)
// do NOT re-render this subtree (and the heavy EmailIntelligenceCard inside).
// Props are all stable between email changes: onViewReport is a setState
// dispatch, onOpenSummaryCenter is stabilized by the caller, email/enabled
// only change on real email transitions.
export const EmailIntelligenceSection = memo(EmailIntelligenceSectionBase);

/**
 * QuickReplyPane — thin intelligence reader for the bottom quick-reply chips.
 * Subscribes useIntelligence independently (React Query dedups the fetch with
 * EmailIntelligenceSection's subscription).
 */
function QuickReplyPaneBase({
	emailId,
	enabled,
	isSentMail,
	lastReceivedMessage,
}: {
	emailId: string;
	enabled: boolean;
	isSentMail: boolean;
	lastReceivedMessage: Email | undefined;
}) {
	const intelligence = useIntelligence(enabled ? emailId : undefined);
	const startCompose = useUIStore((state) => state.startCompose);
	if (!enabled) return null;

	const replyDecisionResult = intelligence.data?.replyDecision?.result;
	const replyNeeded =
		!replyDecisionResult || replyDecisionResult.shouldReply !== false;
	const variants = intelligence.data?.replyDraft?.result?.variants;
	const replyDraftStatus = intelligence.data?.replyDraft?.status ?? (intelligence.isLoading ? "pending" : "pending");
	const showChips =
		!isSentMail &&
		replyNeeded &&
		replyDraftStatus === "succeeded" &&
		Array.isArray(variants) &&
		variants.length > 0;
	return showChips ? (
		<div className="border-t border-edge">
			<QuickReplyChips
				variants={variants}
				confidence={replyDecisionResult?.confidence ?? null}
				onSelect={(variant) =>
					startCompose({
						mode: "reply",
						originalEmail: lastReceivedMessage,
						prefilledBody: variant.draftMarkdown,
					})
				}
			/>
		</div>
	) : null;
}

export const QuickReplyPane = memo(QuickReplyPaneBase);
