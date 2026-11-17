// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import type { SummaryStateFilter } from "~/queries/digests";

interface SummaryTaskFiltersProps {
	query: string;
	state: SummaryStateFilter;
	onQueryChange: (query: string) => void;
	onStateChange: (state: SummaryStateFilter) => void;
}

const stateOptions: Array<{ value: SummaryStateFilter; label: string }> = [
	{ value: "attention", label: "待处理" },
	{ value: "all", label: "全部状态" },
	{ value: "failed", label: "失败" },
	{ value: "missing", label: "未生成" },
	{ value: "invalid", label: "无效" },
	{ value: "pending", label: "排队中" },
	{ value: "running", label: "生成中" },
	{ value: "succeeded", label: "已完成" },
	{ value: "skipped", label: "已跳过" },
];

export function SummaryTaskFilters({
	query,
	state,
	onQueryChange,
	onStateChange,
}: SummaryTaskFiltersProps) {
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
			<div className="relative min-w-0 flex-1">
				<MagnifyingGlassIcon
					size={15}
					weight="bold"
					className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
				/>
				<input
					type="search"
					aria-label="搜索智能任务"
					placeholder="搜索邮件主题、发件人或错误原因"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					className="h-10 w-full rounded-lg border border-edge-2 bg-paper-1 pl-9 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 hover:border-ink-4 focus:border-coral focus:ring-2 focus:ring-ring"
				/>
			</div>
			<div className="relative shrink-0">
				<select
					aria-label="智能任务状态"
					value={state}
					onChange={(event) =>
						onStateChange(event.target.value as SummaryStateFilter)
					}
					className="h-10 min-w-[136px] appearance-none rounded-lg border border-transparent bg-paper-3 pl-3 pr-9 text-sm font-medium text-ink-2 outline-none transition-colors hover:bg-paper-4 focus:border-coral focus:ring-2 focus:ring-ring"
				>
					{stateOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<CaretDownIcon size={14} weight="bold" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" />
			</div>
		</div>
	);
}

export default SummaryTaskFilters;
