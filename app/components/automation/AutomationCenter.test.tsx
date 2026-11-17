import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AutomationDetail,
	AutomationListItem,
} from "../../../shared/wemail/automationCenter";
import { useUIStore } from "~/hooks/useUIStore";
import { AutomationCenter } from "./AutomationCenter";

const mocks = vi.hoisted(() => ({
	mutate: vi.fn(),
	mutateAsync: vi.fn(),
	refetch: vi.fn(),
	getAutomationTemplate: vi.fn(),
	previewAutomationTemplate: vi.fn(),
	confirmAutomationTemplate: vi.fn(),
	listError: false,
	detailOverride: undefined as AutomationDetail | undefined,
	automationsOverride: undefined as AutomationListItem[] | undefined,
	templatesOverride: undefined as Array<{
		id: string;
		version: string;
		name: string;
		description: string;
		readiness: "ready" | "needs_setup" | "incompatible";
		readinessMessage?: string;
		installed: boolean;
	}> | undefined,
}));

const run = {
	id: "run-1",
	ruleId: "rule-1",
	ruleVersion: 2,
	owner: { type: "account" as const, accountId: "acct-1" },
	dryRun: false,
	outcome: "succeeded" as const,
	startedAt: new Date().toISOString(),
	completedAt: new Date().toISOString(),
	durationMs: 1_400,
	inputCount: 36,
	resultCount: 1,
	truncated: false,
	deliveries: [
		{ destination: "message_center" as const, status: "succeeded" as const },
	],
	revision: 4,
};

const automation: AutomationListItem = {
	id: "rule-1",
	schemaVersion: 2,
	version: 2,
	owner: { type: "account", accountId: "acct-1" },
	accountScope: { type: "currentAccount", accountId: "acct-1" },
	name: "每日重要邮件摘要",
	description: "只整理需要我处理的重要邮件",
	enabled: true,
	triggerSummary: "每天 10:00",
	workflowSummary: "读取重要邮件并生成摘要",
	deliverySummary: "消息中心 + 桌面通知",
	health: "healthy",
	stages: [
		{ stage: "trigger", label: "触发", summary: "每天 10:00", status: "configured" },
		{ stage: "data", label: "数据", summary: "最近 24 小时 · INBOX", status: "configured" },
		{ stage: "analysis", label: "分析", summary: "生成邮件摘要", status: "configured" },
		{ stage: "artifact", label: "产出", summary: "摘要卡片", status: "configured" },
		{ stage: "delivery", label: "投递", summary: "消息中心 + 桌面通知", status: "configured" },
	],
	nextRunAt: "2026-07-30T02:00:00.000Z",
	latestRun: run,
	latestOutput: {
		type: "application_message",
		id: "message-1",
		title: "每日重要邮件摘要",
		preview: "今天有 3 封邮件需要处理。",
		availability: "available",
	},
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-07-29T00:00:00.000Z",
};

const detail: AutomationDetail = {
	...automation,
	trigger: {
		type: "scheduled",
		schedule: {
			type: "daily",
			localTime: "10:00",
			timezone: "Asia/Shanghai",
		},
	},
	configuration: {
		data: { summary: "最近 24 小时 · INBOX" },
		analysis: { summary: "生成邮件摘要" },
		artifact: { summary: "摘要卡片" },
		delivery: { summary: "消息中心 + 桌面通知" },
	},
	sourceRule: {} as AutomationDetail["sourceRule"],
	recentRuns: [run],
};

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: () => ({
		data: { account: { id: "acct-1", emailAddress: "mail@example.com" } },
	}),
}));

vi.mock("~/queries/automationRules", () => ({
	useUnifiedAutomations: () => ({
		isLoading: false,
		isError: mocks.listError,
		refetch: mocks.refetch,
		data: mocks.listError ? undefined : {
			automations: mocks.automationsOverride ?? [automation],
			recommendedTemplates: mocks.templatesOverride ?? [
				{
					id: "mail-digest",
					version: "1.0.0",
					name: "邮箱速览",
					description: "整理当天的重要邮件",
					readiness: "ready",
					installed: false,
				},
			],
		},
	}),
	useUnifiedAutomationDetail: () => ({
		data: mocks.detailOverride ?? detail,
		isLoading: false,
		isError: false,
		refetch: mocks.refetch,
	}),
	useUnifiedAutomationRunDetail: () => ({ data: undefined, isLoading: false }),
	useSetUnifiedAutomationEnabled: () => ({ mutate: mocks.mutate, isPending: false }),
	useRunUnifiedAutomation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
	useTestUnifiedAutomation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
	useArchiveUnifiedAutomation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
	useDeleteUnifiedAutomation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
	useResumeUnifiedAutomationDraft: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
	useResumeUnifiedAutomationSchedule: () => ({ mutate: mocks.mutate, isPending: false }),
	useRetryUnifiedAutomationStep: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));

vi.mock("~/services/api", () => ({
	default: {
		getAutomationTemplate: mocks.getAutomationTemplate,
		previewAutomationTemplate: mocks.previewAutomationTemplate,
		confirmAutomationTemplate: mocks.confirmAutomationTemplate,
	},
}));

vi.mock("./AutomationRuleForm", () => ({
	AutomationRuleForm: ({ open, initialMode }: { open: boolean; initialMode?: string }) =>
		open ? <div data-testid="automation-create-dialog">{initialMode}</div> : null,
}));

vi.mock("sonner", () => {
	const toast = Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
	});
	return { toast };
});

