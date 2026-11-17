// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobCenter } from "./JobCenter";
import { useJobStore } from "~/hooks/useJobStore";

function resetStore() {
	useJobStore.setState({ jobs: {} });
}

// Store mutations after mount must flush through act() so assertions see
// the re-render.
describe("JobCenter", () => {
	beforeEach(resetStore);

	it("renders nothing when no jobs exist", () => {
		render(<JobCenter />);
		expect(screen.queryByTestId("job-center")).not.toBeInTheDocument();
	});

	it("shows a running card with count line, percent bar and ETA", () => {
		act(() => {
			useJobStore.getState().upsertJob({
				id: "import",
				title: "正在导入 tasks.csv",
				fileName: "tasks.csv",
				fileKind: "csv",
				progress: { done: 568, total: 1240, percent: 46, eta: "约 2 秒" },
			});
		});
		render(<JobCenter />);

		const card = screen.getByTestId("job-center-card");
		expect(card).toHaveAttribute("data-state", "running");
		expect(card).toHaveTextContent("正在导入 tasks.csv");
		expect(card).toHaveTextContent("568 / 1,240 项");
		expect(card).toHaveTextContent("约 2 秒");
		const bar = screen.getByRole("progressbar", { name: "正在导入 tasks.csv" });
		expect(bar).toHaveAttribute("aria-valuenow", "46");
	});

	it("keeps counting while the producer streams progress (store mirror)", () => {
		render(<JobCenter />);
		act(() => {
			useJobStore.getState().upsertJob({ id: "import", title: "正在导入 tasks.csv", progress: {} });
		});
		expect(screen.getByTestId("job-center-card")).toHaveTextContent("剩余时间估算中…");

		act(() => {
			useJobStore.getState().upsertJob({
				id: "import",
				title: "正在导入 tasks.csv",
				progress: { done: 900, total: 1240, percent: 73 },
			});
		});
		expect(screen.getByTestId("job-center-card")).toHaveTextContent("900 / 1,240 项");
	});

	it("swaps to the done state in place and keeps the card until dismissed", () => {
		render(<JobCenter />);
		act(() => {
			useJobStore.getState().upsertJob({ id: "import", title: "正在导入 tasks.csv", progress: {} });
		});
		act(() => {
			useJobStore.getState().completeJob("import", "已导入 1,240 项任务", "已加入 Backlog");
		});
		const card = screen.getByTestId("job-center-card");
		expect(card).toHaveAttribute("data-state", "done");
		expect(card).toHaveTextContent("已导入 1,240 项任务");
		expect(card).toHaveTextContent("已加入 Backlog");
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		// Done cards stay: no auto-dismiss.
		expect(screen.getByTestId("job-center-card")).toBeInTheDocument();
	});

	it("closing a running card cancels it; closing a done card just dismisses", () => {
		const onCancel = vi.fn();
		render(<JobCenter />);
		act(() => {
			useJobStore.getState().upsertJob({ id: "j1", title: "正在标记全部已读", progress: {}, onCancel });
		});
		fireEvent.click(screen.getByTestId("job-center-close"));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("job-center-card")).not.toBeInTheDocument();

		act(() => {
			useJobStore.getState().upsertJob({ id: "j2", title: "running", progress: {} });
			useJobStore.getState().completeJob("j2", "完成");
		});
		fireEvent.click(screen.getByTestId("job-center-close"));
		expect(onCancel).toHaveBeenCalledTimes(1); // not called again for done jobs
	});

	it("opens what the card is about and removes it on click", () => {
		const onOpen = vi.fn();
		render(<JobCenter />);
		act(() => {
			useJobStore.getState().upsertJob({ id: "j1", title: "任务", progress: {}, doneTitle: "完成", onOpen });
		});
		fireEvent.click(screen.getByTestId("job-center-card"));
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("job-center-card")).not.toBeInTheDocument();
	});
});
