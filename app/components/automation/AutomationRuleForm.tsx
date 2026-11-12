// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reusable form for creating / editing an automation rule.
 *
 * Three entry points feed this component:
 *   1. Settings → 自动化规则 (full CRUD).
 *   2. Email more-menu → "创建类似规则" (sender pre-filled).
 *   3. Sidebar → "创建智能标签" (empty defaults, applyLabel action seeded).
 *
 * The component is a controlled `Dialog` that the consumer drives via
 * `open` / `onOpenChange`. It owns local form state, posts on submit,
 * and toasts on success — consumers only consume the close event.
 */

import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "@phosphor-icons/react/X";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { toast } from "sonner";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	useCreateAutomationRule,
	useUpdateAutomationRule,
	usePreviewAutomationRule,
	useCommitAutomationRule,
} from "~/queries/automationRules";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import type {
	AutomationAction,
	AutomationConditionField,
	AutomationConditionMode,
	AutomationConditionOperator,
	AutomationConditionRule,
	AutomationConditions,
	AutomationRule,
	AutomationTrigger,
	AutomationProcessing,
	AutomationCollectionScope,
	AutomationRulePreviewResult,
} from "../../../shared/wemail/automation";
import api from "~/services/api";

interface AutomationRuleFormProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string | undefined;
	/** Existing rule when editing; absent when creating. */
	editing?: AutomationRule | null;
	/** Pre-filled conditions when launched from "创建类似规则" / sidebar. */
	defaults?: {
		name?: string;
		conditions?: AutomationConditions;
		actions?: AutomationAction[];
	};
	/** Initial creation experience. Other entry points keep the manual editor. */
	initialMode?: "natural" | "manual";
	/** Hands a natural-language intent to the Agent authoring flow. */
	onNaturalLanguageCreate?: (prompt: string) => void;
}

const ACTION_TYPES: { type: AutomationAction["type"]; label: string }[] = [
	{ type: "applyLabel", label: "添加标签" },
	{ type: "star", label: "加星标" },
	{ type: "markImportant", label: "标记重要" },
	{ type: "markNotImportant", label: "取消重要" },
	{ type: "markRead", label: "标记已读" },
	{ type: "markUnread", label: "标记未读" },
	{ type: "archive", label: "归档" },
	{ type: "trash", label: "移到回收站" },
	{ type: "spam", label: "标记为垃圾邮件" },
	{ type: "notSpam", label: "取消垃圾邮件" },
	{ type: "suppressTodoCreation", label: "不生成待办" },
	{ type: "publishBotMessage", label: "发送 Bot 消息" },
];

const CONDITION_FIELDS: { value: AutomationConditionField; label: string }[] = [
	{ value: "sender", label: "发件人" },
	{ value: "recipient", label: "收件人" },
	{ value: "cc", label: "抄送" },
	{ value: "subject", label: "主题" },
	{ value: "body", label: "正文" },
	{ value: "hasAttachment", label: "附件" },
	{ value: "aiTag", label: "AI 标签" },
];

const TEXT_OPERATORS: {
	value: AutomationConditionOperator;
	label: string;
	requiresValue: boolean;
}[] = [
	{ value: "contains", label: "包含", requiresValue: true },
	{ value: "notContains", label: "不包含", requiresValue: true },
	{ value: "equals", label: "等于", requiresValue: true },
	{ value: "notEquals", label: "不等于", requiresValue: true },
	{ value: "exists", label: "存在", requiresValue: false },
	{ value: "notExists", label: "不存在", requiresValue: false },
];

const ATTACHMENT_OPERATORS: {
	value: AutomationConditionOperator;
	label: string;
	requiresValue: boolean;
}[] = [
	{ value: "exists", label: "存在", requiresValue: false },
	{ value: "notExists", label: "不存在", requiresValue: false },
];

