// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import type {
	IntelligenceAttributeKind,
	SummaryHealthItem,
	SummaryRetryMode,
} from "shared/wemail/intelligence";
import { useUIStore } from "~/hooks/useUIStore";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useFolders } from "~/queries/folders";
import { SummaryInsightCards } from "~/components/digests/SummaryInsightCards";
import {
	useInfiniteSummaryHealth,
	useRetryAllSummaries,
	useSummaryHealth,
	type SummaryStateFilter,
} from "~/queries/digests";
import PageFrame from "~/components/wemail/PageFrame";
import { Button } from "~/components/ui/button";
import SummaryBulkActionBar from "./SummaryBulkActionBar";
import SummaryThroughputPanel from "./SummaryThroughputPanel";
import SummaryTaskTable, { isSummaryItemRetryable } from "./SummaryTaskTable";
import SummaryTaskFilters from "./SummaryTaskFilters";
import SummaryTaskInspector from "./SummaryTaskInspector";
import SummaryRetryDialog from "./SummaryRetryDialog";

const summaryCenterSubtitle =
	"集中查看邮件智能处理状态，定位异常任务并按需重新生成。";

const SUMMARY_STATE_FILTERS = new Set<SummaryStateFilter>([
	"all",
	"attention",
	"failed",
	"missing",
	"invalid",
	"pending",
	"running",
	"succeeded",
	"skipped",
]);

function parseSummaryStateFilter(value: string | null): SummaryStateFilter {
	return value && SUMMARY_STATE_FILTERS.has(value as SummaryStateFilter)
		? (value as SummaryStateFilter)
		: "attention";
}

function HeaderActions({
	canRetry,
	isRetrying,
	onRefresh,
	onRetryAll,
}: {
	canRetry: number;
	isRetrying: boolean;
	onRefresh: () => void;
	onRetryAll: () => void;
}) {
	return (
		<>
			<Button
				type="button"
				onClick={onRefresh}
				variant="secondary"
				size="md"
				className="rounded-lg"
			>
				<ArrowsClockwiseIcon size={14} weight="bold" />
				刷新状态
			</Button>
			{canRetry > 0 ? (
				<Button
					type="button"
					onClick={onRetryAll}
					disabled={isRetrying}
					size="md"
					className="rounded-lg"
				>
					<ArrowsClockwiseIcon size={14} weight="bold" />
					{isRetrying ? "正在入队…" : "重试"}
				</Button>
			) : null}
		</>
	);
}

