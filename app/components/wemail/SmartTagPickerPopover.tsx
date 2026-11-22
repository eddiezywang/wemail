// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SmartTagPickerPopover — stateful smart-tag management for a single
 * email. Tags already applied to the message are presented as removable;
 * user-defined tags not yet applied are presented as move-in candidates.
 *
 * Each operation still accepts an optional reason. Those reasons are
 * recorded by the server as smart-tag actions and later feed prompt
 * learning in the action center.
 */

import { useMemo, useRef, useState } from "react";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { toast } from "sonner";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import {
	useApplyMessageTag,
	useUnapplyMessageTag,
} from "~/queries/tagLibrary";
import { useUserTags } from "~/queries/userTags";
import type { UserTag } from "~/queries/userTags";
import { useUIStore } from "~/hooks/useUIStore";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { getUserFacingError } from "~/lib/user-facing-error";

export interface SmartTagPickerPopoverProps {
	emailId: string;
	accountId: string | undefined;
	/** Tag names already applied to this email, drawn from the latest
	 *  intelligence result. Used to split rows into "移入" / "移出". */
	appliedTags: ReadonlySet<string>;
	appliedTagsStatus?: "loading" | "error";
	onRetryAppliedTags?: () => void;
	children?: React.ReactNode;
	/** Embed the picker inside another surface instead of opening a nested popover. */
	onBack?: () => void;
}

