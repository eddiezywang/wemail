import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConfigurationTaskSnapshot } from "../../../shared/wemail/configuration";
import { ConfigurationTaskCard } from "./ConfigurationTaskCard";

describe("ConfigurationTaskCard", () => {
	it("shows an inline stage message and keeps tool diagnostics collapsed", () => {
		const task: ConfigurationTaskSnapshot = {
			id: "configuration-task-1",
			accountId: "acct-1",
			kind: "automation_rule",
			targetKey: "monitoring",
			operation: "create",
			title: "每日监控自动化",
			status: "blocked",
			currentPhase: "discover_capabilities",
			source: { surface: "agent" },
			steps: [
				{ id: "discover", phase: "discover_capabilities", label: "发现能力", status: "blocked" },
				{ id: "preview", phase: "generate_preview", label: "生成预览", status: "skipped" },
			],
			issues: [{
				id: "issue-1",
				category: "dependency_unavailable",
				code: "wecli_binary_missing",
				phase: "discover_capabilities",
				severity: "blocking",
				userMessage: "未检测到 WeCLI，因此依赖它的配置步骤尚未执行。",
				responsibility: "user_action",
				retryability: "safe_after_recovery",
				privacyClass: "diagnostic",
				affectedScope: ["provider:wecli"],
				diagnostic: { tool: "discover_automation_capabilities", toolCallId: "call-1" },
				createdAt: "2026-07-29T00:00:00.000Z",
			}],
			recoveries: [{
				id: "recovery-1",
				issueId: "issue-1",
				type: "install_dependency",
				label: "安装依赖",
				requiresConfirmation: true,
				dangerous: false,
			}],
			effects: [],
			references: [],
			revision: 2,
			createdAt: "2026-07-29T00:00:00.000Z",
			updatedAt: "2026-07-29T00:01:00.000Z",
		};
		render(<ConfigurationTaskCard task={task} />);
		expect(screen.queryByText("当前阻塞")).not.toBeInTheDocument();
		expect(screen.getByText("读取能力")).toBeInTheDocument();
		expect(screen.getByText(/未检测到 WeCLI/)).toBeInTheDocument();
		expect(screen.getByText(/安装依赖/)).toBeInTheDocument();
		// Tool diagnostics are never surfaced in the card; they stay in logs.
		expect(screen.queryByText("技术详情")).not.toBeInTheDocument();
		expect(
			screen.queryByText(/tool: discover_automation_capabilities/),
		).not.toBeInTheDocument();
	});
});