export function AutomationRuleForm({
	open,
	onOpenChange,
	accountId,
	editing,
	defaults,
	initialMode = "manual",
	onNaturalLanguageCreate,
}: AutomationRuleFormProps) {
	const [creationMode, setCreationMode] = useState<"natural" | "manual">(initialMode);
	const [creationPrompt, setCreationPrompt] = useState("");
	const [name, setName] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [trigger, setTrigger] = useState<AutomationTrigger>({
		type: "mailReceived",
	});
	const [naturalLanguageCondition, setNaturalLanguageCondition] = useState("");
	const [conditionMode, setConditionMode] =
		useState<AutomationConditionMode>("all");
	const [conditionRules, setConditionRules] = useState<
		AutomationConditionRule[]
	>([]);
	const [showStructuredConditions, setShowStructuredConditions] = useState(false);
	const [actions, setActions] = useState<AutomationAction[]>([]);
	const [processing, setProcessing] = useState<AutomationProcessing>({ mode: "perMessage" });
	const [preview, setPreview] = useState<AutomationRulePreviewResult | null>(null);
	// P2.6: the structured allowance upload step is an edition module
	// capability. The open edition hides the entry entirely — its execution
	// path fails closed ("allowance-not-wired") without the module, so
	// offering the toggle would only create rules that can never run.
	const { allowanceInvoice } = useEditionFeatures();

	const createMut = useCreateAutomationRule();
	const updateMut = useUpdateAutomationRule(accountId);
	const previewMut = usePreviewAutomationRule();
	const commitMut = useCommitAutomationRule();
	const [channelProfiles, setChannelProfiles] = useState<
		Awaited<ReturnType<typeof api.listChannelProfiles>>["profiles"]
	>([]);
	useEffect(() => {
		if (!open) return;
		let active = true;
		void api
			.listChannelProfiles()
			.then((result) => {
				if (active) setChannelProfiles(result.profiles);
			})
			.catch(() => {
				if (active) setChannelProfiles([]);
			});
		return () => {
			active = false;
		};
	}, [open]);
	const readyChannelProfiles =
		channelProfiles.filter(
			(profile) =>
				profile.enabled &&
				profile.onboardingState === "ready" &&
				!!profile.owner,
		);

	// Hydrate form state when the dialog opens or the editing target changes.
	useEffect(() => {
		if (!open) return;
		setCreationMode(editing ? "manual" : initialMode);
		setCreationPrompt("");
		if (editing) {
			setName(editing.name);
			setEnabled(editing.enabled);
			setTrigger(editing.trigger);
			setNaturalLanguageCondition(editing.naturalLanguageCondition ?? "");
			setConditionMode(editing.conditionMode ?? "all");
			const rules =
				editing.conditionRules && editing.conditionRules.length > 0
					? editing.conditionRules
					: legacyConditionsToRules(editing.conditions);
			setConditionRules(rules);
			setShowStructuredConditions(rules.length > 0);
			setActions(editing.actions);
			const nextProcessing = editing.processing ?? { mode: "perMessage" };
			setProcessing(editing.trigger.type === "scheduled"
				? { ...nextProcessing, scope: nextProcessing.scope ?? defaultScheduledScope() }
				: nextProcessing);
		} else {
			const rules = legacyConditionsToRules(defaults?.conditions ?? {});
			setName(defaults?.name ?? "");
			setEnabled(true);
			setTrigger({ type: "mailReceived" });
			setNaturalLanguageCondition("");
			setConditionMode("all");
			setConditionRules(rules);
			setShowStructuredConditions(rules.length > 0);
			setActions(defaults?.actions ?? []);
			setProcessing({ mode: "perMessage" });
		}
	}, [open, editing, defaults, initialMode]);

	useEffect(() => { setPreview(null); }, [name, enabled, trigger, naturalLanguageCondition, conditionMode, conditionRules, actions, processing]);

	const setTriggerType = (type: "mailReceived" | "scheduled") => {
		if (type === "mailReceived") {
			setTrigger((prev) => ({
				type: "mailReceived",
				execution:
					prev.type === "mailReceived"
						? prev.execution ?? { type: "immediate" }
						: { type: "immediate" },
			}));
			setProcessing({ mode: "perMessage" });
			return;
		}
		setTrigger((prev) => ({
			type: "scheduled",
			intervalMinutes:
				prev.type === "scheduled" ? prev.intervalMinutes : 60,
			nextRunAt: prev.type === "scheduled" ? prev.nextRunAt : undefined,
			timezone: prev.type === "scheduled" ? prev.timezone : undefined,
			schedule: prev.type === "scheduled" ? prev.schedule ?? { type: "interval", intervalMinutes: prev.intervalMinutes ?? 60 } : { type: "interval", intervalMinutes: 60 },
		}));
		setProcessing((prev) => ({
			...prev,
			scope: prev.scope ?? defaultScheduledScope(),
		}));
	};

	const setMailReceivedTiming = (
		type: "immediate" | "delay" | "nextDayAt",
	) => {
		if (trigger.type !== "mailReceived") return;
		if (type === "immediate") {
			setTrigger({ type: "mailReceived", execution: { type } });
		} else if (type === "delay") {
			setTrigger({
				type: "mailReceived",
				execution:
					trigger.execution?.type === "delay"
						? trigger.execution
						: { type: "delay", amount: 24, unit: "hour" },
			});
		} else {
			setTrigger({
				type: "mailReceived",
				execution:
					trigger.execution?.type === "nextDayAt"
						? trigger.execution
						: {
								type: "nextDayAt",
								localTime: "03:00",
								timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							},
			});
		}
	};

	const updateConditionRule = (
		id: string,
		patch: Partial<AutomationConditionRule>,
	) => {
		setConditionRules((prev) =>
			prev.map((rule) => {
				if (rule.id !== id) return rule;
				const next = { ...rule, ...patch };
				if (patch.field) {
					const operator = defaultOperatorForField(patch.field);
					return {
						...next,
						field: patch.field,
						operator,
						value: operatorRequiresValue(operator) ? "" : undefined,
					};
				}
				if (patch.operator) {
					return {
						...next,
						operator: patch.operator,
						value: operatorRequiresValue(patch.operator)
							? typeof next.value === "string"
								? next.value
								: ""
							: undefined,
					};
				}
				return next;
			}),
		);
	};

	const addConditionRule = () => {
		setConditionRules((prev) => [...prev, createConditionRule()]);
		setShowStructuredConditions(true);
	};

	const removeConditionRule = (id: string) => {
		setConditionRules((prev) => prev.filter((rule) => rule.id !== id));
	};

	const toggleActionType = (type: AutomationAction["type"]) => {
		setActions((prev) => {
			const exists = prev.some((a) => a.type === type);
			if (exists) return prev.filter((a) => a.type !== type);
			if (type === "applyLabel") {
				return [...prev, { type, label: "" }];
			}
			if (type === "publishBotMessage") {
				const profile = readyChannelProfiles[0];
				if (!profile?.owner) {
					toast.error("请先在「设置 → 连接」中完成飞书或企业微信 Bot 配置");
					return prev;
				}
				return [
					...prev,
					{
						type,
						botProfileId: profile.id,
						destination: {
							type: "owner",
							ownerBindingVersion: profile.owner.bindingVersion,
						},
						title: "WeMail 自动化通知",
					},
				];
			}
			return [...prev, { type } as AutomationAction];
		});
	};

	const updateLabelAction = (label: string) => {
		setActions((prev) =>
			prev.map((a) => (a.type === "applyLabel" ? { type: "applyLabel", label } : a)),
		);
	};

	const toggleAllowanceUpload = () => {
		setActions((prev) => {
			const exists = prev.some(
				(action) =>
					action.type === "external" &&
					action.adapter === "wecli.allowance.upload",
			);
			if (exists) {
				return prev.filter(
					(action) =>
						!(action.type === "external" &&
							action.adapter === "wecli.allowance.upload"),
				);
			}
			return [
				...prev,
				{
					type: "external",
					adapter: "wecli.allowance.upload",
					input: { attachmentPolicy: "pdf" },
				},
			];
		});
	};

	const handleSubmit = async () => {
		if (!accountId) {
			toast.error("没有可用账号");
			return;
		}
		if (!name.trim()) {
			toast.error("请填写规则名称");
			return;
		}
		if (actions.length === 0) {
			toast.error("至少选择一个动作");
			return;
		}
		const normalizedConditionRules = normalizeConditionRules(conditionRules);
		const naturalRule = naturalLanguageCondition.trim();
		if (!naturalRule && normalizedConditionRules.length === 0 && processing.mode !== "collection") {
			toast.error(
				showModeChoice
					? "逐封处理时至少添加一条条件规则"
					: "至少填写自然语言规则或条件规则",
			);
			return;
		}
		try {
			if (!preview) {
				const result = await previewMut.mutateAsync({ accountId, name: name.trim(), enabled, trigger, naturalLanguageCondition: naturalRule || undefined, conditions: {}, conditionMode, conditionRules: normalizedConditionRules, processing, actions, sourceRuleId: editing?.id });
				setPreview(result.preview);
				return;
			}
			await commitMut.mutateAsync({ accountId, previewId: preview.previewId, ruleHash: preview.ruleHash });
			toast.success(editing ? "规则已更新" : "规则已创建");
			onOpenChange(false);
		} catch (err) {
			toast.error(getUserFacingError(err, "自动化规则保存失败，请稍后重试。"));
		}
	};

	const handleNaturalLanguageCreate = () => {
		const prompt = creationPrompt.trim();
		if (!prompt) {
			toast.error("请先描述你希望自动完成的事情");
			return;
		}
		onNaturalLanguageCreate?.(prompt);
	};

	const isPending = createMut.isPending || updateMut.isPending || previewMut.isPending || commitMut.isPending;
	const showModeChoice = !editing && Boolean(onNaturalLanguageCreate);
	const naturalMode = showModeChoice && creationMode === "natural";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className={`${naturalMode ? "max-w-[600px]" : "max-w-[640px]"} w-[92vw] max-h-[88vh] flex flex-col p-0 overflow-hidden`}>
				<div className="px-6 py-4 border-b border-edge flex items-start justify-between gap-4">
					<div>
						<DialogTitle className="text-base font-semibold text-ink">
							{editing ? "编辑规则" : "创建自动化规则"}
						</DialogTitle>
						<DialogDescription className="text-xs text-ink-3 mt-1">
							{naturalMode
								? "说清楚你想在什么情况下、自动完成什么事情。"
								: "按触发条件、筛选范围和执行动作完成配置。"}
						</DialogDescription>
					</div>
				</div>

				{showModeChoice ? (
					<div className="border-b border-edge px-6 pt-3">
						<div className="inline-flex gap-5" role="tablist" aria-label="创建方式">
							<button
								type="button"
								role="tab"
								aria-selected={creationMode === "natural"}
								onClick={() => setCreationMode("natural")}
								className={`border-b-2 pb-2.5 text-sm font-medium transition-colors ${
									creationMode === "natural"
										? "border-coral text-ink"
										: "border-transparent text-ink-3 hover:text-ink"
								}`}
							>
								对话创建
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={creationMode === "manual"}
								onClick={() => {
									setCreationMode("manual");
									setNaturalLanguageCondition("");
									setShowStructuredConditions(true);
								}}
								className={`border-b-2 pb-2.5 text-sm font-medium transition-colors ${
									creationMode === "manual"
										? "border-coral text-ink"
										: "border-transparent text-ink-3 hover:text-ink"
								}`}
							>
								普通配置
							</button>
						</div>
					</div>
				) : null}

				{naturalMode ? (
					<div className="flex-1 px-6 py-5">
						<label htmlFor="automation-creation-prompt" className="text-sm font-semibold text-ink">
							你希望 WeMail 自动做什么？
						</label>
						<div className="mt-3 rounded-xl border border-edge bg-paper px-4 py-3 shadow-sm transition-colors focus-within:border-coral">
							<textarea
								id="automation-creation-prompt"
								autoFocus
								value={creationPrompt}
								onChange={(event) => setCreationPrompt(event.target.value)}
								className="min-h-32 w-full resize-none bg-transparent text-sm leading-6 text-ink outline-none placeholder:text-ink-4"
								placeholder="例如：每天早上 9 点整理过去一天的重要邮件；只有发现需要我处理的事情时，再通过企业微信通知我。"
							/>
							<p className="mt-2 text-right text-xs text-ink-4">
								时间、邮件范围、处理方式和通知要求都可以直接描述
							</p>
						</div>
						<div className="mt-4 flex flex-wrap gap-2" aria-label="示例">
							{[
								"收到发票后提醒我",
								"每天整理重要邮件",
								"把客户投诉标记为重要",
							].map((example) => (
								<button
									key={example}
									type="button"
									onClick={() => setCreationPrompt(example)}
									className="rounded-full border border-edge bg-paper-2 px-3 py-1.5 text-xs text-ink-3 transition-colors hover:border-coral/40 hover:text-ink"
								>
									{example}
								</button>
							))}
						</div>
					</div>
				) : (
				<div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
					{/* Name + enabled */}
					<div className="grid grid-cols-[1fr_auto] gap-3 items-end">
						<div>
							<label className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
								规则名称
							</label>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="例如：GitHub 通知归档"
							/>
						</div>
						<div className="flex flex-col items-start gap-1 pb-2">
							<label className="text-xs font-medium uppercase tracking-wider text-ink-3">
								启用
							</label>
							<Switch checked={enabled} onCheckedChange={setEnabled} />
						</div>
					</div>

					<section className="space-y-3">
						<h3 className="text-sm font-semibold text-ink">触发</h3>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => setTriggerType("mailReceived")}
								className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
									trigger.type === "mailReceived"
										? "bg-coral text-paper border-coral"
										: "bg-paper-2 text-ink border-edge hover:bg-paper-3"
								}`}
							>
								收到邮件
							</button>
							<button
								type="button"
								onClick={() => setTriggerType("scheduled")}
								className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
									trigger.type === "scheduled"
										? "bg-coral text-paper border-coral"
										: "bg-paper-2 text-ink border-edge hover:bg-paper-3"
								}`}
							>
								定时
							</button>
						</div>
						{trigger.type === "scheduled" ? <div className="space-y-3 rounded-lg border border-edge bg-paper-2 p-3">
							<SelectControl label="调度方式" value={trigger.schedule?.type ?? "interval"} options={[{ value: "interval", label: "固定间隔" }, { value: "daily", label: "每天固定时间" }]} onChange={(type) => setTrigger({ ...trigger, schedule: type === "daily" ? { type: "daily", localTime: "10:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { type: "interval", intervalMinutes: trigger.intervalMinutes ?? 60 } })} />
							{trigger.schedule?.type === "daily" ? <div className="grid grid-cols-2 gap-3"><LabeledInput label="本地时间" value={trigger.schedule.localTime} onChange={(localTime) => setTrigger({ ...trigger, schedule: { ...trigger.schedule!, type: "daily", localTime } as never })} placeholder="10:00" /><LabeledInput label="时区" value={trigger.schedule.timezone} onChange={(timezone) => setTrigger({ ...trigger, schedule: { ...trigger.schedule!, type: "daily", timezone } as never })} placeholder="Asia/Shanghai" /></div> : <LabeledInput
								label="间隔分钟"
								value={String(trigger.schedule?.type === "interval" ? trigger.schedule.intervalMinutes : trigger.intervalMinutes ?? 60)}
								onChange={(v) => {
									const intervalMinutes = Number.parseInt(v, 10);
									setTrigger({
										...trigger,
										intervalMinutes:
											Number.isFinite(intervalMinutes) && intervalMinutes > 0
												? intervalMinutes
												: 60,
										schedule: { type: "interval", intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60 },
									});
								}}
								placeholder="60"
							/>}</div> : null}
						{trigger.type === "mailReceived" ? (
							<div className="space-y-3 rounded-lg border border-edge bg-paper-2 p-3">
								<div className="flex flex-wrap gap-2">
									{([
										["immediate", "立即执行"],
										["delay", "延迟执行"],
										["nextDayAt", "次日指定时间"],
									] as const).map(([type, label]) => (
										<button
											key={type}
											type="button"
											onClick={() => setMailReceivedTiming(type)}
											className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
												(trigger.execution?.type ?? "immediate") === type
													? "border-coral bg-coral text-paper"
													: "border-edge bg-paper text-ink"
											}`}
										>
											{label}
										</button>
									))}
								</div>
								{trigger.execution?.type === "delay" ? (
									<div className="grid grid-cols-2 gap-3">
										<LabeledInput
											label="延迟数量"
											value={String(trigger.execution.amount)}
											onChange={(value) =>
												setTrigger({
													...trigger,
													execution: {
														type: "delay",
														amount: Math.max(1, Number.parseInt(value, 10) || 1),
														unit: trigger.execution?.type === "delay" ? trigger.execution.unit : "hour",
													},
												})
											}
											placeholder="24"
										/>
										<SelectControl
											label="单位"
											value={trigger.execution.unit}
											options={[
												{ value: "minute", label: "分钟" },
												{ value: "hour", label: "小时" },
												{ value: "day", label: "天" },
											]}
											onChange={(unit) =>
												setTrigger({
													...trigger,
													execution: {
														type: "delay",
														amount: trigger.execution?.type === "delay" ? trigger.execution.amount : 24,
														unit,
													},
												})
											}
										/>
									</div>
								) : null}
								{trigger.execution?.type === "nextDayAt" ? (
									<div className="grid grid-cols-2 gap-3">
										<LabeledInput
											label="次日时间"
											value={trigger.execution.localTime}
											onChange={(localTime) =>
												setTrigger({
													...trigger,
													execution: {
														type: "nextDayAt",
														localTime,
														timezone: trigger.execution?.type === "nextDayAt" ? trigger.execution.timezone : "Asia/Shanghai",
													},
												})
											}
											placeholder="03:00"
										/>
										<LabeledInput
											label="时区"
											value={trigger.execution.timezone}
											onChange={(timezone) =>
												setTrigger({
													...trigger,
													execution: {
														type: "nextDayAt",
														localTime: trigger.execution?.type === "nextDayAt" ? trigger.execution.localTime : "03:00",
														timezone,
													},
												})
											}
											placeholder="Asia/Shanghai"
										/>
									</div>
								) : null}
							</div>
						) : null}
					</section>

					{trigger.type === "scheduled" ? <section className="space-y-4">
						<div>
							<h3 className="text-sm font-semibold text-ink">扫描邮件范围</h3>
							<p className="mt-1 text-xs text-ink-3">每次定时运行先按此范围读取邮件，再执行下面的处理方式。</p>
						</div>
						<div className="space-y-3 rounded-lg border border-edge bg-paper-2 p-3">
							<SelectControl label="时间范围" value={processing.scope?.type ?? "previousScheduleWindow"} options={[{ value: "calendarDay", label: "当天 00:00 至执行时" }, { value: "previousScheduleWindow", label: "上次成功执行至今" }, { value: "rollingWindow", label: "滚动时间窗口" }]} onChange={(type) => setProcessing({
								...processing,
								scope: type === "rollingWindow"
									? { type: "rollingWindow", amount: 1, unit: "day", limit: 200 }
									: type === "calendarDay"
										? { type: "calendarDay", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai", limit: 200 }
										: defaultScheduledScope(),
							})} />
							{processing.scope?.type === "rollingWindow" ? <div className="grid grid-cols-2 gap-3"><LabeledInput label="窗口数量" value={String(processing.scope.amount)} onChange={(value) => setProcessing({ ...processing, scope: { ...processing.scope!, type: "rollingWindow", amount: Math.max(1, Number(value) || 1) } as never })} /><SelectControl label="单位" value={processing.scope.unit} options={[{ value: "hour", label: "小时" }, { value: "day", label: "天" }]} onChange={(unit) => setProcessing({ ...processing, scope: { ...processing.scope!, type: "rollingWindow", unit } as never })} /></div> : null}
							{processing.scope?.type === "previousScheduleWindow" ? <LabeledInput label="最长回看小时数" value={String(processing.scope.maxLookback?.amount ?? 24)} onChange={(value) => setProcessing({ ...processing, scope: { ...processing.scope!, type: "previousScheduleWindow", maxLookback: { amount: Math.min(168, Math.max(1, Number(value) || 24)), unit: "hour" } } })} /> : null}
							<LabeledInput label="最多扫描邮件数" value={String(processing.scope?.limit ?? 200)} onChange={(value) => setProcessing({ ...processing, scope: { ...(processing.scope ?? defaultScheduledScope()), limit: Math.min(1000, Math.max(1, Number(value) || 200)) } as AutomationCollectionScope })} />
						</div>
						<div>
							<h3 className="text-sm font-semibold text-ink">处理方式</h3>
							<p className="mt-1 text-xs text-ink-3">决定扫描结果是逐封执行动作，还是归集后生成一条通知。</p>
						</div>
						<div className="flex gap-2"><button type="button" className={`rounded-full border px-3 py-1.5 text-xs ${processing.mode === "perMessage" ? "border-coral bg-coral text-paper" : "border-edge"}`} onClick={() => setProcessing({ mode: "perMessage", scope: processing.scope ?? defaultScheduledScope() })}>逐封处理</button><button type="button" className={`rounded-full border px-3 py-1.5 text-xs ${processing.mode === "collection" ? "border-coral bg-coral text-paper" : "border-edge"}`} onClick={() => { setProcessing({ mode: "collection", scope: processing.scope ?? defaultScheduledScope(), processors: processing.processors?.length ? processing.processors : [{ type: "mailDigest" }] }); setActions([{ type: "publishApplicationMessage", title: name.trim() || "邮件阶段摘要", messageType: "digest", desktopNotification: true }]); }}>归集后通知</button></div>
						{processing.mode === "collection" ? <div className="space-y-3 rounded-lg border border-edge bg-paper-2 p-3">
							<SelectControl label="处理器" value={processing.processors?.[0]?.type ?? "mailDigest"} options={[{ value: "mailDigest", label: "邮件摘要" }, { value: "invoiceReadinessAnalysis", label: "发票就绪分析" }]} onChange={(type) => { setProcessing({ ...processing, processors: [{ type }] }); setActions([{ type: "publishApplicationMessage", title: name.trim() || (type === "mailDigest" ? "邮件阶段摘要" : "发票就绪分析"), messageType: type === "mailDigest" ? "digest" : "analysis", desktopNotification: true }]); }} />
							<LabeledInput label="消息标题" value={actions.find((action) => action.type === "publishApplicationMessage")?.title ?? ""} onChange={(title) => setActions([{ type: "publishApplicationMessage", title, messageType: processing.processors?.[0]?.type === "mailDigest" ? "digest" : "analysis", desktopNotification: true }])} />
						</div> : null}
					</section> : null}

					{/* Legacy/email-context entries may still use a semantic condition. */}
					{!showModeChoice ? <section className="space-y-3">
						<div>
							<label className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
								自然语言规则
							</label>
							<textarea
								value={naturalLanguageCondition}
								onChange={(e) => setNaturalLanguageCondition(e.target.value)}
								className="min-h-20 w-full rounded-md border border-edge bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-coral"
								placeholder="例如：需要我今天回复的客户邮件"
							/>
						</div>
					</section> : null}
					{preview ? <section className="rounded-lg border border-coral/40 bg-paper-2 p-4 text-sm"><h3 className="font-semibold text-ink">保存前预览</h3><div className="mt-2 grid grid-cols-2 gap-2 text-ink-3"><span>匹配邮件</span><strong className="text-right text-ink">{preview.matchedCount}{preview.truncated ? "+" : ""}</strong><span>处理器</span><strong className="text-right text-ink">{preview.plannedProcessors.map((item) => item.type).join("、") || "无"}</strong><span>动作</span><strong className="text-right text-ink">{preview.plannedActions.map((item) => item.type).join("、")}</strong></div>{preview.resolvedWindow ? <p className="mt-2 text-xs text-ink-4">窗口：{preview.resolvedWindow.start} — {preview.resolvedWindow.end}</p> : null}{preview.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-amber">{warning}</p>)}</section> : null}

					{/* Conditions */}
					<section className="space-y-3">
						<div className="rounded-md border border-amber/30 bg-amber-bg px-3 py-2 text-xs font-medium text-amber">
							{showModeChoice
								? "逐封处理时至少添加一条条件；归集处理可以覆盖选定时间范围内的全部邮件。"
								: "自然语言规则和条件规则至少填写一个；只填其中一个也可以。"}
						</div>
						<div className="flex items-center justify-between gap-3">
							<div className="flex items-center gap-2">
								<h3 className="text-sm font-semibold text-ink">条件规则</h3>
								{normalizeConditionRules(conditionRules).length > 0 ? (
									<span className="rounded-full bg-paper-2 px-2 py-0.5 text-xs text-ink-3">
										{normalizeConditionRules(conditionRules).length} 条
									</span>
								) : null}
							</div>
							<button
								type="button"
								onClick={() =>
									setShowStructuredConditions((visible) => !visible)
								}
								className="text-xs font-medium text-coral hover:text-coral/80"
							>
								{showStructuredConditions ? "收起" : "展开"}
							</button>
						</div>
						{showStructuredConditions ? (
							<div className="space-y-3">
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									onClick={() => setConditionMode("all")}
									className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
										conditionMode === "all"
											? "bg-coral text-paper border-coral"
											: "bg-paper-2 text-ink border-edge hover:bg-paper-3"
									}`}
								>
									全部满足
								</button>
								<button
									type="button"
									onClick={() => setConditionMode("any")}
									className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
										conditionMode === "any"
											? "bg-coral text-paper border-coral"
											: "bg-paper-2 text-ink border-edge hover:bg-paper-3"
									}`}
								>
									任一满足
								</button>
							</div>
							<div className="space-y-2">
								{conditionRules.map((rule) => {
									const operators = operatorsForField(rule.field);
									const requiresValue = operatorRequiresValue(rule.operator);
									return (
										<div
											key={rule.id}
											className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2"
										>
											<SelectControl
												label="字段"
												value={rule.field}
												options={CONDITION_FIELDS}
												onChange={(value) =>
													updateConditionRule(rule.id, {
														field: value as AutomationConditionField,
													})
												}
											/>
											<SelectControl
												label="操作符"
												value={rule.operator}
												options={operators}
												onChange={(value) =>
													updateConditionRule(rule.id, {
														operator: value as AutomationConditionOperator,
													})
												}
											/>
											{requiresValue ? (
												<LabeledInput
													label="值"
													value={
														typeof rule.value === "string" ? rule.value : ""
													}
													onChange={(value) =>
														updateConditionRule(rule.id, { value })
													}
													placeholder={placeholderForField(rule.field)}
												/>
											) : (
												<div className="hidden sm:block" />
											)}
											<div className="flex items-end">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => removeConditionRule(rule.id)}
												>
													删除
												</Button>
											</div>
										</div>
									);
								})}
							</div>
							<Button variant="secondary" size="sm" onClick={addConditionRule}>
								添加规则
							</Button>
							</div>
						) : null}
					</section>

					{/* Actions */}
					<section className="space-y-3">
						<h3 className="text-sm font-semibold text-ink">动作</h3>
						<div className="flex flex-wrap gap-2">
							{ACTION_TYPES.map((entry) => {
								const active = actions.some((a) => a.type === entry.type);
								return (
									<button
										key={entry.type}
										type="button"
										onClick={() => toggleActionType(entry.type)}
										className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
											active
												? "bg-coral text-paper border-coral"
												: "bg-paper-2 text-ink border-edge hover:bg-paper-3"
										}`}
									>
										{entry.label}
										{active ? <XIcon size={10} weight="bold" /> : null}
									</button>
								);
							})}
							{allowanceInvoice ? <button
								type="button"
								onClick={toggleAllowanceUpload}
								className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
									actions.some(
										(action) => action.type === "external" && action.adapter === "wecli.allowance.upload",
									)
										? "bg-coral text-paper border-coral"
										: "bg-paper-2 text-ink border-edge hover:bg-paper-3"
								}`}
							>
								wecli 上传月度发票
							</button> : null}
						</div>
						{actions.some((a) => a.type === "applyLabel") ? (
							<div>
								<label className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
									标签名
								</label>
								<Input
									value={
										actions.find((a) => a.type === "applyLabel")?.type ===
										"applyLabel"
											? (
													actions.find(
														(a) => a.type === "applyLabel",
													) as Extract<
														AutomationAction,
														{ type: "applyLabel" }
													>
												).label
											: ""
									}
									onChange={(e) => updateLabelAction(e.target.value)}
									placeholder="例如：GitHub"
								/>
							</div>
						) : null}
						{actions.some((a) => a.type === "publishBotMessage") ? (
							<BotMessageActionEditor
								action={
									actions.find(
										(action): action is Extract<
											AutomationAction,
											{ type: "publishBotMessage" }
										> => action.type === "publishBotMessage",
									)!
								}
								profiles={readyChannelProfiles}
								onChange={(next) =>
									setActions((current) =>
										current.map((action) =>
											action.type === "publishBotMessage" ? next : action,
										),
									)
								}
							/>
						) : null}
					</section>
				</div>
				)}

				<div className="px-6 py-3 border-t border-edge flex items-center justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						取消
					</Button>
					{naturalMode ? (
						<Button size="sm" onClick={handleNaturalLanguageCreate}>
							交给 Agent 创建
						</Button>
					) : (
						<Button size="sm" onClick={handleSubmit} loading={isPending}>
							{preview ? (editing ? "确认更新" : "确认创建") : "生成预览"}
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function BotMessageActionEditor({
	action,
	profiles,
	onChange,
}: {
	action: Extract<AutomationAction, { type: "publishBotMessage" }>;
	profiles: Awaited<ReturnType<typeof api.listChannelProfiles>>["profiles"];
	onChange: (
		action: Extract<AutomationAction, { type: "publishBotMessage" }>,
	) => void;
}) {
	const selected = profiles.find((profile) => profile.id === action.botProfileId);
	const destinations = useQuery({
		queryKey: ["channels", action.botProfileId, "destinations"],
		queryFn: () => api.listChannelDestinations(action.botProfileId),
		enabled: Boolean(action.botProfileId),
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
	const destinationValue =
		action.destination.type === "owner"
			? "owner"
			: `conversation:${action.destination.destinationId}`;
	return (
		<div className="space-y-3 rounded-xl border border-edge bg-paper-2 p-3">
			<SelectControl
				label="发送渠道"
				value={action.botProfileId}
				options={profiles.map((profile) => ({
					value: profile.id,
					label: `${profile.platform === "feishu" ? "飞书" : "企业微信"} · ${profile.displayName} · 主人 ${profile.owner?.displayName || `…${profile.owner?.userId.slice(-6)}`}`,
				}))}
				onChange={(value) => {
					const profile = profiles.find((item) => item.id === value);
					if (!profile?.owner) return;
					onChange({
						...action,
						botProfileId: profile.id,
						destination: {
							type: "owner",
							ownerBindingVersion: profile.owner.bindingVersion,
						},
					});
				}}
			/>
			<div>
				{selected?.lastErrorCode && (
					<p className="mt-1 text-xs text-amber">
						该渠道最近检测异常；规则会保留，但发送可能进入重试。
					</p>
				)}
			</div>
			<SelectControl
				label="发送目标"
				value={destinationValue}
				options={[{ value: "owner", label: `主人 · ${selected?.owner?.displayName || `…${selected?.owner?.userId.slice(-6)}`}` }, ...(destinations.data?.destinations.filter((destination) => destination.verified).map((destination) => ({ value: `conversation:${destination.id}`, label: `${destination.type === "group" ? "群聊" : "私聊"} · ${destination.displayName || `…${destination.externalId.slice(-6)}`}` })) ?? [])]}
				onChange={(value) => {
						if (value === "owner") {
							if (!selected?.owner) return;
							onChange({
								...action,
								destination: {
									type: "owner",
									ownerBindingVersion: selected.owner.bindingVersion,
								},
							});
							return;
						}
						const destinationId = value.replace(
							/^conversation:/,
							"",
						);
						onChange({
							...action,
							destination: {
								type: "conversation",
								destinationId,
							},
						});
				}}
			/>
			<div>
				<p className="mt-1 text-xs text-ink-4">
					只显示该机器人已实际收到过消息的会话。
				</p>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-3">
					标题
				</label>
				<Input
					value={action.title ?? ""}
					maxLength={120}
					onChange={(event) => onChange({ ...action, title: event.target.value })}
				/>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-3">
					正文模板
				</label>
				<textarea
					value={action.bodyTemplate ?? ""}
					maxLength={2000}
					onChange={(event) =>
						onChange({ ...action, bodyTemplate: event.target.value })
					}
					placeholder="发件人：{{sender}}&#10;主题：{{subject}}&#10;时间：{{receivedAt}}&#10;摘要：{{snippet}}"
					className="min-h-24 w-full rounded-lg border border-edge bg-paper px-3 py-2 text-sm"
				/>
				<p className="mt-1 text-xs text-ink-4">
					仅支持 sender、subject、receivedAt、snippet。第一期固定发送给已验证主人。
				</p>
			</div>
		</div>
	);
}

function LabeledInput({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
				{label}
			</label>
			<Input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
			/>
		</div>
	);
}

function SelectControl<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="mb-1.5 block text-xs font-medium text-ink-2">
				{label}
			</label>
			<Select value={value} onValueChange={(next) => onChange(next as T)}>
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

function defaultScheduledScope(): AutomationCollectionScope {
	return {
		type: "previousScheduleWindow",
		maxLookback: { amount: 24, unit: "hour" },
		limit: 200,
	};
}

function createConditionRule(): AutomationConditionRule {
	return {
		id: `condition-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		field: "sender",
		operator: "contains",
		value: "",
	};
}

