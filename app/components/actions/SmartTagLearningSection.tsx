// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { ActionCenterPayload } from "~/services/api";

interface SmartTagLearningSectionProps {
	actions: ActionCenterPayload["smartTagActions"];
	revisions: ActionCenterPayload["smartTagPromptRevisions"];
	runs: NonNullable<ActionCenterPayload["smartTagLearningRuns"]>;
}

function actionLabel(actionType: "apply" | "remove") {
	return actionType === "apply" ? "移入" : "移出";
}

function processedLabel(processedAt?: string) {
	return processedAt ? "已纳入批次" : "等待批量优化";
}

function runTitle(status: NonNullable<ActionCenterPayload["smartTagLearningRuns"]>[number]["status"]) {
	if (status === "generating") return "正在消费真实邮件";
	if (status === "evaluating") return "正在进行 A/B 重打标";
	if (status === "activated") return "优化提示词已激活";
	if (status === "rejected") return "候选未通过，当前提示词保持不变";
	if (status === "stale") return "定义已变化，等待下一批优化";
	return "批量优化失败";
}

export function SmartTagLearningSection({
	actions,
	revisions,
	runs,
}: SmartTagLearningSectionProps) {
	if (actions.length === 0 && revisions.length === 0 && runs.length === 0) return null;

	return (
		<section
			className="space-y-3"
			aria-labelledby="smart-tag-learning-heading"
			data-testid="action-center-smart-tags"
		>
			<div className="flex items-center justify-between gap-3">
				<h2
					id="smart-tag-learning-heading"
					className="text-sm font-semibold text-ink"
				>
					智能标签反馈
				</h2>
				<span className="text-xs text-ink-3 tabular-nums">
					{actions.length} 条反馈 · {runs.length} 个批次
				</span>
			</div>

			{runs.length > 0 ? (
				<div className="rounded-lg border border-edge bg-paper overflow-hidden">
					{runs.map((run) => (
						<div
							key={run.id}
							className="px-4 py-3 border-b border-edge last:border-b-0"
							data-testid="smart-tag-learning-run-row"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="text-sm font-medium text-ink truncate">
										「{run.tagName}」{runTitle(run.status)}
									</div>
									<div className="mt-1 text-xs text-ink-3">
										{run.status === "activated"
											? `验证 ${run.currentCorrect}/${run.validationCount} → ${run.candidateCorrect}/${run.validationCount}，修正 ${run.correctedCount} 封`
											: `共 ${run.sampleCount} 封：移入 ${run.positiveCount}，移出 ${run.negativeCount}`}
									</div>
								</div>
								<span className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-xs text-ink-3">
									{run.status}
								</span>
							</div>
						</div>
					))}
				</div>
			) : null}

			{actions.length > 0 ? (
				<div className="rounded-lg border border-edge bg-paper overflow-hidden">
					{actions.map((action) => (
						<div
							key={action.id}
							className="px-4 py-3 border-b border-edge last:border-b-0"
							data-testid="smart-tag-action-row"
						>
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<div className="text-sm font-medium text-ink truncate">
										{actionLabel(action.actionType)}「{action.tagName}」
									</div>
									<div className="mt-1 text-xs text-ink-3">
										操作已记录；达到样本门槛后会与其他真实邮件一起优化和验证。
									</div>
								</div>
								<span className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-xs text-ink-3">
									{processedLabel(action.processedAt)}
								</span>
							</div>
						</div>
					))}
				</div>
			) : null}

			{revisions.length > 0 ? (
				<div className="rounded-lg border border-edge bg-paper overflow-hidden">
					{revisions.map((revision) => (
						<div
							key={revision.id}
							className="px-4 py-3 border-b border-edge last:border-b-0"
							data-testid="smart-tag-revision-row"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="text-sm font-medium text-ink truncate">
										「{revision.tagName}」提示词已更新
									</div>
									<div className="mt-1 text-xs text-ink-3">
										{revision.summary}
									</div>
								</div>
								<span className="shrink-0 text-xs text-ink-3 tabular-nums">
									{revision.actionCount} 条
								</span>
							</div>
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}

