import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter";
import { ApiError } from "~/services/api";
import { StructuredAutomationEditorDialog } from "./StructuredAutomationEditorDialog";

const mocks = vi.hoisted(() => ({
	getDraft: vi.fn(),
	patchDraft: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("~/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("~/services/api")>();
	return {
		...actual,
		default: {
			patchUnifiedAutomationDraft: mocks.patchDraft,
			getUnifiedAutomationDraft: mocks.getDraft,
		},
	};
});

vi.mock("sonner", () => ({
	toast: {
		success: mocks.success,
		error: mocks.error,
	},
}));

const draft: ExecutionPipelineDraft = {
	id: "draft-1",
	accountId: "acct-1",
	accountScope: { type: "currentAccount", accountId: "acct-1" },
	revision: 4,
	mode: "automation",
	trigger: {
		event: "schedule",
		timing: { type: "daily", localTime: "21:00", timezone: "Asia/Shanghai" },
	},
	dataSelection: {
		version: 1,
		source: "mail",
		scope: {
			type: "previous_schedule_window",
			maxLookback: { amount: 24, unit: "hour" },
		},
		filters: [],
		limits: { maxMessages: 400 },
	},
	analysis: {
		version: 1,
		inputKinds: ["mail-collection"],
		dimensions: [],
		metrics: [],
		modelTasks: [
			{
				id: "summary",
				instruction: "整理告警并提炼趋势",
				outputFields: ["summary"],
				maxInputItems: 400,
			},
		],
		conclusions: [],
		outputSchema: { type: "object" },
	},
	artifact: {
		version: 1,
		format: "html",
		title: "银行电销平台日报",
		components: [{
			id: "trend",
			type: "line_chart",
			title: "告警趋势",
			binding: { xField: "hour", valueField: "requestCount" },
		}],
		layout: { structure: "single-column", sections: ["content"] },
		theme: { name: "wemail" },
		accessibility: { includeTextSummary: true, chartDescriptions: true },
		emptyState: "今日没有告警",
		errorState: "日报生成失败",
		outputSchema: { type: "object" },
	},
	delivery: {
		version: 1,
		destinations: [
			{ type: "message_center", enabled: true },
			{ type: "connected_bot", enabled: true },
		],
		content: {
			includeSummary: true,
			includeImage: false,
			includeArtifactLink: true,
		},
		fallbackPolicy: { type: "all_available", messageCenterRequired: true },
	},
	advancedPolicy: {
		name: "自动化",
		description: "每天整理电销平台监控邮件",
		retentionDays: 30,
	},
	steps: [
		{
			id: "analyze",
			capabilityId: "analysis.monitoringReport",
			input: { messages: { type: "path", from: "collection", path: "messages" } },
			outputKind: "dataset",
			onError: { policy: "stop", retries: 0 },
		},
		{
			id: "render",
			capabilityId: "output.render",
			input: { dataset: { type: "path", from: "step", stepId: "analyze", path: "" } },
			outputKind: "artifact-reference",
			onError: { policy: "stop", retries: 0 },
		},
	],
	skillSnapshots: [],
	capabilitySnapshots: [],
	reviews: [
		{
			id: "artifact-review",
			target: "artifact",
			policy: "required",
			status: "stale",
			draftRevision: 4,
			targetVersion: 2,
			contentHash: "hash",
			previewUrl: "/api/previews/artifact-review",
			dependsOn: ["analysis"],
		},
	],
	validation: { status: "not_validated", issues: [] },
	createdAt: "2026-07-30T00:00:00.000Z",
	updatedAt: "2026-07-30T01:00:00.000Z",
};

describe("StructuredAutomationEditorDialog", () => {
	beforeEach(() => vi.clearAllMocks());

	it("saves a typed patch against the current revision without enabling the rule", async () => {
		const user = userEvent.setup();
		const changed = { ...draft, revision: 5 };
		mocks.patchDraft.mockResolvedValue({
			ok: true,
			draft: changed,
			interaction: { message: "预览需要重新确认" },
		});
		const onDraftChange = vi.fn();

		render(
			<StructuredAutomationEditorDialog
				accountId="acct-1"
				draft={draft}
				open
				onOpenChange={vi.fn()}
				onDraftChange={onDraftChange}
				onAskAgent={vi.fn()}
				automationName="邮箱速览"
			/>,
		);

		expect(screen.getByText("编辑邮箱速览")).toBeInTheDocument();
		expect(screen.getByLabelText("名称")).toHaveValue("邮箱速览");
		expect(screen.getByText("什么时候执行")).toBeInTheDocument();
		expect(screen.getByText("产出什么")).toBeInTheDocument();
		expect(screen.getByText("发送到哪里")).toBeInTheDocument();
		expect(screen.getByText("读取哪些邮件")).toBeInTheDocument();
		expect(screen.getByLabelText("邮件时间范围")).toHaveTextContent(
			"上次成功执行后，最多回看指定时长",
		);
		expect(screen.queryByText("本次收到的邮件")).not.toBeInTheDocument();
		// Field wraps its unit hint inside the <label>, so match on the
		// leading label text rather than the whole label content.
		expect(screen.getByLabelText(/^最长回看时间/)).toHaveValue(24);
		expect(screen.getByLabelText(/^最多处理邮件/)).toHaveValue(400);
		expect(screen.getByText("每天 21:00 运行，读取上次成功执行后的邮件，最多回看 24 小时，最多处理 400 封。")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "发布到消息中心" })).toBeChecked();
		expect(screen.getByText(/保存后需要重新确认结果预览/)).toBeInTheDocument();
		expect(screen.queryByText("数据与分析")).not.toBeInTheDocument();
		expect(screen.queryByText("高级配置")).not.toBeInTheDocument();
		expect(screen.queryByText("最终确认摘要")).not.toBeInTheDocument();
		expect(screen.getByTestId("automation-editor-scroll-region")).toHaveClass(
			"overflow-y-auto",
		);
		await user.clear(screen.getByLabelText("名称"));
		await user.type(screen.getByLabelText("名称"), "新版监控日报");
		await user.clear(screen.getByLabelText("生成规则（提示词）"));
		await user.type(
			screen.getByLabelText("生成规则（提示词）"),
			"生成带趋势图的 HTML 日报",
		);
		await user.click(screen.getByRole("button", { name: "保存草稿" }));

		await waitFor(() => expect(mocks.patchDraft).toHaveBeenCalledTimes(1));
		const [draftId, accountId, patch] = mocks.patchDraft.mock.calls[0];
		expect(draftId).toBe("draft-1");
		expect(accountId).toBe("acct-1");
		expect(patch).toMatchObject({
			expectedRevision: 4,
			name: "新版监控日报",
			accountScope: { type: "currentAccount", accountId: "acct-1" },
			trigger: {
				event: "schedule",
				timing: { type: "daily", localTime: "21:00", timezone: "Asia/Shanghai" },
			},
		});
		expect(patch).not.toHaveProperty("enabled");
		expect(patch.dataSelection.limits.maxMessages).toBe(400);
		expect(patch.dataSelection.scope).toEqual({
			type: "previous_schedule_window",
			maxLookback: { amount: 24, unit: "hour" },
		});
		expect(patch.analysis.modelTasks[0].instruction).toBe(
			"生成带趋势图的 HTML 日报",
		);
		expect(patch.steps.map((step: ExecutionPipelineDraft["steps"][number]) => step.capabilityId)).toEqual([
			"analysis.monitoringReport",
			"analysis.recipeExecute",
			"output.render",
		]);
		expect(patch.steps[2].input.dataset).toMatchObject({
			from: "step",
			stepId: "analysis-recipe",
		});
		expect(patch.advancedPolicy).toMatchObject({
			modelPolicy: "default",
			catchUpPolicy: "skip",
			retentionDays: 30,
		});
		expect(onDraftChange).toHaveBeenCalledWith(changed);
		expect(screen.getByText("预览需要重新确认")).toBeInTheDocument();
	});

	it("uses only the triggering email for mail-received rules", async () => {
		const user = userEvent.setup();
		mocks.patchDraft.mockResolvedValue({
			ok: true,
			draft: { ...draft, revision: 5 },
		});

		render(
			<StructuredAutomationEditorDialog
				accountId="acct-1"
				draft={{
					...draft,
					trigger: { event: "mail.received", timing: { type: "immediate" } },
				}}
				open
				onOpenChange={vi.fn()}
				onDraftChange={vi.fn()}
				onAskAgent={vi.fn()}
				automationName="新邮件处理"
			/>,
		);

		expect(screen.getByText("收到一封匹配邮件时，使用该邮件启动本次自动化。")).toBeInTheDocument();
		expect(screen.getByText("数据来源")).toBeInTheDocument();
		expect(screen.getByText("本次收到的邮件")).toBeInTheDocument();
		expect(screen.getByText("每封匹配邮件会分别触发一次，不读取其他邮件，也不使用时间窗口。")).toBeInTheDocument();
		expect(screen.queryByLabelText("邮件时间范围")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("最长回看时间")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "保存草稿" }));

		await waitFor(() => expect(mocks.patchDraft).toHaveBeenCalledTimes(1));
		const patch = mocks.patchDraft.mock.calls[0][2];
		expect(patch.dataSelection).toEqual({
			version: 1,
			source: "mail",
			scope: { type: "current_mail", emailId: "$trigger.mail.emailId" },
			filters: [],
			limits: { maxMessages: 1 },
		});
	});

	it("explains the saved data range for manual runs", () => {
		render(
			<StructuredAutomationEditorDialog
				accountId="acct-1"
				draft={{ ...draft, trigger: { event: "manual", timing: { type: "immediate" } } }}
				open
				onOpenChange={vi.fn()}
				onDraftChange={vi.fn()}
				onAskAgent={vi.fn()}
			/>,
		);

		expect(screen.getByText("手动运行时沿用当前保存的数据范围。如需调整时间范围，请先切换为定时触发。")).toBeInTheDocument();
		expect(screen.queryByLabelText("邮件时间范围")).not.toBeInTheDocument();
	});

	it("does not overwrite a newer draft and can reload the latest revision", async () => {
		const user = userEvent.setup();
		const latest = { ...draft, revision: 7, updatedAt: "2026-07-30T03:00:00.000Z" };
		mocks.patchDraft.mockRejectedValue(
			new ApiError(409, {
				error: "draft_revision_conflict",
				conflict: {
					currentRevision: 7,
					changedSections: ["analysis", "delivery"],
					updatedAt: latest.updatedAt,
				},
			}),
		);
		mocks.getDraft.mockResolvedValue({ ok: true, draft: latest });
		const onDraftChange = vi.fn();

		render(
			<StructuredAutomationEditorDialog
				accountId="acct-1"
				draft={draft}
				open
				onOpenChange={vi.fn()}
				onDraftChange={onDraftChange}
				onAskAgent={vi.fn()}
				automationName="邮箱速览"
			/>,
		);

		await user.click(screen.getByRole("button", { name: "保存草稿" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("分析");
		expect(screen.getByRole("alert")).toHaveTextContent("投递");
		expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "重新载入最新版本" }));
		await waitFor(() => expect(mocks.getDraft).toHaveBeenCalledWith("draft-1", "acct-1"));
		expect(onDraftChange).toHaveBeenCalledWith(latest);
	});

	it("hands the same draft back to the Agent for natural-language refinement", async () => {
		const user = userEvent.setup();
		const onAskAgent = vi.fn();
		render(
			<StructuredAutomationEditorDialog
				accountId="acct-1"
				draft={draft}
				open
				onOpenChange={vi.fn()}
				onDraftChange={vi.fn()}
				onAskAgent={onAskAgent}
				automationName="邮箱速览"
			/>,
		);

		await user.click(screen.getByRole("button", { name: "用自然语言继续调整" }));
		expect(onAskAgent).toHaveBeenCalledTimes(1);
	});
});