function legacyConditionsToRules(
	conditions: AutomationConditions,
): AutomationConditionRule[] {
	const rules: AutomationConditionRule[] = [];
	const pushTextRule = (
		field: AutomationConditionField,
		value: string | undefined,
	) => {
		if (!value) return;
		rules.push({
			id: `condition-${field}-${rules.length}`,
			field,
			operator: "contains",
			value,
		});
	};

	pushTextRule("sender", conditions.sender);
	pushTextRule("recipient", conditions.recipient);
	pushTextRule("cc", conditions.cc);
	pushTextRule("subject", conditions.subjectKeyword);
	pushTextRule("body", conditions.bodyKeyword);
	pushTextRule("aiTag", conditions.aiTag);
	if (conditions.hasAttachment !== undefined) {
		rules.push({
			id: `condition-hasAttachment-${rules.length}`,
			field: "hasAttachment",
			operator: conditions.hasAttachment ? "exists" : "notExists",
		});
	}
	return rules;
}

function normalizeConditionRules(
	rules: AutomationConditionRule[],
): AutomationConditionRule[] {
	return rules.flatMap((rule) => {
		const operator = validOperatorForField(rule.field, rule.operator)
			? rule.operator
			: defaultOperatorForField(rule.field);
		if (!operatorRequiresValue(operator)) {
			return [{ id: rule.id, field: rule.field, operator }];
		}
		if (typeof rule.value !== "string" || !rule.value.trim()) {
			return [];
		}
		return [
			{
				id: rule.id,
				field: rule.field,
				operator,
				value: rule.value.trim(),
			},
		];
	});
}

function operatorsForField(field: AutomationConditionField) {
	return field === "hasAttachment" ? ATTACHMENT_OPERATORS : TEXT_OPERATORS;
}

function validOperatorForField(
	field: AutomationConditionField,
	operator: AutomationConditionOperator,
): boolean {
	return operatorsForField(field).some((entry) => entry.value === operator);
}

function defaultOperatorForField(
	field: AutomationConditionField,
): AutomationConditionOperator {
	return field === "hasAttachment" ? "exists" : "contains";
}

function operatorRequiresValue(operator: AutomationConditionOperator): boolean {
	return TEXT_OPERATORS.some(
		(entry) => entry.value === operator && entry.requiresValue,
	);
}

function placeholderForField(field: AutomationConditionField): string | undefined {
	switch (field) {
		case "sender":
			return "github.com";
		case "recipient":
			return "me@example.com";
		case "cc":
			return "team@example.com";
		case "subject":
			return "urgent";
		case "body":
			return "invoice";
		case "aiTag":
			return "newsletter / 营销";
		case "hasAttachment":
			return undefined;
	}
}
