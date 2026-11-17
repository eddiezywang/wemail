// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cn } from "~/lib/cn";

export type TraceEntryKind = "command" | "status" | "output" | "error";

export interface TraceEntry {
	kind: TraceEntryKind;
	text: string;
	timestamp?: string | Date;
}

export interface TraceProps {
	entries: TraceEntry[];
	className?: string;
}

function formatTimestamp(ts: string | Date): string {
	if (typeof ts === "string") return ts;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
}

/**
 * Trace — terminal-style log surface for ops/agent activity.
 *
 * Rendering rules:
 * - command rows are prefixed with `$ `
 * - status rows show `[HH:MM:SS]` when a timestamp is provided
 * - error rows are tinted via `text-red` AND `data-status="failed"`
 * - all rows wrap long lines (`whitespace-pre-wrap break-words`)
 *
 * Uses the WeMail `font-mono-meta` token (JetBrains Mono / SF Mono fallback
 * chain defined in `app/styles/tokens.css`).
 */
export function Trace({ entries, className }: TraceProps) {
	return (
		<div
			data-testid="trace"
			className={cn(
				"font-mono-meta text-xs leading-relaxed",
				"rounded-md bg-[var(--color-term-bg)] text-[var(--color-term-fg)]",
				"px-3 py-2",
				className,
			)}
		>
			{entries.map((entry, i) => {
				const isFailure = entry.kind === "error";
				const tint =
					entry.kind === "error"
						? "text-red"
						: entry.kind === "status"
							? "text-amber"
							: entry.kind === "command"
								? "text-[var(--color-term-run)]"
								: "text-[var(--color-term-fg)]";
				const prefix = entry.kind === "command" ? "$ " : "";
				const ts = entry.timestamp
					? `[${formatTimestamp(entry.timestamp)}] `
					: "";
				return (
					<div
						key={`${i}-${entry.kind}`}
						data-status={isFailure ? "failed" : entry.kind}
						className={cn(
							"whitespace-pre-wrap break-words",
							tint,
						)}
					>
						{ts}
						{prefix}
						{entry.text}
					</div>
				);
			})}
		</div>
	);
}

export default Trace;
