import { describe, expect, it } from "vitest";
import { mergeModelRows, type UsageModelRow } from "./aiUsageModelRows";

// Regression: the AI usage "按模型" list used to split one model into several
// rows when it was reached via different provider protocols (openai- vs
// anthropic-compatible), because the frontend grouped by `${provider}␀${model}`.
// For free / multi-protocol models the provider label is hidden, so the rows
// looked identical. mergeModelRows must collapse every provider row for a
// model into a single entry.

describe("mergeModelRows", () => {
	it("collapses rows that share a model name across different providers", () => {
		// The screenshot scenario: one deepseek-v4-flash, three protocol rows.
		const rows: UsageModelRow[] = [
			{ provider: "openai", model: "deepseek-v4-flash", tokens: 26_000_000, inputTokens: 20_000_000, outputTokens: 6_000_000, calls: 9539 },
			{ provider: "anthropic", model: "deepseek-v4-flash", tokens: 14_000_000, inputTokens: 12_000_000, outputTokens: 2_000_000, calls: 4547 },
			{ provider: "unknown", model: "deepseek-v4-flash", tokens: 620_000, inputTokens: 400_000, outputTokens: 220_000, calls: 475 },
		];

		const merged = mergeModelRows(rows);

		expect(merged).toHaveLength(1);
		const [row] = merged;
		expect(row.model).toBe("deepseek-v4-flash");
		expect(row.tokens).toBe(40_620_000);
		expect(row.calls).toBe(14_561);
		expect(row.inputTokens).toBe(32_400_000);
		expect(row.outputTokens).toBe(8_220_000);
		// Mixed providers → no single provider to label, so it collapses to unknown
		// and the UI renders no protocol prefix.
		expect(row.provider).toBe("unknown");
	});

	it("keeps the provider label when every row for a model used the same provider", () => {
		const rows: UsageModelRow[] = [
			{ provider: "openai", model: "glm-5.2", tokens: 203_000, inputTokens: 160_000, outputTokens: 43_000, calls: 54 },
			{ provider: "openai", model: "glm-5.2", tokens: 100_000, inputTokens: 80_000, outputTokens: 20_000, calls: 10 },
		];

		const merged = mergeModelRows(rows);

		expect(merged).toHaveLength(1);
		expect(merged[0]!.model).toBe("glm-5.2");
		expect(merged[0]!.provider).toBe("openai");
		expect(merged[0]!.tokens).toBe(303_000);
		expect(merged[0]!.calls).toBe(64);
	});

	it("treats an all-unknown model as unknown (no provider label)", () => {
		const rows: UsageModelRow[] = [
			{ provider: "unknown", model: "hy3", tokens: 26_400, inputTokens: 24_000, outputTokens: 2_400, calls: 2 },
		];

		const [row] = mergeModelRows(rows);

		expect(row.provider).toBe("unknown");
	});

	it("keeps distinct models as separate rows sorted by tokens descending", () => {
		const rows: UsageModelRow[] = [
			{ provider: "openai", model: "gpt-3.6-luna", tokens: 109_000, inputTokens: 92_000, outputTokens: 17_000, calls: 52 },
			{ provider: "openai", model: "glm-5.2", tokens: 203_000, inputTokens: 160_000, outputTokens: 43_000, calls: 54 },
			{ provider: "openai", model: "hy3", tokens: 26_400, inputTokens: 24_000, outputTokens: 2_400, calls: 2 },
		];

		const merged = mergeModelRows(rows);

		expect(merged.map((r) => r.model)).toEqual(["glm-5.2", "gpt-3.6-luna", "hy3"]);
	});

	it("borrows the single known provider for rows that were recorded as unknown", () => {
		// Backend sometimes records provider as unknown even when the same model is
		// otherwise always served by one provider; keep that label available.
		const rows: UsageModelRow[] = [
			{ provider: "anthropic", model: "claude-sonnet", tokens: 500, inputTokens: 400, outputTokens: 100, calls: 5 },
			{ provider: "unknown", model: "claude-sonnet", tokens: 100, inputTokens: 80, outputTokens: 20, calls: 1 },
		];

		const [row] = mergeModelRows(rows);

		expect(row.provider).toBe("anthropic");
		expect(row.tokens).toBe(600);
	});

	it("returns an empty list for no input", () => {
		expect(mergeModelRows([])).toEqual([]);
	});
});
