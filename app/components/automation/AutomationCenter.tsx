import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { NewspaperIcon } from "@phosphor-icons/react/Newspaper";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlayIcon } from "@phosphor-icons/react/Play";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import type {
	AutomationDetail,
	AutomationHealth,
	AutomationListItem,
	AutomationRunSummary,
	AutomationRecoveryAction,
	AutomationStepDetail,
	AutomationTemplateSummary,
} from "../../../shared/wemail/automationCenter";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter";
import { useUIStore } from "~/hooks/useUIStore";
import { automationFeatureFlags } from "~/lib/automation-feature-flags";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	useArchiveUnifiedAutomation,
	useResumeUnifiedAutomationDraft,
	useRetryUnifiedAutomationStep,
	useRunUnifiedAutomation,
	useSetUnifiedAutomationEnabled,
	useUnifiedAutomationDetail,
	useUnifiedAutomationRunDetail,
	useUnifiedAutomations,
} from "~/queries/automationRules";
import { useCurrentAccount } from "~/queries/currentAccount";
import api from "~/services/api";
import { Button } from "~/components/ui/button";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Switch } from "~/components/ui/switch";
import { AutomationRuleForm } from "./AutomationRuleForm";
import { AutomationRunDetailDialog } from "./AutomationRunDetailDialog";
import { StructuredAutomationEditorDialog } from "./StructuredAutomationEditorDialog";

