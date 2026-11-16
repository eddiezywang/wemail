// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Feature F1 — dedicated "Scheduled" route.
 *
 * Renders the queue of drafts whose send time hasn't passed yet plus
 * recently-sent / failed entries. Backed by `ScheduledSendService`.
 *
 * The data shape here is `ScheduledDraftRecord`, not `Email`, so we
 * render a bespoke list rather than reusing `MessageListView`.
 */

import { useState } from "react";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { toast } from "sonner";
import {
	useCancelScheduledDraft,
	useDeleteScheduledDraft,
	useScheduledDrafts,
} from "~/queries/scheduledDrafts";
import { useCurrentAccount } from "~/queries/currentAccount";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { getUserFacingError } from "~/lib/user-facing-error";

export function meta() {
	return [{ title: "Scheduled" }];
}

function statusLabel(status: string): string {
	switch (status) {
		case "pending":
			return "等待发送";
		case "sent":
			return "已发送";
		case "failed":
			return "发送失败";
		case "cancelled":
			return "已取消";
		default:
			return status;
	}
}

function statusClass(status: string): string {
	switch (status) {
		case "pending":
			return "bg-coral/10 text-coral";
		case "sent":
			return "bg-green/10 text-green";
		case "failed":
			return "bg-red-bg/40 text-red";
		case "cancelled":
			return "bg-paper-3 text-ink-3";
		default:
			return "bg-paper-3 text-ink-3";
	}
}

// Delayed skeleton (S1/S3): nothing under 300ms; then rows shaped like the
// real scheduled items (badge line + subject line) with the shared band.
function ScheduledSkeleton() {
	const visible = useDelayedFlag(true);
	if (!visible) return null;
	return (
		<div className="relative" role="status" aria-label="正在加载定时发送列表">
			<ul className="divide-y divide-edge-3">
				{Array.from({ length: 5 }).map((_, i) => (
					<li key={i} className="flex items-start gap-3 px-5 py-3">
						<div className="min-w-0 flex-1 space-y-1.5">
							<div className="flex items-center gap-2">
								<Skeleton className="h-7 w-14 rounded-full" />
								<Skeleton className="h-3 w-36" />
							</div>
							<Skeleton className="h-3 w-2/3" />
						</div>
					</li>
				))}
			</ul>
			<div aria-hidden="true" className="skeleton-band" />
		</div>
	);
}

