import { describe, expect, it } from "vitest";
import { getUserFacingError, resolvePublicError } from "./user-facing-error";

describe("uncertain automation outcomes", () => {
	it("asks the user to verify side effects rather than retry", () => {
		const error = { status: 409, body: { publicError: {
			code: "AUTOMATION_OUTCOME_UNKNOWN", messageKey: "outcome_unknown",
			retryable: false, recoveryAction: "none",
		} } };
		expect(getUserFacingError(error)).toContain("核实是否已产生副作用");
		expect(resolvePublicError(error).retryable).toBe(false);
	});
});
