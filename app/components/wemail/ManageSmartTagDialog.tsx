// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	useDeleteUserTag,
	useRestoreOriginalUserTag,
	useUpdateUserTag,
	type UserTag,
} from "~/queries/userTags";

const NAME_LIMIT = 30;
const DESCRIPTION_LIMIT = 1000;

export interface ManageSmartTagDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string | undefined;
	tag: UserTag | null;
	onDeleted?: (tag: UserTag) => void;
}

export function ManageSmartTagDialog({
	open,
	onOpenChange,
	accountId,
	tag,
	onDeleted,
}: ManageSmartTagDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const updateMut = useUpdateUserTag(accountId);
	const deleteMut = useDeleteUserTag(accountId);
	const restoreMut = useRestoreOriginalUserTag(accountId);

	useEffect(() => {
		if (!open || !tag) return;
		setName(tag.name);
		setDescription(tag.description);
	}, [open, tag]);

	const trimmedName = name.trim();
	const isValid =
		!!tag &&
		trimmedName.length > 0 &&
		trimmedName.length <= NAME_LIMIT &&
		description.length <= DESCRIPTION_LIMIT &&
		description.trim().length > 0;

	const handleSave = async () => {
		if (!tag || !isValid) return;
		try {
			await updateMut.mutateAsync({
				id: tag.id,
				name: trimmedName,
				description,
			});
			toast.success("智能标签已更新");
			onOpenChange(false);
		} catch (err) {
			toast.error(getUserFacingError(err, "智能标签保存失败，请稍后重试。"));
		}
	};

	const handleDelete = async () => {
		if (!tag) return;
		try {
			await deleteMut.mutateAsync(tag.id);
			toast.success("智能标签已删除");
			setDeleteConfirmOpen(false);
			onDeleted?.(tag);
			onOpenChange(false);
		} catch (err) {
			toast.error(getUserFacingError(err, "智能标签删除失败，请稍后重试。"));
		}
	};

	const handleRestoreOriginal = async () => {
		if (!tag?.optimizedPrompt) return;
		try {
			await restoreMut.mutateAsync(tag.id);
			toast.success("已恢复用户原始提示词");
			onOpenChange(false);
		} catch (err) {
			toast.error(getUserFacingError(err, "智能标签恢复失败，请稍后重试。"));
		}
	};

	const learning = tag?.latestLearningRun;
	const retag = tag?.latestRetagRun;
	const learningValidationCount = learning
		? learning.validationCount || learning.sampleCount
		: 0;
	const learningLabel = learning
		? learning.status === "generating"
			? `正在批量消费 ${learning.sampleCount} 封邮件`
			: learning.status === "evaluating"
				? "正在使用智能标签功能进行 A/B 重打标"
				: learning.status === "activated"
					? `已修正 ${learning.correctedCount} 封，验证 ${learning.currentCorrect}/${learningValidationCount} → ${learning.candidateCorrect}/${learningValidationCount}`
					: learning.status === "rejected"
						? "候选未通过，当前提示词保持不变"
						: learning.status === "stale"
							? "标签或模型已变化，等待下一批重新优化"
							: "最近一次批量优化失败"
		: `已记录 ${tag?.feedbackSampleCount ?? 0} 条反馈（移入 ${tag?.positiveFeedbackCount ?? 0}，移出 ${tag?.negativeFeedbackCount ?? 0}）；系统每小时消费新反馈，单条或单一方向也会处理`;

	return (
		<>
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[520px] w-[92vw] p-0 overflow-hidden">
				<div className="px-5 py-4 border-b border-edge">
					<DialogTitle className="text-base font-semibold text-ink">
						管理智能标签
					</DialogTitle>
					<DialogDescription className="text-xs text-ink-3 mt-1">
						你只需维护自然语言描述；系统会转换为严格判定规则，并根据反馈每小时优化。
					</DialogDescription>
				</div>

				<div className="px-5 py-4 space-y-4">
					<div>
						<div className="flex items-baseline justify-between mb-1">
							<label
								htmlFor="manage-smart-tag-name"
								className="text-xs font-medium uppercase tracking-wider text-ink-3"
							>
								名称
							</label>
							<span className="text-xs text-ink-3 tabular-nums">
								{trimmedName.length}/{NAME_LIMIT}
							</span>
						</div>
						<Input
							id="manage-smart-tag-name"
							value={name}
							onChange={(e) => setName(e.target.value.slice(0, NAME_LIMIT))}
							data-testid="manage-smart-tag-name-input"
						/>
					</div>

					<div>
						<div className="flex items-baseline justify-between mb-1">
							<label
								htmlFor="manage-smart-tag-description"
								className="text-xs font-medium uppercase tracking-wider text-ink-3"
							>
								内容描述
							</label>
							<span className="text-xs text-ink-3 tabular-nums">
								{description.length}/{DESCRIPTION_LIMIT}
							</span>
						</div>
						<Textarea
							id="manage-smart-tag-description"
							value={description}
							onChange={(e) =>
								setDescription(e.target.value.slice(0, DESCRIPTION_LIMIT))
							}
							rows={3}
							className="resize-none text-sm"
							data-testid="manage-smart-tag-description-input"
						/>
					</div>

					<div>
						<div className="flex items-baseline justify-between mb-1">
							<label
								htmlFor="manage-smart-tag-prompt"
								className="text-xs font-medium uppercase tracking-wider text-ink-3"
							>
								系统生成的判定规则
							</label>
						</div>
						<Textarea
							id="manage-smart-tag-prompt"
							value={tag?.prompt ?? ""}
							readOnly
							rows={7}
							className="resize-none text-sm bg-paper-2"
							data-testid="manage-smart-tag-prompt-input"
						/>
					</div>

					<div className="rounded-lg border border-edge bg-paper-2 px-3 py-3 space-y-2">
						<div className="text-xs font-medium uppercase tracking-wider text-ink-3">
							定时学习状态
						</div>
						<div className="text-xs leading-5 text-ink-2" data-testid="smart-tag-learning-status">
							{learningLabel}
						</div>
						{retag ? (
							<div className="text-xs text-ink-3" data-testid="smart-tag-retag-status">
								{retag.status === "running"
									? `正在二次打标 ${retag.processedCount + retag.failedCount}/${retag.queuedCount} 封已有标签邮件`
									: retag.status === "completed"
										? `二次打标完成：保留 ${retag.retainedCount}，移除 ${retag.removedCount}`
										: "二次打标失败，可在后台继续重试"}
							</div>
						) : null}
					</div>

					{tag?.optimizedPrompt ? (
						<div className="space-y-2">
							<div className="flex items-center justify-between gap-3">
								<label
									htmlFor="manage-smart-tag-optimized-prompt"
									className="text-xs font-medium uppercase tracking-wider text-ink-3"
								>
									当前 AI 优化提示词
								</label>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={handleRestoreOriginal}
									loading={restoreMut.isPending}
									data-testid="manage-smart-tag-restore-original"
								>
									恢复原始提示词
								</Button>
							</div>
							<Textarea
								id="manage-smart-tag-optimized-prompt"
								value={tag.optimizedPrompt}
								readOnly
								rows={6}
								className="resize-none text-sm bg-paper-2"
								data-testid="manage-smart-tag-optimized-prompt"
							/>
						</div>
					) : null}
				</div>

				<div className="px-5 py-3 border-t border-edge flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setDeleteConfirmOpen(true)}
						loading={deleteMut.isPending}
						className="gap-2 text-coral hover:text-coral"
						data-testid="manage-smart-tag-delete"
					>
						<TrashIcon size={14} />
						删除
					</Button>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={!isValid}
						loading={updateMut.isPending}
						data-testid="manage-smart-tag-save"
					>
						保存
					</Button>
				</div>
			</DialogContent>
		</Dialog>
		<ConfirmActionDialog
			open={deleteConfirmOpen}
			onOpenChange={setDeleteConfirmOpen}
			title="删除智能标签？"
			description={`将删除「${tag?.name ?? "该标签"}」，邮件本身不会被删除。`}
			confirmLabel="删除标签"
			destructive
			pending={deleteMut.isPending}
			onConfirm={() => void handleDelete()}
		/>
		</>
	);
}
