// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as agentPanel from "./AgentPanel";
import {
	addPendingActionToList,
	canReplaceHomeSuggestions,
	configurationTaskFromWemailEvent,
	digestCenterPath,
	getVisibleAgentSuggestions,
	notifyAgentConfirmation,
	pendingActionFromWemailEvent,
	buildAgentMessageContext,
	buildAgentMessagePresentationContext,
	resolveContextSuggestions,
	semanticActionFromSuggestion,
	shouldShowAgentSuggestions,
	wecliInstallFailureDetail,
} from "./AgentPanel";
import type { AgentPendingAction } from "~/services/api";
import type { AgentSuggestion } from "~/queries/agentSuggestions";

it("renders the agent mark without the WeMail brand image", () => {
	const AgentAvatar = (
		agentPanel as unknown as {
			AgentAvatar?: React.ComponentType;
		}
	).AgentAvatar;

	expect(AgentAvatar).toBeTypeOf("function");
	if (!AgentAvatar) return;

	render(<AgentAvatar />);
	expect(screen.getByTestId("agent-avatar").querySelector("svg")).not.toBeNull();
	expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("uses the store-selected conversation without a mailbox fallback", () => {
	expect(
		agentPanel.resolveAgentConversationId?.("conv-home-new"),
	).toBe("conv-home-new");
});

it("keeps a complete semantic home action in the Agent runtime context", () => {
	const suggestion: AgentSuggestion = {
		id: "aggregate-alerts-24h",
		label: "汇总过去 24 小时的系统告警",
		prompt: "汇总过去 24 小时全部系统告警。",
		kind: "aggregate",
		discovery: {
			emailIds: ["alert-1", "alert-2"],
			primaryWindow: "24h",
			mailState: "unread",
		},
		executionScope: {
			mode: "query",
			query: {
				receivedWithin: "24h",
				mailState: "all",
				folder: "inbox",
				category: "notification",
			},
		},
	};

	const semanticAction = semanticActionFromSuggestion(suggestion);
	const context = buildAgentMessageContext(
		{ mailboxId: "acct-1", accountId: "acct-1" },
		semanticAction,
	);

	expect(context.semanticAction).toEqual(suggestion);
	expect(context).not.toHaveProperty("emailId");
});

it("marks a mailbox-scoped turn without attaching the focused email", () => {
	expect(
		buildAgentMessagePresentationContext(undefined, undefined, "mailbox"),
	).toEqual({ actionTags: ["搜索整个邮箱"] });
});

it("does not treat a legacy navigation shortcut as a semantic action", () => {
	expect(
		semanticActionFromSuggestion({
			id: "digest",
			label: "打开摘要中心",
			prompt: "打开摘要中心。",
			action: { type: "open_digest_center", filter: "pending" },
		}),
	).toBeUndefined();
});

it("does not invent a fallback chip when the home action service returns empty", () => {
	expect(resolveContextSuggestions([], false)).toEqual([]);
});

function makePendingAction(overrides: Partial<AgentPendingAction> = {}): AgentPendingAction {
	return {
		id: "pending-1",
		actionType: "upload_allowance_invoices",
		description: "上传 2 个邮件附件到 wecli allowance",
		toolName: "propose_allowance_invoice_upload",
		inputJson: '{"items":[]}',
		riskReason: "runs a confirmed wecli allowance upload command",
		riskLevel: "medium",
		...overrides,
	};
}

describe("pendingActionFromWemailEvent", () => {
	it("extracts pending actions from dedicated streaming events", () => {
		expect(
			pendingActionFromWemailEvent({
				schemaVersion: 1,
				conversationId: "conv-1",
				runId: "run-1",
				messageId: "message-1",
				sequence: 1,
				timestamp: "2026-08-02T00:00:00.000Z",
				type: "confirmation_requested",
				confirmation: {
					id: "pending-event",
					actionType: "upload_allowance_invoices",
					description: "上传 2 个邮件附件到 wecli allowance",
					riskLevel: "medium",
					parameters: { items: [] },
					expiresAt: "2026-08-02T00:15:00.000Z",
					idempotencyKey: "idem-1",
					status: "pending",
				},
			}),
		).toMatchObject({
			id: "pending-event",
			parameters: { items: [] },
			idempotencyKey: "idem-1",
		});
	});

	it("extracts pending actions from tool result output as a compatibility fallback", () => {
		const action = makePendingAction({ id: "pending-tool-result" });

		expect(
			pendingActionFromWemailEvent({
				schemaVersion: 1,
				conversationId: "conv-1",
				runId: "run-1",
				messageId: "message-1",
				sequence: 2,
				timestamp: "2026-08-02T00:00:01.000Z",
				type: "tool_execution_completed",
				toolCallId: "tool-1",
				output: {
					ok: true,
					pendingAction: action,
					executed: false,
				},
			}),
		).toEqual(action);
	});

	it("deduplicates cached pending action rows by id", () => {
		const existing = makePendingAction({ id: "pending-1" });
		const next = makePendingAction({ id: "pending-2" });

		expect(addPendingActionToList([existing], next)).toEqual([existing, next]);
		expect(addPendingActionToList([existing], existing)).toEqual([existing]);
	});

	it("publishes only the safe pending-action fields to the desktop notifier", () => {
		const notify = vi.fn();
		notifyAgentConfirmation(
			"acct-1",
			makePendingAction({
				id: "confirm-1",
				description: "发送邮件给财务",
				inputJson: '{"secret":"must-not-cross"}',
			}),
			notify,
		);

		expect(notify).toHaveBeenCalledWith({
			accountId: "acct-1",
			actionId: "confirm-1",
			description: "发送邮件给财务",
		});
		expect(JSON.stringify(notify.mock.calls)).not.toContain("must-not-cross");
	});

	it("suppresses a desktop confirmation when the relevant conversation is already visible", () => {
		const notify = vi.fn();
		notifyAgentConfirmation(
			"acct-1",
			makePendingAction({ id: "confirm-visible" }),
			notify,
			true,
		);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("configurationTaskFromWemailEvent", () => {
	it("extracts a canonical configuration snapshot without relying on finalizer text", () => {
		const snapshot = {
			id: "configuration-task-1",
			accountId: "acct-1",
			kind: "automation_rule",
			targetKey: "daily-monitoring",
			operation: "create",
			title: "每日监控",
			status: "blocked",
			currentPhase: "discover_capabilities",
			source: { surface: "agent" },
			steps: [],
			issues: [],
			recoveries: [],
			effects: [],
			references: [],
			revision: 3,
			createdAt: "2026-07-29T00:00:00.000Z",
			updatedAt: "2026-07-29T00:01:00.000Z",
		};
		const base = {
			schemaVersion: 1 as const,
			conversationId: "conv-1",
			runId: "run-1",
			messageId: "message-1",
			sequence: 1,
			timestamp: "2026-08-02T00:00:00.000Z",
			type: "tool_execution_completed" as const,
			toolCallId: "tool-1",
		};
		expect(configurationTaskFromWemailEvent({
			...base,
			output: { ok: true, configurationTask: snapshot },
		})).toEqual(snapshot);
		expect(configurationTaskFromWemailEvent({
			...base,
			output: { ok: false, error: "wecli missing" },
		})).toBeNull();
	});
});

describe("getVisibleAgentSuggestions", () => {
	it("keeps backend order and limits the panel to three suggestions", () => {
		const suggestions = [
			{ id: "a", label: "上传发票", prompt: "a" },
			{ id: "b", label: "分析告警", prompt: "b" },
			{ id: "c", label: "提取待办", prompt: "c" },
			{ id: "d", label: "总结", prompt: "d" },
			{ id: "e", label: "翻译", prompt: "e" },
		];

		expect(getVisibleAgentSuggestions(suggestions).map((s) => s.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});
});

describe("digestCenterPath", () => {
	it("maps typed digest filters to summary center deep links", () => {
		expect(digestCenterPath("pending")).toBe(
			"/digests?tab=tasks&filter=pending",
		);
		expect(digestCenterPath("attention")).toBe(
			"/digests?tab=tasks&filter=attention",
		);
		expect(digestCenterPath("history")).toBe("/digests?tab=tasks");
	});
});

describe("shouldShowAgentSuggestions", () => {
	it("hides actions once the chat has conversation content", () => {
		expect(
			shouldShowAgentSuggestions({
				messageCount: 2,
				hasSelectedEmail: true,
			}),
		).toBe(false);
		expect(
			shouldShowAgentSuggestions({
				messageCount: 1,
				hasSelectedEmail: true,
			}),
		).toBe(false);
	});

	it("shows default chips only on an empty mailbox-level chat", () => {
		expect(
			shouldShowAgentSuggestions({
				messageCount: 0,
				hasSelectedEmail: false,
			}),
		).toBe(true);
		expect(
			shouldShowAgentSuggestions({
				messageCount: 1,
				hasSelectedEmail: false,
			}),
		).toBe(false);
	});

	it("does not show mailbox suggestions for an explicitly restored empty history", () => {
		expect(
			shouldShowAgentSuggestions({
				messageCount: 0,
				hasSelectedEmail: false,
				isHomeInitial: false,
			}),
		).toBe(false);
	});
});

describe("canReplaceHomeSuggestions", () => {
	it("allows silent replacement only before home interaction", () => {
		expect(canReplaceHomeSuggestions({
			isHomeInitial: true,
			isFrozen: false,
			messageCount: 0,
		})).toBe(true);
		expect(canReplaceHomeSuggestions({
			isHomeInitial: true,
			isFrozen: true,
			messageCount: 0,
		})).toBe(false);
		expect(canReplaceHomeSuggestions({
			isHomeInitial: true,
			isFrozen: false,
			messageCount: 1,
		})).toBe(false);
		expect(canReplaceHomeSuggestions({
			isHomeInitial: false,
			isFrozen: false,
			messageCount: 0,
		})).toBe(false);
	});
});

describe("wecliInstallFailureDetail", () => {
	it("maps blocking install failures to stable user-facing copy without raw diagnostics", () => {
		// Raw backend messages (exit codes, npm stderr) belong in logs, never
		// in the blocking dialog; the detail must resolve to friendly copy.
		expect(
			wecliInstallFailureDetail(
				{
					ok: false,
					summary: "WeCLI 安装未完成",
					failureCount: 1,
					items: [
						{
							filename: "WeCLI",
							ok: false,
							exitCode: 1,
							error: "安装命令返回失败",
							stderr: "npm ERR! registry unavailable",
						},
					],
				},
				undefined,
			),
		).toBe("安装没有完成。请检查网络或 npm 权限后重试。");
		expect(
			wecliInstallFailureDetail(
				{
					ok: false,
					summary: "WeCLI 安装未完成",
					items: [
						{
							ok: false,
							stderr: "npm ERR! registry unavailable",
						},
					],
				},
				undefined,
			),
		).toBe("安装没有完成。请检查网络或 npm 权限后重试。");
	});
});
