// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";

export type JobFileKind = "csv" | "xls" | "pdf" | "txt" | "image" | "file";

export interface JobProgress {
	/** Processed count, e.g. 568. */
	done?: number;
	/** Total count, e.g. 1240. Shown as “568 / 1,240 项”. */
	total?: number;
	/** 0–100. Omit for uncountable work (indeterminate bar). */
	percent?: number;
	/** Preformatted remaining time, e.g. “约 2 秒”. Omit while estimating. */
	eta?: string;
}

export interface Job {
	id: string;
	/** Card title while running, e.g. “正在导入 tasks.csv”. */
	title: string;
	/** Optional filename — picks the tile icon and appends to the title line. */
	fileName?: string;
	/** Icon family for the file tile. Default "file". */
	fileKind?: JobFileKind;
	progress: JobProgress;
	/** Set when the job finished — the card swaps to its done state. */
	done?: boolean;
	/** Final card title once complete, e.g. “已导入 1,240 项任务”. */
	doneTitle?: string;
	/** Final sub line once complete, e.g. “已加入 Backlog”. */
	doneDetail?: string;
	/** Called when the card body is activated (card opens what it is about). */
	onOpen?: () => void;
	/** Called when the hover close mark is used while the job is running. */
	onCancel?: () => void;
}

interface JobStoreState {
	jobs: Record<string, Job>;
	upsertJob: (job: Job) => void;
	completeJob: (id: string, doneTitle: string, doneDetail?: string) => void;
	dismissJob: (id: string) => void;
}

/**
 * Cross-page persistent jobs shown by `<JobCenter />` (mounted in root).
 * Producers keep calling `upsertJob` as counts move; `completeJob` swaps the
 * card to its done state in place — the card stays until the user opens or
 * dismisses it. Navigating away never cancels a job: state lives here, not in
 * the route.
 */
export const useJobStore = create<JobStoreState>((set) => ({
	jobs: {},
	upsertJob: (job) => set((state) => ({ jobs: { ...state.jobs, [job.id]: job } })),
	completeJob: (id, doneTitle, doneDetail) =>
		set((state) => {
			const job = state.jobs[id];
			if (!job) return state;
			return {
				jobs: {
					...state.jobs,
					[id]: {
						...job,
						done: true,
						title: doneTitle,
						doneTitle,
						doneDetail,
						progress: { ...job.progress, percent: 100 },
					},
				},
			};
		}),
	dismissJob: (id) =>
		set((state) => {
			const jobs = { ...state.jobs };
			delete jobs[id];
			return { jobs };
		}),
}));
