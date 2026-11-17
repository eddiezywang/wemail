// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	CheckIcon,
	FileCsvIcon,
	FileImageIcon,
	FilePdfIcon,
	FileTextIcon,
	FileXlsIcon,
	FileIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { zhCN } from "~/copy/zh-CN";
import { useJobStore, type Job, type JobFileKind } from "~/hooks/useJobStore";
import { cn } from "~/lib/cn";

const FILE_KIND_ICONS: Record<JobFileKind, typeof FileIcon> = {
	csv: FileCsvIcon,
	xls: FileXlsIcon,
	pdf: FilePdfIcon,
	txt: FileTextIcon,
	image: FileImageIcon,
	file: FileIcon,
};

function formatCountLine(job: Job): string {
	const { done, total, eta } = job.progress;
	const parts: string[] = [];
	if (typeof done === "number") {
		parts.push(
			typeof total === "number"
				? `${done.toLocaleString()} / ${total.toLocaleString()} 项`
				: `${done.toLocaleString()} 项`,
		);
	}
	parts.push(eta ?? zhCN.waits.jobEstimating);
	return parts.join(" · ");
}

/** Two-line word swap: old words blur out over 160ms, new ones in over 420ms. */
function WordSwap({ text }: { text: string }) {
	const [current, setCurrent] = useState(text);
	const [leaving, setLeaving] = useState<string | null>(null);

	useEffect(() => {
		if (text === current) return;
		setLeaving(current);
		setCurrent(text);
	}, [text]);

	useEffect(() => {
		if (!leaving) return;
		const timer = window.setTimeout(() => setLeaving(null), 160);
		return () => window.clearTimeout(timer);
	}, [leaving]);

	return (
		<span className="relative block h-5 overflow-hidden">
			{leaving ? (
				<span key={leaving} aria-hidden="true" className="wm-word-out absolute inset-0 truncate">
					{leaving}
				</span>
			) : null}
			<span key={current} className={cn("block truncate", leaving && "wm-word-in")}>
				{current}
			</span>
		</span>
	);
}

function JobCard({ job }: { job: Job }) {
	const dismissJob = useJobStore((state) => state.dismissJob);
	const isDone = job.done === true;
	const percent = job.progress.percent;
	const Icon = FILE_KIND_ICONS[job.fileKind ?? "file"];

	return (
		<div
			role="status"
			aria-live="polite"
			data-testid="job-center-card"
			data-state={isDone ? "done" : "running"}
			className="wm-job-enter group relative w-[344px] cursor-pointer rounded-[24px] border border-edge bg-paper-2 p-3.5 pr-4 shadow-[var(--shadow-3)]"
			onClick={() => {
				dismissJob(job.id);
				job.onOpen?.();
			}}
		>
			<div className="flex items-center gap-3">
				<span
					aria-hidden="true"
					className={cn(
						"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-[420ms]",
						isDone ? "bg-green text-paper" : "bg-paper-3 text-ink-2",
					)}
				>
					{isDone ? (
						<CheckIcon size={18} weight="bold" />
					) : (
						<Icon size={18} weight="duotone" />
					)}
				</span>
				<span className="min-w-0 flex-1">
					<WordSwap text={job.title} />
					<span className="block text-xs leading-5 text-ink-3">
						<WordSwap text={isDone ? (job.doneDetail ?? zhCN.waits.jobDone) : formatCountLine(job)} />
					</span>
				</span>
			</div>
			<div
				aria-hidden={isDone || undefined}
				className={cn(
					"overflow-hidden transition-all duration-[180ms]",
					isDone ? "mt-0 h-0" : "mt-2.5 h-1",
				)}
			>
				<div className="h-full w-full overflow-hidden rounded-full bg-coral/10">
					{typeof percent === "number" ? (
						<div
							role="progressbar"
							aria-label={job.title}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(percent)}
							className="h-full rounded-full bg-coral transition-[width] duration-[420ms]"
							style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
						/>
					) : (
						<div className="wm-job-indeterminate h-full w-1/3 rounded-full bg-coral" />
					)}
				</div>
			</div>
			<button
				type="button"
				data-testid="job-center-close"
				aria-label={isDone ? zhCN.waits.jobDismiss : zhCN.waits.jobCancel}
				className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-edge bg-paper text-ink-3 opacity-0 shadow-[var(--shadow-2)] transition-opacity hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
				onClick={(event) => {
					event.stopPropagation();
					if (!isDone && job.onCancel) job.onCancel();
					dismissJob(job.id);
				}}
			>
				<XIcon size={12} weight="bold" />
			</button>
		</div>
	);
}

/**
 * Persistent top-right job cards for long countable work that continues
 * across pages. Fixed below the draggable titlebar; entrance drops 56px out
 * of a 4px blur from 96% over 420ms (`.wm-job-enter`). Done cards stay until
 * opened or dismissed; closing a running card cancels it via `onCancel`.
 */
export function JobCenter() {
	const jobs = useJobStore((state) => state.jobs);
	const entries = Object.values(jobs);
	if (entries.length === 0) return null;
	return (
		<div data-testid="job-center" className="pointer-events-none fixed right-4 top-12 z-40 flex flex-col items-end gap-2">
			{entries.map((job) => (
				<div key={job.id} className="pointer-events-auto">
					<JobCard job={job} />
				</div>
			))}
		</div>
	);
}
