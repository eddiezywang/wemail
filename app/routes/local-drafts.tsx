// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useUIStore } from "~/hooks/useUIStore";
import { formatAddressList } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "~/components/ui/dialog";
import type { WemailAddress } from "../../shared/wemail/mail";

const formatAddresses = (items: WemailAddress[]) => formatAddressList(items);
const plainTextToHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;").replaceAll("\n", "<br>");

export default function LocalDraftsRoute() {
	const { data: currentAccount } = useCurrentAccount();
	const account = currentAccount?.account;
	const startCompose = useUIStore((state) => state.startCompose);
	const queryClient = useQueryClient();
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; accountId: string; subject: string } | null>(null);
	const deleteDraft = useMutation({
		mutationFn: async (target: { id: string; accountId: string }) => {
			const database = window.wemailDesktop?.mailDatabase;
			if (!database?.isConnected()) throw new Error("mail-database-unavailable");
			const result = await database.deleteDraft(target);
			if (!result.value) throw new Error("draft-no-longer-editable");
		},
		onSuccess: (_result, target) => {
			void queryClient.invalidateQueries({ queryKey: ["local-drafts", target.accountId] });
			setDeleteTarget(null);
			toast.success("草稿已删除");
		},
		onError: () => toast.error("草稿无法删除，可能已被发送或移除。请刷新后重试。"),
	});
	const drafts = useQuery({
		queryKey: ["local-drafts", account?.id],
		enabled: !!account?.id,
		queryFn: async () => {
			const database = window.wemailDesktop?.mailDatabase;
			if (!database?.isConnected()) throw new Error("mail-database-unavailable");
			return database.listDrafts({ accountId: account!.id, limit: 1000 });
		},
		refetchOnMount: "always",
	});

	return (
		<div className="h-full overflow-y-auto rounded-xl border border-edge bg-paper-2">
			<h1 className="border-b border-edge px-5 py-4 text-base font-semibold text-ink">本地草稿</h1>
			{drafts.isLoading ? <p className="p-5 text-sm text-ink-3">正在加载草稿…</p> : null}
			{drafts.isError ? <p role="alert" className="p-5 text-sm text-red">草稿加载失败，请稍后重试。</p> : null}
			{drafts.data?.length === 0 ? <p className="p-5 text-sm text-ink-3">没有本地草稿。</p> : null}
			<ul className="divide-y divide-edge-3">
				{drafts.data?.map((draft) => (
					<li key={draft.id} className="flex items-center">
						<button type="button" className="min-w-0 flex-1 px-5 py-3 text-left hover:bg-paper-3" onClick={() => startCompose({
							mode: draft.type === "reply" ? "reply" : draft.type === "forward" ? "forward" : "new",
							draftEmail: {
								id: draft.id, subject: draft.subject, sender: account?.emailAddress ?? "",
								recipient: formatAddresses(draft.to), cc: formatAddresses(draft.cc), bcc: formatAddresses(draft.bcc),
								date: draft.updatedAt, read: true, starred: false, body: draft.bodyHtml || plainTextToHtml(draft.bodyText),
								in_reply_to: draft.originalEmailId ?? null,
							},
						})}>
							<div className="text-sm font-medium text-ink">{draft.subject || "（无主题）"}</div>
							<div className="mt-1 text-xs text-ink-3">{formatAddresses(draft.to) || "（无收件人）"} · {new Date(draft.updatedAt).toLocaleString()}</div>
						</button>
						<Button type="button" variant="ghost" className="mr-3 text-red" onClick={() => setDeleteTarget({ id: draft.id, accountId: draft.accountId, subject: draft.subject })}>删除</Button>
					</li>
				))}
			</ul>
			{drafts.data?.length === 1000 ? <p className="p-5 text-xs text-ink-3">仅显示最近 1000 封本地草稿。</p> : null}
			<Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleteDraft.isPending) setDeleteTarget(null); }}>
				<DialogContent>
					<DialogTitle>删除本地草稿？</DialogTitle>
					<DialogDescription>“{deleteTarget?.subject || "无主题"}”将被永久删除，此操作无法撤销。</DialogDescription>
					<DialogFooter>
						<Button variant="outline" disabled={deleteDraft.isPending} onClick={() => setDeleteTarget(null)}>取消</Button>
						<Button variant="destructive" loading={deleteDraft.isPending} onClick={() => { if (deleteTarget) deleteDraft.mutate(deleteTarget); }}>删除草稿</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
