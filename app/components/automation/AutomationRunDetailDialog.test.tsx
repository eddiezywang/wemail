import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AutomationRunDetail } from "../../../shared/wemail/automationCenter";
import { AutomationRunDetailDialog } from "./AutomationRunDetailDialog";

const run: AutomationRunDetail = {
	id: "run-1",
	ruleId: "rule-1",
	ruleVersion: 2,
	owner: { type: "localProfile", profileId: "default" },
	dryRun: false,
	outcome: "succeeded",
	startedAt: "2026-07-30T12:00:00.000Z",
	inputCount: 2,
	resultCount: 1,
	truncated: false,
	deliveries: [],
	revision: 1,
	accountScope: { type: "allConnectedAccounts" },
	resolvedAccountIds: ["acct-1", "acct-2"],
	capabilityFingerprints: [],
	manifestAvailability: "available",
	resultAvailability: "available",
	steps: [],
	recoveryActions: [],
	warnings: [],
	result: {
		resultType: "test",
		schemaVersion: 1,
		rendererId: "missing",
		rendererVersion: "1",
		data: {},
		actionCandidates: [],
		provenance: [
			{
				outputPath: "result",
				sources: [
					{
						type: "email",
						accountId: "acct-1",
						emailId: "mail-1",
						subject: "来源邮件",
						availability: "available",
					},
					{
						type: "attachment",
						accountId: "acct-2",
						emailId: "mail-2",
						attachmentId: "part-1",
						filename: "报告.pdf",
						availability: "available",
					},
					{
						type: "email",
						accountId: "acct-2",
						emailId: "missing",
						subject: "已断开邮件",
						availability: "account_disconnected",
					},
				],
			},
		],
	},
};

describe("AutomationRunDetailDialog", () => {
	it("renders account-qualified mail and attachment links with disconnected states", () => {
		render(
			<AutomationRunDetailDialog
				open
				onOpenChange={vi.fn()}
				run={run}
				loading={false}
				retrying={false}
				onRetry={vi.fn()}
			/>,
		);

		expect(screen.getByRole("link", { name: "来源邮件" })).toHaveAttribute(
			"href",
			"/message/mail-1?accountId=acct-1",
		);
		expect(screen.getByRole("link", { name: "报告.pdf" })).toHaveAttribute(
			"href",
			"/api/mail/messages/mail-2/attachments/part-1?accountId=acct-2",
		);
		expect(screen.getByText(/已断开邮件（邮箱已断开）/)).toBeInTheDocument();
	});

	it("shows partial delivery, expired result, safe retry, and keeps focus inside the dialog", () => {
		const onRetry = vi.fn();
		render(
			<AutomationRunDetailDialog
				open
				onOpenChange={vi.fn()}
				run={{
					...run,
					outcome: "partial",
					result: undefined,
					resultAvailability: "expired",
					deliveries: [
						{ destination: "message_center", status: "succeeded" },
						{ destination: "feishu_bot", status: "failed" },
					],
					steps: [
						{
							id: "step-row-1",
							stepId: "delivery",
							stage: "delivery",
							capabilityId: "delivery.bot.sendConnected",
							status: "failed",
							warnings: [],
							sideEffects: [],
							retrySafe: true,
							error: {
								code: "bot-unavailable",
								message: "飞书暂时不可用",
							},
						},
					],
				}}
				loading={false}
				retrying={false}
				onRetry={onRetry}
			/>,
		);

		expect(screen.getByText("部分完成")).toBeInTheDocument();
		expect(screen.getByText(/业务结果已按保留策略清理/)).toBeInTheDocument();
		expect(screen.getByText("已发送至消息中心。")).toBeInTheDocument();
		expect(screen.getByText("发送至飞书 Bot失败。")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /重试此步/ }));
		expect(onRetry).toHaveBeenCalledWith(
			expect.objectContaining({ stepId: "delivery" }),
		);
		const dialog = screen.getByRole("dialog");
		expect(dialog).toContainElement(document.activeElement as HTMLElement);
	});

	it("shows the actual Bot delivery in business language without internal counters", () => {
		render(
			<AutomationRunDetailDialog
				open
				accountId="acct-1"
				onOpenChange={vi.fn()}
				run={{
					...run,
					inputCount: 0,
					resultCount: 3,
					result: undefined,
					deliveries: [
						{
							destination: "wecom_bot",
							status: "succeeded",
							outputId: "delivery-1",
						},
					],
				}}
				loading={false}
				retrying={false}
				onRetry={vi.fn()}
			/>,
		);

		expect(screen.getByText("已发送至企业微信 Bot。")).toBeInTheDocument();
		expect(screen.getByText("本次运行已完成。")).toBeInTheDocument();
		expect(screen.queryByText(/输入 0/)).not.toBeInTheDocument();
		expect(screen.queryByText(/产出 3/)).not.toBeInTheDocument();
		expect(screen.queryByText(/没有外部投递/)).not.toBeInTheDocument();
		expect(screen.queryByText("技术信息")).not.toBeInTheDocument();
	});

	it("explains the analysis and links a generated chart through application messages", () => {
		render(
			<AutomationRunDetailDialog
				open
				accountId="acct-1"
				onOpenChange={vi.fn()}
				run={{
					...run,
					result: undefined,
					resultAvailability: "missing",
					window: {
						start: "2026-07-30T00:00:00.000Z",
						end: "2026-07-30T12:00:00.000Z",
						timezone: "Asia/Shanghai",
					},
					output: {
						type: "application_message",
						id: "message-1",
						title: "银行电销会话分析平台 · 当日监控报告",
						preview: "晚高峰接口耗时升高，需要关注。",
						artifactId: "artifact-1",
						artifactVersion: 1,
						availability: "available",
					},
					steps: [{
						id: "artifact-step",
						stepId: "chart",
						stage: "artifact",
						capabilityId: "design.render",
						status: "succeeded",
						inputSummary: { objective: "分析调用量、失败与耗时趋势" },
						warnings: [],
						sideEffects: [],
						retrySafe: false,
					}],
				}}
				loading={false}
				retrying={false}
				onRetry={vi.fn()}
			/>,
		);

		expect(screen.getByText("分析调用量、失败与耗时趋势")).toBeInTheDocument();
		expect(screen.getByText("晚高峰接口耗时升高，需要关注。")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "查看完整图表" }));
		expect(
			screen.getByRole("dialog", {
				name: "银行电销会话分析平台 · 当日监控报告",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByTitle("银行电销会话分析平台 · 当日监控报告"),
		).toHaveAttribute(
			"src",
			expect.stringContaining(
				"/api/application-messages/message-1/artifact?accountId=acct-1",
			),
		);
	});

	it("explains a deliberate silent run instead of presenting it as failed delivery", () => {
		render(
			<AutomationRunDetailDialog
				open
				onOpenChange={vi.fn()}
				run={{
					...run,
					deliveries: [],
					steps: [
						{
							id: "step-silent",
							stepId: "delivery",
							stage: "delivery",
							capabilityId: "delivery.bot.sendConnected",
							status: "empty",
							warnings: ["无需通知，本次静默"],
							sideEffects: [],
							retrySafe: false,
						},
					],
				}}
				loading={false}
				retrying={false}
				onRetry={vi.fn()}
			/>,
		);

		expect(screen.getByText("没有需要你处理的内容，本次已静默。")).toBeInTheDocument();
	});
});