export default function ScheduledRoute() {
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const scheduledQuery = useScheduledDrafts(mailboxId);
	const { data, isLoading, isError, error } = scheduledQuery;
	const cancelMut = useCancelScheduledDraft();
	const deleteMut = useDeleteScheduledDraft();
	const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

	const items = data?.scheduled ?? [];
	const deleteTarget = items.find((item) => item.id === deleteTargetId);

	const list = (
		<div onScroll={(event) => {
			const element = event.currentTarget;
			if (scheduledQuery.hasNextPage && !scheduledQuery.isFetchingNextPage && element.scrollHeight - element.scrollTop - element.clientHeight <= 240) {
				void scheduledQuery.fetchNextPage();
			}
		}} className="h-full overflow-y-auto bg-paper-2 rounded-xl border border-edge shadow-[var(--shadow-2)]">
			<div className="px-5 py-4 border-b border-edge flex items-center gap-2">
				<TimerIcon size={18} weight="regular" className="text-ink-2" />
				<h2 className="text-base font-semibold text-ink">定时发送</h2>
				<span className="ml-auto text-xs text-ink-3">
					{items.filter((i) => i.status === "pending").length} 个待发送
				</span>
			</div>
			{isLoading ? (
				<ScheduledSkeleton />
			) : isError ? (
				<div className="p-6 text-sm text-red">
					{getUserFacingError(error, "定时发送列表加载失败，请稍后重试。")}
				</div>
			) : items.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-20 px-6 text-center">
					<TimerIcon size={48} weight="thin" className="text-ink-3 mb-3" />
					<h3 className="text-base font-semibold text-ink mb-1.5">
						没有定时发送
					</h3>
					<p className="text-sm text-ink-3 max-w-xs">
						撰写邮件时点击发送按钮旁的下拉箭头，可以选择稍后发送。
					</p>
				</div>
			) : (
				<ul className="divide-y divide-edge-3">
					{items.map((item) => {
						const recipient = item.payload.to
							.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
							.join(", ");
						const sendAt = new Date(item.sendAt);
						const sendAtLabel = Number.isNaN(sendAt.getTime())
							? item.sendAt
							: sendAt.toLocaleString();
						return (
							<li
								key={item.id}
								className="px-5 py-3 flex items-start gap-3 hover:bg-paper-3"
							>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-1">
										<span
											className={`inline-flex min-h-7 items-center rounded-full px-2 text-xs font-semibold ${statusClass(item.status)}`}
										>
											{statusLabel(item.status)}
										</span>
										<span className="text-xs text-ink-3 truncate">
											{sendAtLabel}
										</span>
									</div>
									<div className="text-sm font-medium text-ink truncate">
										{item.payload.subject || "(无主题)"}
									</div>
									<div className="text-xs text-ink-3 truncate">
										致 {recipient || "(无收件人)"}
									</div>
					{item.lastError ? (
						<div className="text-xs text-red mt-1">
							上次发送没有完成，请检查账号状态后重试。
						</div>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-1">
									{item.status === "pending" ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => {
								cancelMut.mutate({ id: item.id, accountId: item.accountId }, {
													onSuccess: () => toast.success("已取消发送，记录已保留"),
													onError: (err) =>
														toast.error(
													getUserFacingError(err, "取消发送失败，请稍后重试。"),
														),
												});
											}}
											disabled={cancelMut.isPending || deleteMut.isPending}
										>
											<XCircleIcon size={14} />
											取消发送
										</Button>
									) : null}
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-red hover:bg-red-bg/40 hover:text-red"
										onClick={() => setDeleteTargetId(item.id)}
										disabled={cancelMut.isPending || deleteMut.isPending}
									>
										<TrashIcon size={14} />
										删除
									</Button>
								</div>
							</li>
						);
					})}
								</ul>
			)}
			{scheduledQuery.isFetchingNextPage ? <div className="py-4 text-center text-xs text-ink-3">正在加载更多计划发送…</div> : null}
			{scheduledQuery.isFetchNextPageError ? <button type="button" className="block w-full py-4 text-center text-xs text-red hover:underline" onClick={() => void scheduledQuery.fetchNextPage()}>加载失败，点击重试</button> : null}
			{!scheduledQuery.hasNextPage && items.length > 0 ? <div className="py-4 text-center text-xs text-ink-3">已加载全部计划发送</div> : null}
		</div>
	);

	return (
		<>
			{list}
			<Dialog
				open={deleteTargetId !== null}
				onOpenChange={(open) => {
					if (!open && !deleteMut.isPending) setDeleteTargetId(null);
				}}
			>
				<DialogContent className="max-w-[420px]">
					<DialogHeader>
						<DialogTitle>删除定时发送记录？</DialogTitle>
						<DialogDescription>
							{deleteTarget?.status === "pending"
								? "删除后，这封邮件不会发送，记录也会永久移除。如果只想停止发送并保留记录，请选择“取消发送”。"
								: "该记录将从定时发送列表中永久移除，此操作无法撤销。"}
						</DialogDescription>
					</DialogHeader>
					{deleteTarget ? (
						<div className="rounded-lg border border-edge bg-paper-3 px-3 py-2.5">
							<div className="truncate text-sm font-medium text-ink">
								{deleteTarget.payload.subject || "(无主题)"}
							</div>
							<div className="mt-0.5 text-xs text-ink-3">
								{statusLabel(deleteTarget.status)}
							</div>
						</div>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setDeleteTargetId(null)}
							disabled={deleteMut.isPending}
						>
							返回
						</Button>
						<Button
							variant="destructive"
							loading={deleteMut.isPending}
							onClick={() => {
								if (!deleteTarget || !mailboxId) return;
								deleteMut.mutate(
									{ id: deleteTarget.id, accountId: mailboxId },
									{
										onSuccess: () => {
											setDeleteTargetId(null);
											toast.success("定时发送记录已删除");
										},
										onError: (err) =>
											toast.error(
											getUserFacingError(err, "记录删除失败，请稍后重试。"),
											),
									},
								);
							}}
						>
							删除记录
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