describe("AutomationCenter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listError = false;
		mocks.detailOverride = undefined;
		mocks.automationsOverride = undefined;
		mocks.templatesOverride = undefined;
		mocks.getAutomationTemplate.mockResolvedValue({
			template: { defaultConfiguration: { localTime: "08:30" } },
		});
		mocks.previewAutomationTemplate.mockResolvedValue({
			preview: { previewId: "template-preview-1", previewHash: "hash-1" },
		});
		mocks.confirmAutomationTemplate.mockResolvedValue({
			automation: { id: "configured-rule-1" },
		});
		useUIStore.setState({
			isAgentPanelOpen: true,
			agentComposerRequest: undefined,
		});
	});

	it("presents a concise schedule-first automation detail", () => {
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		expect(screen.getByTestId("automation-center")).toBeInTheDocument();
		expect(screen.getAllByText("每日重要邮件摘要").length).toBeGreaterThan(0);
		expect(screen.getAllByText("每天 10:00").length).toBeGreaterThan(0);
		expect(screen.getByLabelText("规则配置摘要")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "编辑配置" })).toBeInTheDocument();
		expect(screen.queryByText("工作流")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("自动化执行流程")).not.toBeInTheDocument();
		expect(screen.queryByRole("tab")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "试运行" })).not.toBeInTheDocument();
		expect(screen.getByText("最近运行")).toBeInTheDocument();
		expect(screen.queryByText("说明")).not.toBeInTheDocument();
		expect(
			within(screen.getByTestId("automation-rule-detail")).queryByText(
				automation.description!,
			),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/输入 36/)).not.toBeInTheDocument();
		expect(screen.queryByText(/产出 1/)).not.toBeInTheDocument();
		expect(screen.getByText("已发送至消息中心")).toBeInTheDocument();
		expect(screen.getByText("邮箱速览")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "添加 邮箱速览" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("automation-rule-rule-1")).toHaveAttribute(
			"aria-current",
			"true",
		);
	});

	it("runs immediately without an extra browser confirmation", async () => {
		const confirm = vi.spyOn(window, "confirm");
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		fireEvent.click(screen.getByRole("button", { name: "立即运行" }));

		await waitFor(() =>
			expect(mocks.mutateAsync).toHaveBeenCalledWith({
				id: "rule-1",
				confirmDangerous: true,
			}),
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("keeps detailed configuration and implementation metadata out of the overview", () => {
		render(
			<MemoryRouter
				initialEntries={["/automation?rule=rule-1&tab=configuration"]}
			>
				<AutomationCenter />
			</MemoryRouter>,
		);

		expect(screen.queryByText("读取内容")).not.toBeInTheDocument();
		expect(screen.queryByText("整理方式")).not.toBeInTheDocument();
		expect(screen.queryByText("发送到")).not.toBeInTheDocument();
		expect(screen.queryByText("模板版本")).not.toBeInTheDocument();
		expect(screen.queryByText("高级配置")).not.toBeInTheDocument();
		expect(screen.queryByText(/compiledPipelineHash/)).not.toBeInTheDocument();
	});

	it("opens the two-mode creator from the natural-language entry", () => {
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: /告诉 WeMail 你想自动做什么/,
			}),
		);

		expect(screen.getByTestId("automation-create-dialog")).toHaveTextContent(
			"natural",
		);
		expect(useUIStore.getState().agentComposerRequest).toBeUndefined();
	});

	it("passes the selected automation to the Agent question entry", async () => {
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		fireEvent.pointerDown(screen.getByRole("button", { name: "更多操作" }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(await screen.findByText("询问 Agent"));

		expect(useUIStore.getState().agentComposerRequest?.text).toContain(
			"每日重要邮件摘要",
		);
		expect(useUIStore.getState().agentComposerRequest?.text).toContain(
			"rule-1",
		);
	});

	it("adds a recommended template through the configured automation path", async () => {
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		fireEvent.click(screen.getByRole("button", { name: "添加 邮箱速览" }));

		await waitFor(() => {
			expect(mocks.getAutomationTemplate).toHaveBeenCalledWith(
				"mail-digest",
				"1.0.0",
			);
			expect(mocks.previewAutomationTemplate).toHaveBeenCalled();
			expect(mocks.confirmAutomationTemplate).toHaveBeenCalledWith(
				"mail-digest",
				{
					accountId: "acct-1",
					previewId: "template-preview-1",
					previewHash: "hash-1",
				},
			);
		});
		expect(mocks.refetch).toHaveBeenCalled();
	});

	it("keeps a Bot-dependent template addable without a fallback notice", () => {
		mocks.templatesOverride = [
			{
				id: "wemail.received-mail-summary-notification",
				version: "1.0.0",
				name: "新邮件摘要通知",
				description: "收到新邮件后发布摘要",
				readiness: "ready",
				installed: false,
			},
		];
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		expect(screen.queryByText("未配置 Bot，将自动发布到消息中心。"))
			.toBeNull();
		expect(
			screen.getByRole("button", { name: "添加 新邮件摘要通知" }),
		).not.toBeDisabled();
	});

	it("does not keep an installed template in the recommendations", () => {
		mocks.templatesOverride = [
			{
				id: "subscription-daily-insight",
				version: "1.0.0",
				name: "邮箱速览",
				description: "整理当天的重要邮件",
				readiness: "ready",
				installed: true,
			},
		];
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		expect(
			screen.queryByRole("button", { name: "添加 邮箱速览" }),
		).not.toBeInTheDocument();
	});

	it("announces a bounded loading failure and offers an explicit retry", async () => {
		mocks.listError = true;
		render(
			<MemoryRouter initialEntries={["/automation"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"自动化暂时无法加载",
		);
		screen.getByRole("button", { name: "重试" }).click();
		expect(mocks.refetch).toHaveBeenCalledTimes(1);
	});

	it("localizes stage blockers, preserves available output, and deduplicates recovery actions", () => {
		const retryAction = {
			id: "retry-1",
			type: "retry_delivery" as const,
			label: "重试投递",
			runId: "run-1",
			stepId: "delivery",
		};
		mocks.detailOverride = {
			...detail,
			stages: detail.stages.map((stage) =>
				stage.stage === "delivery"
					? {
							...stage,
							status: "failed" as const,
							impact: "飞书暂时不可用，消息中心结果不受影响。",
							outputAvailable: true,
							recoveryActions: [
								retryAction,
								{ ...retryAction, id: "retry-duplicate" },
							],
						}
					: stage,
			),
		};
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-1"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		expect(screen.getByLabelText("需要处理的流程问题")).toHaveTextContent(
			"投递阶段未完成",
		);
		expect(screen.getByText("飞书暂时不可用，消息中心结果不受影响。")).toBeInTheDocument();
		expect(screen.getByText(/此前已生成的结果仍可查看/)).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "重试投递" })).toHaveLength(1);
	});

	it("renders V1 and V2 together with authoritative non-color health labels", () => {
		const healths = [
			"healthy",
			"running",
			"needs_attention",
			"paused",
			"disabled",
			"never_run",
		] as const;
		mocks.automationsOverride = healths.map((health, index) => ({
			...automation,
			id: `rule-${index}`,
			name: `规则 ${index}`,
			schemaVersion: index === 0 ? 1 : 2,
			health,
			enabled: health !== "disabled",
		}));
		render(
			<MemoryRouter initialEntries={["/automation?rule=rule-0"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		for (const label of [
			"正常",
			"执行中",
			"需处理",
			"已暂停",
			"已停用",
			"待首次运行",
		]) {
			expect(screen.getAllByText(label).length).toBeGreaterThan(0);
		}
		expect(
			screen
				.getAllByRole("button")
				.filter((button) =>
					button.dataset.testid?.startsWith("automation-rule-rule-"),
				),
		).toHaveLength(6);
	});

	it("uses a keyboard-operable drill-in on narrow windows", () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
		render(
			<MemoryRouter initialEntries={["/automation"]}>
				<AutomationCenter />
			</MemoryRouter>,
		);

		const row = screen.getByTestId("automation-rule-rule-1");
		row.focus();
		expect(row).toHaveFocus();
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.click(row);
		expect(screen.getByTestId("automation-rule-detail")).toBeInTheDocument();
		vi.unstubAllGlobals();
	});
});