export function AutomationCenter() {
	const { data: currentAccount } = useCurrentAccount();
	const accountId = currentAccount?.account?.id;
	const listQuery = useUnifiedAutomations(accountId);
	const { data, isLoading, isError } = listQuery;
	const automations = data?.automations ?? [];
	const templates = automationFeatureFlags.templateCatalog
		? (data?.recommendedTemplates ?? []).filter(
				(item) =>
					(automationFeatureFlags.subscriptionInsight ||
						item.id !== "subscription-daily-insight"),
			)
		: [];
	const [searchParams, setSearchParams] = useSearchParams();
	const [legacyFormOpen, setLegacyFormOpen] = useState(false);
	const [addingTemplateId, setAddingTemplateId] = useState<string>();
	const [wideLayout, setWideLayout] = useState(() => isWide());

	const sortedAutomations = useMemo(
		() =>
			[...automations].sort((a, b) => {
				const attentionDelta =
					Number(b.health === "needs_attention") - Number(a.health === "needs_attention");
				if (attentionDelta) return attentionDelta;
				if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
				return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
			}),
		[automations],
	);
	const requestedId = searchParams.get("rule") ?? undefined;
	const selectedId =
		sortedAutomations.some((item) => item.id === requestedId)
			? requestedId
			: wideLayout
				? sortedAutomations[0]?.id
				: undefined;
	const selectedSummary = sortedAutomations.find((item) => item.id === selectedId);
	const detailQuery = useUnifiedAutomationDetail(
		accountId,
		selectedId,
	);
	const {
		data: detail,
		isLoading: detailLoading,
		isError: detailError,
	} = detailQuery;

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia("(min-width: 1024px)");
		const update = () => setWideLayout(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		if (!selectedId || requestedId === selectedId || (!wideLayout && !requestedId)) return;
		const next = new URLSearchParams(searchParams);
		next.set("rule", selectedId);
		setSearchParams(next, { replace: true });
	}, [requestedId, searchParams, selectedId, setSearchParams, wideLayout]);

	const selectAutomation = (id: string) => {
		const next = new URLSearchParams(searchParams);
		next.set("rule", id);
		next.delete("run");
		setSearchParams(next);
	};
	const clearSelection = () => {
		const next = new URLSearchParams(searchParams);
		next.delete("rule");
		next.delete("run");
		setSearchParams(next);
	};
	const addTemplate = async (template: AutomationTemplateSummary) => {
		if (!accountId || addingTemplateId) return;
		setAddingTemplateId(template.id);
		try {
			const { template: definition } = await api.getAutomationTemplate(
				template.id,
				template.version,
			);
			const preview = await api.previewAutomationTemplate(template.id, {
				accountId,
				version: template.version,
				configuration: structuredClone(definition.defaultConfiguration),
			});
			const result = await api.confirmAutomationTemplate(template.id, {
				accountId,
				previewId: preview.preview.previewId,
				previewHash: preview.preview.previewHash,
			});
			await listQuery.refetch?.();
			selectAutomation(result.automation.id);
			toast.success("已添加到自动化并启用，可继续编辑或试运行");
		} catch (error) {
			toast.error(messageOf(error, "添加自动化失败"));
		} finally {
			setAddingTemplateId(undefined);
		}
	};

	const enabledCount = automations.filter((item) => item.enabled).length;
	const attentionCount = automations.filter((item) => item.health === "needs_attention").length;

	return (
		<div
			className="grid h-full min-h-0 bg-paper lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]"
			data-testid="automation-center"
		>
			<section
				className={`${selectedId ? "hidden lg:flex" : "flex"} min-h-0 flex-col border-r border-edge bg-paper-2`}
				aria-label="自动化列表"
			>
				<header className="shrink-0 border-b border-edge px-5 pb-4 pt-6">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-xl font-semibold tracking-tight text-ink">自动化</h1>
							<p className="mt-1 text-xs text-ink-3">
								{enabledCount} 个启用
								{attentionCount ? ` · ${attentionCount} 个需要处理` : ""}
							</p>
						</div>
						<Button size="sm" onClick={() => setLegacyFormOpen(true)}>
							<PlusIcon size={14} weight="bold" />
							新建
						</Button>
					</div>
					<button
						type="button"
						onClick={() => setLegacyFormOpen(true)}
						className="mt-4 flex w-full items-center gap-3 rounded-lg border border-coral/20 bg-coral/[0.06] px-3 py-2.5 text-left transition-colors hover:bg-coral/10"
					>
						<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-coral text-white">
							<SparkleIcon size={15} weight="fill" />
						</span>
						<span className="min-w-0">
							<span className="block text-sm font-semibold text-ink">
								告诉 WeMail 你想自动做什么
							</span>
							<span className="block truncate text-xs text-ink-3">
								创建、调整或解释一条完整工作流
							</span>
						</span>
					</button>
				</header>

				<div
					className="min-h-0 flex-1 overflow-y-auto p-3"
					aria-busy={isLoading}
					aria-live="polite"
				>
					{isLoading ? (
						<EmptyState title="正在加载自动化…" />
					) : isError ? (
						<ErrorState
							title="自动化暂时无法加载"
							onRetry={() => void listQuery.refetch?.()}
						/>
					) : (
						<>
							{sortedAutomations.length ? (
								<div className="space-y-1.5">
									{sortedAutomations.map((item) => (
										<AutomationListRow
											key={item.id}
											item={item}
											selected={item.id === selectedId}
											onSelect={() => selectAutomation(item.id)}
										/>
									))}
								</div>
							) : (
								<EmptyState
									title="还没有自动化"
									description="从一句自然语言或一个内置模板开始。"
								/>
							)}
							{templates.length ? (
								<section className="mt-6 border-t border-edge pt-4" aria-labelledby="template-list-title">
									<h2 id="template-list-title" className="px-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
										推荐模板
									</h2>
									<div className="mt-2 space-y-1">
										{templates.slice(0, 4).map((item) => (
											<TemplateRow
												key={`${item.id}-${item.version}`}
												template={item}
												adding={addingTemplateId === item.id}
												onAdd={() => void addTemplate(item)}
											/>
										))}
									</div>
								</section>
							) : null}
						</>
					)}
				</div>
			</section>

			{selectedId ? (
				<AutomationDetailPane
					accountId={accountId}
					summary={selectedSummary}
					detail={detail}
					loading={detailLoading}
					loadError={detailError}
					searchParams={searchParams}
					setSearchParams={setSearchParams}
					onBack={clearSelection}
					onRefresh={() => {
						void listQuery.refetch?.();
						void detailQuery.refetch?.();
					}}
				/>
			) : (
				<div className="hidden items-center justify-center bg-paper lg:flex">
					<EmptyState title="选择一条自动化查看详情" />
				</div>
			)}

			<AutomationRuleForm
				open={legacyFormOpen}
				onOpenChange={setLegacyFormOpen}
				accountId={accountId}
				editing={null}
				initialMode="natural"
				onNaturalLanguageCreate={(prompt) => {
					setLegacyFormOpen(false);
					openAgentAuthoring(`帮我创建一条自动化规则：${prompt}`);
				}}
			/>
		</div>
	);
}

