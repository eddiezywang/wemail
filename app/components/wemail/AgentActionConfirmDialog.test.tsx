// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentActionConfirmDialog from "./AgentActionConfirmDialog";

describe("AgentActionConfirmDialog", () => {
	it("does not show the dialog when open=false", () => {
		render(
			<AgentActionConfirmDialog
				open={false}
				title="t"
				description="d"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders a dialog with title and description when open=true", () => {
		render(
			<AgentActionConfirmDialog
				open
				title="Proceed?"
				description="This cannot be undone."
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-confirm-title")).toHaveTextContent(
			"Proceed?",
		);
		expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-confirm-cancel")).toHaveFocus();
	});

	it("fires onConfirm when the confirm button is clicked", async () => {
		const user = userEvent.setup();
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(
			<AgentActionConfirmDialog
				open
				title="Proceed?"
				description="..."
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		await user.click(screen.getByTestId("wemail-confirm-confirm"));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("marks the dangerous variant distinctly via data-dangerous attribute", () => {
		const { rerender } = render(
			<AgentActionConfirmDialog
				open
				title="t"
				description="d"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(screen.getByTestId("wemail-confirm-dialog")).toHaveAttribute(
			"data-dangerous",
			"false",
		);
		rerender(
			<AgentActionConfirmDialog
				open
				dangerous
				title="t"
				description="d"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(screen.getByTestId("wemail-confirm-dialog")).toHaveAttribute(
			"data-dangerous",
			"true",
		);
	});

	it("blocks dismissal while work is running, then exposes a terminal result", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		const { rerender } = render(
			<AgentActionConfirmDialog
				open
				title="WeCLI 安装"
				description="可选组件安装流程"
				onConfirm={() => {}}
				onCancel={onCancel}
				feedback={{
					status: "running",
					title: "正在安装 WeCLI",
					description: "安装命令正在执行。",
					progressText: "已等待 7 秒 · 最长等待 120 秒",
				}}
			/>,
		);

		expect(screen.getByTestId("wemail-confirm-dialog")).toHaveAttribute(
			"data-phase",
			"running",
		);
		expect(screen.getByText("已等待 7 秒 · 最长等待 120 秒")).toBeInTheDocument();
		expect(screen.queryByTestId("wemail-confirm-confirm")).toBeNull();
		expect(screen.queryByTestId("wemail-confirm-cancel")).toBeNull();
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

		await user.keyboard("{Escape}");
		expect(onCancel).not.toHaveBeenCalled();

		rerender(
			<AgentActionConfirmDialog
				open
				title="WeCLI 安装"
				description="可选组件安装流程"
				onConfirm={() => {}}
				onCancel={onCancel}
				feedback={{
					status: "success",
					title: "WeCLI 安装成功",
					description: "请回到对话重新执行刚才的请求。",
					closeLabel: "返回对话",
				}}
			/>,
		);

		expect(screen.getByTestId("wemail-confirm-dialog")).toHaveAttribute(
			"data-phase",
			"success",
		);
		await user.click(screen.getByRole("button", { name: "返回对话" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("shows selectable failure diagnostics", () => {
		render(
			<AgentActionConfirmDialog
				open
				title="WeCLI 安装"
				description="可选组件安装流程"
				onConfirm={() => {}}
				onCancel={() => {}}
				feedback={{
					status: "error",
					title: "WeCLI 安装失败",
					description: "请检查网络。",
					detail: "退出码：1\nnpm ERR! registry unavailable",
				}}
			/>,
		);

		expect(screen.getByTestId("wemail-confirm-feedback-detail")).toHaveClass(
			"select-text",
		);
		expect(screen.getByText(/registry unavailable/)).toBeInTheDocument();
	});
});
