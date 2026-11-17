import {
	CheckCircleIcon,
	CircleIcon,
	ClockIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import type {
	AutomationWorkflowStage,
	AutomationWorkflowStageSummary,
} from "../../../shared/wemail/automationCenter";

const STAGES: Array<{ id: AutomationWorkflowStage; label: string }> = [
	{ id: "trigger", label: "触发" },
	{ id: "data", label: "数据" },
	{ id: "analysis", label: "分析" },
	{ id: "artifact", label: "产出" },
	{ id: "delivery", label: "投递" },
];

export function WorkflowRail({
	stages,
	compact = false,
}: {
	stages: AutomationWorkflowStageSummary[];
	compact?: boolean;
}) {
	const byId = new Map(stages.map((stage) => [stage.stage, stage]));
	return (
		<ol
			className={`grid grid-cols-5 ${compact ? "gap-1" : "gap-2"}`}
			aria-label="自动化执行流程"
		>
			{STAGES.map((definition, index) => {
				const stage = byId.get(definition.id);
				const state = stage?.status ?? "pending";
				const tone = statusTone(state);
				return (
					<li key={definition.id} className="relative min-w-0">
						{index > 0 ? (
							<span
								className={`absolute right-1/2 top-3 h-px w-full ${tone.line}`}
								aria-hidden="true"
							/>
						) : null}
						<div className="relative flex flex-col items-center text-center">
							<span
								className={`z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-paper ${tone.ring}`}
								title={stage?.summary}
							>
								<StatusIcon status={state} />
							</span>
							<span className={`mt-1.5 truncate text-xs font-medium ${tone.text}`}>
								{definition.label}
							</span>
							{!compact ? (
								<span className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-ink-3">
									{stage?.summary || "等待配置"}
								</span>
							) : null}
						</div>
					</li>
				);
			})}
		</ol>
	);
}

function StatusIcon({ status }: { status: AutomationWorkflowStageSummary["status"] }) {
	if (status === "failed" || status === "blocked") {
		return <WarningCircleIcon size={14} weight="fill" className="text-red" />;
	}
	if (status === "running") {
		return <ClockIcon size={13} weight="bold" className="animate-pulse text-coral motion-reduce:animate-none" />;
	}
	if (status === "succeeded" || status === "configured" || status === "empty") {
		return <CheckCircleIcon size={14} weight="fill" className="text-green" />;
	}
	return <CircleIcon size={11} weight="fill" className="text-ink-4" />;
}

function statusTone(status: AutomationWorkflowStageSummary["status"]) {
	if (status === "failed" || status === "blocked") {
		return { ring: "border-red/30", line: "bg-red/20", text: "text-red" };
	}
	if (status === "running") {
		return { ring: "border-coral/40", line: "bg-coral/30", text: "text-coral" };
	}
	if (status === "succeeded" || status === "configured" || status === "empty") {
		return {
			ring: "border-green/30",
			line: "bg-green/25",
			text: "text-ink-2",
		};
	}
	return { ring: "border-edge", line: "bg-edge", text: "text-ink-3" };
}
