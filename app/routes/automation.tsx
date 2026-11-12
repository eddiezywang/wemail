import { AutomationCenter } from "~/components/automation/AutomationCenter";
import { SmartFiltersSection } from "~/components/settings/sections/SmartFiltersSection";
import { PageFrame } from "~/components/wemail/PageFrame";
import { automationFeatureFlags } from "~/lib/automation-feature-flags";

export function meta() {
	return [{ title: "自动化 / WeMail" }];
}

function AutomationPage() {
	if (automationFeatureFlags.unifiedCenter) return <AutomationCenter />;
	return (
		<PageFrame
			title="自动化"
			subtitle="根据邮件条件自动分类和处理。"
			testId="automation-page"
		>
			<SmartFiltersSection />
		</PageFrame>
	);
}

export default function AutomationRoute() {
	return <AutomationPage />;
}
