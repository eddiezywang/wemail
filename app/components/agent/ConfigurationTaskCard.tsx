import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import type {
	ConfigurationInteractionAction,
	ConfigurationTaskSnapshot,
} from "../../../shared/wemail/configuration";

export function ConfigurationTaskCard({
	task,
	onAction,
}: {
	task: ConfigurationTaskSnapshot;
	onAction?: (action: ConfigurationInteractionAction) => void;
}) {
	const issue = task.issues.find((item) => !item.resolvedAt);
	const interaction = task.interaction ?? fallbackInteraction(task);
	const terminal =
		task.status === "completed" || task.status === "completed_with_warnings";

	return (
		<section
			className="border-l-2 border-edge px-3 py-1"
			data-configuration-task-id={task.id}
			aria-live="polite"
		>
			<div className="flex items-center gap-2 text-xs text-ink-3">
				{terminal ? (
					<CheckCircleIcon size={14} weight="fill" className="text-green" />
				) : issue ? (
					<WarningCircleIcon size={14} className="text-amber" />
				) : (
					<span className="h-2 w-2 rounded-full bg-coral" />
				)}
				<span>{interaction.stage}</span>
			</div>
			<p className="mt-1.5 text-sm leading-6 text-ink">{interaction.message}</p>
			{interaction.impact ? (
				<p className="mt-1 text-xs leading-5 text-ink-3">{interaction.impact}</p>
			) : null}

			{interaction.previewLinks.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-2">
					{interaction.previewLinks.map((preview) => (
						<a
							key={preview.id}
							href={preview.url}
							target="_blank"
							rel="noreferrer"
							className="rounded-full border border-edge bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:bg-paper-2"
						>
							{preview.label} · v{preview.version}
						</a>
					))}
				</div>
			) : null}

			{interaction.actions.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-2">
					{interaction.actions
						.filter((action) => action.type !== "open_preview")
						.map((action) => (
							<button
								key={action.id}
								type="button"
								onClick={() => onAction?.(action)}
								className={`rounded-full px-3 py-1.5 text-xs ${
									action.preferred
										? "bg-ink text-paper hover:opacity-90"
										: "border border-edge text-ink-2 hover:bg-paper-2"
								}`}
							>
								{action.label}
							</button>
						))}
				</div>
			) : null}

		</section>
	);
}

function fallbackInteraction(task: ConfigurationTaskSnapshot) {
	const issue = task.issues.find((item) => !item.resolvedAt);
	return {
		goalStatus: "in_progress" as const,
		stage: phaseLabel(task.currentPhase),
		message: issue?.userMessage ?? statusLabel(task.status),
		impact: issue?.affectedScope.length
			? `当前只影响：${issue.affectedScope.join("、")}。`
			: undefined,
		actions: task.recoveries
			.filter((action) => !action.resolvedAt)
			.map((action) => ({
				id: action.id,
				type:
					action.type === "open_settings"
						? ("open_settings" as const)
						: action.type === "cancel"
							? ("cancel" as const)
							: ("retry" as const),
				label: action.label,
				preferred: action.preferred,
			})),
		previewLinks: [],
		technicalDetails: undefined,
	};
}

function statusLabel(status: ConfigurationTaskSnapshot["status"]): string {
	return {
		drafting: "正在理解你的配置目标。",
		collecting: "还需要补充一些配置要求。",
		needs_input: "需要你补充信息后继续。",
		checking_prerequisites: "正在检查当前环境。",
		resolving_capabilities: "正在匹配这台设备可用的能力。",
		compiling: "正在把要求编译成可执行流程。",
		reviewing: "正在等待你评价当前预览。",
		blocked: "当前阶段被一个明确条件阻塞。",
		preparing_preview: "正在生成可评审的结果预览。",
		awaiting_confirmation: "预览已就绪，等待确认。",
		awaiting_final_confirmation: "流程已串通，等待最终创建授权。",
		committing: "正在创建精确规则。",
		verifying: "规则已提交，正在回读验证。",
		completed: "配置已验证生效。",
		completed_with_warnings: "配置已生效，但有提示需要关注。",
		retryable_failure: "当前步骤可以安全重试。",
		failed: "配置未完成。",
		outcome_unknown: "已经发生操作，但结果仍需核对。",
		cancelled: "配置已取消。",
	}[status];
}

function phaseLabel(phase: ConfigurationTaskSnapshot["currentPhase"]): string {
	return {
		understand_goal: "理解目标",
		collect_requirements: "补齐信息",
		resolve_capabilities: "匹配能力",
		check_prerequisites: "检查环境",
		discover_capabilities: "读取能力",
		compile_configuration: "生成流程",
		validate_configuration: "校验流程",
		generate_preview: "生成预览",
		review_intermediate_result: "评审预览",
		await_confirmation: "确认预览",
		await_final_confirmation: "最终确认",
		commit_configuration: "创建规则",
		verify_configuration: "验证生效",
	}[phase];
}
