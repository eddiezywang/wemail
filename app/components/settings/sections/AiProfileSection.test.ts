import { describe, expect, it } from "vitest";
import {
	responseStyleFromPreference,
	unifiedLanguagePatch,
} from "./AiProfileSection";

describe("AI profile presentation adapter", () => {
	it("hydrates supported presets and safely falls back for legacy free text", () => {
		expect(responseStyleFromPreference(undefined)).toBe("balanced");
		expect(responseStyleFromPreference("回复简洁直接，优先给出结论，避免不必要的客套。"))
			.toBe("concise");
		expect(responseStyleFromPreference("legacy preference that must remain stored"))
			.toBe("balanced");
	});

	it("writes one language choice to all active AI capabilities", () => {
		expect(unifiedLanguagePatch("zh-CN")).toEqual({
			summaryLanguage: "zh-CN",
			todoLanguage: "zh-CN",
			composeLanguage: "zh-CN",
		});
		expect(unifiedLanguagePatch("auto")).toEqual({
			summaryLanguage: undefined,
			todoLanguage: undefined,
			composeLanguage: undefined,
		});
	});
});
