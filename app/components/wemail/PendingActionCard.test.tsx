// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentPendingAction } from "~/services/api";
import { PendingActionCard } from "./PendingActionCard";

// P2.6: the allowance upload flow (and its login hint) is an edition module.
// The internal edition turns the feature on; the open edition never sees it.
const editionFeatures = vi.hoisted(() => ({ allowanceInvoice: true }));
vi.mock("~/hooks/useEditionFeatures", () => ({
	useEditionFeatures: () => ({
		wecli: false,
		allowanceInvoice: editionFeatures.allowanceInvoice,
		enterpriseDirectory: false,
		officeSceneDetection: false,
	}),
}));

function makeAction(
	overrides: Partial<AgentPendingAction> = {},
): AgentPendingAction {
	return {
		id: "pa-1",
		actionType: "delete",
		description: "Delete the spam thread",
		toolName: "propose_action",
		inputJson: '{"actionType":"delete"}',
		riskReason: "delete is a high-risk action",
		riskLevel: "high",
		...overrides,
	};
}

describe("PendingActionCard", () => {
	it("expires at the original deadline, including after a suspended tab resumes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
		try {
			const onConfirm = vi.fn();
			const { unmount } = render(<PendingActionCard action={makeAction({
				status: "pending", expiresAt: "2026-11-03T00:00:02Z",
			})} onConfirm={onConfirm} onReject={vi.fn()} />);
			expect(screen.getByRole("timer")).toHaveTextContent("0:02");
			act(() => vi.advanceTimersByTime(1000));
			expect(screen.getByRole("timer")).toHaveTextContent("0:01");
			vi.setSystemTime(new Date("2026-11-03T00:01:00Z"));
			act(() => screen.getByRole("button", { name: "确认" }).click());
			expect(onConfirm).not.toHaveBeenCalled();
			act(() => document.dispatchEvent(new Event("visibilitychange")));
			expect(screen.getByRole("status")).toHaveTextContent("已过期");
			expect(screen.queryByRole("timer")).toBeNull();
			expect(screen.queryByRole("button", { name: /确认|拒绝/ })).toBeNull();
			unmount();
		} finally { vi.useRealTimers(); }
	});

	it("treats a succeeded MCP approval without execution as authorization only", () => {
		render(<PendingActionCard action={makeAction({ origin: "mcp", status: "confirmed", executionState: "succeeded",
			executionResult: { state: "approved", executed: false },
		})} onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByTestId("pending-action-risk-badge")).toHaveTextContent("已授权");
		expect(screen.getByText(/等待外部客户端提交/)).toBeInTheDocument();
		expect(screen.queryByText("已处理")).toBeNull();
	});

	it("shows the actual outbox receipt without claiming delivery", () => {
		const summary = "邮件已进入规范发件队列：预算 review";
		render(<PendingActionCard action={makeAction({ actionType: "send", status: "confirmed", executionState: "succeeded",
			executionResult: { ok: true, summary },
		})} onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByText(summary)).toBeVisible();
		expect(screen.queryByText(/已送达/)).toBeNull();
	});

	it("shows outbound review fields without expanding technical details or leaking nested secrets", () => {
		render(<PendingActionCard action={makeAction({ actionType: "schedule_send", parameters: {
			accountId: "account", sendAt: "2030-11-03T09:00:00Z",
			draft: { to: [{ email: "recipient@example.test", name: "Test" }], bcc: ["audit@example.test"], subject: "预算 review" },
			extra: { apiKey: "secret-value" },
		} })} mailbox={{ id: "account", email: "sender@example.test" }} onConfirm={vi.fn()} onReject={vi.fn()} />);
		for (const text of ["sender@example.test", "recipient@example.test", "audit@example.test", "预算 review"]) {
			expect(screen.getByText(text)).toBeVisible();
		}
		expect(screen.getByText("发送时间")).toBeVisible();
		expect(screen.getByTestId("pending-action-parameters")).not.toHaveAttribute("open");
		expect(screen.getByTestId("pending-action-card")).not.toHaveTextContent("secret-value");
	});

	it("shows permanent deletion scope without borrowing another account address", () => {
		render(<PendingActionCard action={makeAction({ actionType: "bulk_mail_operation", parameters: {
			operation: "permanent_delete", accountId: "target-account", emailIds: ["first", "second"],
		} })} mailbox={{ id: "other-account", email: "other@example.test" }} onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByText("2 封邮件")).toBeVisible();
		expect(screen.getByText(/此操作无法恢复/)).toBeVisible();
		expect(screen.getByText("target-account")).toBeVisible();
		expect(screen.queryByText("other@example.test")).toBeNull();
	});

	it("keeps partial results and unknown outcomes read-only", () => {
		const { rerender } = render(<PendingActionCard action={makeAction({ status: "confirmed", executionState: "failed",
			executionResult: { summary: "成功 1 封，失败 1 封", successCount: 1, failureCount: 1 },
		})} onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByText("部分成功")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
		rerender(<PendingActionCard action={makeAction({ executionState: "outcome_unknown" })} onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByText("结果待核实")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
	});
	it("keeps elapsed time across task updates and freezes it when finished", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-03T00:00:10Z"));
		try {
			const task = { planVersion: 1 as const, id: "task", actionId: "pa-1", accountId: "account", state: "running" as const,
				revision: 2, generation: 1, acceptedAt: Date.parse("2026-11-03T00:00:00Z"),
				items: [{ index: 0, emailId: "m", attachmentId: "a", filename: "发票.pdf", phase: "submitting" as const }] };
			const { rerender, unmount } = render(<PendingActionCard action={makeAction({ executionState: "executing", executionResult: { task } })} onConfirm={vi.fn()} onReject={vi.fn()} />);
			expect(screen.getByRole("status")).toHaveTextContent("提交平台并等待核验");
			expect(screen.getByText("已用时 10 秒")).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(3000));
			expect(screen.getByText("已用时 13 秒")).toBeInTheDocument();
			rerender(<PendingActionCard action={makeAction({ status: "confirmed", executionState: "succeeded", executionResult: { task: { ...task,
				state: "succeeded", completedAt: Date.parse("2026-11-03T00:00:12Z"), items: [{ ...task.items[0], phase: "succeeded" }] } } })} onConfirm={vi.fn()} onReject={vi.fn()} />);
			expect(screen.getByText("耗时 12 秒")).toBeInTheDocument();
			expect(screen.queryByRole("status")).toBeNull();
			act(() => vi.advanceTimersByTime(5000));
			expect(screen.getByText("耗时 12 秒")).toBeInTheDocument();
			unmount();
		} finally { vi.useRealTimers(); }
	});
	it("shows a clear login action for an authentication rejection", () => {
		render(<PendingActionCard action={makeAction({ actionType: "upload_allowance_invoices", status: "confirmed", executionState: "failed",
			executionResult: { task: { planVersion: 1, id: "task", actionId: "pa-1", accountId: "account", state: "failed", revision: 4, generation: 1,
				items: [{ index: 0, emailId: "m", attachmentId: "a", phase: "failed", error: "发票平台未登录或登录已过期，本次未上传。" }] } } })}
			onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByTestId("pending-action-risk-badge")).toHaveTextContent("需要登录发票平台");
		// P2.6: the login link is edition data — the retained hint is
		// text-only and carries no platform URL in any edition.
		expect(screen.getByText("请先在浏览器登录补贴平台，再重试失败项。")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "打开补贴平台登录" })).toBeNull();
		expect(screen.queryByText("结果待核实")).not.toBeInTheDocument();
	});
	it("discloses uncertain previous outcome before confirming another upload", () => {
		render(<PendingActionCard action={makeAction({ actionType: "upload_allowance_invoices",
			parameters: { retryUnverified: true }, description: "重新尝试上传 1 个发票附件（历史结果未确认）" })}
			onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByTestId("pending-action-risk-reason")).toHaveTextContent("存在重复风险");
		expect(screen.getByRole("button", { name: "确认" })).toBeInTheDocument();
	});
	it("shows previously uploaded and associated invoices as completed business results", () => {
		render(<PendingActionCard action={makeAction({ actionType: "upload_allowance_invoices", status: "confirmed", executionState: "succeeded",
			executionResult: { task: { planVersion: 1, id: "task", actionId: "pa-1", accountId: "account", state: "succeeded", revision: 4, generation: 1,
				items: [{ index: 0, emailId: "m", attachmentId: "a", phase: "succeeded", alreadyProcessed: "uploaded" },
					{ index: 1, emailId: "m", attachmentId: "b", phase: "succeeded", alreadyProcessed: "associated" }] } } })}
			onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByText("此前已上传，本次无需上传")).toBeInTheDocument();
		expect(screen.getByText("已关联账单，本次无需上传")).toBeInTheDocument();
		expect(screen.queryByText("执行失败")).not.toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});
	it("retains per-file success and unknown outcomes after the request settles", () => {
		render(<PendingActionCard action={makeAction({ actionType: "upload_allowance_invoices", status: "confirmed", executionState: "outcome_unknown",
			executionResult: { task: { planVersion: 1, id: "task", actionId: "pa-1", accountId: "account", state: "outcome_unknown", revision: 4, generation: 1,
				items: [{ index: 0, emailId: "m", attachmentId: "a", filename: "成功.pdf", phase: "succeeded" },
					{ index: 1, emailId: "m", attachmentId: "b", filename: "待核实.pdf", phase: "outcome_unknown" }] } } })}
			onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByText("成功.pdf")).toBeInTheDocument();
		expect(screen.getByText("已上传并通过核验")).toBeInTheDocument();
		expect(screen.getByText("结果待核实，未自动重传")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});
	it("shows confirmation errors visibly", () => {
		render(<PendingActionCard action={makeAction()} error="暂时无法确认提交结果" onConfirm={vi.fn()} onReject={vi.fn()} />);
		expect(screen.getByRole("alert")).toHaveTextContent("暂时无法确认提交结果");
	});
	it("renders description and user-facing risk hint", () => {
		render(
			<PendingActionCard
				action={makeAction()}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);
		expect(screen.getByTestId("pending-action-description")).toHaveTextContent(
			"Delete the spam thread",
		);
		expect(screen.getByTestId("pending-action-risk-reason")).toHaveTextContent(
			"确认后会删除邮件。",
		);
	});

	it("calls onConfirm with the action id when Confirm is clicked", async () => {
		const onConfirm = vi.fn();
		const onReject = vi.fn();
		render(
			<PendingActionCard
				action={makeAction({ id: "pa-confirm" })}
				onConfirm={onConfirm}
				onReject={onReject}
			/>,
		);
		await userEvent.click(screen.getByTestId("pending-action-confirm"));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onConfirm).toHaveBeenCalledWith("pa-confirm");
		expect(onReject).not.toHaveBeenCalled();
	});

	it("calls onReject with the action id when Reject is clicked", async () => {
		const onConfirm = vi.fn();
		const onReject = vi.fn();
		render(
			<PendingActionCard
				action={makeAction({ id: "pa-reject" })}
				onConfirm={onConfirm}
				onReject={onReject}
			/>,
		);
		await userEvent.click(screen.getByTestId("pending-action-reject"));
		expect(onReject).toHaveBeenCalledTimes(1);
		expect(onReject).toHaveBeenCalledWith("pa-reject");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("exposes data-risk-level matching action.riskLevel", () => {
		render(
			<PendingActionCard
				action={makeAction({ riskLevel: "medium" })}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);
		expect(screen.getByTestId("pending-action-card")).toHaveAttribute(
			"data-risk-level",
			"medium",
		);
	});

	it("renders a different DOM marker for high vs low risk (style branch coverage)", () => {
		const { rerender } = render(
			<PendingActionCard
				action={makeAction({ id: "pa-high", riskLevel: "high" })}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);
		const highCard = screen.getByTestId("pending-action-card");
		expect(highCard).toHaveAttribute("data-risk-level", "high");
		expect(screen.getByTestId("pending-action-risk-badge")).toHaveTextContent(
			"高风险",
		);
		const highClassName = highCard.className;

		rerender(
			<PendingActionCard
				action={makeAction({ id: "pa-low", riskLevel: "low" })}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);
		const lowCard = screen.getByTestId("pending-action-card");
		expect(lowCard).toHaveAttribute("data-risk-level", "low");
		expect(screen.getByTestId("pending-action-risk-badge")).toHaveTextContent(
			"低风险",
		);
		expect(highClassName).not.toEqual(lowCard.className);
	});

	it("disables both buttons while resolving", () => {
		render(
			<PendingActionCard
				action={makeAction()}
				onConfirm={() => {}}
				onReject={() => {}}
				isResolving
			/>,
		);
		expect(screen.getByTestId("pending-action-confirm")).toBeDisabled();
		expect(screen.getByTestId("pending-action-reject")).toBeDisabled();
	});

	it("shows confirmation submission without inventing upload progress", () => {
		render(
			<PendingActionCard
				action={makeAction({
					actionType: "upload_allowance_invoices",
					description: "上传 1 个附件到发票平台",
					riskLevel: "medium",
				})}
				onConfirm={() => {}}
				onReject={() => {}}
				isResolving
			/>,
		);

		const card = screen.getByTestId("pending-action-card");
		expect(card).toHaveTextContent("提交确认中");
		expect(card).not.toHaveTextContent("正在上传");
		expect(screen.getByRole("button", { name: "提交确认中" })).toBeDisabled();
	});

	it("does not offer confirmation again while the server is executing", () => {
		render(
			<PendingActionCard
				action={makeAction({ executionState: "executing" })}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);

		expect(screen.getByTestId("pending-action-card")).toHaveTextContent("正在执行");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("explains that WeCLI installation is optional and intranet-only", () => {
		render(
			<PendingActionCard
				action={makeAction({
					actionType: "install_wecli",
					description: "安装可选组件 WeCLI",
					riskLevel: "high",
				})}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);

		const card = screen.getByTestId("pending-action-card");
		expect(card).toHaveTextContent("安装可选组件 WeCLI");
		// P2.5: the install hint no longer names a private registry network.
		expect(card).toHaveTextContent("企业内网");
		expect(card).toHaveTextContent("取消不影响 WeMail 其他功能");
	});

	it("renders user-facing copy without internal ids, tool names, or raw risk text", () => {
		render(
			<PendingActionCard
				action={makeAction({
					id: "pending-1",
					actionType: "upload_allowance_invoices",
					description: "上传 2 个附件到发票平台",
					toolName: "propose_allowance_invoice_upload",
					inputJson: '{"items":[]}',
					riskReason:
						"This downloads selected mail attachments to Wemail's internal directory and runs a confirmed wecli allowance upload command.",
					riskLevel: "medium",
				})}
				onConfirm={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		const card = screen.getByTestId("pending-action-card");
		expect(card).toHaveTextContent("上传 2 个附件到发票平台");
		expect(card).toHaveTextContent("需要确认");
		expect(card).toHaveTextContent(
			"确认后 WeMail 会先将本卡片列出的 PDF 下载到内部临时目录，再用本地临时路径上传；下载不需要单独权限，后续上传需重新确认。",
		);
		expect(card).not.toHaveTextContent("upload_allowance_invoices");
		expect(card).not.toHaveTextContent("propose_allowance_invoice_upload");
		expect(card).not.toHaveTextContent("internal directory");
		expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "确认" })).toBeInTheDocument();
	});

	it("labels MCP-origin confirmation as authorization without immediate execution", () => {
		render(
			<PendingActionCard
				action={makeAction({ origin: "mcp", operationId: "op-1", actionType: "send", description: "Send reviewed message" })}
				onConfirm={vi.fn()}
				onReject={vi.fn()}
			/>,
		);
		expect(screen.getByTestId("pending-action-mcp-badge")).toHaveTextContent("MCP 请求");
		expect(screen.getByText(/不会立即执行/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "授权" })).toBeInTheDocument();
	});

	it("keeps resolved and expired confirmations as read-only conversation history", () => {
		const { rerender } = render(
			<PendingActionCard
				action={makeAction({ status: "confirmed", executionState: "succeeded" })}
				onConfirm={vi.fn()}
				onReject={vi.fn()}
			/>,
		);
		expect(screen.getByText("已处理")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();

		rerender(
			<PendingActionCard
				action={makeAction({ status: "expired", expiresAt: "2026-01-01T00:00:00.000Z" })}
				onConfirm={vi.fn()}
				onReject={vi.fn()}
			/>,
		);
		expect(screen.getByText("已过期")).toBeInTheDocument();
		expect(screen.getByText(/重新提出操作/)).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("shows the failed execution result instead of returning to confirmation", () => {
		render(
			<PendingActionCard
				action={makeAction({
					actionType: "upload_allowance_invoices",
					description: "上传 5 个 PDF 发票附件到发票平台",
					riskLevel: "medium",
					status: "confirmed",
					executionState: "failed",
					executionResult: {
						ok: false,
						summary: "上传未完成：成功 2 个，失败 3 个。",
						items: [{ ok: false, stderr: "AUTH_REQUIRED: Not logged in" }],
					},
				})}
				onConfirm={() => {}}
				onReject={() => {}}
			/>,
		);

		expect(screen.getByTestId("pending-action-risk-badge")).toHaveTextContent("执行失败");
		expect(screen.getByTestId("pending-action-risk-reason")).toHaveTextContent(
			"上传未完成：成功 2 个，失败 3 个。 请先登录发票平台，再重新发起失败项。",
		);
		expect(screen.queryByRole("button")).toBeNull();
	});

	describe("with the allowanceInvoice edition feature off (open edition)", () => {
		// P2.6 round 8: the whole allowance card branch (upload-flow hints,
		// execution snapshot progress, platform login/expense results) is
		// edition semantics. With the feature off a legacy row renders as a
		// generic card: generic hint, generic failure text, no task
		// interpretation.
		afterEach(() => {
			editionFeatures.allowanceInvoice = true;
		});

		it("falls back to the generic confirmation hint for allowance actions", () => {
			editionFeatures.allowanceInvoice = false;
			render(
				<PendingActionCard
					action={makeAction({
						id: "pending-open-1",
						actionType: "upload_allowance_invoices",
						description: "上传 2 个附件到发票平台",
						toolName: "propose_allowance_invoice_upload",
						inputJson: '{"items":[]}',
						riskLevel: "medium",
					})}
					onConfirm={vi.fn()}
					onReject={vi.fn()}
				/>,
			);

			const card = screen.getByTestId("pending-action-card");
			expect(card).toHaveTextContent("上传 2 个附件到发票平台");
			expect(card).toHaveTextContent("确认后会执行该操作。");
			expect(card).not.toHaveTextContent("内部临时目录");
			expect(card).not.toHaveTextContent("本地临时路径上传");
			expect(screen.getByRole("button", { name: "确认" })).toBeInTheDocument();
		});

		it("falls back to the generic hint for legacy delete actions", () => {
			editionFeatures.allowanceInvoice = false;
			render(
				<PendingActionCard
					action={makeAction({
						id: "pending-open-2",
						actionType: "delete_allowance_invoices",
						description: "删除 1 个发票关联",
						riskLevel: "medium",
					})}
					onConfirm={vi.fn()}
					onReject={vi.fn()}
				/>,
			);

			expect(screen.getByTestId("pending-action-card")).toHaveTextContent("确认后会执行该操作。");
			expect(screen.queryByText("确认后会从月度发票平台删除选中的发票关联。")).toBeNull();
		});

		it("does not interpret the upload execution snapshot (generic failure, no phase results)", () => {
			editionFeatures.allowanceInvoice = false;
			render(
				<PendingActionCard
					action={makeAction({
						actionType: "upload_allowance_invoices",
						description: "上传 2 个附件到发票平台",
						riskLevel: "medium",
						status: "confirmed",
						executionState: "failed",
						executionResult: { task: { planVersion: 1 as const, id: "task", actionId: "pa-1", accountId: "account", state: "failed",
							revision: 4, generation: 1, items: [
								{ index: 0, emailId: "m", attachmentId: "a", phase: "failed" as const, error: "发票平台未登录或登录已过期，本次未上传。" },
								{ index: 1, emailId: "m", attachmentId: "b", phase: "failed" as const, error: "平台核验未通过：当前发票已经在费控中绑定！" },
							] } },
					})}
					onConfirm={() => {}}
					onReject={() => {}}
				/>,
			);

			const card = screen.getByTestId("pending-action-card");
			// The snapshot is not interpreted: no login/expense hint, no
			// per-file phase vocabulary.
			expect(card).not.toHaveTextContent("需要登录发票平台");
			expect(card).not.toHaveTextContent("请先在浏览器登录补贴平台");
			expect(card).not.toHaveTextContent("费控已绑定，本次未接收");
			expect(card).not.toHaveTextContent("下载并准备附件");
			expect(card).not.toHaveTextContent("提交平台并等待核验");
			expect(card).not.toHaveTextContent("已处理 0 / 2 个附件");
			expect(screen.queryByTestId("pending-action-risk-reason")).toHaveTextContent("执行失败");
		});

		it("shows the generic executing text without the upload phrasing", () => {
			editionFeatures.allowanceInvoice = false;
			render(
				<PendingActionCard
					action={makeAction({
						actionType: "upload_allowance_invoices",
						description: "上传 1 个附件到发票平台",
						executionState: "executing",
					})}
					onConfirm={() => {}}
					onReject={() => {}}
				/>,
			);

			expect(screen.getByTestId("pending-action-card")).toHaveTextContent("正在执行：上传 1 个附件到发票平台");
			expect(screen.queryByText("正在上传 1 个附件到发票平台")).toBeNull();
		});
	});
});
