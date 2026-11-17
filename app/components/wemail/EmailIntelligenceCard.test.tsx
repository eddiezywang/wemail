import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MailSceneAction } from "shared/wemail/intelligence";
import EmailIntelligenceCard, { extractBodyLinks } from "./EmailIntelligenceCard";

vi.hoisted(() => {
	vi.resetModules();
});

vi.mock("~/hooks/useTodos", () => ({
	useCompleteTodo: () => ({
		mutate: vi.fn(),
		isPending: false,
	}),
}));

vi.mock("./EmailSmartTags", () => ({
	default: () => null,
}));

describe("extractBodyLinks", () => {
	it("never labels links with bare \u201c\u6253\u5f00 {\u57df\u540d}\u201d \u2014 uses meaningful action copy", () => {
		expect(extractBodyLinks("处理入口 https://itsm.example.com/problems/10071940")).toEqual([
			expect.objectContaining({
				url: "https://itsm.example.com/problems/10071940",
				actionText: "查看详情",
				category: "navigate",
			}),
		]);
	});

	it("uses the named system before a bare URL as its label", () => {
		for (const body of [
			"公文管理系统地址：http://portal.example.com",
			'公文管理系统地址：<a href="http://portal.example.com">http://portal.example.com</a>',
		]) {
			expect(extractBodyLinks(body)).toEqual([
				expect.objectContaining({
					url: "http://portal.example.com",
					actionText: "公文管理系统",
					category: "navigate",
				}),
			]);
		}
	});

	it("derives semantic labels from known URL shapes", () => {
		const labelled = (body: string) => extractBodyLinks(body)![0]!.actionText;
		expect(labelled("see https://us02web.zoom.us/j/123")).toBe("加入会议");
		expect(labelled("signed https://sign.docusign.com/x")).toBe("查看审批");
		expect(labelled("doc https://docs.google.com/document/d/x")).toBe("查看文档");
		expect(labelled("get https://a.com/report.pdf")).toBe("下载文件");
		expect(labelled("pay https://pay.example.com/billing")).toBe("查看账单");
	});

	it("uses real anchor text from HTML links (open-ended, not an enum)", () => {
		const html = '<a href="https://git.example.com/org/repo/pull/42">查看PR #42</a>';
		expect(extractBodyLinks(html)![0]).toEqual(
			expect.objectContaining({ url: "https://git.example.com/org/repo/pull/42", actionText: "查看PR #42" }),
		);
	});

	it("filters namespace / schema noise URLs like w3.org", () => {
		const html =
			'<html xmlns="http://www.w3.org/1999/xhtml/"><body>' +
			'<a href="https://portal.example.com/alert/123">查看告警</a></body></html>';
		const links = extractBodyLinks(html)!;
		expect(links.find((l) => l.url.includes("w3.org"))).toBeUndefined();
		expect(links.find((l) => l.actionText === "查看告警")).toBeTruthy();
	});

	it("filters static resources such as PNG images", () => {
		const html =
			'<a href="https://cdn.example.com/assets/banner.png?v=2">Banner</a>' +
			'<a href="https://app.example.com/tickets/42">查看工单</a>';
		expect(extractBodyLinks(html).map((link) => link.url)).toEqual([
			"https://app.example.com/tickets/42",
		]);
	});
});

