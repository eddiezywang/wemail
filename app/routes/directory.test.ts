import { describe, expect, it } from "vitest";
import { buildDirectoryContactQueryOptions } from "./directory";

describe("buildDirectoryContactQueryOptions", () => {
	it("includes descendant employees while browsing a selected department", () => {
		expect(buildDirectoryContactQueryOptions("", "root", 2)).toEqual({
			departmentId: "root",
			includeDescendants: true,
			limit: 50,
			offset: 100,
		});
	});

	it("keeps directory search global", () => {
		expect(buildDirectoryContactQueryOptions("evan", "root", 0)).toEqual({
			departmentId: undefined,
			includeDescendants: false,
			limit: 50,
			offset: 0,
		});
	});
});
