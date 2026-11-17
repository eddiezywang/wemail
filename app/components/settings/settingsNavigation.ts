import type { SettingsSection } from "~/hooks/useUIStore";

export type LegacySettingsSection =
	| "model"
	| "custom-ai"
	| "ai-summary"
	| "ai-learning"
	| "ai-usage"
	| "smart-filters"
	| "automation"
	| "writing-style"
	| "inbox"
	| "compose"
	| "storage"
	| "security"
	| "mcp"
	| "mail"
	| "signature"
	| "notifications"
	| "shortcuts"
	| "language";

export type SettingsDestination =
	| { kind: "settings"; section: SettingsSection }
	| { kind: "route"; to: string };

const PRIMARY_SECTIONS = new Set<SettingsSection>([
	"account",
	"ai",
	"model",
	"mcp",
	"connections",
	"skills",
	"appearance",
	"about",
	"advanced",
]);

export const LEGACY_SETTINGS_DESTINATIONS: Record<
	LegacySettingsSection,
	SettingsDestination
> = {
	model: { kind: "settings", section: "model" },
	"custom-ai": { kind: "settings", section: "ai" },
	"ai-summary": { kind: "route", to: "/digests" },
	"ai-learning": { kind: "route", to: "/workspace" },
	"ai-usage": { kind: "settings", section: "account" },
	"smart-filters": { kind: "route", to: "/automation" },
	automation: { kind: "route", to: "/automation" },
	"writing-style": { kind: "route", to: "/?compose=styles" },
	inbox: { kind: "settings", section: "advanced" },
	compose: { kind: "settings", section: "advanced" },
	storage: { kind: "settings", section: "advanced" },
	security: { kind: "settings", section: "advanced" },
	mcp: { kind: "settings", section: "mcp" },
	mail: { kind: "settings", section: "advanced" },
	signature: { kind: "settings", section: "advanced" },
	notifications: { kind: "settings", section: "advanced" },
	shortcuts: { kind: "settings", section: "advanced" },
	language: { kind: "settings", section: "advanced" },
};

export function resolveSettingsDestination(
	section: string | null | undefined,
): SettingsDestination {
	if (!section) return { kind: "settings", section: "account" };
	if (PRIMARY_SECTIONS.has(section as SettingsSection)) {
		return { kind: "settings", section: section as SettingsSection };
	}
	return (
		LEGACY_SETTINGS_DESTINATIONS[section as LegacySettingsSection] ?? {
			kind: "settings",
			section: "account",
		}
	);
}
