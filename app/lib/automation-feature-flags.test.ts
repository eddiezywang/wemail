import { describe, expect, it } from "vitest";
import { readAutomationFeatureFlags } from "./automation-feature-flags";

describe("readAutomationFeatureFlags", () => {
	it("enables the new automation surfaces by default", () => {
		expect(readAutomationFeatureFlags({})).toEqual({
			unifiedCenter: true,
			structuredCanonicalEditing: true,
			templateCatalog: true,
			crossAccountScope: true,
			subscriptionInsight: true,
		});
	});

	it("supports independent non-destructive rollback flags", () => {
		expect(
			readAutomationFeatureFlags({
				VITE_WEMAIL_UNIFIED_AUTOMATION_CENTER: "0",
				VITE_WEMAIL_STRUCTURED_AUTOMATION_EDITING: "0",
				VITE_WEMAIL_AUTOMATION_TEMPLATE_CATALOG: "0",
				VITE_WEMAIL_CROSS_ACCOUNT_AUTOMATION: "0",
				VITE_WEMAIL_SUBSCRIPTION_INSIGHT: "0",
			}),
		).toEqual({
			unifiedCenter: false,
			structuredCanonicalEditing: false,
			templateCatalog: false,
			crossAccountScope: false,
			subscriptionInsight: false,
		});
	});
});
