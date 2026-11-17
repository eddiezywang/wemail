import { describe, expect, it } from "vitest";
import {
	LEGACY_SETTINGS_DESTINATIONS,
	resolveSettingsDestination,
} from "./settingsNavigation";

describe("settings navigation migration", () => {
	it("maps old settings to their new destinations", () => {
		expect(LEGACY_SETTINGS_DESTINATIONS.model).toEqual({
			kind: "settings",
			section: "model",
		});
		expect(LEGACY_SETTINGS_DESTINATIONS.mcp).toEqual({
			kind: "settings",
			section: "mcp",
		});
		expect(LEGACY_SETTINGS_DESTINATIONS.notifications).toEqual({
			kind: "settings",
			section: "advanced",
		});
		expect(LEGACY_SETTINGS_DESTINATIONS["custom-ai"]).toEqual({
			kind: "settings",
			section: "ai",
		});
		expect(LEGACY_SETTINGS_DESTINATIONS["ai-summary"]).toEqual({
			kind: "route",
			to: "/digests",
		});
		expect(LEGACY_SETTINGS_DESTINATIONS.automation).toEqual({
			kind: "route",
			to: "/automation",
		});
		expect(LEGACY_SETTINGS_DESTINATIONS["writing-style"]).toEqual({
			kind: "route",
			to: "/?compose=styles",
		});
	});

	it("keeps current sections and falls unknown values back to Account", () => {
		expect(resolveSettingsDestination("model")).toEqual({
			kind: "settings",
			section: "model",
		});
		expect(resolveSettingsDestination("mcp")).toEqual({
			kind: "settings",
			section: "mcp",
		});
		expect(resolveSettingsDestination("advanced")).toEqual({
			kind: "settings",
			section: "advanced",
		});
		expect(resolveSettingsDestination("not-real")).toEqual({
			kind: "settings",
			section: "account",
		});
	});
});