describe("EmailIntelligenceCard", () => {
	it("does not render a succeeded but empty summary", () => {
		const { container } = render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: ["   "],
					actionItems: [],
					urgency: "low",
				}}
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders only non-empty summary lines", () => {
		render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: ["有效摘要", ""],
					actionItems: ["  ", "需要回复客户"],
					urgency: "medium",
				}}
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		expect(screen.getByText("有效摘要")).toBeInTheDocument();
		expect(screen.getByText("需要回复客户")).toBeInTheDocument();
		expect(screen.queryByText(/摘要内容为空，请重新生成/)).toBeNull();
	});

	it("emphasizes selected text without changing the summary string", () => {
		render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: ["续费价为 ¥6.00/月"],
					actionItems: [],
					urgency: "low",
				}}
				summaryEmphasis={[
					{ target: "bullet", index: 0, start: 5, end: 10 },
				]}
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		const bullets = screen.getByTestId("wemail-intelligence-bullets");
		expect(bullets).toHaveTextContent("续费价为 ¥6.00/月");
		expect(bullets.querySelector("strong")).toHaveTextContent("¥6.00");
	});

	it("renders one-line v2 summaries without detail or action rows", () => {
		render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					schemaVersion: 2,
					intent: "invoice",
					attention: "know",
					displayMode: "one_line",
					headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
					details: ["电子发票可下载或打印。"],
					actions: ["下载并保存电子发票"],
					bullets: ["不应显示旧 bullets"],
					actionItems: ["不应显示旧 actionItems"],
					urgency: "low",
				}}
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		expect(screen.getByText("湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。")).toBeInTheDocument();
		expect(screen.queryByText("电子发票可下载或打印。")).toBeNull();
		expect(screen.queryByText("下载并保存电子发票")).toBeNull();
		expect(screen.queryByText("不应显示旧 bullets")).toBeNull();
	});

	it("renders actionable v2 summaries with explicit actions", () => {
		render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					schemaVersion: 2,
					intent: "request",
					attention: "act",
					displayMode: "actionable",
					headline: "客户要求周五前确认合同条款。",
					details: ["合同第 3 条和第 5 条需要复核。"],
					actions: ["周五前回复客户合同确认意见"],
					bullets: [],
					actionItems: [],
					urgency: "medium",
				}}
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		expect(screen.getByText("客户要求周五前确认合同条款。")).toBeInTheDocument();
		expect(screen.getByText("合同第 3 条和第 5 条需要复核。")).toBeInTheDocument();
		expect(screen.getByText("周五前回复客户合同确认意见")).toBeInTheDocument();
	});

	it("does not render while a summary job is running", () => {
		const { container } = render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="running"
				summary={null}
				summaryJob={{
					id: "job-summary-running",
					status: "running",
					attempts: 1,
					maxAttempts: 2,
					createdAt: "2026-06-30T10:50:00.000Z",
					updatedAt: "2026-06-30T10:54:00.000Z",
					startedAt: "2026-06-30T10:53:00.000Z",
					error: "previous attempt timed out",
				} as any}
				summaryError="previous attempt timed out"
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("does not render attachment-like links inside the summary card", () => {
		render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: ["发票已开具，请在附件区下载。"],
					actionItems: [],
					urgency: "low",
				}}
				tagsStatus="skipped"
				tags={null}
				linksStatus="succeeded"
				links={{
					type: "linkExtraction",
					links: [
						{
							url: "https://example.com/invoice.pdf",
							actionText: "电子发票.pdf",
							category: "download",
							risk: false,
							riskReasons: [],
						},
						{
							url: "https://example.com/activity",
							actionText: "查看安全活动",
							category: "action",
							risk: false,
							riskReasons: [],
						},
					],
					unsubscribeUrl: null,
				}}
			/>,
		);

		expect(screen.queryByText("电子发票.pdf")).toBeNull();
		expect(screen.getByText("查看安全活动")).toBeInTheDocument();
	});

	it("keeps email addresses out of summary action buttons", () => {
		render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: ["名单已经公布。"],
					actionItems: [],
					urgency: "low",
				}}
				tagsStatus="skipped"
				links={{
					type: "linkExtraction",
					links: [
						{
							url: "mailto:team@example.com",
							actionText: "team@example.com",
							category: "navigate",
							risk: false,
							riskReasons: [],
						},
						{
							url: "https://example.com/application",
							actionText: "轮候退出申请",
							category: "action",
							risk: false,
							riskReasons: [],
						},
					],
					unsubscribeUrl: null,
				}}
			/>,
		);

		expect(screen.queryByText("team@example.com")).toBeNull();
		expect(screen.getByText("轮候退出申请")).toBeInTheDocument();
	});

	it("does not render controls for an empty summary", () => {
		const { container } = render(
			<EmailIntelligenceCard
				emailId="email-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: [],
					actionItems: [],
					urgency: "low",
				}}
				tagsStatus="skipped"
				tags={null}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("does not render while summary generation is pending", () => {
		const { container } = render(
			<EmailIntelligenceCard
				emailId="msg-1"
				summaryStatus="pending"
				tagsStatus="skipped"
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("does not render when summary generation failed", () => {
		const { container } = render(
			<EmailIntelligenceCard
				emailId="msg-1"
				summaryStatus="failed"
				summaryError="model unavailable"
				tagsStatus="skipped"
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders monitoring insights and delegates the chart scene action", () => {
		const onSceneAction = vi.fn();
		const action = {
			id: "monitoring.generate_chart" as const,
			scene: "monitoring_report" as const,
			label: "生成图表",
			icon: "chart" as const,
			status: "available" as const,
			agentPrompt: "分析当前邮件并生成图表。",
			risk: "none" as const,
		};
		render(
			<EmailIntelligenceCard
				emailId="monitor-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					schemaVersion: 3,
					headline: "当前失败量为 2。",
					bullets: ["当前失败量为 2。"],
					actionItems: [],
					urgency: "low",
					dataInsight: {
						kind: "monitoring_report",
						metrics: [
							{ label: "调用量", value: "100" },
							{ label: "失败量", value: "2" },
						],
						findings: [{ kind: "fact", text: "当前失败量为 2。" }],
						evidenceLevel: "snapshot",
						chartRecommended: true,
					},
				}}
				tagsStatus="skipped"
				sceneActions={[action]}
				onSceneAction={onSceneAction}
			/>,
		);

		expect(screen.getByRole("button", { name: "生成图表" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "生成图表" }));
		expect(onSceneAction).toHaveBeenCalledWith(action);
	});

	it("renders ordinary summary actions as executable agent buttons", () => {
		const onSceneAction = vi.fn();
		const action: MailSceneAction = {
			id: "summary.action.1",
			scene: "summary_action",
			label: "下周前回复客户是否续约",
			icon: "action",
			status: "available",
			agentPrompt: "基于当前邮件帮助我完成续约回复。",
			risk: "none",
		};
		render(
			<EmailIntelligenceCard
				emailId="request-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					schemaVersion: 3,
					displayMode: "actionable",
					headline: "客户要求下周确认续约。",
					details: [],
					actions: ["下周前回复客户是否续约"],
					actionObligation: "required",
					bullets: ["客户要求下周确认续约。"],
					actionItems: ["下周前回复客户是否续约"],
					urgency: "low",
				}}
				tagsStatus="skipped"
				sceneActions={[action]}
				onSceneAction={onSceneAction}
			/>,
		);

		const button = screen.getByRole("button", { name: "下周前回复客户是否续约" });
		fireEvent.click(button);
		expect(onSceneAction).toHaveBeenCalledWith(action);
	});

	it("renders the insight scope menu through a portal", () => {
		const onSceneAction = vi.fn();
		const primaryAction: MailSceneAction = {
			id: "insight-report.regenerate",
			scene: "insight_report",
			label: "生成洞察报告",
			icon: "chart",
			status: "available",
			agentPrompt: "生成当前邮件的洞察报告。",
			risk: "none",
		};
		const aggregateAction: MailSceneAction = {
			id: "insight-report.aggregate_24h",
			scene: "insight_report",
			label: "最近 24 小时",
			icon: "chart",
			status: "available",
			agentPrompt: "聚合最近 24 小时的相似邮件并生成洞察报告。",
			agentContext: {
				kind: "insight-report",
				operation: "aggregate",
				lookbackPreset: "24h",
			},
			risk: "none",
		};
		const { container } = render(
			<EmailIntelligenceCard
				emailId="report-1"
				summaryStatus="succeeded"
				summary={{
					type: "summary",
					bullets: ["报告数据已准备"],
					actionItems: [],
					urgency: "low",
				}}
				tagsStatus="skipped"
				sceneActions={[primaryAction, aggregateAction]}
				onSceneAction={onSceneAction}
			/>,
		);

		const trigger = screen.getByRole("button", { name: /默认当前邮件/ });
		fireEvent.pointerEnter(trigger.parentElement ?? trigger);

		const menu = screen.getByRole("menu");
		expect(menu).toBeInTheDocument();
		expect(container.contains(menu)).toBe(false);
		// The menu item's accessible name also carries its hint line, so match
		// on the leading label.
		expect(
			screen.getByRole("menuitem", { name: /^当前邮件/ }),
		).toBeInTheDocument();
	});

	it("renders invoice actions even when no summary is ready", () => {
		render(
			<EmailIntelligenceCard
				emailId="invoice-1"
				summaryStatus="pending"
				tagsStatus="skipped"
				sceneActions={[{
					id: "invoice.upload",
					scene: "invoice",
					label: "上传至发票平台",
					icon: "upload",
					status: "available",
					agentPrompt: "上传当前邮件中的发票附件。",
					risk: "confirmation_required",
				}]}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "上传至发票平台" }),
		).toBeInTheDocument();
	});

	it("renders an uploaded invoice as a disabled success state", () => {
		const onSceneAction = vi.fn();
		render(
			<EmailIntelligenceCard
				emailId="invoice-1"
				summaryStatus="pending"
				tagsStatus="skipped"
				sceneActions={[{
					id: "invoice.upload",
					scene: "invoice",
					label: "已上传发票平台",
					icon: "upload",
					status: "completed",
					risk: "none",
				}]}
				onSceneAction={onSceneAction}
			/>,
		);

		const completed = screen.getByRole("button", { name: "已上传发票平台" });
		expect(completed).toBeDisabled();
		expect(completed).toHaveAttribute("data-state", "completed");
		fireEvent.click(completed);
		expect(onSceneAction).not.toHaveBeenCalled();
	});
});
