import { describe, expect, it } from "vitest";
import type { AgentActionExecutionResult } from "~/services/api";
import {
	formatAgentExecutionMessage,
	friendlyToolLabel,
	sanitizeAgentDisplayText,
} from "./agent-display";

describe("sanitizeAgentDisplayText", () => {
	it("removes internal citation metadata while keeping the business answer", () => {
		const text =
			"邮件已找到，快递单号为 SF123。\n（emailId: acct-1:INBOX:1:10, tool: summarize_mail, path: summary.headline）";

		expect(sanitizeAgentDisplayText(text)).toBe("邮件已找到，快递单号为 SF123。");
	});

	it("does not remove ordinary Chinese wording about tools and paths", () => {
		const text = "请检查工具路径是否正确，然后继续处理。";

		expect(sanitizeAgentDisplayText(text)).toBe(text);
	});

	it("cleans legacy suggestion prompts that embedded a mail id", () => {
		expect(
			sanitizeAgentDisplayText("总结这封邮件 acct-1782584815363:INBOX:1:10，列出重点。"),
		).toBe("总结这封邮件，列出重点。");
		expect(
			sanitizeAgentDisplayText("阅读当前邮件 acct-1:INBOX:1:10，查找附件。"),
		).toBe("阅读当前邮件，查找附件。");
	});
});

describe("friendlyToolLabel", () => {
	it("uses human-facing labels and never falls back to the raw tool name", () => {
		expect(friendlyToolLabel("summarize_mail").label).toBe("整理邮件");
		expect(friendlyToolLabel("internal_secret_tool").label).toBe("正在执行一项操作");
		expect(friendlyToolLabel("internal_secret_tool").label).not.toContain(
			"internal_secret_tool",
		);
	});
});

describe("formatAgentExecutionMessage", () => {
	it("summarizes the outcome as a count without implementation details", () => {
		const execution: AgentActionExecutionResult = {
			ok: true,
			summary: "已完成：上传 1 个发票附件",
			items: [
				{
					filename: "invoice.pdf",
					ok: true,
					command: "wecli allowance upload --file invoice.pdf",
					binary: "wecli",
					resolvedBinary: "C:\\Program Files\\wecli.exe",
					args: ["allowance", "upload"],
					errorCode: "EXIT_0",
					stdout: "uploaded",
					stderr: "",
				},
			],
		};

		const formatted = formatAgentExecutionMessage(execution);
		expect(formatted).toBe("操作已完成，共处理 1 项。");
		expect(formatted).not.toMatch(/命令|可执行文件|解析路径|参数|错误码|stdout|stderr|wecli|Program Files/);
		// Filenames from the execution items stay out of the surfaced message.
		expect(formatted).not.toContain("invoice.pdf");
	});

	it("keeps a concise human-readable failure reason", () => {
		const execution: AgentActionExecutionResult = {
			ok: false,
			summary: "上传未完成",
			items: [{ filename: "invoice.pdf", ok: false, error: "登录已过期" }],
		};

		expect(formatAgentExecutionMessage(execution)).toBe(
			"操作未能全部完成，1 项需要重试。",
		);
	});
});
