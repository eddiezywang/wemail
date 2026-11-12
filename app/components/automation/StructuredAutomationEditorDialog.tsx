import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type {
	AutomationAccountScope,
	AutomationDraftPatch,
} from "../../../shared/wemail/automationCenter";
import type {
	AnalysisRecipe,
	ArtifactRecipe,
	DataSelectionSpec,
	DeliveryPlan,
	ExecutionPipelineDraft,
} from "../../../shared/wemail/skillCenter";
import { ApiError } from "~/services/api";
import api from "~/services/api";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { getUserFacingError } from "~/lib/user-facing-error";

export function StructuredAutomationEditorDialog({
	accountId,
	draft,
	open,
	onOpenChange,
	onDraftChange,
	onAskAgent,
	automationName,
	automationDescription,
}: {
	accountId: string;
	draft?: ExecutionPipelineDraft;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDraftChange: (draft: ExecutionPipelineDraft) => void;
	onAskAgent: () => void;
	automationName?: string;
	automationDescription?: string;
}) {
	const [form, setForm] = useState(() =>
		formFromDraft(draft, automationName, automationDescription),
	);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState<{
		currentRevision?: number;
		changedSections?: string[];
		updatedAt?: string;
	}>();
	const [interaction, setInteraction] = useState<string>();

	useEffect(() => {
		setForm(formFromDraft(draft, automationName, automationDescription));
		setConflict(undefined);
		setInteraction(undefined);
	}, [draft?.id, draft?.revision, automationName, automationDescription]);

	if (!draft) return null;
	const notificationOnly = isSummaryNotificationDraft(draft);

	const save = async () => {
		setSaving(true);
		setConflict(undefined);
		try {
			const result = await api.patchUnifiedAutomationDraft(
				draft.id,
				accountId,
				patchFromForm(draft, form),
			);
			onDraftChange(result.draft);
			setInteraction(
				result.interaction?.message ??
					"草稿已保存。受影响的预览需要重新评审，保存不会直接启用规则。",
			);
			toast.success("配置草稿已保存");
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) {
				const value =
					error.body.conflict && typeof error.body.conflict === "object"
						? (error.body.conflict as typeof conflict)
						: {};
				setConflict(value);
			} else {
				toast.error(getUserFacingError(error, "配置草稿保存失败，请稍后重试。"));
			}
		} finally {
			setSaving(false);
		}
	};

	const reload = async () => {
		try {
			const latest = await api.getUnifiedAutomationDraft(draft.id, accountId);
			onDraftChange(latest.draft);
			setConflict(undefined);
			toast.success("已载入最新草稿");
		} catch (error) {
			toast.error(getUserFacingError(error, "最新配置载入失败，请稍后重试。"));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[88vh] w-[94vw] max-w-[640px] flex-col overflow-hidden p-0">
				<header className="shrink-0 border-b border-edge px-6 py-4">
					<DialogTitle>编辑{form.name || "规则"}</DialogTitle>
					<DialogDescription className="mt-1 text-xs">
						{notificationOnly
							? "设置何时执行，以及将邮件摘要和标签发送到哪里。"
							: "设置何时执行、结果发送到哪里，以及结果如何生成。"}
					</DialogDescription>
				</header>
				<div
					className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 py-5"
					data-testid="automation-editor-scroll-region"
				>
					{conflict ? (
						<div role="alert" className="rounded-lg border border-amber/40 bg-amber-bg p-4 text-sm text-amber">
							<p className="font-semibold">草稿已在其他位置更新</p>
							<p className="mt-1 text-xs leading-5">
								当前版本 {conflict.currentRevision ?? "已变化"}
								{conflict.changedSections?.length
									? `，涉及：${conflict.changedSections.map(conflictSectionLabel).join("、")}`
									: ""}
								。为避免覆盖 Agent 或其他窗口的修改，请先重新载入。
							</p>
							<Button className="mt-3" size="sm" variant="outline" onClick={() => void reload()}>
								重新载入最新版本
							</Button>
						</div>
					) : null}

					<Field label="名称">
						<Input
							value={form.name}
							onChange={(event) => setForm({ ...form, name: event.target.value })}
						/>
					</Field>

					<EditorSection
						title="什么时候执行"
						description="选择规则开始运行的时机。"
					>
						<div className="grid gap-3 sm:grid-cols-2">
							<SelectField
								label="触发条件"
								value={form.triggerEvent}
								onValueChange={(value) => setForm({ ...form, triggerEvent: value as EditorForm["triggerEvent"] })}
								options={[{ value: "schedule", label: "每天定时" }, { value: "mail.received", label: "收到匹配邮件时" }, { value: "manual", label: "仅手动运行" }]}
							/>
							<SelectField
								label="邮箱范围"
								value={form.accountScope}
								onValueChange={(value) => setForm({ ...form, accountScope: value as EditorForm["accountScope"] })}
								options={[{ value: "currentAccount", label: "当前邮箱" }, { value: "allConnectedAccounts", label: "全部已连接邮箱" }]}
							/>
						</div>
						{form.triggerEvent === "schedule" ? (
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label="执行时间"><Input type="time" value={form.localTime} onChange={(event) => setForm({ ...form, localTime: event.target.value })} /></Field>
								<Field label="时区"><Input value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></Field>
							</div>
						) : null}
					</EditorSection>

					{form.triggerEvent === "schedule" ? (
						<EditorSection
							title="读取哪些邮件"
							description="控制每次定时运行读取的邮件时间范围。"
						>
							<div className="space-y-3">
								<SelectField
									label="邮件时间范围"
									value={form.dataScope}
									onValueChange={(value) => setForm({ ...form, dataScope: value as EditorForm["dataScope"] })}
									options={[{ value: "bounded_previous_schedule_window", label: "上次成功执行后，最多回看指定时长" }, { value: "rolling_window", label: "每次读取最近一段时间" }, { value: "previous_schedule_window", label: "上次成功执行后的全部邮件" }, { value: "calendar_day", label: "当天 00:00 至执行时" }]}
								/>
								<div className="grid gap-3 sm:grid-cols-2">
									{form.dataScope === "bounded_previous_schedule_window" || form.dataScope === "rolling_window" ? (
										<Field label={form.dataScope === "bounded_previous_schedule_window" ? "最长回看时间" : "读取最近时间"}>
											<Input
												type="number"
												min={1}
												max={168}
												value={form.windowAmount}
												onChange={(event) => setForm({ ...form, windowAmount: event.target.value })}
												onBlur={() => setForm({ ...form, windowAmount: String(parsedWindowHours(form.windowAmount)) })}
												aria-describedby="automation-window-hours-hint"
											/>
											<span id="automation-window-hours-hint" className="mt-1.5 block text-xs text-ink-3">1-168 小时</span>
										</Field>
									) : null}
									<Field label="最多处理邮件">
										<Input
											type="number"
											min={1}
											max={1000}
											value={form.maxMessages}
											onChange={(event) => setForm({ ...form, maxMessages: event.target.value })}
											onBlur={() => setForm({ ...form, maxMessages: String(parsedMaxMessages(form.maxMessages)) })}
											aria-describedby="automation-max-messages-hint"
										/>
										<span id="automation-max-messages-hint" className="mt-1.5 block text-xs text-ink-3">全部已选邮箱合计，1-1000 封</span>
									</Field>
								</div>
							</div>
							<p role="status" className="rounded-md bg-paper-3 px-3 py-2.5 text-xs leading-5 text-ink-2">
								{scheduledReadSummary(form)}
							</p>
						</EditorSection>
					) : form.triggerEvent === "mail.received" ? (
						<EditorSection
							title="读取哪些邮件"
							description="收到一封匹配邮件时，使用该邮件启动本次自动化。"
						>
							<div className="flex min-h-11 items-center justify-between rounded-md border border-edge bg-paper-2 px-3 py-2.5">
								<span className="text-xs text-ink-3">数据来源</span>
								<strong className="text-sm font-medium text-ink">本次收到的邮件</strong>
							</div>
							<p className="text-xs leading-5 text-ink-3">每封匹配邮件会分别触发一次，不读取其他邮件，也不使用时间窗口。</p>
						</EditorSection>
					) : (
						<EditorSection
							title="读取哪些邮件"
							description="手动触发不提供定时时间范围配置。"
						>
							<div role="status" className="rounded-md bg-paper-3 px-3 py-2.5 text-xs leading-5 text-ink-2">
								手动运行时沿用当前保存的数据范围。如需调整时间范围，请先切换为定时触发。
							</div>
						</EditorSection>
					)}

					<EditorSection
						title="发送到哪里"
						description="可以保存在应用内，也可以发送到当前已连接的 Bot。"
					>
						<ToggleRow label="发布到消息中心" checked={form.messageCenter} onCheckedChange={(value) => setForm({ ...form, messageCenter: value })} />
						<ToggleRow label="发送到已连接 Bot（飞书或企业微信）" checked={form.connectedBot} onCheckedChange={(value) => setForm({ ...form, connectedBot: value })} />
					</EditorSection>

					{notificationOnly ? (
						<EditorSection
							title="通知内容"
							description="发送摘要文本和邮件标签，不生成 HTML、图片或 PDF 产物。"
						>
							<div className="rounded-md border border-edge bg-paper-2 px-3 py-3 text-xs leading-5 text-ink-2">
								正文包含主题、发件人、接收时间、摘要要点、待办事项和 AI 标签。
							</div>
						</EditorSection>
					) : (
						<EditorSection
							title="产出什么"
							description="这段生成规则会交给 Agent，决定 HTML 的内容和呈现方式。"
						>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label="结果标题"><Input value={form.artifactTitle} onChange={(event) => setForm({ ...form, artifactTitle: event.target.value })} /></Field>
								<SelectField
									label="格式"
									value={form.artifactFormat}
									onValueChange={(value) => setForm({ ...form, artifactFormat: value as ArtifactRecipe["format"] })}
									options={[{ value: "html", label: "HTML 页面" }, { value: "image", label: "图片" }, { value: "pdf", label: "PDF" }, { value: "text", label: "文本" }]}
								/>
							</div>
							<Field label="生成规则（提示词）">
								<textarea
									className={textareaClass}
									rows={8}
									value={form.analysisInstruction}
									onChange={(event) =>
										setForm({ ...form, analysisInstruction: event.target.value })
									}
								/>
							</Field>
							<ToggleRow label="包含折线图" checked={form.includeLineChart} onCheckedChange={(value) => setForm({ ...form, includeLineChart: value })} />
						</EditorSection>
					)}

					{draft.reviews.some((review) => review.status === "stale") ? (
						<p className="rounded-md bg-amber-bg px-3 py-2 text-xs text-amber">
							生成规则已变化，保存后需要重新确认结果预览。
						</p>
					) : null}
					{interaction ? <p role="status" className="rounded-lg bg-paper-3 px-3 py-2 text-xs text-ink-2">{interaction}</p> : null}
				</div>
				<DialogFooter className="shrink-0 border-t border-edge px-6 py-3">
					<Button variant="outline" onClick={onAskAgent}>用自然语言继续调整</Button>
					<Button disabled={saving || !!conflict} onClick={() => void save()}>{saving ? "保存中…" : "保存草稿"}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface EditorForm {
	name: string;
	description: string;
	accountScope: "currentAccount" | "allConnectedAccounts";
	triggerEvent: "schedule" | "mail.received" | "manual";
	localTime: string;
	timezone: string;
	dataScope: "bounded_previous_schedule_window" | "previous_schedule_window" | "calendar_day" | "rolling_window";
	windowAmount: string;
	maxMessages: string;
	analysisInstruction: string;
	artifactTitle: string;
	artifactFormat: ArtifactRecipe["format"];
	includeLineChart: boolean;
	messageCenter: boolean;
	connectedBot: boolean;
	includeArtifactLink: boolean;
	cron: string;
	modelPolicy: string;
	catchUpPolicy: string;
	retentionDays: number;
	instructionOverride: string;
}

function formFromDraft(
	draft?: ExecutionPipelineDraft,
	automationName?: string,
	automationDescription?: string,
): EditorForm {
	const notificationOnly = isSummaryNotificationDraft(draft);
	const timing = draft?.trigger?.timing ?? {};
	const data = draft?.dataSelection;
	const advanced = draft?.advancedPolicy ?? {};
	const modelTask = draft?.analysis?.modelTasks[0];
	const draftName = String(advanced.name ?? "").trim();
	return {
		name:
			!draftName || draftName === "自动化"
				? automationName || "未命名规则"
				: draftName,
		description: String(advanced.description ?? automationDescription ?? ""),
		accountScope: draft?.accountScope?.type === "allConnectedAccounts" ? "allConnectedAccounts" : "currentAccount",
		triggerEvent: draft?.trigger?.event ?? "schedule",
		localTime: String(timing.localTime ?? timing.time ?? "21:00"),
		timezone: String(timing.timezone ?? "Asia/Shanghai"),
		dataScope:
			data?.scope.type === "calendar_day" || data?.scope.type === "rolling_window"
				? data.scope.type
				: data?.scope.type === "previous_schedule_window" && data.scope.maxLookback
					? "bounded_previous_schedule_window"
					: "previous_schedule_window",
		windowAmount: String(
			data?.scope.type === "rolling_window"
				? data.scope.amount * (data.scope.unit === "day" ? 24 : 1)
				: data?.scope.type === "previous_schedule_window" && data.scope.maxLookback
					? data.scope.maxLookback.amount * (data.scope.maxLookback.unit === "day" ? 24 : 1)
					: 24,
		),
		maxMessages: String(data?.limits.maxMessages ?? 400),
		analysisInstruction: notificationOnly ? "" : modelTask?.instruction?.trim() || defaultOutputInstruction,
		artifactTitle: draft?.artifact?.title ?? (notificationOnly ? "邮件摘要通知" : "自动化结果"),
		artifactFormat: draft?.artifact?.format ?? (notificationOnly ? "text" : "html"),
		includeLineChart: notificationOnly ? false : draft?.artifact?.components.some((component) => component.type === "line_chart") ?? false,
		messageCenter: draft?.delivery?.destinations.some((destination) => destination.type === "message_center" && destination.enabled) ?? true,
		connectedBot: draft?.delivery?.destinations.some((destination) => destination.type === "connected_bot" && destination.enabled) ?? false,
		includeArtifactLink: notificationOnly ? false : draft?.delivery?.content.includeArtifactLink ?? true,
		cron: String(advanced.cron ?? ""),
		modelPolicy: String(advanced.modelPolicy ?? "default"),
		catchUpPolicy: String(advanced.catchUpPolicy ?? "skip"),
		retentionDays: Number(advanced.retentionDays ?? 30),
		instructionOverride: String(advanced.instructionOverride ?? ""),
	};
}

function patchFromForm(draft: ExecutionPipelineDraft, form: EditorForm): AutomationDraftPatch {
	const notificationOnly = isSummaryNotificationDraft(draft);
	const accountScope: AutomationAccountScope =
		form.accountScope === "allConnectedAccounts"
			? { type: "allConnectedAccounts" }
			: { type: "currentAccount", accountId: draft.accountId };
	const scheduledDataSelection: DataSelectionSpec = {
		...(draft.dataSelection ?? {
			version: 1,
			source: "mail",
			filters: [],
			limits: { maxMessages: 400 },
		}),
		scope:
			form.dataScope === "bounded_previous_schedule_window"
				? {
						type: "previous_schedule_window",
						maxLookback: {
							amount: parsedWindowHours(form.windowAmount),
							unit: "hour",
						},
					}
				: form.dataScope === "rolling_window"
				? { type: "rolling_window", amount: parsedWindowHours(form.windowAmount), unit: "hour" }
				: form.dataScope === "calendar_day"
					? { type: "calendar_day", timezone: form.timezone }
					: { type: "previous_schedule_window" },
		limits: {
			...(draft.dataSelection?.limits ?? {}),
			maxMessages: parsedMaxMessages(form.maxMessages),
		},
	};
	const dataSelection: DataSelectionSpec =
		form.triggerEvent === "mail.received"
			? {
					version: 1,
					source: "mail",
					scope: { type: "current_mail", emailId: "$trigger.mail.emailId" },
					filters: draft.dataSelection?.filters ?? [],
					limits: { maxMessages: 1 },
				}
			: form.triggerEvent === "schedule"
				? scheduledDataSelection
				: draft.dataSelection ?? scheduledDataSelection;
	const analysis: AnalysisRecipe = {
		...(draft.analysis ?? {
			version: 1,
			inputKinds: ["mail-collection"],
			dimensions: [],
			metrics: [],
			conclusions: [],
			outputSchema: { type: "object" },
			modelTasks: [],
		}),
		modelTasks: form.analysisInstruction.trim()
			? [
					{
						...(draft.analysis?.modelTasks[0] ?? {
							id: "structured-editor-analysis",
							outputFields: ["summary"],
							maxInputItems: 100,
						}),
							instruction: form.analysisInstruction.trim().slice(0, 4_000),
							maxInputItems: clamp(parsedMaxMessages(form.maxMessages), 1, 500),
					},
				]
			: draft.analysis?.modelTasks ?? [],
	};
	const existingComponents = draft.artifact?.components ?? [];
	const withoutLineChart = existingComponents.filter((component) => component.type !== "line_chart");
	const artifact: ArtifactRecipe = {
		...(draft.artifact ?? {
			version: 1,
			components: [],
			layout: { structure: "single-column", sections: ["content"] },
			theme: { name: "wemail" },
			accessibility: { includeTextSummary: true, chartDescriptions: true },
			emptyState: "没有符合条件的数据",
			errorState: "结果生成失败",
			outputSchema: { type: "object" },
		}),
		title: form.artifactTitle.trim().slice(0, 160) || "自动化结果",
		format: form.artifactFormat,
		components: form.includeLineChart
			? [
					...withoutLineChart,
					{
						id: "trend-line-chart",
						type: "line_chart",
						title: "趋势",
						binding: {
							xField: "hour",
							valueFields: ["requestCount", "errorCount"],
						},
					},
				]
			: withoutLineChart,
	};
	const delivery: DeliveryPlan = {
		...(draft.delivery ?? {
			version: 1,
			content: { includeSummary: true, includeImage: false, includeArtifactLink: true },
			fallbackPolicy: { type: "all_available", messageCenterRequired: true },
			destinations: [],
		}),
		destinations: [
			{ type: "message_center", enabled: form.messageCenter },
			{ type: "connected_bot", enabled: form.connectedBot },
		],
		content: {
			...(draft.delivery?.content ?? { includeSummary: true, includeImage: false }),
			includeArtifactLink: notificationOnly ? false : form.includeArtifactLink,
		},
	};
	const steps = notificationOnly ? draft.steps : materializeAnalysisRecipeStep(draft.steps, analysis);
	return {
		expectedRevision: draft.revision,
		name: form.name.trim().slice(0, 160),
		description: form.description.trim().slice(0, 1_000),
		accountScope,
		trigger: {
			event: form.triggerEvent,
			timing:
				form.triggerEvent === "schedule"
					? { type: "daily", localTime: form.localTime, timezone: form.timezone }
					: form.triggerEvent === "mail.received"
						? { type: "immediate" }
						: { type: "immediate" },
		},
		dataSelection,
		...(notificationOnly ? { analysis: null, artifact: null } : { analysis, artifact }),
		delivery,
		steps,
		advancedPolicy: {
			cron: form.cron.trim() || undefined,
			modelPolicy: form.modelPolicy.trim() || "default",
			catchUpPolicy: form.catchUpPolicy,
			retentionDays: clamp(form.retentionDays, 1, 365),
			instructionOverride: form.instructionOverride.trim().slice(0, 4_000),
		},
	};
}

function materializeAnalysisRecipeStep(
	steps: ExecutionPipelineDraft["steps"],
	recipe: AnalysisRecipe,
): ExecutionPipelineDraft["steps"] {
	const existing = steps.find((step) => step.capabilityId === "analysis.recipeExecute");
	const needsExecutor =
		!!existing || recipe.modelTasks.length > 0 || recipe.conclusions.length > 0;
	if (!needsExecutor) return steps;
	const source = [...steps]
		.reverse()
		.find((step) =>
			step.capabilityId.startsWith("analysis.") &&
			step.capabilityId !== "analysis.recipeExecute" &&
			step.outputKind === "dataset",
		);
	if (!source) return steps;
	const id = existing?.id ?? uniqueStepId(steps, "analysis-recipe");
	const recipeStep: ExecutionPipelineDraft["steps"][number] = {
		id,
		name: "执行分析配方",
		capabilityId: "analysis.recipeExecute",
		input: {
			dataset: { type: "path", from: "step", stepId: source.id, path: "" },
			recipe: { type: "literal", value: recipe },
		},
		outputKind: "dataset",
		onError: { policy: "stop", retries: 0 },
	};
	const withoutExisting = steps.filter((step) => step.id !== existing?.id);
	const sourceIndex = withoutExisting.findIndex((step) => step.id === source.id);
	const materialized = [
		...withoutExisting.slice(0, sourceIndex + 1),
		recipeStep,
		...withoutExisting.slice(sourceIndex + 1),
	];
	return materialized.map((step, index) => {
		if (step.id === id || index <= sourceIndex + 1) return step;
		return {
			...step,
			input: Object.fromEntries(
				Object.entries(step.input).map(([key, binding]) => [
					key,
					rebindAnalysisSource(binding, source.id, id),
				]),
			),
		};
	});
}

function rebindAnalysisSource(
	binding: unknown,
	fromStepId: string,
	toStepId: string,
): unknown {
	if (!binding || typeof binding !== "object" || Array.isArray(binding)) return binding;
	const value = binding as Record<string, unknown>;
	if (value.type === "path" && value.from === "step" && value.stepId === fromStepId) {
		return { ...value, stepId: toStepId };
	}
	if (value.type === "coalesce" && Array.isArray(value.values)) {
		return {
			...value,
			values: value.values.map((candidate) =>
				rebindAnalysisSource(candidate, fromStepId, toStepId),
			),
		};
	}
	return value;
}

function uniqueStepId(
	steps: ExecutionPipelineDraft["steps"],
	base: string,
): string {
	const ids = new Set(steps.map((step) => step.id));
	if (!ids.has(base)) return base;
	let suffix = 2;
	while (ids.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

function EditorSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3 border-t border-edge pt-5">
			<div>
				<h3 className="text-sm font-semibold text-ink">{title}</h3>
				{description ? (
					<p className="mt-1 text-xs leading-5 text-ink-3">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>{children}</label>;
}

function SelectField({
	label,
	value,
	options,
	onValueChange,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onValueChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="mb-1.5 block text-xs font-medium text-ink-2">
				{label}
			</label>
			<Select value={value} onValueChange={onValueChange}>
				<SelectTrigger id={id}><SelectValue /></SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function ToggleRow({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (value: boolean) => void }) {
	const id = useId();
	return <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center justify-between rounded-md border border-edge bg-paper-2 px-3 py-2.5"><span className="text-xs text-ink-2">{label}</span><Switch id={id} aria-label={label} checked={checked} onCheckedChange={onCheckedChange} /></label>;
}

function conflictSectionLabel(value: string) {
	return {
		metadata: "基本信息",
		owner: "邮箱范围",
		trigger: "触发条件",
		dataSelection: "数据范围",
		analysis: "分析",
		artifact: "结果产出",
		delivery: "投递",
		templateConfiguration: "模板配置",
		advancedPolicy: "高级配置",
		steps: "执行步骤",
	}[value] ?? value;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : min));
}

function parsedWindowHours(value: string) {
	return clamp(Number(value) || 24, 1, 168);
}

function parsedMaxMessages(value: string) {
	return clamp(Number(value) || 400, 1, 1000);
}

function scheduledReadSummary(form: EditorForm) {
	const scope = {
		bounded_previous_schedule_window: `读取上次成功执行后的邮件，最多回看 ${parsedWindowHours(form.windowAmount)} 小时`,
		rolling_window: `读取运行前 ${parsedWindowHours(form.windowAmount)} 小时内的邮件`,
		previous_schedule_window: "读取上次成功执行后的全部邮件",
		calendar_day: "读取当天 00:00 至执行时收到的邮件",
	}[form.dataScope];
	return `每天 ${form.localTime || "09:00"} 运行，${scope}，最多处理 ${parsedMaxMessages(form.maxMessages)} 封。`;
}

const textareaClass = "w-full rounded-md border border-edge bg-paper-2 px-3 py-2 text-sm text-ink outline-none focus-visible:border-coral focus-visible:ring-2 focus-visible:ring-ring";
const SUMMARY_NOTIFICATION_TEMPLATE_ID = "wemail.received-mail-summary-notification";

function isSummaryNotificationDraft(draft?: ExecutionPipelineDraft): boolean {
	return draft?.templateBinding?.templateId === SUMMARY_NOTIFICATION_TEMPLATE_ID;
}

const defaultOutputInstruction =
	"读取本次触发范围内的邮件，提取需要关注的关键信息并生成一份结构清晰的 HTML 页面。页面包含标题、摘要、重点事项和来源；存在时间序列数据时生成折线图；保留来源邮件引用；没有需要处理的内容时明确给出静默结论。";
