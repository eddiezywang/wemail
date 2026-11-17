import { describe, expect, it } from "vitest";
import {
	buildComposeSpellcheckExemptWords,
	findSpellcheckExemptRanges,
} from "./spellcheck";

describe("compose spellcheck exemptions", () => {
	it("builds a case-insensitive account word list without custom signature text", () => {
		expect(
			buildComposeSpellcheckExemptWords({
				displayName: " Eddie Wang ",
				emailAddress: "eddie.wang@example.com",
			}),
		).toEqual(["WeMail", "Eddie", "Wang", "eddie.wang"]);
	});

	it("falls back to the product word when account identity is unavailable", () => {
		expect(buildComposeSpellcheckExemptWords({})).toEqual(["WeMail"]);
	});

	it("matches complete allowlisted words throughout a text node", () => {
		const text = "WeMail wemail WeMailer eddiewang AIMC";
		const matches = findSpellcheckExemptRanges(text, [
			"WeMail",
			"eddiewang",
		]);

		expect(matches.map(({ from, to }) => text.slice(from, to))).toEqual([
			"WeMail",
			"wemail",
			"eddiewang",
		]);
	});

	it("prefers the longest non-overlapping account identity match", () => {
		const text = "john.smith wrote";
		const matches = findSpellcheckExemptRanges(text, [
			"john.smith",
			"john",
			"smith",
		]);

		expect(matches).toEqual([{ from: 0, to: 10 }]);
	});
});
