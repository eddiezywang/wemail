export interface AutomationFeatureFlags {
	unifiedCenter: boolean;
	structuredCanonicalEditing: boolean;
	templateCatalog: boolean;
	crossAccountScope: boolean;
	subscriptionInsight: boolean;
}

type AutomationFeatureEnvironment = Partial<
	Record<
		| "VITE_WEMAIL_UNIFIED_AUTOMATION_CENTER"
		| "VITE_WEMAIL_STRUCTURED_AUTOMATION_EDITING"
		| "VITE_WEMAIL_AUTOMATION_TEMPLATE_CATALOG"
		| "VITE_WEMAIL_CROSS_ACCOUNT_AUTOMATION"
		| "VITE_WEMAIL_SUBSCRIPTION_INSIGHT",
		string
	>
>;

export function readAutomationFeatureFlags(
	environment: AutomationFeatureEnvironment,
): AutomationFeatureFlags {
	return {
		unifiedCenter: environment.VITE_WEMAIL_UNIFIED_AUTOMATION_CENTER !== "0",
		structuredCanonicalEditing:
			environment.VITE_WEMAIL_STRUCTURED_AUTOMATION_EDITING !== "0",
		templateCatalog:
			environment.VITE_WEMAIL_AUTOMATION_TEMPLATE_CATALOG !== "0",
		crossAccountScope:
			environment.VITE_WEMAIL_CROSS_ACCOUNT_AUTOMATION !== "0",
		subscriptionInsight:
			environment.VITE_WEMAIL_SUBSCRIPTION_INSIGHT !== "0",
	};
}

export const automationFeatureFlags = readAutomationFeatureFlags(
	import.meta.env as unknown as AutomationFeatureEnvironment,
);
