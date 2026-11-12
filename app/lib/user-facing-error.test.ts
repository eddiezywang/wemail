import { describe, expect, it } from "vitest";
import { ApiError } from "~/services/api";
import { getFreeTrialError } from "./user-facing-error";

describe("getFreeTrialError", () => {
	it("explains that restricted networks can block the free AI service", () => {
		expect(getFreeTrialError(new ApiError(502, { error: "network" }))).toContain(
			"检查当前网络是否允许访问",
		);
	});
});
