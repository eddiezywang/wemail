// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	useCreateSmartTagPromotion,
	usePreviewSmartTagPromotion,
} from "~/queries/smartTagPromotions";
import { useCreateUserTag, type UserTag } from "~/queries/userTags";
import { ApiError } from "~/services/api";
import type { ContentTopicTag } from "shared/wemail/intelligence";

const NAME_LIMIT = 30;
const DESCRIPTION_LIMIT = 1000;

export interface SmartTagCandidateSource {
	emailId: string;
	candidate: ContentTopicTag;
}

export interface CreateSmartTagDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string | undefined;
	candidateSource?: SmartTagCandidateSource;
	onCreated?: (tag: UserTag) => void;
}

export function CreateSmartTagDialog({
	open,
	onOpenChange,
	accountId,
	candidateSource,
	onCreated,
}: CreateSmartTagDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [topicId, setTopicId] = useState<string | undefined>();
	const [generationFallback, setGenerationFallback] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const preview = usePreviewSmartTagPromotion();
	const createTag = useCreateUserTag();
	const createPromotion = useCreateSmartTagPromotion(accountId);

	const generateDescription = async (
		source: SmartTagCandidateSource,
		refresh = false,
	) => {
		setSubmitError(null);
		setGenerationFallback(false);
		try {
			const draft = await preview.mutateAsync({
				emailId: source.emailId,
				candidateName: source.candidate.name,
				topicId: source.candidate.topicId,
				refresh,
			});
			setName(draft.name.slice(0, NAME_LIMIT));
			setDescription(draft.description.slice(0, DESCRIPTION_LIMIT));
			setTopicId(draft.topicId);
			setGenerationFallback(draft.generationStatus === "fallback");
		} catch {
			setDescription("");
			setTopicId(source.candidate.topicId);
			setGenerationFallback(true);
		}
	};

	useEffect(() => {
		if (!open) return;
		preview.reset();
		createTag.reset();
		createPromotion.reset();
		setSubmitError(null);
		setGenerationFallback(false);
		if (candidateSource) {
			setName(candidateSource.candidate.name.slice(0, NAME_LIMIT));
			setDescription("");
			setTopicId(candidateSource.candidate.topicId);
			void generateDescription(candidateSource);
			return;
		}
		setName("");
		setDescription("");
		setTopicId(undefined);
		// The source identity is the dialog's reset boundary.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		open,
		candidateSource?.emailId,
		candidateSource?.candidate.name,
		candidateSource?.candidate.topicId,
	]);

	const trimmedName = name.trim();
	const trimmedDescription = description.trim();
	const isValid = Boolean(
		accountId
		&& trimmedName.length > 0
		&& trimmedName.length <= NAME_LIMIT
		&& trimmedDescription.length > 0
		&& trimmedDescription.length <= DESCRIPTION_LIMIT,
	);
	const isCreating = createTag.isPending || createPromotion.isPending;
	const isGenerating = Boolean(candidateSource && preview.isPending && !description);

	const handleSubmit = async () => {
		if (!accountId || !isValid) return;
		setSubmitError(null);
		try {
			const tag = candidateSource
				? (await createPromotion.mutateAsync({
					emailId: candidateSource.emailId,
					candidateName: candidateSource.candidate.name,
					topicId,
					name: trimmedName,
					description: trimmedDescription,
				})).tag
				: await createTag.mutateAsync({
					accountId,
					name: trimmedName,
					description: trimmedDescription,
				});
			toast.success("标签已创建，历史邮件正在回填");
			onCreated?.(tag);
			onOpenChange(false);
		} catch (error) {
			const code = error instanceof ApiError ? error.body.code : undefined;
			setSubmitError(
				code === "SMART_TAG_NAME_EXISTS"
					? "已有同名智能标签，请修改名称后再创建。"
					: getUserFacingError(error, "智能标签创建失败，请保留当前内容并稍后重试。"),
			);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => !isCreating && onOpenChange(next)}
		>
			<DialogContent
				className="w-[92vw] max-w-[440px] overflow-hidden p-0"
				showClose={!isCreating}
				data-testid="create-smart-tag-dialog"
			>
				<div className="border-b border-edge px-5 py-4">
					<DialogTitle className="text-base font-semibold text-ink">
						创建智能标签
					</DialogTitle>
					<DialogDescription className="mt-1 text-xs leading-5 text-ink-3">
						{candidateSource
							? "系统会根据当前邮件生成描述；确认后自动生成分类规则并回填已有邮件。"
							: "填写名称和描述后，系统会自动生成分类规则并回填已有邮件。"}
					</DialogDescription>
				</div>

				{isGenerating ? (
					<div className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 text-center" aria-live="polite">
						<span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-blue-bg text-blue">
							<SparkleIcon size={18} weight="fill" className="animate-pulse motion-reduce:animate-none" />
						</span>
						<div>
							<p className="text-sm font-medium text-ink">正在根据当前邮件生成标签描述</p>
							<p className="mt-1 text-xs text-ink-3">只会使用这封邮件，不会读取其他历史邮件。</p>
						</div>
					</div>
				) : (
					<div className="space-y-4 px-5 py-4">
						{candidateSource && generationFallback ? (
							<div className="rounded-xl bg-paper-2 px-3.5 py-3 text-xs leading-5 text-ink-2" role="status">
								<p className="font-medium text-ink">
									{description ? "暂时无法生成精准描述" : "标签描述生成失败"}
								</p>
								<p className="mt-0.5 text-ink-3">
									{description
										? "已提供可编辑的基础描述，你可以修改或重新生成。"
										: "请重新生成，或直接填写标签描述后创建。"}
								</p>
								<Button
									variant="ghost"
									size="sm"
									className="mt-2 -ml-2 text-blue"
									onClick={() => void generateDescription(candidateSource, true)}
									loading={preview.isPending}
								>
									<ArrowClockwiseIcon size={14} weight="bold" />
									重新生成描述
								</Button>
							</div>
						) : null}

						<div>
							<FieldLabel htmlFor="smart-tag-name" label="名称" count={name.length} limit={NAME_LIMIT} />
							<Input
								id="smart-tag-name"
								value={name}
								onChange={(event) => setName(event.target.value.slice(0, NAME_LIMIT))}
								placeholder="标签名称"
								autoFocus={!candidateSource}
								data-testid="smart-tag-name-input"
							/>
						</div>

						<div>
							<div className="mb-1 flex items-baseline justify-between">
								<label htmlFor="smart-tag-description" className="text-xs font-medium text-ink-2">
									内容描述
								</label>
								<span className="flex items-center gap-2">
									{candidateSource && !isGenerating ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="-mr-1 h-6 px-1.5 text-xs text-blue"
											onClick={() => void generateDescription(candidateSource, true)}
											loading={preview.isPending}
											data-testid="smart-tag-regenerate-description"
										>
											<ArrowClockwiseIcon size={12} weight="bold" />
											重新生成
										</Button>
									) : null}
									<span className="text-xs tabular-nums text-ink-3">
										{description.length}/{DESCRIPTION_LIMIT}
									</span>
								</span>
							</div>
							<Textarea
								id="smart-tag-description"
								value={description}
								onChange={(event) => setDescription(event.target.value.slice(0, DESCRIPTION_LIMIT))}
								placeholder="比如：来自客户的退款、发票、合同审批、需要本周回复的销售线索。"
								rows={4}
								className="resize-y text-sm"
								data-testid="smart-tag-description-input"
							/>
						</div>

						{submitError ? (
							<p className="text-xs leading-5 text-coral" role="alert">{submitError}</p>
						) : null}
					</div>
				)}

				<div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
					<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isCreating}>
						取消
					</Button>
					<Button
						size="sm"
						onClick={() => void handleSubmit()}
						disabled={!isValid || isGenerating}
						loading={isCreating}
						data-testid="smart-tag-create-submit"
					>
						创建
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function FieldLabel({
	htmlFor,
	label,
	count,
	limit,
}: {
	htmlFor: string;
	label: string;
	count: number;
	limit: number;
}) {
	return (
		<div className="mb-1 flex items-baseline justify-between">
			<label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">{label}</label>
			<span className="text-xs tabular-nums text-ink-3">{count}/{limit}</span>
		</div>
	);
}