function AutomationDetailPane({
	accountId,
	summary,
	detail,
	loading,
	loadError,
	searchParams,
	setSearchParams,
	onBack,
	onRefresh,
}: {
	accountId?: string;
	summary?: AutomationListItem;
	detail?: AutomationDetail;
	loading: boolean;
	loadError: boolean;
	searchParams: URLSearchParams;
	setSearchParams: ReturnType<typeof useSearchParams>[1];
	onBack: () => void;
	onRefresh: () => void;
}) {
	const id = detail?.id ?? summary?.id;
	const runId = searchParams.get("run") ?? undefined;
	const toggle = useSetUnifiedAutomationEnabled(accountId);
	const run = useRunUnifiedAutomation(accountId);
	const archive = useArchiveUnifiedAutomation(accountId);
	const resumeDraft = useResumeUnifiedAutomationDraft(accountId);
	const [editorDraft, setEditorDraft] = useState<ExecutionPipelineDraft>();
	const [editorOpen, setEditorOpen] = useState(false);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [deliveryRetry, setDeliveryRetry] = useState<{
		runId: string;
		stepId: string;
		successMessage: string;
	} | null>(null);
	const retry = useRetryUnifiedAutomationStep(accountId);
	const { data: runDetail, isLoading: runDetailLoading } = useUnifiedAutomationRunDetail(
		accountId,
		id,
		runId,
	);
	const item = detail ?? summary;
	if (!item) return <EmptyState title="自动化不存在或不可见" />;
	if (loadError && !detail) {
		return <ErrorState title="自动化详情暂时无法加载" onRetry={onRefresh} />;
	}

	const busy =
		toggle.isPending ||
		run.isPending ||
		archive.isPending ||
		resumeDraft.isPending;
	const showRun = (nextRunId: string) => {
		const next = new URLSearchParams(searchParams);
		next.set("run", nextRunId);
		setSearchParams(next);
	};
	const closeRun = () => {
		const next = new URLSearchParams(searchParams);
		next.delete("run");
		setSearchParams(next, { replace: true });
	};

	const handleRun = async () => {
		if (!item.enabled) return toast.error("请先启用这条自动化");
		try {
			await run.mutateAsync({ id: item.id, confirmDangerous: true });
			toast.success("运行已开始，可在“最近运行”查看进度");
		} catch (error) {
			toast.error(messageOf(error, "运行失败"));
		}
	};
	const resumeEditingDraft = async () => {
		if (!id) throw new Error("automation-id-required");
		const result = await resumeDraft.mutateAsync(id);
		setEditorDraft(result.draft);
		return result.draft;
	};
	const handleAgentEdit = async () => {
		try {
			const draft = await resumeEditingDraft();
			openAgentAuthoring(
				`请继续修改自动化“${item.name}”（规则 ID：${item.id}，编辑草稿 ID：${draft.id}）。我希望调整：`,
			);
			toast("已把编辑草稿带入 Agent，请补充你的调整要求");
		} catch (error) {
			toast.error(messageOf(error, "无法创建编辑草稿"));
		}
	};
	const handleStructuredEdit = async () => {
		try {
			await resumeEditingDraft();
			setEditorOpen(true);
		} catch (error) {
			toast.error(messageOf(error, "无法打开配置草稿"));
		}
	};
	const handleDelete = async () => {
		try {
			await archive.mutateAsync(item.id);
			setDeleteConfirmOpen(false);
			onBack();
			toast.success("自动化已删除");
		} catch (error) {
			toast.error(messageOf(error, "删除失败"));
		}
	};
	const submitRetry = async ({
		runId: retryRunId,
		stepId,
		confirmDelivery,
		successMessage,
	}: {
		runId: string;
		stepId: string;
		confirmDelivery: boolean;
		successMessage: string;
	}) => {
		try {
			await retry.mutateAsync({
				id: item.id,
				runId: retryRunId,
				stepId,
				confirmDelivery,
			});
			setDeliveryRetry(null);
			toast.success(successMessage);
		} catch (error) {
			toast.error(messageOf(error, "该步骤当前不能安全重试"));
		}
	};
	const handleRetry = async (step: AutomationStepDetail) => {
		const delivery = step.stage === "delivery";
		if (delivery) {
			setDeliveryRetry({ runId: runId!, stepId: step.stepId, successMessage: "已从失败步骤恢复执行" });
			return;
		}
		await submitRetry({ runId: runId!, stepId: step.stepId, confirmDelivery: false, successMessage: "已从失败步骤恢复执行" });
	};
	const handleRecoveryAction = async (action: AutomationRecoveryAction) => {
		if (
			(action.type === "retry_step" || action.type === "retry_delivery") &&
			action.runId &&
			action.stepId
		) {
			if (action.type === "retry_delivery") {
				setDeliveryRetry({ runId: action.runId, stepId: action.stepId, successMessage: "恢复操作已提交" });
				return;
			}
			await submitRetry({ runId: action.runId, stepId: action.stepId, confirmDelivery: false, successMessage: "恢复操作已提交" });
			return;
		}
		if (action.type === "new_run") return handleRun();
		if (action.type === "revise_rule") return handleStructuredEdit();
		if (
			action.type === "open_settings" ||
			action.type === "reconnect_account"
		) {
			useUIStore.getState().openSettings("connections");
			return;
		}
		if (action.type === "open_output") {
			window.location.assign("/notifications");
		}
	};

	return (
		<article className="flex min-h-0 flex-col bg-paper" data-testid="automation-rule-detail">
			<header className="shrink-0 border-b border-edge px-5 pb-0 pt-4 md:px-7">
				<div className="flex items-start gap-3">
					<button
						type="button"
						onClick={onBack}
						className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
						aria-label="返回自动化列表"
					>
						<ArrowLeftIcon size={16} />
					</button>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="flex h-8 w-8 items-center justify-center rounded-lg bg-coral/10 text-coral">
								<LightningIcon size={17} weight="fill" />
							</span>
							<h2 className="truncate text-xl font-semibold tracking-tight text-ink">{item.name}</h2>
							<HealthBadge health={item.health} />
						</div>
					</div>
					<Switch
						checked={item.enabled}
						disabled={busy}
						onCheckedChange={(enabled) =>
							toggle.mutate(
								{ id: item.id, enabled },
								{ onError: (error) => toast.error(messageOf(error, "保存失败")) },
							)
						}
						aria-label={`${item.enabled ? "停用" : "启用"} ${item.name}`}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label="更多操作"
							>
								<DotsThreeIcon size={18} weight="bold" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{automationFeatureFlags.structuredCanonicalEditing ? (
								<DropdownMenuItem onSelect={() => void handleStructuredEdit()}>
									<PencilSimpleIcon size={14} />
									编辑配置
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem onSelect={() => void handleAgentEdit()}>
								<PencilSimpleIcon size={14} />
								通过 Agent 编辑
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() =>
									openAgentAuthoring(
										`请解释自动化“${item.name}”（规则 ID：${item.id}）的配置、运行状态或最近结果。我想了解：`,
									)
								}
							>
								<SparkleIcon size={14} />
								询问 Agent
							</DropdownMenuItem>
							<DropdownMenuSeparator />
								<DropdownMenuItem className="text-red" onSelect={() => setDeleteConfirmOpen(true)}>
								<TrashIcon size={14} />
								删除
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<div className="mt-3 pb-4">
					<Button size="sm" onClick={() => void handleRun()} disabled={busy || !item.enabled}>
						<PlayIcon size={14} weight="fill" />
						立即运行
					</Button>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
				{loading || !detail ? (
					<EmptyState title="正在读取自动化详情…" />
				) : (
					<Overview
						detail={detail}
						onOpenRun={showRun}
						onEdit={() =>
							void (automationFeatureFlags.structuredCanonicalEditing
								? handleStructuredEdit()
								: handleAgentEdit())
						}
						onRecoveryAction={(action) => {
							void handleRecoveryAction(action).catch((error) =>
								toast.error(messageOf(error, "恢复操作失败")),
							);
						}}
					/>
				)}
			</div>

				<AutomationRunDetailDialog
				open={!!runId}
				accountId={accountId}
				onOpenChange={(open) => {
					if (!open) closeRun();
				}}
				run={runDetail}
				loading={runDetailLoading}
				retrying={retry.isPending}
				onRetry={(step) => void handleRetry(step)}
				/>
				<ConfirmActionDialog
					open={deleteConfirmOpen}
					onOpenChange={setDeleteConfirmOpen}
					title="删除这条自动化？"
					description={<>“{item.name}”将停止运行并从自动化列表移除。历史运行记录仍会保留用于回溯。</>}
					confirmLabel="删除自动化"
					pending={archive.isPending}
					onConfirm={() => void handleDelete()}
				/>
				<ConfirmActionDialog
					open={deliveryRetry !== null}
					onOpenChange={(nextOpen) => { if (!nextOpen) setDeliveryRetry(null); }}
					title="确认重试投递？"
					description="该步骤可能再次向收件人发送消息。请确认你已检查最近运行记录，避免重复投递。"
					confirmLabel="继续重试"
					destructive
					pending={retry.isPending}
					onConfirm={() => {
						if (!deliveryRetry) return;
						void submitRetry({ ...deliveryRetry, confirmDelivery: true });
					}}
				/>
			{accountId ? (
				<>
					<StructuredAutomationEditorDialog
						accountId={accountId}
						draft={editorDraft}
						automationName={item.name}
						automationDescription={item.description}
						open={editorOpen}
						onOpenChange={setEditorOpen}
						onDraftChange={setEditorDraft}
						onAskAgent={() => {
							setEditorOpen(false);
							openAgentAuthoring(
								`请继续修改自动化“${item.name}”（规则 ID：${item.id}，编辑草稿 ID：${editorDraft?.id ?? "尚未生成"}）。我希望调整：`,
							);
							toast("已把当前草稿带入 Agent，请补充你的调整要求");
						}}
					/>
				</>
			) : null}
		</article>
	);
}

function Overview({
	detail,
	onOpenRun,
	onEdit,
	onRecoveryAction,
}: {
	detail: AutomationDetail;
	onOpenRun: (id: string) => void;
	onEdit: () => void;
	onRecoveryAction: (action: AutomationRecoveryAction) => void;
}) {
	return (
		<div className="space-y-5" data-testid="automation-overview">
			<CompactConfiguration detail={detail} onEdit={onEdit} />
			<StageBlockers stages={detail.stages} onAction={onRecoveryAction} />

			<section aria-labelledby="recent-run-title">
				<div className="flex items-center justify-between">
					<h3 id="recent-run-title" className="text-base font-semibold text-ink">最近运行</h3>
				</div>
				<div className="mt-3 space-y-2">
					{detail.recentRuns.slice(0, 10).map((run) => (
						<RunRow key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
					))}
					{detail.recentRuns.length === 0 ? (
						<p className="rounded-lg border border-dashed border-edge px-4 py-4 text-center text-xs text-ink-3">
							还没有运行记录
						</p>
					) : null}
				</div>
			</section>
		</div>
	);
}

function StageBlockers({
	stages,
	onAction,
}: {
	stages: AutomationDetail["stages"];
	onAction: (action: AutomationRecoveryAction) => void;
}) {
	const blocked = stages.filter(
		(stage) => stage.status === "blocked" || stage.status === "failed",
	);
	if (!blocked.length) return null;
	const seen = new Set<string>();
	return (
		<div className="mt-3 space-y-2" aria-label="需要处理的流程问题">
			{blocked.map((stage) => {
				const actions = (stage.recoveryActions ?? []).filter((action) => {
					const key = `${action.type}:${action.runId ?? ""}:${action.stepId ?? ""}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				return (
					<div
						key={stage.stage}
						className="rounded-lg border border-red/20 bg-red/[0.04] px-3 py-2.5"
					>
						<p className="text-xs font-semibold text-red">
							{stage.label}阶段未完成
						</p>
						<p className="mt-1 text-xs leading-5 text-ink-2">
							{stage.impact || stage.summary}
						</p>
						{stage.outputAvailable ? (
							<p className="mt-1 text-xs text-green">
								此前已生成的结果仍可查看，不会因本次失败丢失。
							</p>
						) : null}
						{actions.length ? (
							<div className="mt-2 flex flex-wrap gap-2">
								{actions.map((action) => (
									<Button
										key={action.id}
										size="sm"
										variant="outline"
										onClick={() => onAction(action)}
									>
										{action.label}
									</Button>
								))}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function CompactConfiguration({
	detail,
	onEdit,
}: {
	detail: AutomationDetail;
	onEdit: () => void;
}) {
	const summary = [
		detail.triggerSummary,
		detail.nextRunAt ? `下次 ${formatShortDate(detail.nextRunAt)}` : "手动触发",
		scopeLabel(detail),
		configurationSummary(detail.configuration.delivery, detail.deliverySummary),
	];
	return (
		<section
			aria-label="规则配置摘要"
			className="flex min-h-11 items-center justify-between gap-4 border-y border-edge py-2"
		>
			<p className="min-w-0 truncate text-xs text-ink-3">
				{summary.map((item, index) => (
					<span key={`${item}-${index}`}>
						{index ? <span className="mx-2 text-edge-2">·</span> : null}
						<span className={index === 0 ? "font-medium text-ink-2" : undefined}>
							{item}
						</span>
					</span>
				))}
			</p>
			<Button
				size="sm"
				variant="ghost"
				className="h-9 shrink-0 px-3 text-xs text-ink-3"
				onClick={onEdit}
			>
				<PencilSimpleIcon size={13} />
				编辑配置
			</Button>
		</section>
	);
}

function AutomationListRow({
	item,
	selected,
	onSelect,
}: {
	item: AutomationListItem;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={`w-full rounded-xl px-3.5 py-3.5 text-left transition-colors motion-reduce:transition-none ${
				selected ? "bg-paper-3" : "hover:bg-paper-3/70"
			}`}
			data-testid={`automation-rule-${item.id}`}
		>
			<span className="block">
				<span className="flex items-center gap-1.5 text-xs text-ink-3">
					<ClockIcon size={12} />
					<span>{item.triggerSummary}</span>
				</span>
				<span className="mt-1.5 flex items-start gap-2.5">
					<HealthIcon health={item.health} />
					<span className="min-w-0 flex-1">
						<span className="flex items-center justify-between gap-2">
							<strong className="truncate text-sm font-semibold text-ink">
								{item.name}
							</strong>
							<span
								className={`shrink-0 text-xs font-medium ${healthMeta(item.health).text}`}
							>
								{healthMeta(item.health).label}
							</span>
						</span>
						<span className="mt-1 block line-clamp-2 text-xs leading-4 text-ink-3">
							{item.description || item.workflowSummary}
						</span>
						<span className="mt-1.5 block truncate text-xs text-ink-3">
							{item.latestRun
								? `${outcomeLabel(item.latestRun.outcome)} · ${formatRelativeTime(item.latestRun.startedAt)}`
								: "尚未运行"}
						</span>
					</span>
				</span>
			</span>
		</button>
	);
}

function TemplateRow({
	template,
	adding,
	onAdd,
}: {
	template: AutomationTemplateSummary;
	adding: boolean;
	onAdd: () => void;
}) {
	return (
		<div
			className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-paper-3"
			data-installed={template.installed ? "true" : "false"}
		>
			<span className="mt-0.5 text-ink-3" aria-hidden="true">
				<TemplateIcon name={template.icon} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center justify-between gap-2">
					<strong className="truncate text-xs font-semibold text-ink">{template.name}</strong>
					<button
						type="button"
						onClick={onAdd}
						disabled={adding || template.installed}
						className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30 ${
							template.installed
								? "cursor-default text-green"
								: "text-coral hover:bg-coral/10"
						}`}
						aria-label={
							template.installed
								? `${template.name} 已添加`
								: `添加 ${template.name}`
						}
					>
						{template.installed ? "已添加" : adding ? "添加中…" : "添加 +"}
					</button>
				</span>
				{template.defaultTiming ? (
					<span className="mt-1 flex items-center gap-1 text-xs text-ink-3">
						<ClockIcon size={11} />
						{template.defaultTiming}
					</span>
				) : null}
				<span className="mt-0.5 line-clamp-2 text-xs leading-4 text-ink-3">{template.description}</span>
				{template.readinessMessage || template.readiness !== "ready" ? (
					<span className="mt-1 block text-xs text-amber">
						{template.readinessMessage ?? "添加前需要完成相关设置"}
					</span>
				) : null}
			</span>
		</div>
	);
}

function RunRow({ run, onOpen }: { run: AutomationRunSummary; onOpen: () => void }) {
	const failed = run.outcome === "failed" || run.outcome === "partial";
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex w-full items-center gap-3 rounded-lg border border-edge bg-paper-2 px-3 py-3 text-left hover:border-coral/30"
		>
			<span className={failed ? "text-red" : "text-green"}>
				{failed ? <WarningCircleIcon size={16} weight="fill" /> : <ClockIcon size={16} />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-xs font-semibold text-ink">
					{run.dryRun ? "试运行" : outcomeLabel(run.outcome)}
				</span>
				<span className="mt-0.5 block truncate text-xs text-ink-3">
					{deliverySummary(run)}
				</span>
				<span className="mt-0.5 block truncate text-xs text-ink-4">
					计划 {formatDate(run.plannedAt ?? run.startedAt)}
					{run.durationMs != null ? ` · 耗时 ${formatDuration(run.durationMs)}` : ""}
				</span>
			</span>
			<time className="shrink-0 text-xs tabular-nums text-ink-4">{formatRelativeTime(run.startedAt)}</time>
		</button>
	);
}

function TemplateIcon({ name }: { name?: string }) {
	if (name === "newspaper") return <NewspaperIcon size={18} weight="duotone" />;
	if (name === "mail-open") return <EnvelopeOpenIcon size={18} weight="duotone" />;
	return <SparkleIcon size={18} weight="duotone" />;
}

function HealthBadge({ health }: { health: AutomationHealth }) {
	const meta = healthMeta(health);
	return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.badge}`}>{meta.label}</span>;
}

function HealthIcon({ health }: { health: AutomationHealth }) {
	const meta = healthMeta(health);
	return (
		<span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${meta.badge}`} title={meta.label}>
			{health === "needs_attention" ? <WarningCircleIcon size={13} weight="fill" /> : <span aria-hidden="true">•</span>}
		</span>
	);
}

function EmptyState({ title, description }: { title: string; description?: string }) {
	return (
		<div
			className="flex min-h-40 flex-col items-center justify-center px-6 text-center"
			role="status"
		>
			<LightningIcon size={24} className="text-ink-4" />
			<p className="mt-3 text-sm font-medium text-ink-2">{title}</p>
			{description ? <p className="mt-1 max-w-xs text-xs leading-5 text-ink-3">{description}</p> : null}
		</div>
	);
}

function ErrorState({
	title,
	onRetry,
}: {
	title: string;
	onRetry: () => void;
}) {
	return (
		<div
			className="flex min-h-40 flex-col items-center justify-center px-6 text-center"
			role="alert"
		>
			<WarningCircleIcon size={24} className="text-red" weight="fill" />
			<p className="mt-3 text-sm font-medium text-ink-2">{title}</p>
			<Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
				重试
			</Button>
		</div>
	);
}

function healthMeta(health: AutomationHealth) {
	return {
		healthy: { label: "正常", text: "text-green", badge: "bg-green-bg text-green" },
		running: { label: "执行中", text: "text-coral", badge: "bg-coral/10 text-coral" },
		needs_attention: { label: "需处理", text: "text-red", badge: "bg-red/10 text-red" },
		paused: { label: "已暂停", text: "text-amber", badge: "bg-amber-bg text-amber" },
		disabled: { label: "已停用", text: "text-ink-3", badge: "bg-ink/5 text-ink-3" },
		never_run: { label: "待首次运行", text: "text-ink-3", badge: "bg-blue-bg text-blue" },
	}[health];
}

function scopeLabel(item: Pick<AutomationListItem, "accountScope">) {
	if (item.accountScope.type === "allConnectedAccounts") return "全部已连接账号";
	if (item.accountScope.type === "selectedAccounts") return `${item.accountScope.accountIds.length} 个指定账号`;
	return "当前账号";
}

function configurationSummary(value: unknown, fallback: string) {
	if (!value) return fallback;
	if (typeof value === "string") return value;
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		for (const key of ["summary", "description", "type", "kind"]) {
			if (typeof object[key] === "string") return String(object[key]);
		}
	}
	return fallback;
}

function outcomeLabel(outcome: AutomationRunSummary["outcome"]) {
	return {
		running: "执行中",
		succeeded: "已完成",
		empty: "没有匹配数据",
		partial: "部分完成",
		failed: "运行失败",
		cancelled: "已取消",
		outcome_unknown: "状态未知",
	}[outcome];
}

function deliverySummary(run: AutomationRunSummary) {
	if (!run.deliveries.length) return "本次未发送通知";
	const labels = run.deliveries
		.filter((item) => item.status === "succeeded")
		.map((item) => ({
			conversation: "Agent 对话",
			message_center: "消息中心",
			feishu_bot: "飞书 Bot",
			wecom_bot: "企业微信 Bot",
			connected_bot: "已连接 Bot",
			desktop_notification: "桌面通知",
		})[item.destination]);
	if (labels.length) return `已发送至${labels.join("、")}`;
	if (run.deliveries.some((item) => item.status === "failed")) return "通知发送失败";
	return "通知发送中";
}

function formatDate(value: string) {
	return new Date(value).toLocaleString();
}

function formatShortDate(value: string) {
	return new Date(value).toLocaleString([], {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatDuration(value: number) {
	if (value < 1_000) return `${value}ms`;
	if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
	return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function startOfTodayAge() {
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	return Date.now() - start;
}

function formatRelativeTime(value: string) {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return value;
	const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
	if (minutes < 10_080) return `${Math.floor(minutes / 1_440)} 天前`;
	return new Date(timestamp).toLocaleDateString();
}

function openAgentAuthoring(prompt: string) {
	const state = useUIStore.getState();
	state.startFreshAgentConversation();
	state.requestAgentComposerInput(prompt);
	if (!state.isAgentPanelOpen) state.toggleAgentPanel();
}

function messageOf(error: unknown, fallback: string) {
	return getUserFacingError(error, fallback);
}

function isWide() {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(min-width: 1024px)").matches
	);
}
