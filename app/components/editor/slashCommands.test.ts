// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Slash command catalogue + filter unit tests.
 *
 * Covers the pure filter / regroup helpers; the editor-runtime side
 * (insertion, AI bridge) is exercised by the renderer test in
 * `SlashCommandMenu.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
	filterSlashCommands,
	flattenGroups,
	indexInGroups,
	SLASH_COMMANDS,
} from "./slashCommands";

describe("filterSlashCommands", () => {
	it("returns every command grouped when query is empty", () => {
		const groups = filterSlashCommands("");
		const flat = flattenGroups(groups);
		expect(flat).toHaveLength(SLASH_COMMANDS.length);
		// Order: template → ai → insert
		expect(groups.map((g) => g.group)).toEqual([
			"template",
			"ai",
			"insert",
		]);
	});

	it("matches Chinese characters in titles", () => {
		const groups = filterSlashCommands("润");
		const flat = flattenGroups(groups);
		// Should narrow to the polish AI command (id ai-polish).
		expect(flat.map((c) => c.id)).toContain("ai-polish");
		// And drop unrelated groups entirely.
		expect(groups.find((g) => g.group === "template")).toBeUndefined();
	});

	it("matches pinyin keywords", () => {
		const groups = filterSlashCommands("wenhou");
		const flat = flattenGroups(groups);
		expect(flat).toHaveLength(1);
		expect(flat[0].id).toBe("tpl-greeting");
	});

	it("is case-insensitive on latin keywords", () => {
		const lower = flattenGroups(filterSlashCommands("polish"));
		const upper = flattenGroups(filterSlashCommands("POLISH"));
		expect(lower.map((c) => c.id)).toEqual(upper.map((c) => c.id));
		expect(lower.map((c) => c.id)).toContain("ai-polish");
	});

	it("returns no groups when nothing matches", () => {
		expect(filterSlashCommands("zzzzzz-nope")).toEqual([]);
	});

	it("indexInGroups maps a flat index to {group, item}", () => {
		const groups = filterSlashCommands("");
		const flat = flattenGroups(groups);
		// First item is in the first group at item 0.
		expect(indexInGroups(groups, 0)).toEqual({ group: 0, item: 0 });
		// Last item is in the last group.
		const lastIdx = flat.length - 1;
		const last = indexInGroups(groups, lastIdx);
		expect(last).not.toBeNull();
		expect(last!.group).toBe(groups.length - 1);
	});
});

describe("SLASH_COMMANDS catalogue", () => {
	it("has the 13 documented commands", () => {
		expect(SLASH_COMMANDS).toHaveLength(13);
	});

	it("declares 5 templates, 5 ai, 3 insert", () => {
		const by = (g: string) =>
			SLASH_COMMANDS.filter((c) => c.group === g).length;
		expect(by("template")).toBe(5);
		expect(by("ai")).toBe(5);
		expect(by("insert")).toBe(3);
	});

	it("ids are unique", () => {
		const ids = SLASH_COMMANDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
