import { describe, expect, it } from "vitest";
import { getComposeError, getComposeSubmitError } from "./compose-errors";

describe("compose error recovery", () => {
	it("explains missing reply metadata without exposing raw errors", () => {
		expect(getComposeError(new Error("reply-source-message-id-unavailable"), "fallback")).toContain("原邮件");
	});
	it("warns about an unknown submission outcome before retrying", () => {
		expect(getComposeSubmitError(new Error("request timed out"), "fallback")).toContain("提交结果不确定");
	});
});
