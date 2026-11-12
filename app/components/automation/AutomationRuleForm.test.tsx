// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
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

// P2.6: the structured allowance upload step is an edition module capability;
// the toggle must render only behind `features.allowanceInvoice`.
const editionFeatures = vi.hoisted(() => ({ allowanceInvoice: false }));

vi.mock("~/hooks/useEditionFeatures", () => ({
	useEditionFeatures: () => ({
		wecli: false,
		allowanceInvoice: editionFeatures.allowanceInvoice,
		enterpriseDirectory: false,
		officeSceneDetection: false,
	}),
}));

describe("AutomationRuleForm", () => {
	beforeEach(() => {
		mocks.createMutateAsync.mockReset();
		mocks.updateMutateAsync.mockReset();
		mocks.previewMutateAsync.mockReset();
		mocks.commitMutateAsync.mockReset();
		mocks.toastError.mockReset();
		editionFeatures.allowanceInvoice = false;
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

	it("hides the allowance upload toggle outside the allowance edition", () => {
		editionFeatures.allowanceInvoice = false;

		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
			/>,
		);

		expect(screen.queryByRole("button", { name: "wecli 上传月度发票" })).not.toBeInTheDocument();
	});

	it("offers the allowance upload toggle only behind the allowance feature", async () => {
		const user = userEvent.setup();
		editionFeatures.allowanceInvoice = true;

		render(
			<AutomationRuleForm
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
			/>,
		);

		const toggle = screen.getByRole("button", { name: "wecli 上传月度发票" });
		expect(toggle).toHaveClass("bg-paper-2");
		await user.click(toggle);
		expect(toggle).toHaveClass("bg-coral");
		await user.click(toggle);
		expect(toggle).toHaveClass("bg-paper-2");
	});
});
