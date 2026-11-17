// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → 写作风格.
 *
 * Lists user-defined writing styles and lets the user create / edit /
 * delete them. The compose AI prompt bar (WS2) reads this list to build
 * its style picker.
 */

import { useState } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { XIcon } from "@phosphor-icons/react/X";
import { Button } from "~/components/ui/button";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import { getUserFacingError } from "~/lib/user-facing-error";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "sonner";
import {
	useCreateWritingStyle,
	useDeleteWritingStyle,
	useUpdateWritingStyle,
	useWritingStyles,
} from "~/queries/writingStyles";
import type { WritingStyle } from "../../../../shared/wemail/settings";

interface DraftStyle {
	id: string | null;
	name: string;
	description: string;
	instructions: string;
}

const EMPTY_DRAFT: DraftStyle = {
	id: null,
	name: "",
	description: "",
	instructions: "",
};

export function WritingStyleSection() {
	const { data: styles = [], isLoading } = useWritingStyles();
	const createMut = useCreateWritingStyle();
	const updateMut = useUpdateWritingStyle();
	const deleteMut = useDeleteWritingStyle();

	const [draft, setDraft] = useState<DraftStyle | null>(null);
	const [deleteCandidate, setDeleteCandidate] = useState<WritingStyle | null>(null);

	const isEditing = draft !== null;
	const isPending = createMut.isPending || updateMut.isPending;

	const handleSave = async () => {
		if (!draft) return;
		if (!draft.name.trim() || !draft.instructions.trim()) {
			toast.error("名称和指令不能为空");
			return;
		}
		try {
			if (draft.id) {
				await updateMut.mutateAsync({
					id: draft.id,
					update: {
						name: draft.name.trim(),
						description: draft.description.trim(),
						instructions: draft.instructions.trim(),
					},
				});
				toast.success("已更新");
			} else {
				await createMut.mutateAsync({
					name: draft.name.trim(),
					description: draft.description.trim() || undefined,
					instructions: draft.instructions.trim(),
				});
				toast.success("已创建");
			}
			setDraft(null);
		} catch (err) {
			toast.error(getUserFacingError(err, "写作风格保存失败，请稍后重试。"));
		}
	};

	const handleDelete = (style: WritingStyle) => {
		deleteMut.mutate(style.id, {
			onSuccess: () => {
				setDeleteCandidate(null);
				toast.success("已删除");
			},
			onError: (err) =>
				toast.error(getUserFacingError(err, "写作风格删除失败，请稍后重试。")),
		});
	};

	return (
		<div className="space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="text-base font-semibold text-ink mb-1">写作风格</h2>
					<p className="text-xs text-ink-3">
						为 AI 撰写定义可复用的风格。撰写时可在 AI 输入栏切换。
					</p>
				</div>
				{!isEditing ? (
					<Button size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
						<PlusIcon size={14} weight="bold" />
						添加风格
					</Button>
				) : null}
			</div>

			{draft ? (
				<div className="rounded-md border border-edge bg-paper-2 px-4 py-4 space-y-3">
					<div>
						<label className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
							名称
						</label>
						<Input
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							placeholder="例如：Concise / 正式中文"
						/>
					</div>
					<div>
						<label className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
							描述（可选）
						</label>
						<Input
							value={draft.description}
							onChange={(e) =>
								setDraft({ ...draft, description: e.target.value })
							}
							placeholder="给团队同事的内部回信"
						/>
					</div>
					<div>
						<label className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1">
							指令
						</label>
						<Textarea
							rows={6}
							value={draft.instructions}
							onChange={(e) =>
								setDraft({ ...draft, instructions: e.target.value })
							}
							placeholder="像真人一样写作。短句、直接、流畅。避免客套话。"
							className="resize-y min-h-32 font-mono text-xs"
						/>
					</div>
					<div className="flex items-center justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setDraft(null)}
							disabled={isPending}
						>
							<XIcon size={14} />
							取消
						</Button>
						<Button size="sm" onClick={handleSave} loading={isPending}>
							<CheckIcon size={14} weight="bold" />
							保存
						</Button>
					</div>
				</div>
			) : null}

			{isLoading ? (
				<div className="rounded-md border border-edge bg-paper-2 px-4 py-8 text-center text-xs text-ink-3">
					加载中…
				</div>
			) : styles.length === 0 && !isEditing ? (
				<div className="rounded-md border border-dashed border-edge bg-paper-2 px-4 py-8 text-center text-xs text-ink-3">
					还没有写作风格。点击右上角"添加风格"创建一个。
				</div>
			) : (
				<div className="rounded-md border border-edge bg-paper-2 overflow-hidden divide-y divide-edge-3">
					{styles.map((style) => (
						<div
							key={style.id}
							className="px-4 py-3 flex items-start gap-3"
						>
							<div className="flex-1 min-w-0">
								<div className="text-sm font-semibold text-ink truncate">
									{style.name}
								</div>
								{style.description ? (
									<p className="text-xs text-ink-3 mt-0.5 truncate">
										{style.description}
									</p>
								) : null}
								<p className="text-xs text-ink-2 mt-1 line-clamp-2 whitespace-pre-wrap font-mono">
									{style.instructions}
								</p>
							</div>
							<div className="flex items-center gap-1 shrink-0">
								<button
									type="button"
									title="编辑"
									aria-label="编辑写作风格"
									onClick={() =>
										setDraft({
											id: style.id,
											name: style.name,
											description: style.description ?? "",
											instructions: style.instructions,
										})
									}
									className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<PencilSimpleIcon size={14} />
								</button>
								<button
									type="button"
									title="删除"
									aria-label="删除写作风格"
									onClick={() => setDeleteCandidate(style)}
									disabled={deleteMut.isPending}
									className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:bg-red/10 hover:text-red disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<TrashIcon size={14} />
								</button>
							</div>
						</div>
					))}
				</div>
			)}
			<ConfirmActionDialog
				open={deleteCandidate !== null}
				onOpenChange={(nextOpen) => { if (!nextOpen) setDeleteCandidate(null); }}
				title="删除写作风格？"
				description={`将永久删除「${deleteCandidate?.name ?? "该风格"}」。`}
				confirmLabel="删除风格"
				destructive
				pending={deleteMut.isPending}
				onConfirm={() => { if (deleteCandidate) handleDelete(deleteCandidate); }}
			/>
		</div>
	);
}
