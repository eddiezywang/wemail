import { expect, test } from "vitest";
import { PROVIDER_PRESETS } from "./providers.js";

test("163 provider uses the current help URL", () => {
	const provider = PROVIDER_PRESETS.find((preset) => preset.id === "netease-163");

	expect(provider?.helpUrl).toBe(
		"https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac25ef2e192b234ae4d",
	);
});
