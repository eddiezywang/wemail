// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * MailFilterPopover — list-toolbar popover that lets the user narrow
 * the mail list by unread / needs-reply / informational / has-attachment (multi-
 * select booleans) and a single "older than X" date preset.
 *
 * Toggling commits immediately to the current directory view's filter scope.
 * Routes thread the same filters into `useEmails(mailboxId, params)`,
 * so the list refetches on the next render with the new querystring.
 */

import { CheckIcon } from "@phosphor-icons/react/Check";
import { XIcon } from "@phosphor-icons/react/X";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import {
	useUIStore,
	type MailFilters,
	type OlderThanFilter,
} from "~/hooks/useUIStore";
import { useMailFilters } from "~/hooks/useMailFilters";

const BOOLEAN_OPTIONS: Array<{ key: keyof MailFilters; label: string }> = [
	{ key: "unread", label: "待我查看" },
	{ key: "toMe", label: "需要我回复" },
	{ key: "ccMe", label: "仅供知会" },
	{ key: "hasAttachment", label: "包含附件" },
];

const DATE_OPTIONS: Array<{ value: OlderThanFilter; label: string }> = [
	{ value: "7d", label: "一周前" },
	{ value: "30d", label: "一个月前" },
	{ value: "180d", label: "六个月前" },
];

export interface MailFilterPopoverProps {
	children: React.ReactNode;
}

export default function MailFilterPopover({
	children,
}: MailFilterPopoverProps) {
	const mailFilters = useMailFilters();
	const setMailFilter = useUIStore((state) => state.setMailFilter);
	const clearMailFilters = useUIStore((state) => state.clearMailFilters);

	const activeCount =
		(mailFilters.unread ? 1 : 0) +
		(mailFilters.toMe ? 1 : 0) +
		(mailFilters.ccMe ? 1 : 0) +
		(mailFilters.hasAttachment ? 1 : 0) +
		(mailFilters.olderThan ? 1 : 0);

	const toggleBoolean = (key: keyof MailFilters) => {
		setMailFilter(key, !mailFilters[key] as never);
	};

	const pickDate = (value: OlderThanFilter) => {
		setMailFilter(
			"olderThan",
			mailFilters.olderThan === value ? null : value,
		);
	};

	return (
		<Popover>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={6}
				className="w-56 p-0 overflow-hidden"
				data-testid="mail-filter-popover"
			>
				<div className="px-3 py-2.5 border-b border-edge flex items-center justify-between">
					<span className="text-sm font-semibold text-ink">筛选条件</span>
					{activeCount > 0 ? (
						<button
							type="button"
							onClick={clearMailFilters}
							className="text-xs text-coral hover:opacity-80"
							data-testid="mail-filter-clear"
						>
							清除
						</button>
					) : null}
				</div>
				<ul className="py-1.5">
					{BOOLEAN_OPTIONS.map(({ key, label }) => {
						const active = !!mailFilters[key];
						return (
							<li key={key}>
								<button
									type="button"
									onClick={() => toggleBoolean(key)}
									data-testid={`mail-filter-${key}`}
									className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-paper-3 transition-colors ${
										active ? "text-ink font-medium" : "text-ink-2"
									}`}
								>
									<span>{label}</span>
									{active ? (
										<CheckIcon size={12} weight="bold" className="text-coral" />
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
				<div className="px-3 py-1 border-t border-edge text-xs uppercase tracking-wider text-ink-3 font-medium">
					时间范围
				</div>
				<ul className="py-1.5 pb-2">
					{DATE_OPTIONS.map(({ value, label }) => {
						const active = mailFilters.olderThan === value;
						return (
							<li key={value ?? ""}>
								<button
									type="button"
									onClick={() => pickDate(value)}
									data-testid={`mail-filter-older-${value}`}
									className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-paper-3 transition-colors ${
										active ? "text-ink font-medium" : "text-ink-2"
									}`}
								>
									<span>{label}</span>
									{active ? (
										<CheckIcon size={12} weight="bold" className="text-coral" />
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

/** Build the bounded canonical mail query from
 *  the current filter state. Skips falsy entries so the URL stays clean. */
export function buildMailFilterParams(
	filters: MailFilters,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (filters.unread) out.unread = "1";
	if (filters.toMe) out.toMe = "1";
	if (filters.ccMe) out.ccMe = "1";
	if (filters.hasAttachment) out.hasAttachment = "1";
	if (filters.olderThan) out.olderThan = filters.olderThan;
	return out;
}

/**
 * Active-filter chip row (approved design section 11). The popover stays
 * for adding filters; this row makes what is currently filtered visible
 * in the list chrome with one-tap removal per chip plus a clear-all.
 * Renders nothing when no filter is active. Filter counts per option are
 * not available client-side (the list is server-paginated), so chips stay
 * count-free rather than showing misleading page-local numbers.
 */
export function MailFilterChips() {
	const mailFilters = useMailFilters();
	const setMailFilter = useUIStore((state) => state.setMailFilter);
	const clearMailFilters = useUIStore((state) => state.clearMailFilters);

	const active: Array<{ label: string; remove: () => void }> = [];
	for (const { key, label } of BOOLEAN_OPTIONS) {
		if (mailFilters[key]) {
			active.push({
				label,
				remove: () => setMailFilter(key, false as never),
			});
		}
	}
	if (mailFilters.olderThan) {
		const dateOption = DATE_OPTIONS.find(
			(option) => option.value === mailFilters.olderThan,
		);
		active.push({
			label: `${dateOption?.label ?? "更早"}之前`,
			remove: () => setMailFilter("olderThan", null),
		});
	}
	if (active.length === 0) return null;

	return (
		<div
			className="flex flex-wrap items-center gap-1.5 border-b border-edge px-3 py-1.5"
			data-testid="mail-filter-chips"
		>
			<span className="text-xs font-semibold tracking-wide text-ink-4">筛选</span>
			{active.map((chip) => (
				<button
					key={chip.label}
					type="button"
					onClick={chip.remove}
					aria-label={`移除筛选：${chip.label}`}
					className="inline-flex min-h-7 items-center gap-1 rounded-full border border-coral/40 bg-coral-bg px-2.5 text-xs text-coral-2 transition-colors hover:border-coral hover:text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{chip.label}
					<XIcon size={10} weight="bold" aria-hidden="true" />
				</button>
			))}
			<button
				type="button"
				onClick={clearMailFilters}
				data-testid="mail-filter-chips-clear"
				className="ml-1 inline-flex min-h-7 items-center rounded-md px-1.5 text-xs text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				清除
			</button>
		</div>
	);
}