function tagDotColor(name: string): string {
	const norm = name.trim().toLowerCase();
	let hash = 0;
	for (let i = 0; i < norm.length; i += 1) {
		hash = (hash * 31 + norm.charCodeAt(i)) | 0;
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue} 58% 52%)`;
}

export default function SmartTagPickerPopover({
	emailId,
	accountId,
	appliedTags,
	appliedTagsStatus,
	onRetryAppliedTags,
	children,
	onBack,
}: SmartTagPickerPopoverProps) {
	const { data: library = [], isLoading, isError, refetch } = useUserTags(accountId);
	const applyMut = useApplyMessageTag(emailId);
	const unapplyMut = useUnapplyMessageTag(emailId);
	const openCreateTagDialog = useUIStore((state) => state.openCreateTagDialog);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [pendingAction, setPendingAction] = useState<{
		tag: UserTag;
		action: "apply" | "remove";
	} | null>(null);
	const [reason, setReason] = useState("");
	const actionTrigger = useRef<HTMLButtonElement | null>(null);
	const backRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	const { appliedNames, availableNames } = useMemo(() => {
		const unique = [...library]
			.filter((tag) => tag.name.length > 0)
			.sort((a, b) => a.name.localeCompare(b.name, "zh"));
		return {
			appliedNames: unique.filter((tag) => appliedTags.has(tag.name)),
			availableNames: unique.filter((tag) => !appliedTags.has(tag.name)),
		};
	}, [library, appliedTags]);

	const handleToggle = (tag: UserTag, currentlyOn: boolean, trigger: HTMLButtonElement) => {
		actionTrigger.current = trigger;
		setReason("");
		setPendingAction({ tag, action: currentlyOn ? "remove" : "apply" });
	};

	const submitAction = async () => {
		if (!pendingAction) return;
		const input = {
			tagId: pendingAction.tag.id,
			tag: pendingAction.tag.name,
			reason: reason.trim() || undefined,
		};
		try {
			if (pendingAction.action === "remove") {
				await unapplyMut.mutateAsync(input);
				toast.success(`已移出「${pendingAction.tag.name}」`);
			} else {
				await applyMut.mutateAsync(input);
				toast.success(`已移入「${pendingAction.tag.name}」`);
			}
			setPendingAction(null);
			setPopoverOpen(false);
		} catch (error) {
			toast.error(getUserFacingError(error, "智能标签操作失败，请稍后重试。"));
		}
	};
	const actionPending = applyMut.isPending || unapplyMut.isPending;

	const picker = (
		<div data-testid="smart-tag-picker">
			{onBack ? <button ref={backRef} type="button" autoFocus onClick={onBack} className="min-h-11 w-full border-b border-edge px-3.5 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">‹ 返回邮件操作</button> : null}
			<div className="flex items-center justify-between gap-2 border-b border-edge px-3.5 py-3">
					<div>
						<div className="text-sm font-semibold text-ink">标签处理</div>
						<div className="text-xs text-ink-3 mt-0.5">
							移入或移出智能标签
						</div>
					</div>
					<button
						type="button"
						onClick={openCreateTagDialog}
						aria-label="创建新标签"
						className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink text-paper hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						data-testid="smart-tag-picker-create"
					>
						<PlusIcon size={14} weight="bold" />
					</button>
				</div>
				<div
					className="max-h-80 overflow-y-auto py-2"
					data-testid="smart-tag-picker-list"
				>
					{isLoading || appliedTagsStatus === "loading" ? <p role="status" className="px-4 py-4 text-xs text-ink-3">正在加载智能标签…</p>
						: isError || appliedTagsStatus === "error" ? <div className="px-4 py-2 text-xs text-ink-2">
							<p role="alert">智能标签暂时无法加载。</p>
							<button type="button" className="min-h-11 font-medium underline" onClick={() => {
								if (isError) void refetch();
								if (appliedTagsStatus === "error") onRetryAppliedTags?.();
							}}>重试</button>
						</div>
						: library.length === 0 ? (
						<div className="px-4 py-6 text-center text-xs text-ink-3">
							暂无智能标签 — 点击 + 创建第一个
						</div>
					) : (
						<>
							<TagSection
								title="已选标签"
								emptyText="这封邮件还没有智能标签"
								names={appliedNames}
								actionLabel="移出"
								actionTone="remove"
								isPending={(tag) =>
									unapplyMut.isPending && unapplyMut.variables?.tagId === tag.id
								}
								onAction={(tag, trigger) => handleToggle(tag, true, trigger)}
							/>
							<TagSection
								title="可移入标签"
								emptyText="没有可移入的智能标签"
								names={availableNames}
								actionLabel="移入"
								actionTone="apply"
								isPending={(tag) =>
									applyMut.isPending && applyMut.variables?.tagId === tag.id
								}
								onAction={(tag, trigger) => handleToggle(tag, false, trigger)}
							/>
						</>
					)}
				</div>
		</div>
	);
	return (
		<>
		{onBack ? picker : (
			<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
				<PopoverTrigger asChild>{children}</PopoverTrigger>
				<PopoverContent align="end" sideOffset={6} className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto p-0">
					{picker}
				</PopoverContent>
			</Popover>
		)}
		<Dialog
			open={pendingAction !== null}
			onOpenChange={(open) => {
				if (!open && !actionPending) setPendingAction(null);
			}}
		>
			<DialogContent
				className="max-h-[min(70dvh,30rem)] max-w-md overflow-y-auto"
				data-testid="smart-tag-action-dialog"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					cancelRef.current?.focus({ preventScroll: true });
				}}
				onCloseAutoFocus={(event) => {
					const target = actionTrigger.current?.isConnected ? actionTrigger.current : backRef.current;
					if (!target || (document.activeElement && document.activeElement !== document.body)) return;
					event.preventDefault();
					target.focus({ preventScroll: true });
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{pendingAction?.action === "remove" ? "移出智能标签" : "移入智能标签"}
					</DialogTitle>
					<DialogDescription>
						{pendingAction
							? `${pendingAction.action === "remove" ? "从" : "将邮件加入"}「${pendingAction.tag.name}」${pendingAction.action === "remove" ? "中移出" : ""}。备注可选。`
							: ""}
					</DialogDescription>
				</DialogHeader>
				<textarea
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					aria-label="智能标签操作备注"
					placeholder="备注（可选）"
					rows={3}
					className="w-full resize-none rounded-lg border border-edge bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-coral [@media(pointer:coarse)]:text-base"
				/>
				<DialogFooter>
					<Button
						ref={cancelRef}
						variant="secondary"
						className="min-h-11"
						onClick={() => setPendingAction(null)}
						disabled={actionPending}
					>
						取消
					</Button>
					<Button
						className="min-h-11"
						onClick={() => void submitAction()}
						disabled={actionPending}
						data-testid="smart-tag-action-confirm"
					>
						{actionPending ? "处理中…" : "确认"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
		</>
	);
}

function TagSection({
	title,
	emptyText,
	names,
	actionLabel,
	actionTone,
	isPending,
	onAction,
}: {
	title: string;
	emptyText: string;
	names: UserTag[];
	actionLabel: string;
	actionTone: "apply" | "remove";
	isPending: (tag: UserTag) => boolean;
	onAction: (tag: UserTag, trigger: HTMLButtonElement) => void;
}) {
	return (
		<section className="py-1">
			<div className="px-3.5 pb-1 text-xs font-medium text-ink-3">
				{title}
			</div>
			{names.length === 0 ? (
				<div className="px-3.5 py-2 text-xs text-ink-3">{emptyText}</div>
			) : (
				<ul className="space-y-0.5">
					{names.map((tag) => (
						<li key={tag.id}>
							<div
								data-testid={`smart-tag-picker-item-${tag.name}`}
								className="flex items-center gap-2.5 px-3.5 py-2 text-sm text-ink"
							>
								<TagIcon size={14} className="shrink-0 text-ink-3" />
								<span
									aria-hidden
									className="inline-block h-2 w-2 rounded-full shrink-0"
									style={{ backgroundColor: tagDotColor(tag.name) }}
								/>
								<span className="min-w-0 flex-1 truncate">{tag.name}</span>
								<button
									type="button"
									onClick={(event) => onAction(tag, event.currentTarget)}
									disabled={isPending(tag)}
									data-testid={`smart-tag-picker-${actionTone}-${tag.name}`}
									className={`min-h-11 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
										actionTone === "apply"
											? "bg-coral text-paper hover:opacity-90"
											: "border border-edge bg-paper text-ink-2 hover:bg-paper-3"
									}`}
								>
									{actionLabel}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
