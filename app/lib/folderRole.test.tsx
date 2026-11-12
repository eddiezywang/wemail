// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { folderRole } from "./folderRole";
import { getFolderDisplayName } from "shared/folders";

describe("folderRole", () => {
	it("renders inbox protocol aliases as 收件箱", () => {
		expect(getFolderDisplayName("INBOX")).toBe("收件箱");
		expect(getFolderDisplayName("Inbox")).toBe("收件箱");
		expect(getFolderDisplayName("inbox")).toBe("收件箱");
	});
	it.each([
		["INBOX", "inbox"],
		["inbox", "inbox"],
		["[Gmail]/Sent Mail", "sent"],
		["Sent Items", "sent"],
		["Sent", "sent"],
		["送信済み", "sent"],
		["[Gmail]/Drafts", "drafts"],
		["Drafts", "drafts"],
		["草稿", "drafts"],
		["[Gmail]/Trash", "trash"],
		["Trash", "trash"],
		["Bin", "trash"],
		["Deleted Items", "trash"],
		["Archive", "archive"],
		["[Gmail]/All Mail", "archive"],
		["归档", "archive"],
		["MyCustomLabel", "custom"],
		["Travel/2024", "custom"],
		["", "custom"],
	])("%s → %s", (input, expected) => {
		expect(folderRole(input)).toBe(expected);
	});

	it("trims whitespace", () => {
		expect(folderRole("  INBOX  ")).toBe("inbox");
	});
});
