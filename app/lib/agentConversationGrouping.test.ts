// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	conversationGroupKey,
	groupByConversationTime,
} from "./utils";

// Use a fixed local-noon `now` so the start-of-day boundary lands at
// midnight in the test runner's TZ. Items are then crafted relative to
// that so the grouping is timezone-agnostic.
const NOW = new Date(2026, 3, 27, 12, 0, 0, 0);
const ONE_DAY = 24 * 60 * 60 * 1000;
function isoBefore(days: number, hours = 0): string {
	return new Date(NOW.getTime() - days * ONE_DAY - hours * 3600_000).toISOString();
}

describe("conversationGroupKey", () => {
	it("buckets today / yesterday / past 7 / past 30 / older months", () => {
		expect(conversationGroupKey(isoBefore(0, 4), NOW).bucket).toBe("today");
		expect(conversationGroupKey(isoBefore(1, 2), NOW).bucket).toBe(
			"yesterday",
		);
		expect(conversationGroupKey(isoBefore(4), NOW).bucket).toBe("past7");
		expect(conversationGroupKey(isoBefore(15), NOW).bucket).toBe("past30");
		// 70 days back lands in February 2026 regardless of TZ since NOW is
		// April 27 noon local.
		const older = conversationGroupKey(isoBefore(70), NOW);
		expect(older.bucket).toBe("older");
		expect(older.id).toMatch(/^older-2026-0[12]$/);
	});

	it("falls back to a stable label for invalid timestamps", () => {
		const k = conversationGroupKey("not-a-date", NOW);
		expect(k.bucket).toBe("older");
		expect(k.id).toBe("older-unknown");
	});
});

describe("groupByConversationTime", () => {
	it("preserves input order within groups and emits groups in first-occurrence order", () => {
		const items = [
			{ id: "a", iso: isoBefore(0, 1) },
			{ id: "b", iso: isoBefore(1, 1) },
			{ id: "c", iso: isoBefore(0, 5) },
			{ id: "d", iso: isoBefore(4) },
			{ id: "e", iso: isoBefore(15) },
			{ id: "f", iso: isoBefore(80) },
		];
		const grouped = groupByConversationTime(items, (i) => i.iso, NOW);
		expect(grouped.map((g) => g.key.bucket)).toEqual([
			"today",
			"yesterday",
			"past7",
			"past30",
			"older",
		]);
		expect(grouped[0].items.map((i) => i.id)).toEqual(["a", "c"]);
	});

	it("returns an empty array for no items", () => {
		expect(groupByConversationTime([], () => "")).toEqual([]);
	});
});
