// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	formatListDate,
	formatDetailDate,
	formatShortDate,
	formatQuotedDate,
} from "./dates.js";

describe("formatListDate", () => {
	it("returns the input string for invalid dates", () => {
		expect(formatListDate("not-a-date")).toBe("not-a-date");
	});

	it("formats today's date as HH:mm only", () => {
		const now = new Date();
		const result = formatListDate(now.toISOString());
		// Should match a 24h time like "08:42" — never contain Chinese day char
		expect(result).toMatch(/^\d{2}:\d{2}$/);
		expect(result).not.toContain("日");
	});

	it("formats this year's date as M月D日", () => {
		const date = new Date();
		date.setMonth(0, 15); // Jan 15 of current year
		date.setHours(10, 0, 0, 0);
		const result = formatListDate(date.toISOString());
		expect(result).toBe("1月15日");
	});

	it("formats older dates with year prefix", () => {
		const result = formatListDate("2024-04-15T10:00:00.000Z");
		expect(result).toMatch(/^2024年\d{1,2}月\d{1,2}日$/);
		expect(result).toContain("2024年");
	});
});

describe("formatDetailDate", () => {
	it("returns the input string for invalid dates", () => {
		expect(formatDetailDate("bad")).toBe("bad");
	});

	it("formats as M月D日 周X HH:mm", () => {
		// Use a fixed local-time construction to avoid TZ flakiness:
		// March 29 2026 was a Sunday locally everywhere it parses to 2026-03-29.
		const local = new Date(2026, 2, 29, 20, 55, 0);
		const result = formatDetailDate(local.toISOString());
		expect(result).toBe("3月29日 周日 20:55");
	});

	it("zero-pads single-digit hours and minutes", () => {
		const local = new Date(2026, 0, 5, 9, 7, 0);
		const result = formatDetailDate(local.toISOString());
		expect(result).toMatch(/^1月5日 周. 09:07$/);
	});
});

describe("formatShortDate", () => {
	it("returns the input string for invalid dates", () => {
		expect(formatShortDate("invalid")).toBe("invalid");
	});

	it("formats today as HH:mm only", () => {
		const now = new Date();
		const result = formatShortDate(now.toISOString());
		expect(result).toMatch(/^\d{2}:\d{2}$/);
	});

	it("formats other days as M月D日 HH:mm", () => {
		const local = new Date(2026, 2, 29, 20, 55, 0);
		const result = formatShortDate(local.toISOString());
		expect(result).toBe("3月29日 20:55");
	});
});

describe("formatQuotedDate", () => {
	it("returns empty string for undefined input", () => {
		expect(formatQuotedDate(undefined)).toBe("");
	});

	it("returns the input string for invalid dates", () => {
		expect(formatQuotedDate("not-a-date")).toBe("not-a-date");
	});

	it("formats with en-US locale for deterministic output", () => {
		const result = formatQuotedDate("2026-04-15T15:42:00.000Z");
		expect(result).toMatch(/Apr/);
		expect(result).toContain("2026");
	});
});
