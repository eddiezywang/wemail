// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	autoCloseStreamingFence,
	hasUnclosedCodeFence,
	isFarFromBottom,
	JUMP_TO_LATEST_THRESHOLD_PX,
} from "./streamingMarkdown";

describe("hasUnclosedCodeFence", () => {
	it("returns false for empty input", () => {
		expect(hasUnclosedCodeFence("")).toBe(false);
	});

	it("returns false for plain prose", () => {
		expect(hasUnclosedCodeFence("hello there, no code here")).toBe(false);
	});

	it("returns true when a backtick fence has no closer", () => {
		expect(hasUnclosedCodeFence("```js\nconst x = 1")).toBe(true);
	});

	it("returns false once the closing backtick fence arrives", () => {
		expect(hasUnclosedCodeFence("```js\nconst x = 1\n```")).toBe(false);
	});

	it("returns true when the second of two blocks is unclosed", () => {
		const text = [
			"```js",
			"const a = 1;",
			"```",
			"some prose",
			"```ts",
			"const b: number = 2;",
		].join("\n");
		expect(hasUnclosedCodeFence(text)).toBe(true);
	});

	it("handles tilde fences the same as backticks", () => {
		expect(hasUnclosedCodeFence("~~~py\nprint('hi')")).toBe(true);
		expect(hasUnclosedCodeFence("~~~py\nprint('hi')\n~~~")).toBe(false);
	});

	it("does not treat a backtick fence as closed by a tilde fence", () => {
		// Mismatched markers — backtick fence is still open.
		expect(hasUnclosedCodeFence("```\nfoo\n~~~")).toBe(true);
	});

	it("ignores inline single-backtick code", () => {
		expect(hasUnclosedCodeFence("use `foo` to call the helper")).toBe(false);
	});

	it("requires the closing fence to match or exceed the opening length", () => {
		// Open with 4 backticks; close attempt with only 3 should not close.
		expect(hasUnclosedCodeFence("````\nstuff\n```")).toBe(true);
		expect(hasUnclosedCodeFence("````\nstuff\n````")).toBe(false);
	});
});

describe("autoCloseStreamingFence", () => {
	it("returns input unchanged when there is no open fence", () => {
		const result = autoCloseStreamingFence("hello world");
		expect(result.didAutoClose).toBe(false);
		expect(result.text).toBe("hello world");
	});

	it("appends a closing backtick fence when one is missing", () => {
		const result = autoCloseStreamingFence("```js\nconst x = 1");
		expect(result.didAutoClose).toBe(true);
		expect(result.text.endsWith("\n```")).toBe(true);
	});

	it("appends a tilde closer for an unclosed tilde fence", () => {
		const result = autoCloseStreamingFence("~~~\nx");
		expect(result.didAutoClose).toBe(true);
		expect(result.text.endsWith("\n~~~")).toBe(true);
	});

	it("matches the fence length of the opener", () => {
		const result = autoCloseStreamingFence("````ts\nx");
		expect(result.didAutoClose).toBe(true);
		expect(result.text.endsWith("\n````")).toBe(true);
	});
});

describe("isFarFromBottom", () => {
	const clientHeight = 400;
	const scrollHeight = 2000;

	it("returns false when scrolled to the bottom", () => {
		expect(
			isFarFromBottom({
				scrollTop: scrollHeight - clientHeight,
				scrollHeight,
				clientHeight,
			}),
		).toBe(false);
	});

	it("returns false when within the threshold of the bottom", () => {
		expect(
			isFarFromBottom({
				scrollTop: scrollHeight - clientHeight - (JUMP_TO_LATEST_THRESHOLD_PX - 1),
				scrollHeight,
				clientHeight,
			}),
		).toBe(false);
	});

	it("returns true when scrolled past the threshold", () => {
		expect(
			isFarFromBottom({
				scrollTop: scrollHeight - clientHeight - (JUMP_TO_LATEST_THRESHOLD_PX + 50),
				scrollHeight,
				clientHeight,
			}),
		).toBe(true);
	});

	it("returns false at exactly the threshold (boundary not far)", () => {
		expect(
			isFarFromBottom({
				scrollTop: scrollHeight - clientHeight - JUMP_TO_LATEST_THRESHOLD_PX,
				scrollHeight,
				clientHeight,
			}),
		).toBe(false);
	});
});
