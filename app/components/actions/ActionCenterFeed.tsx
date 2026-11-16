// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Action Center — top-level feed (Route C / WP 3H).
 *
 * Renders three stacked sections in priority order:
 *   1. Pending agent actions (high-risk confirmation cards).
 *   2. Open todos (TaskAgent-aware).
 *   3. Curator insights (placeholder until WP J.5–J.6 ships).
 *
 * Sections render their own empty state where it makes sense
 * (`PendingActionsSection` collapses entirely when empty so the page
 * doesn't get a "No pending actions" line in the common case).
 */

import { useCurrentAccount } from "~/queries/currentAccount";
import { useActionCenter } from "~/queries/actionCenter";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { SignInIcon } from "@phosphor-icons/react/SignIn";
import EmptyState from "~/components/wemail/EmptyState";
import { AsyncState } from "~/components/ui/async-state";
import PageFrame from "~/components/wemail/PageFrame";
import { CuratorInsightsSection } from "./CuratorInsightsSection";
import { SmartTagLearningSection } from "./SmartTagLearningSection";
import { TodosSection } from "./TodosSection";

const ACTION_CENTER_TITLE = "行动中心";
const ACTION_CENTER_SUBTITLE =
	"邮件待办和智能标签学习会集中出现在这里。确认操作始终保留在原对话中。";

function ActionCenterFrame({
	children,
	testId = "action-center-page",
}: {
	children: React.ReactNode;
	testId?: string;
}) {
	return (
		<PageFrame
			title={ACTION_CENTER_TITLE}
			subtitle={ACTION_CENTER_SUBTITLE}
			testId={testId}
		>
			{children}
		</PageFrame>
	);
}

export function ActionCenterFeed() {
	const accountQuery = useCurrentAccount();
	const accountId = accountQuery.data?.account?.id ?? null;
	const query = useActionCenter();

	if (!accountQuery.isLoading && !accountId) {
		return (
			<ActionCenterFrame>
				<EmptyState
					icon={<SignInIcon size={22} weight="regular" />}
					title="登录后查看行动中心"
					description="需要确认的操作、待办和智能标签纠偏会汇总到这里。"
					className="min-h-[520px]"
					data-testid="action-center-no-account"
				/>
			</ActionCenterFrame>
		);
	}

	if (query.isLoading) {
		return (
			<ActionCenterFrame>
				<AsyncState
					kind="loading"
					title="正在加载行动中心"
					delayed
					className="min-h-[520px]"
					data-testid="action-center-loading"
				/>
			</ActionCenterFrame>
		);
	}

	if (query.isError || !query.data) {
		return (
			<ActionCenterFrame>
				<AsyncState
					kind="error"
					title="行动中心加载失败"
					description="可以刷新页面重试，或稍后再查看需要确认的操作。"
					actionLabel="重试"
					onAction={() => void query.refetch()}
					actionPending={query.isFetching}
					className="min-h-[520px]"
					data-testid="action-center-error"
				/>
			</ActionCenterFrame>
		);
	}

	const {
		todos,
		smartTagActions = [],
		smartTagPromptRevisions = [],
		smartTagLearningRuns = [],
		curatorInsights,
	} = query.data;
	const everythingEmpty =
		todos.length === 0 &&
		smartTagActions.length === 0 &&
		smartTagPromptRevisions.length === 0 &&
		smartTagLearningRuns.length === 0 &&
		curatorInsights === null;

	return (
		<ActionCenterFrame>
			<div className="mx-auto w-full max-w-3xl space-y-5" data-testid="action-center-feed">
				{everythingEmpty ? (
					<EmptyState
						icon={<CheckCircleIcon size={22} weight="regular" />}
						title="当前没有待处理事项"
						description="新的确认操作、邮件待办或智能标签纠偏出现后，会自动汇总到这里。"
						className="min-h-[520px]"
						data-testid="action-center-empty"
					/>
				) : (
					<>
						<TodosSection todos={todos} />
						<SmartTagLearningSection
								actions={smartTagActions}
								revisions={smartTagPromptRevisions}
								runs={smartTagLearningRuns}
						/>
						<CuratorInsightsSection insights={curatorInsights} />
					</>
				)}
			</div>
		</ActionCenterFrame>
	);
}

export default ActionCenterFeed;
