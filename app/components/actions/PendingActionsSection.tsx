// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Action Center — Pending agent actions section (Route C / WP 3H).
 *
 * Wraps the existing `PendingActionCard` from WP 3I so the Action
 * Center stays a thin composition over already-shipped pieces. Resolve
 * goes through the same mutation hook the agent panel uses
 * (`useResolvePendingAction`) and additionally invalidates the
 * action-center query so the card disappears immediately.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getUserFacingError } from "~/lib/user-facing-error";
import { useResolvePendingAction } from "~/queries/pendingActions";
import { queryKeys } from "~/queries/keys";
import type { Mailbox } from "~/types";
import { PendingActionCard } from "~/components/wemail/PendingActionCard";
import type { AgentPendingAction } from "~/services/api";

export function PendingActionsSection({
	actions,
}: {
	actions: AgentPendingAction[];
}) {
	const qc = useQueryClient();
	const resolve = useResolvePendingAction();
	const [errors, setErrors] = useState<Record<string, string>>({});

	if (actions.length === 0) return null;

	const handleResolve = (
		id: string,
		status: "confirmed" | "rejected",
	) => {
		const action = actions.find((item) => item.id === id);
		if (!action) return;
		setErrors((current) => ({ ...current, [id]: "" }));
		resolve.mutate(
			{ id, status, ...(status === "confirmed" ? { idempotencyKey: action.idempotencyKey, parameters: action.parameters } : {}) },
			{
				// The mutation hook itself invalidates the pending-actions
				// queries. We additionally invalidate action-center so this
				// page's polling cycle picks up the change before the next
				// 10s tick.
				onSuccess: () => {
					qc.invalidateQueries({ queryKey: ["action-center"] });
				},
				onError: (error) => {
					setErrors((current) => ({ ...current, [id]: getUserFacingError(error, "暂时无法确认提交结果，请刷新原任务状态。") }));
					void qc.invalidateQueries({ queryKey: ["action-center"] });
				},
			},
		);
	};

	return (
		<section
			data-testid="action-center-pending-actions"
			aria-labelledby="action-center-pending-actions-heading"
			className="space-y-2"
		>
			<h2
				id="action-center-pending-actions-heading"
				className="text-sm font-semibold text-ink"
			>
				需要确认
				<span className="ml-2 text-xs font-normal text-ink-3">
					({actions.length})
				</span>
			</h2>
			<div className="space-y-2">
				{actions.map((action) => (
					<PendingActionCard
						key={action.id}
						action={action}
						mailbox={typeof action.parameters?.accountId === "string"
							? qc.getQueryData<Mailbox>(queryKeys.mailboxes.detail(action.parameters.accountId)) : undefined}
						onConfirm={(id) => handleResolve(id, "confirmed")}
						onReject={(id) => handleResolve(id, "rejected")}
						isResolving={resolve.isPending && resolve.variables?.id === action.id}
						error={errors[action.id]}
						onRefresh={() => void qc.invalidateQueries({ queryKey: ["action-center"] })}
					/>
				))}
			</div>
		</section>
	);
}

export default PendingActionsSection;
