// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type ReactNode, useMemo } from "react";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useEmails } from "~/queries/emails";
import { useSearchEmails } from "~/queries/search";
import { useUserTags } from "~/queries/userTags";
import { useSmartTagBackfills } from "~/queries/smartTagBackfills";
import { useMailFilters } from "~/hooks/useMailFilters";
import { buildMailFilterParams } from "~/components/wemail/MailFilterPopover";
import EmptyState from "~/components/wemail/EmptyState";
import { MessageListView } from "./_workbench";

export function meta() {
	return [{ title: "WeMail" }];
}

export default function SmartTagRoute() {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const backfillQuery = useSmartTagBackfills(mailboxId);
	const backfillRuns = backfillQuery.data ?? [];
	const latestBackfill = backfillRuns[0];
	const smartTagsQuery = useUserTags(mailboxId, {
		refetchInterval: latestBackfill?.status === "running" ? 3_000 : false,
	});
	const smartTags = smartTagsQuery.data ?? [];
	const [searchParams] = useSearchParams();
	const q = (searchParams.get("q") ?? "").trim();
	const mailFilters = useMailFilters();

	const tagId = useMemo(() => {
		const raw = params.id ?? "";
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}, [params.id]);
	const smartTag = smartTags.find((tag) => tag.id === tagId);
	const categoryName = smartTag?.name ?? "";
	const filterParams = useMemo(
		() => ({ smartTagId: tagId, ...buildMailFilterParams(mailFilters) }),
		[tagId, mailFilters],
	);

	const emailsQuery = useEmails(
		mailboxId,
		{
			...filterParams,
		},
		{
			enabled: !!mailboxId && !!categoryName,
			refetchInterval: latestBackfill?.status === "running" ? 3_000 : undefined,
		},
	);
	const searchQuery = useSearchEmails(mailboxId, q, filterParams);

	const query = useMemo(() => {
		if (!q) return emailsQuery;
		return {
			...searchQuery,
			data: searchQuery.data
				? {
					emails: searchQuery.data.pages.flatMap((page) => page.results),
					totalCount: searchQuery.data.pages[0]?.totalCount ?? 0,
				}
				: undefined,
		} as unknown as typeof emailsQuery;
	}, [q, emailsQuery, searchQuery]);

	let listContent: ReactNode;
	if (smartTagsQuery.isLoading) {
		listContent = (
			<div className="flex h-full items-center justify-center text-sm text-ink-3" role="status" aria-live="polite">
				正在加载智能标签…
			</div>
		);
	} else if (smartTagsQuery.isError) {
		listContent = (
			<EmptyState
				icon={<WarningCircleIcon size={22} weight="regular" />}
				title="智能标签暂时无法加载"
				description="请检查连接后重试。"
				actions={[{ label: "重试", onClick: () => void smartTagsQuery.refetch(), variant: "primary" }]}
			/>
		);
	} else if (!smartTag) {
		listContent = (
			<EmptyState
				icon={<TagIcon size={22} weight="regular" />}
				title="智能标签不存在"
				description="它可能已被删除或当前账号无权查看。"
				actions={[{ label: "返回收件箱", onClick: () => navigate("/"), variant: "primary" }]}
			/>
		);
	} else {
		listContent = (
			<div className="flex h-full min-h-0 flex-col">
				{backfillQuery.isError ? (
					<div className="flex min-h-10 items-center gap-2 border-b border-edge bg-amber/10 px-4 py-2 text-xs text-ink-2" role="alert">
						<WarningCircleIcon size={14} className="shrink-0" />
						<span>扫描状态暂时无法更新，邮件列表仍可继续使用。</span>
						<button type="button" onClick={() => void backfillQuery.refetch()} className="ml-auto min-h-8 shrink-0 font-medium text-coral hover:underline">
							重试
						</button>
					</div>
				) : latestBackfill?.status === "running" ? (
					<div
						className="border-b border-edge bg-coral/5 px-4 py-2 text-xs text-ink-2"
						data-testid="smart-tag-backfill-progress"
						role="status"
						aria-live="polite"
					>
						正在扫描邮件：已处理 {latestBackfill.processedCount + latestBackfill.failedCount}/{latestBackfill.queuedCount}
					</div>
				) : latestBackfill?.failedCount ? (
					<div className="flex min-h-10 items-center gap-2 border-b border-edge bg-amber/10 px-4 py-2 text-xs text-ink-2" role="alert">
						<WarningCircleIcon size={14} className="shrink-0" />
						<span>扫描完成，{latestBackfill.failedCount} 封处理失败。</span>
					</div>
				) : null}
				<div className="min-h-0 flex-1">
					<MessageListView
						folder={categoryName}
						query={query}
						listTitle={categoryName}
						hideCategoryTabs
						digestEnabled={false}
						mailSyncEnabled={false}
						emptyTitle="这个智能标签里还没有邮件"
						emptyDescription={`AI 回填或手动移入后，匹配「${categoryName}」的邮件会出现在这里。`}
						showComposeInEmptyState={false}
					/>
				</div>
			</div>
		);
	}

	return listContent;
}
