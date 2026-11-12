import { describe, expect, it } from "vitest";
import {
	hasEditableComposeContent,
	mergeComposeAiBody,
	splitComposeAiBody,
} from "./composeAiBody";

describe("compose AI body protection", () => {
	it("treats signature-only content as an empty editable draft", () => {
		expect(
			hasEditableComposeContent(
				'<p><br></p><div data-wemail-signature="true">Alice</div>',
			),
		).toBe(false);
		expect(
			hasEditableComposeContent(
				'<p>Received, thank you.</p><div data-wemail-signature="true">Alice</div>',
			),
		).toBe(true);
	});

	it("separates editable content from signature and quoted reply", () => {
		const body = [
			"<p>Current reply</p>",
			'<div data-wemail-signature="true">--<br>Eddie</div>',
			'<br><blockquote data-wemail-quoted-reply="true">Original</blockquote>',
		].join("");

		const result = splitComposeAiBody(body);

		expect(result.editableHtml).toBe("<p>Current reply</p>");
		expect(result.protectedHtml).toContain("Eddie");
		expect(result.protectedHtml).toContain("Original");
	});

	it("merges generated content before the unchanged protected tail", () => {
		const protectedHtml =
			'<div data-wemail-signature="true">--<br>Eddie</div>';

		expect(
			mergeComposeAiBody("<p>Generated reply</p>", protectedHtml),
		).toBe(
			'<p>Generated reply</p><div data-wemail-signature="true">--<br>Eddie</div>',
		);
	});

	it("protects forwarded mail when no signature is present", () => {
		const body =
			'<p>Forwarding this for review.</p><div data-wemail-forwarded-message="true"><p>Original</p></div>';

		const result = splitComposeAiBody(body);

		expect(result.editableHtml).toBe("<p>Forwarding this for review.</p>");
		expect(result.protectedHtml).toContain("Original");
	});

	it("treats an unmarked legacy blockquote as protected", () => {
		const body =
			'<p>Reply</p><br><blockquote style="border-left: 2px solid #ccc">Original</blockquote>';

		const result = splitComposeAiBody(body);

		expect(result.editableHtml).toBe("<p>Reply</p>");
		expect(result.protectedHtml).toContain("Original");
	});
});
