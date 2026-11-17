import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useState } from "react";
import type {
	AutomationRunDetail,
	AutomationStepDetail,
} from "../../../shared/wemail/automationCenter";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { AutomationResultView } from "./AutomationResultView";
import { ArtifactViewer } from "../applicationMessages/ArtifactViewer";

export function AutomationRunDetailDialog({
	open,
	onOpenChange,
	run,
	accountId,
	loading,
	retrying,
	onRetry,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	run?: AutomationRunDetail;
	accountId?: string;
	loading: boolean;
	retrying: boolean;
	onRetry: (step: AutomationStepDetail) => void;
}) {
	const [artifactOpen, setArtifactOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[88vh] w-[94vw] max-w-[680px] overflow-y-auto p-0">
				<header className="border-b border-edge px-6 py-4">
					<div className="flex items-center gap-2">
						<DialogTitle className="text-lg font-semibold text-ink">运行详情</DialogTitle>
						{run ? <OutcomeBadge outcome={run.outcome} /> : null}
					</div>
					<DialogDescription className="mt-1 text-xs text-ink-3">
						{run
							? `${formatDate(run.startedAt)}${durationOf(run) ? ` · ${formatDuration(durationOf(run)!)} 完成` : ""}`
							: "正在读取运行记录"}
					</DialogDescription>
				</header>

				{loading || !run ? (
					<div className="px-6 py-14 text-center text-sm text-ink-3">正在加载运行详情…</div>
				) : (
					<RunDetailContent
						run={run}
						accountId={accountId}
						retrying={retrying}
						onRetry={onRetry}
						onOpenArtifact={() => setArtifactOpen(true)}
					/>
				)}
				{artifactOpen && run?.output?.id && accountId ? (
					<ArtifactViewer
						viewport
						accountId={accountId}
						message={{
							id: run.output.id,
							title: run.output.title ?? "自动化图表",
						}}
						onClose={() => setArtifactOpen(false)}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function RunDetailContent({
	run,
	accountId,
	retrying,
	onRetry,
	onOpenArtifact,
}: {
	run: AutomationRunDetail;
	accountId?: string;
	retrying: boolean;
	onRetry: (step: AutomationStepDetail) => void;
	onOpenArtifact: () => void;
}) {
	const problemSteps = run.steps.filter(
		(step) => step.status === "failed" || step.status === "blocked" || step.status === "partial",
	);
	const detailSteps = problemSteps.length
		? run.steps.filter((step) => !problemSteps.includes(step))
		: run.steps;
	const hasSources = run.result?.provenance.some((item) => item.sources.length);
	const analysis = analysisSummary(run);
	return (
		<div className="space-y-5 px-6 py-5">
			<section aria-labelledby="run-business-result">
				<h3 id="run-business-result" className="text-sm font-semibold text-ink">
					本次分析
				</h3>
				<div className="mt-3 space-y-3 text-sm leading-6 text-ink-2">
					<div>
						<p className="text-xs text-ink-4">分析范围</p>
						<p>{analysis.scope}</p>
					</div>
					{analysis.objective ? (
						<div>
							<p className="text-xs text-ink-4">分析内容</p>
							<p>{analysis.objective}</p>
						</div>
					) : null}
					{analysis.metrics ? (
						<div>
							<p className="text-xs text-ink-4">关键结果</p>
							<p>{analysis.metrics}</p>
						</div>
					) : null}
					{run.result ? (
						<AutomationResultView envelope={run.result} />
					) : (
						<div>
							<p className="text-xs text-ink-4">结论</p>
							<p>{run.output?.preview ?? resultSummary(run)}</p>
						</div>
					)}
				</div>
				{run.output?.type === "application_message" && run.output.id && accountId ? (
					<button
						type="button"
						onClick={onOpenArtifact}
						className="mt-4 inline-flex items-center rounded-md bg-coral px-3 py-2 text-sm font-medium text-paper hover:opacity-90"
					>
						查看完整图表
					</button>
				) : run.output?.type === "artifact" ? (
					<p className="mt-3 text-xs text-amber">
						图表已生成，但这条历史记录尚未保存到应用消息。再次运行后可直接打开。
					</p>
				) : null}
				<DeliveryStatement run={run} />
				{run.truncated ? (
					<p className="mt-2 text-xs text-amber">邮件数量较多，本次只处理了设定范围内的内容。</p>
				) : null}
			</section>

			{problemSteps.length ? (
				<section aria-labelledby="run-problem-result">
					<h3 id="run-problem-result" className="text-sm font-semibold text-red">
						需要处理
					</h3>
					<div className="mt-3 divide-y divide-edge-3 rounded-lg border border-red/20 bg-red/[0.025]">
						{problemSteps.map((step) => (
							<StepRow key={step.id} step={step} retrying={retrying} onRetry={onRetry} />
						))}
					</div>
				</section>
			) : null}

			{detailSteps.length || hasSources ? (
				<details className="group border-t border-edge pt-1">
					<summary className="flex cursor-pointer list-none items-center justify-between py-3 text-xs font-medium text-ink-3 hover:text-ink">
						查看执行信息
						<CaretDownIcon className="transition-transform group-open:rotate-180" size={14} />
					</summary>
					<div className="space-y-5 pb-1">
						{detailSteps.length ? (
							<div className="divide-y divide-edge-3 border-y border-edge">
								{detailSteps.map((step) => (
									<StepRow key={step.id} step={step} retrying={retrying} onRetry={onRetry} />
								))}
							</div>
						) : null}
						{hasSources ? (
							<section aria-labelledby="run-source-result">
								<h3 id="run-source-result" className="text-xs font-semibold text-ink">
									相关邮件
								</h3>
								<SourceLinks provenance={run.result!.provenance} />
							</section>
						) : null}
					</div>
				</details>
			) : null}
		</div>
	);
}

function analysisSummary(run: AutomationRunDetail) {
	const artifactStep = run.steps.find(
		(step) =>
			typeof step.inputSummary?.objective === "string" ||
			step.outputSummary?.type === "artifact-reference",
	);
	const objective = textAt(artifactStep?.inputSummary, "objective");
	const summary = nestedRecord(artifactStep?.inputSummary, "dataset", "summary");
	const metrics = summary
		? [
				metric(summary, "totalRequests", "调用"),
				metric(summary, "totalErrors", "失败"),
				metric(summary, "totalAlerts", "告警"),
				metric(summary, "avgLatencyMs", "平均耗时", "ms"),
				metric(summary, "successRate", "成功率", "%"),
			].filter(Boolean).join(" · ")
		: undefined;
	const accountText = run.resolvedAccountIds.length > 1
		? `${run.resolvedAccountIds.length} 个邮箱`
		: "当前邮箱";
	const windowText = run.window
		? `${formatShortDate(run.window.start)} 至 ${formatShortDate(run.window.end)}`
		: "本次触发时段";
	return {
		scope: `${windowText}，${accountText}，共读取 ${run.inputCount} 封匹配邮件。`,
		objective,
		metrics,
	};
}

function nestedRecord(
	value: Record<string, unknown> | undefined,
	...path: string[]
): Record<string, unknown> | undefined {
	let current: unknown = value;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current && typeof current === "object"
		? current as Record<string, unknown>
		: undefined;
}

function metric(
	summary: Record<string, unknown>,
	key: string,
	label: string,
	suffix = "",
) {
	const value = summary[key];
	return typeof value === "number" && Number.isFinite(value)
		? `${label} ${value.toLocaleString()}${suffix}`
		: undefined;
}

function textAt(value: Record<string, unknown> | undefined, key: string) {
	const item = value?.[key];
	return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function formatShortDate(value: string) {
	return new Date(value).toLocaleString([], {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function DeliveryStatement({ run }: { run: AutomationRunDetail }) {
	if (run.deliveries.length) {
		return (
			<div className="mt-4 space-y-1.5 border-l-2 border-green pl-3">
				{run.deliveries.map((delivery, index) => (
					<p
						key={`${delivery.destination}-${delivery.outputId ?? index}`}
						className={`text-xs ${
							delivery.status === "failed" ? "text-red" : "text-ink-3"
						}`}
					>
						{deliverySentence(delivery)}
					</p>
				))}
			</div>
		);
	}
	const silent = run.steps.some(
		(step) =>
			step.stage === "delivery" &&
			step.warnings.some((warning) => /未发送|静默|无需通知/.test(warning)),
	);
	return silent ? (
		<p className="mt-4 border-l-2 border-edge pl-3 text-xs text-ink-3">
			没有需要你处理的内容，本次已静默。
		</p>
	) : null;
}

function SourceLinks({
	provenance,
}: {
	provenance: NonNullable<AutomationRunDetail["result"]>["provenance"];
}) {
	const seen = new Set<string>();
	const sources = provenance
		.flatMap((item) => item.sources)
		.filter((source) => {
			const key =
				source.type === "attachment"
					? `${source.accountId}:${source.emailId}:${source.attachmentId}`
					: `${source.accountId}:${source.emailId}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 20);
	return (
		<ul className="mt-3 space-y-2 rounded-lg border border-edge px-3 py-2.5">
			{sources.map((source) => {
				const key =
					source.type === "attachment"
						? `${source.accountId}:${source.emailId}:${source.attachmentId}`
						: `${source.accountId}:${source.emailId}`;
				const label =
					source.type === "attachment"
						? source.label || source.filename || "查看附件"
						: source.label || source.subject || "查看邮件";
				if (source.availability && source.availability !== "available") {
					return (
						<li key={key} className="text-xs text-ink-4">
							{label}（
							{source.availability === "account_disconnected"
								? "邮箱已断开"
								: "来源不存在"}
							）
						</li>
					);
				}
				const href =
					source.type === "attachment"
						? `/api/mail/messages/${encodeURIComponent(source.emailId)}/attachments/${encodeURIComponent(source.attachmentId)}?accountId=${encodeURIComponent(source.accountId)}`
						: `/message/${encodeURIComponent(source.emailId)}?accountId=${encodeURIComponent(source.accountId)}`;
				return (
					<li key={key}>
						<a
							href={href}
							className="text-xs text-coral hover:underline"
							{...(source.type === "attachment"
								? { target: "_blank", rel: "noreferrer" }
								: {})}
						>
							{label}
						</a>
					</li>
				);
			})}
		</ul>
	);
}

function StepRow({
	step,
	retrying,
	onRetry,
}: {
	step: AutomationStepDetail;
	retrying: boolean;
	onRetry: (step: AutomationStepDetail) => void;
}) {
	const failed = step.status === "failed" || step.status === "blocked";
	return (
		<div className="flex items-start gap-3 px-4 py-3">
			<span className={`mt-0.5 ${failed ? "text-red" : "text-ink-3"}`}>
				{failed ? <WarningCircleIcon size={16} weight="fill" /> : <span aria-hidden="true">•</span>}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex items-center justify-between gap-3">
					<p className="text-xs font-semibold text-ink">{stageLabel(step.stage)}</p>
					<span className={`text-xs ${failed ? "text-red" : "text-ink-3"}`}>
						{stepStatusLabel(step.status)}
					</span>
				</div>
				<p className="mt-1 text-xs leading-5 text-ink-3">{stepBusinessSummary(step)}</p>
				{step.warnings.length ? (
					<p className="mt-1 text-xs text-amber">{step.warnings.join("；")}</p>
				) : null}
			</div>
			{failed && step.retrySafe ? (
				<Button
					size="sm"
					variant="outline"
					disabled={retrying}
					onClick={() => onRetry(step)}
				>
					<ArrowClockwiseIcon size={13} />
					重试此步
				</Button>
			) : null}
		</div>
	);
}

function OutcomeBadge({ outcome }: { outcome: AutomationRunDetail["outcome"] }) {
	const failed = outcome === "failed" || outcome === "partial";
	return (
		<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${failed ? "bg-red-bg text-red" : "bg-green-bg text-green"}`}>
			{outcomeLabel(outcome)}
		</span>
	);
}

function resultSummary(run: AutomationRunDetail) {
	if (run.resultAvailability === "expired") return "业务结果已按保留策略清理，运行摘要仍然可用。";
	if (run.resultAvailability === "unsupported") return "结果格式暂不受当前版本支持，请升级应用后查看。";
	if (run.outcome === "empty") return "本次时间范围内没有需要处理的内容。";
	if (run.outcome === "failed") return "本次运行未完成，请查看需要处理的问题。";
	if (run.outcome === "partial") return "主要处理已完成，但仍有一项需要处理。";
	const data = run.result?.data;
	if (data && typeof data === "object" && Object.keys(data).length) {
		return summarizeObject(data as Record<string, unknown>);
	}
	const generatedArtifact = run.steps.some(
		(step) =>
			step.stage === "artifact" &&
			(step.outputSummary?.type === "artifact-reference" ||
				typeof step.outputSummary?.artifactId === "string"),
	);
	return generatedArtifact ? "报告已生成。" : "本次运行已完成。";
}

function summarizeObject(value: Record<string, unknown>) {
	const preferred = ["summary", "title", "message", "description"];
	for (const key of preferred) {
		if (typeof value[key] === "string") return String(value[key]);
	}
	return Object.entries(value)
		.slice(0, 3)
		.map(([key, item]) => `${key}: ${Array.isArray(item) ? `${item.length} 项` : String(item)}`)
		.join(" · ");
}

function stageLabel(stage: AutomationStepDetail["stage"]) {
	return { trigger: "触发", data: "读取数据", analysis: "分析", artifact: "生成产出", delivery: "投递" }[stage];
}

function stepBusinessSummary(step: AutomationStepDetail) {
	if (step.error?.message) return "这一步没有完成。你可以重试，或检查自动化配置。";
	if (step.sideEffects.length) return step.sideEffects.join("；");
	if (step.status === "empty") return "没有找到需要处理的内容";
	return {
		trigger: "已按计划触发",
		data: "邮件读取完成",
		analysis: "内容分析完成",
		artifact: "结果已生成",
		delivery: "通知步骤已完成",
	}[step.stage];
}

function stepStatusLabel(status: AutomationStepDetail["status"]) {
	return {
		configured: "已配置",
		pending: "等待中",
		running: "执行中",
		succeeded: "已完成",
		empty: "无数据",
		partial: "部分完成",
		failed: "失败",
		skipped: "已跳过",
		blocked: "被阻塞",
	}[status];
}

function outcomeLabel(outcome: AutomationRunDetail["outcome"]) {
	return {
		running: "执行中",
		succeeded: "已完成",
		empty: "无数据",
		partial: "部分完成",
		failed: "失败",
		cancelled: "已取消",
		outcome_unknown: "状态未知",
	}[outcome];
}

function deliveryLabel(destination: AutomationRunDetail["deliveries"][number]["destination"]) {
	return {
		conversation: "Agent 对话",
		message_center: "消息中心",
		feishu_bot: "飞书 Bot",
		wecom_bot: "企业微信 Bot",
		connected_bot: "已连接 Bot",
		desktop_notification: "桌面通知",
	}[destination];
}

function deliverySentence(delivery: AutomationRunDetail["deliveries"][number]) {
	const target = deliveryLabel(delivery.destination);
	return {
		pending: `正在发送至${target}。`,
		succeeded: `已发送至${target}。`,
		failed: `发送至${target}失败。`,
		skipped: `未发送至${target}。`,
		unknown: `是否送达${target}暂时无法确认。`,
	}[delivery.status];
}

function formatDate(value: string) {
	return new Date(value).toLocaleString();
}

function formatDuration(value: number) {
	return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function durationOf(run: AutomationRunDetail) {
	if (typeof run.durationMs === "number") return run.durationMs;
	if (!run.completedAt) return undefined;
	const duration = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
	return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
