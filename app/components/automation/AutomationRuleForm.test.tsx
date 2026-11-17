// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationRuleForm } from "./AutomationRuleForm";

const mocks = vi.hoisted(() => ({
	...(() => {
		vi.resetModules();
		return {};
	})(),
	createMutateAsync: vi.fn(),
	updateMutateAsync: vi.fn(),
	previewMutateAsync: vi.fn(),
	commitMutateAsync: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("~/queries/automationRules", () => ({
	useCreateAutomationRule: () => ({
		mutateAsync: mocks.createMutateAsync,
		isPending: false,
	}),
	useUpdateAutomationRule: () => ({
		mutateAsync: mocks.updateMutateAsync,
		isPending: false,
	}),
	usePreviewAutomationRule: () => ({ mutateAsync: mocks.previewMutateAsync, isPending: false }),
	useCommitAutomationRule: () => ({ mutateAsync: mocks.commitMutateAsync, isPending: false }),
}));

vi.mock("sonner", () => ({
	toast: {
		error: mocks.toastError,
		success: vi.fn(),
	},
}));

const contributions = vi.hoisted(() => ({ enabled: false, fail: false }));
vi.mock("~/services/api", () => ({ default: {
	getAutomationFormContributions: async () => {
		if (contributions.fail) throw new Error("unavailable");
		return { contributions: {
		processors: [], externalActions: contributions.enabled
			? [{ label: "外部任务", action: { type: "external", adapter: "example.action", input: {} } }] : [],
	} };
	},
	listChannelProfiles: async () => ({ profiles: [] }),
} }));

describe("AutomationRuleForm", () => {
	beforeEach(() => {
		mocks.createMutateAsync.mockReset();
		mocks.updateMutateAsync.mockReset();
		mocks.previewMutateAsync.mockReset();
		mocks.commitMutateAsync.mockReset();
		mocks.toastError.mockReset();
		contributions.enabled = false;
		contributions.fail = false;
	});

	it("requires either a natural language rule or a structured condition", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();

		render(
			<AutomationRuleForm
				open
				onOpenChange={onOpenChange}
				accountId="acct-1"
			/>,
		);

		await user.type(
			screen.getByPlaceholderText("例如：GitHub 通知归档"),
			"Only action",
		);
		await user.click(screen.getByRole("button", { name: "加星标" }));
		await user.click(screen.getByRole("button", { name: "生成预览" }));

		expect(mocks.toastError).toHaveBeenCalledWith(
			"至少填写自然语言规则或条件规则",
		);
		expect(mocks.createMutateAsync).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("discards a preview returned after the rule changes", async () => {
		let resolvePreview!: (value: unknown) => void;
		mocks.previewMutateAsync.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
		const user = userEvent.setup();
		render(<AutomationRuleForm open onOpenChange={vi.fn()} accountId="acct-1" />);
		await user.type(screen.getByPlaceholderText("例如：GitHub 通知归档"), "旧名称");
		await user.type(screen.getByPlaceholderText("例如：需要我今天回复的客户邮件"), "需要关注");
		await user.click(screen.getByRole("button", { name: "加星标" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "生成预览" })).toBeEnabled());
		await user.click(screen.getByRole("button", { name: "生成预览" }));
		await user.type(screen.getByPlaceholderText("例如：GitHub 通知归档"), "新内容");
		await act(async () => resolvePreview({ preview: { matchedCount: 0, plannedProcessors: [], plannedActions: [], warnings: [] } }));
		expect(screen.queryByText("保存前预览")).not.toBeInTheDocument();
		expect(mocks.commitMutateAsync).not.toHaveBeenCalled();
	});

	it("defaults to the focused natural-language creation mode", async () => {
		const user = userEvent.setup();
		const onNaturalLanguageCreate = vi.fn();

		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
				initialMode="natural"
				onNaturalLanguageCreate={onNaturalLanguageCreate}
			/>,
		);

		expect(screen.getByRole("tab", { name: "对话创建" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.queryByPlaceholderText("例如：GitHub 通知归档")).not.toBeInTheDocument();

		await user.type(
			screen.getByLabelText("你希望 WeMail 自动做什么？"),
			"每天早上九点整理重要邮件，没有待办时静默",
		);
		await user.click(screen.getByRole("button", { name: "交给 Agent 创建" }));

		expect(onNaturalLanguageCreate).toHaveBeenCalledWith(
			"每天早上九点整理重要邮件，没有待办时静默",
		);
	});

	it("keeps ordinary configuration as a separate mode", async () => {
		const user = userEvent.setup();

		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
				initialMode="natural"
				onNaturalLanguageCreate={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("tab", { name: "普通配置" }));

		expect(screen.getByPlaceholderText("例如：GitHub 通知归档")).toBeInTheDocument();
		expect(screen.getByText("触发")).toBeInTheDocument();
		expect(screen.getByText("动作")).toBeInTheDocument();
		expect(screen.queryByLabelText("你希望 WeMail 自动做什么？")).not.toBeInTheDocument();
	});

	it("keeps the scheduled scan range visible for both processing modes", async () => {
		const user = userEvent.setup();
		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
			/>,
		);

		await user.click(screen.getByRole("button", { name: "定时" }));
		expect(screen.getByLabelText("时间范围")).toHaveTextContent("上次成功执行至今");
		expect(screen.getByLabelText("最长回看小时数")).toHaveValue("24");

		await user.click(screen.getByRole("button", { name: "归集后通知" }));
		expect(screen.getByLabelText("时间范围")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "逐封处理" }));
		expect(screen.getByLabelText("时间范围")).toBeInTheDocument();
	});

	it("hides external actions when no edition contributes them", () => {

		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
			/>,
		);

		expect(screen.queryByRole("button", { name: "外部任务" })).not.toBeInTheDocument();
	});

	it("prevents saving while edition options are unavailable and allows retry", async () => {
		contributions.fail = true;
		render(<AutomationRuleForm open onOpenChange={vi.fn()} accountId="acct-1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("自动化选项加载失败");
		expect(screen.getByRole("button", { name: "生成预览" })).toBeDisabled();
		contributions.fail = false;
		await userEvent.click(screen.getByRole("button", { name: "重试" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "生成预览" })).toBeEnabled());
	});

	it("shows unavailable legacy actions and requires explicit removal", async () => {
		render(<AutomationRuleForm open onOpenChange={vi.fn()} accountId="acct-1" editing={{
			id: "rule-1", accountId: "acct-1", name: "旧规则", enabled: true,
			trigger: { type: "mailReceived" }, conditions: { sender: "example" },
			actions: [{ type: "external", adapter: "edition.action", input: {} }],
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		}} />);
		expect(await screen.findByText(/当前版本不可用的动作或处理器/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "移除不可用动作" }));
		expect(screen.queryByText(/当前版本不可用的动作或处理器/)).not.toBeInTheDocument();
	});

	it("offers edition-contributed external actions", async () => {
		const user = userEvent.setup();
		contributions.enabled = true;

		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
			/>,
		);

		const toggle = await screen.findByRole("button", { name: "外部任务" });
		expect(toggle).toHaveClass("bg-paper-2");
		await user.click(toggle);
		expect(toggle).toHaveClass("bg-coral");
		await user.click(toggle);
		expect(toggle).toHaveClass("bg-paper-2");
	});
});