export function SummaryCenterPage() {
	const [searchParams] = useSearchParams();
	const searchParamsKey = searchParams.toString();
	const deepLinkFilter = useMemo(() => {
		const params = new URLSearchParams(searchParamsKey);
		return parseSummaryStateFilter(params.get("filter"));
	}, [searchParamsKey]);
	const [summaryQuery, setSummaryQuery] = useState("");
	const [summaryStateFilter, setSummaryStateFilter] =
		useState<SummaryStateFilter>(() => deepLinkFilter);
	const [summaryScope, setSummaryScope] = useState("account");
	const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [selectedTask, setSelectedTask] = useState<SummaryHealthItem | null>(
		null,
	);
	const [retryDialogOpen, setRetryDialogOpen] = useState(false);
	const currentAccount = useCurrentAccount();
	const foldersQuery = useFolders(currentAccount.data?.account?.id);
	const selectEmail = useUIStore((state) => state.selectEmail);
	const accountId = currentAccount.data?.account?.id;
	const resolvedSummaryScope = useMemo(() => {
		if (summaryScope.startsWith("folder:")) {
			return {
				scopeKind: "folder" as const,
				scopeKey: summaryScope.slice("folder:".length),
			};
		}
		return { scopeKind: "view" as const, scopeKey: "account-summary-work" };
	}, [summaryScope]);
	const aggregateHealth = useSummaryHealth(accountId, resolvedSummaryScope, !!accountId);
	const taskHealth = useInfiniteSummaryHealth(accountId, resolvedSummaryScope, !!accountId, {
		state: summaryStateFilter,
		query: summaryQuery,
	});
	const retryAll = useRetryAllSummaries(accountId, resolvedSummaryScope);
	const retrySummaries = retryAll.mutate;
	const health = aggregateHealth.data;
	const items = useMemo(
		() => taskHealth.data?.pages.flatMap((page) => page.items ?? []) ?? [],
		[taskHealth.data],
	);

	useEffect(() => {
		setSummaryStateFilter(deepLinkFilter);
	}, [deepLinkFilter]);

	useEffect(() => {
		const nextItems = taskHealth.data?.pages.flatMap((page) => page.items ?? []) ?? [];
		setSelectedTaskIds((current) =>
			new Set(
				[...current].filter((emailId) =>
					nextItems.some(
						(item) => item.emailId === emailId && isSummaryItemRetryable(item),
					),
			),
		));
		setSelectedTask((current) =>
			current
				? nextItems.find((item) => item.emailId === current.emailId) ?? current
				: null,
		);
	}, [taskHealth.data]);

	const toggleSelected = useCallback((emailId: string, selected: boolean) => {
		setSelectedTaskIds((current) => {
			const next = new Set(current);
			if (selected) {
				next.add(emailId);
			} else {
				next.delete(emailId);
			}
			return next;
		});
	}, []);

	const runRetry = useCallback((
		input: { emailIds?: string[]; kinds?: IntelligenceAttributeKind[]; mode?: SummaryRetryMode; limit?: number },
		label: string,
	) => {
		retrySummaries(input, {
			onSuccess: (result) => {
				const skipped = result.skipped ?? 0;
				if (skipped > 0) {
					toast.warning(
						`已入队 ${result.queued} 封，${skipped} 封入队失败，可筛选失败项后重试`,
					);
				} else if (result.queued > 0) {
					toast.success(`已将 ${result.queued} 封邮件重新加入智能处理队列`);
				} else {
					toast.info("没有需要重试的邮件");
				}
			},
			onError: () => {
				toast.error(`${label}失败，请稍后重试`);
			},
		});
	}, [retrySummaries]);

	function retrySelected() {
		if (selectedTaskIds.size === 0) return;
		runRetry({ emailIds: [...selectedTaskIds] }, "批量重试");
	}

	const retryOne = useCallback((emailId: string) => {
		runRetry({ emailIds: [emailId] }, "重试");
	}, [runRetry]);

	const loadMore = useCallback(() => {
		void taskHealth.fetchNextPage();
	}, [taskHealth.fetchNextPage]);

	function retryAttribute(emailId: string, kind: IntelligenceAttributeKind) {
		runRetry({ emailIds: [emailId], kinds: [kind] }, "重试");
	}

	return (
		<PageFrame
			title="智能中心"
			subtitle={summaryCenterSubtitle}
			appearance="workspace"
			testId="summary-center-page"
			contentClassName="flex flex-col gap-4"
			actions={
				<HeaderActions
					canRetry={health?.retryable ?? 0}
					isRetrying={retryAll.isPending}
					onRefresh={() => {
						void aggregateHealth.refetch();
						void taskHealth.refetch();
					}}
					onRetryAll={() => setRetryDialogOpen(true)}
				/>
			}
		>
			<SummaryInsightCards accountId={accountId} health={health} onFilter={setSummaryStateFilter} />
			<SummaryThroughputPanel accountId={accountId} health={health} />

			<div className="flex flex-col gap-3 rounded-xl border border-edge bg-paper-2 p-3 sm:flex-row sm:items-center">
				<div className="min-w-0 flex-1">
					<SummaryTaskFilters
						query={summaryQuery}
						state={summaryStateFilter}
						onQueryChange={setSummaryQuery}
						onStateChange={setSummaryStateFilter}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs font-medium text-ink-3">
					<span className="whitespace-nowrap">任务范围</span>
					<span className="relative">
						<select
							aria-label="智能任务范围"
							value={summaryScope}
							onChange={(event) => setSummaryScope(event.target.value)}
							className="h-10 min-w-[132px] appearance-none rounded-lg border border-transparent bg-paper-3 pl-3 pr-9 text-sm font-medium text-ink outline-none transition-colors hover:bg-paper-4 focus:border-coral focus:ring-2 focus:ring-ring"
						>
							<option value="account">全部邮件</option>
							{(foldersQuery.data ?? []).map((folder) => (
								<option key={folder.id} value={`folder:${folder.id}`}>
									{folder.name}
								</option>
							))}
						</select>
						<CaretDownIcon size={14} weight="bold" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" />
					</span>
				</label>
			</div>
			<div className="grid min-h-[420px] min-w-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
				<div className="relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-edge bg-paper-2">
					<div className="min-h-0 flex-1">
						<SummaryTaskTable
							items={items}
							selectedIds={selectedTaskIds}
							isRetrying={retryAll.isPending}
							hasMore={taskHealth.hasNextPage === true}
							isLoadingMore={taskHealth.isFetchingNextPage}
							onLoadMore={loadMore}
							onToggleSelected={toggleSelected}
							onSelectItem={setSelectedTask}
							onRetryOne={retryOne}
						/>
					</div>
					<SummaryBulkActionBar
						selectedCount={selectedTaskIds.size}
						isRetrying={retryAll.isPending}
						onClear={() => setSelectedTaskIds(new Set())}
						onRetry={retrySelected}
					/>
				</div>
				<SummaryTaskInspector
					item={selectedTask}
					isRetrying={retryAll.isPending}
					onRetry={retryOne}
					onRetryAttribute={retryAttribute}
					onOpenEmail={selectEmail}
				/>
			</div>

			<SummaryRetryDialog
				open={retryDialogOpen}
				onOpenChange={setRetryDialogOpen}
				health={health}
				isRetrying={retryAll.isPending}
				onConfirm={(mode, limit) => {
					runRetry({ mode, limit }, "重试");
					setRetryDialogOpen(false);
				}}
			/>
		</PageFrame>
	);
}

export default SummaryCenterPage;
