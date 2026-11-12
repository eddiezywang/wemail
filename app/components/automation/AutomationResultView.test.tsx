import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AutomationRunResultEnvelope } from "../../../shared/wemail/automationCenter";
import { AutomationResultView } from "./AutomationResultView";

describe("AutomationResultView", () => {
	it("renders validated subscription insight with bounded source links", () => {
		const envelope: AutomationRunResultEnvelope = {
			resultType: "wemail.subscriptionDailyInsight",
			schemaVersion: 1,
			rendererId: "wemail.subscriptionDailyInsight",
			rendererVersion: "1.0.0",
			data: {
				type: "subscriptionDailyInsight",
				schemaVersion: 1,
				window: {
					start: "2026-07-29T00:00:00.000Z",
					end: "2026-07-30T00:00:00.000Z",
					timezone: "Asia/Shanghai",
				},
				accountCount: 2,
				topHighlights: [
					{
						id: "highlight-1",
						kind: "risk",
						text: "平台发布了安全更新",
						sourceEmails: Array.from({ length: 6 }, (_, index) => ({
							type: "email" as const,
							accountId: `acct-${index % 2}`,
							emailId: `mail-${index}`,
							label: `来源 ${index + 1}`,
							...(index === 1
								? { availability: "account_disconnected" as const }
								: {}),
						})),
					},
				],
				curatedCategories: [],
				recommendedActions: [],
				keepSubscriptions: [{ id: "keep-1", sourceName: "Platform", reason: "内容具体且与决策相关。", sourceEmails: [] }],
				stats: {
					scanned: 20,
					selected: 3,
					excluded: 17,
					groups: 1,
					truncated: false,
					perAccount: {},
				},
			},
			provenance: [],
			actionCandidates: [],
		};
		render(<AutomationResultView envelope={envelope} />);
		expect(screen.getByTestId("subscription-insight-result")).toBeInTheDocument();
		expect(screen.getByText("平台发布了安全更新")).toBeInTheDocument();
		expect(screen.getAllByRole("link")).toHaveLength(1);
		expect(screen.getByText(/Platform/)).toBeInTheDocument();
	});

	it("renders explicit empty and bounded partial states", () => {
		const base: AutomationRunResultEnvelope = {
			resultType: "wemail.subscriptionDailyInsight",
			schemaVersion: 1,
			rendererId: "wemail.subscriptionDailyInsight",
			rendererVersion: "1.0.0",
			data: {
				type: "subscriptionDailyInsight",
				schemaVersion: 1,
				window: {
					start: "2026-07-29T00:00:00.000Z",
					end: "2026-07-30T00:00:00.000Z",
					timezone: "Asia/Shanghai",
				},
				accountCount: 1,
				topHighlights: [],
				curatedCategories: [],
				recommendedActions: [],
				keepSubscriptions: [],
				stats: {
					scanned: 8,
					selected: 0,
					excluded: 8,
					groups: 0,
					truncated: false,
					perAccount: {},
				},
				emptyReason: "noCandidates",
			},
			provenance: [],
			actionCandidates: [],
		};
		const { rerender } = render(<AutomationResultView envelope={base} />);
		expect(screen.getByText("过去 24 小时未发现值得整理的营销、简报或订阅更新。")).toBeInTheDocument();

		rerender(
			<AutomationResultView
				envelope={{
					...base,
					data: {
						...base.data as Extract<typeof base.data, object>,
						topHighlights: [
							{ id: "h", kind: "update", text: "更新", sourceEmails: [] },
						],
						stats: {
							scanned: 400,
							selected: 12,
							excluded: 388,
							groups: 1,
							truncated: true,
							perAccount: {},
						},
						emptyReason: undefined,
					},
				}}
			/>,
		);
		expect(screen.getByText(/数据量超过上限/)).toHaveTextContent("已扫描 400 封，选中 12 封");
	});

	it("uses a safe fallback for unavailable historical renderers", () => {
		render(
			<AutomationResultView
				envelope={{
					resultType: "historical.result",
					schemaVersion: 1,
					rendererId: "missing",
					rendererVersion: "0.1.0",
					data: { secret: "must not be rendered as arbitrary markup" },
					provenance: [],
					actionCandidates: [],
				}}
			/>,
		);
		expect(screen.getByText("当前版本没有匹配的安全渲染器。")).toBeInTheDocument();
		expect(screen.queryByText("must not be rendered as arbitrary markup")).not.toBeInTheDocument();
	});
});
