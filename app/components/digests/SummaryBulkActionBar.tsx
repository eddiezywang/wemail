// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "~/components/ui/button";

export interface SummaryBulkActionBarProps {
	selectedCount: number;
	isRetrying: boolean;
	onClear: () => void;
	onRetry: () => void;
}

export default function SummaryBulkActionBar({
	selectedCount,
	isRetrying,
	onClear,
	onRetry,
}: SummaryBulkActionBarProps) {
	if (selectedCount === 0) return null;

	return (
		<div className="absolute inset-x-3 bottom-3 z-20 rounded-xl bg-ink px-4 py-3 text-paper-2 shadow-[var(--shadow-3)]">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="text-sm font-medium">
					已选 {selectedCount} 封可重试邮件
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-paper-2 hover:bg-paper-2/10 hover:text-paper-2"
						onClick={onClear}
						disabled={isRetrying}
					>
						清空选择
					</Button>
					<Button
						type="button"
						size="sm"
						className="bg-paper-2 text-ink hover:bg-paper-3"
						onClick={onRetry}
						disabled={isRetrying}
					>
						重试选中 {selectedCount}
					</Button>
				</div>
			</div>
		</div>
	);
}
