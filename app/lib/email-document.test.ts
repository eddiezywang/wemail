import { beforeEach, describe, expect, test } from "vitest";
import {
	clearPreparedEmailDocumentCache,
	getCachedEmailDocument,
	getPreparedEmailDocumentCacheStats,
	prepareEmailDocument,
} from "./email-document";

describe("prepareEmailDocument", () => {
	beforeEach(() => clearPreparedEmailDocumentCache());

	test("reuses a prepared document for the same body and options", () => {
		const input = { body: "<p>Hello</p>", autoSize: true };
		const first = prepareEmailDocument(input);
		const second = prepareEmailDocument(input);

		expect(second).toBe(first);
		expect(getPreparedEmailDocumentCacheStats()).toMatchObject({
			entries: 1,
			hits: 1,
			misses: 1,
		});
	});

	test("getCachedEmailDocument returns the prepared doc synchronously on a hit", () => {
		const input = { body: "<p>Hello</p>", autoSize: true };
		const prepared = prepareEmailDocument(input);

		expect(getCachedEmailDocument(input)).toBe(prepared);
		// A hit moves the entry to MRU and counts as a cache hit.
		expect(getPreparedEmailDocumentCacheStats().hits).toBe(1);
	});

	test("getCachedEmailDocument returns undefined on a miss without preparing", () => {
		expect(getCachedEmailDocument({ body: "<p>Never prepared</p>" })).toBeUndefined();
		expect(getPreparedEmailDocumentCacheStats().misses).toBe(0);
	});

	test("sanitizes and transforms images, links, and highlights in one result", () => {
		const result = prepareEmailDocument({
			body: '<script>bad()</script><a href="https://example.com">Hello</a><img src="http://img.example.com/a.png"><img src="http://127.0.0.1:8787/a.png">',
			highlightTerms: ["Hello"],
		});

		expect(result).not.toContain("bad()");
		expect(result).toContain('data-wemail-email-link="true"');
		expect(result).toContain("/api/mail/remote-images?url=http%3A%2F%2Fimg.example.com%2Fa.png");
		expect(result).toContain('data-wemail-remote-image="true"');
		expect(result).toContain('src="http://127.0.0.1:8787/a.png"');
		expect(result).toContain(">Hello</mark>");
	});

	test("removes declared tracking pixels instead of requesting them", () => {
		const result = prepareEmailDocument({
			body: '<img src="https://tracker.example.com/open.png" width="1" height="1"><img src="https://cdn.example.com/content.png" width="640" height="480">',
		});

		expect(result).not.toContain("tracker.example.com");
		expect(result).toContain("cdn.example.com%2Fcontent.png");
	});

	test("keeps the Wemail brand coral in the isolated email document", () => {
		const result = prepareEmailDocument({
			body: '<p data-wemail-signature-brand="true">Sent with <strong>Wemail</strong></p>',
		});

		expect(result).toContain(
			'[data-wemail-signature-brand="true"] strong',
		);
		expect(result).toContain("color: #d96f4a !important;");
	});

	test("invalidates when highlights change", () => {
		prepareEmailDocument({ body: "<p>Hello world</p>", highlightTerms: ["Hello"] });
		prepareEmailDocument({ body: "<p>Hello world</p>", highlightTerms: ["world"] });

		expect(getPreparedEmailDocumentCacheStats()).toMatchObject({
			entries: 2,
			hits: 0,
			misses: 2,
		});
	});

	test("limits the cache entry count", () => {
		for (let index = 0; index < 25; index += 1) {
			prepareEmailDocument({ body: `<p>Message ${index}</p>` });
		}

		expect(getPreparedEmailDocumentCacheStats().entries).toBe(20);
	});
});
