// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import EmailIframe from "./EmailIframe";
import { clearPreparedEmailDocumentCache } from "~/lib/email-document";
import { resolveApiUrl } from "~/services/api";

/**
 * Iframe isolation invariant — locked by spec `wemail-theme-and-cleanup`.
 *
 * Email content is sender-controlled HTML rendered through `srcdoc` inside
 * a sandboxed iframe (no `allow-same-origin`). The host theme MUST NOT
 * propagate into that document. In practice that means:
 *
 *   1. The iframe document's `<html>` carries no `data-theme` attribute,
 *      regardless of what the host has set.
 *   2. The host's CSS custom properties (e.g. `--color-paper`) do NOT
 *      cascade into the iframe — the iframe paints on `#ffffff` per its
 *      own inline `<style>`.
 *
 * If either assertion regresses, the email body has started inheriting the
 * app palette and DARK MODE WILL BREAK MAIL READABILITY.
 */
describe("EmailIframe theme isolation", () => {
	beforeEach(() => {
		clearPreparedEmailDocumentCache();
		// Simulate the user having selected the dark theme on the host page.
		document.documentElement.dataset.theme = "dark";
	});

	afterEach(() => {
		delete document.documentElement.dataset.theme;
	});

	/**
	 * The component defers building the sanitized document to a timeout, so
	 * the <iframe> only mounts after srcDoc is set. Wait for it.
	 */
	async function getIframe(container: HTMLElement) {
		let iframe: HTMLIFrameElement | null = null;
		await waitFor(
			() => {
				iframe = container.querySelector("iframe");
				expect(iframe).not.toBeNull();
			},
			{ timeout: 2000 },
		);
		return iframe!;
	}

	async function getIframeDocument(container: HTMLElement) {
		const iframe = await getIframe(container);
		// The component sets `srcdoc` inside an effect; wait for the iframe
		// document to be populated before asserting.
		await waitFor(
			() => {
				expect(iframe.srcdoc).toContain("<!DOCTYPE html>");
			},
			{ timeout: 2000 },
		);
		// jsdom only resolves the iframe's document once srcdoc is set.
		await waitFor(
			() => {
				const doc = iframe!.contentDocument;
				expect(doc).not.toBeNull();
				expect(doc!.documentElement).not.toBeNull();
			},
			{ timeout: 2000 },
		);
		return { iframe: iframe!, doc: iframe!.contentDocument! };
	}

	it("iframe <html> has no data-theme attribute even when host theme is dark", async () => {
		const { container } = render(
			<EmailIframe body="<p>hello from sender</p>" />,
		);
		// Host attribute is set (sanity).
		expect(document.documentElement.dataset.theme).toBe("dark");

		const { doc } = await getIframeDocument(container);
		expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);
	});

	it("sets srcdoc with the email body during initial render", async () => {
		const { container } = render(
			<EmailIframe body="<p>first click body</p>" />,
		);
		const iframe = await getIframe(container);

		expect(iframe.srcdoc).toContain("first click body");
	});

	it("loads remote images through the validated local image proxy", async () => {
		const { container } = render(
			<EmailIframe body={'<img src="http://thirdqq.qlogo.cn/avatar/0" alt="Rad">'} />,
		);
		const iframe = await getIframe(container);

		expect(iframe.srcdoc).toContain(
			"/api/mail/remote-images?url=http%3A%2F%2Fthirdqq.qlogo.cn%2Favatar%2F0",
		);
		expect(iframe.srcdoc).toContain('data-wemail-remote-image="true"');
		expect(iframe.srcdoc).not.toContain("加载远程图片");
	});

	it("wraps matching body text in highlight marks", async () => {
		const { container } = render(
			<EmailIframe body="<p>??????????</p>" highlightTerms={["??"]} />,
		);
		const iframe = await getIframe(container);

		expect(iframe.srcdoc).toContain("<mark");
		expect(iframe.srcdoc).toContain(">??</mark>");
	});

	it("allows local attachment image endpoints in the iframe CSP", async () => {
		const attachment = resolveApiUrl("/api/mail/messages/msg-1/attachments/part-2");
		const { container } = render(
			<EmailIframe body={`<img src="${attachment}">`} />,
		);
		const iframe = await getIframe(container);

		expect(iframe.srcdoc).toContain(`src="${attachment}"`);
		expect(iframe.srcdoc).toContain(`img-src data: cid: ${new URL(attachment).origin}/api/mail/remote-images ${attachment};`);
		expect(iframe.srcdoc).not.toContain("http://127.0.0.1:*");
		expect(iframe.srcdoc).not.toContain("http://localhost:*");
	});

	it("srcdoc reports height after image load and resize events", async () => {
		const { container } = render(
			<EmailIframe body={'<img src="https://example.com/a.png" alt="A">'} autoSize />,
		);
		const iframe = await getIframe(container);

		expect(iframe.srcdoc).toContain("ResizeObserver");
		expect(iframe.srcdoc).not.toContain("MutationObserver");
		expect(iframe.srcdoc).toContain("h !== lastHeight");
		expect(iframe.srcdoc).toContain('addEventListener("load"');
		expect(iframe.srcdoc).toContain('addEventListener("error"');
	});

	it("intercepts sender links instead of allowing iframe navigation or popups", async () => {
		const { container } = render(
			<EmailIframe body={'<a href="http://portal.example.com">公文系统</a>'} />,
		);
		const iframe = await getIframe(container);

		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe.srcdoc).toContain('data-wemail-email-link="true"');
		expect(iframe.srcdoc).toContain("parent.postMessage");
		expect(iframe.srcdoc).toContain("__wemailOpenExternal");
		expect(iframe.srcdoc).not.toContain("allow-popups");
		expect(iframe.srcdoc).not.toContain("allow-top-navigation");
	});

	it("iframe srcdoc carries no host token references and forces a white background", async () => {
		const { container } = render(
			<EmailIframe body="<p>sender body</p>" />,
		);
		const { iframe, doc } = await getIframeDocument(container);

		// The injected document MUST NOT mention any host token name.
		// `--color-paper`, `--color-ink`, `data-theme=` — none of these may
		// appear in the iframe HTML, otherwise the host palette has leaked.
		expect(iframe.srcdoc).not.toMatch(/--color-paper/);
		expect(iframe.srcdoc).not.toMatch(/--color-ink/);
		expect(iframe.srcdoc).not.toMatch(/data-theme/);

		// Body has no inline style referencing host tokens.
		const body = doc.body;
		const inlineStyle = body.getAttribute("style") ?? "";
		expect(inlineStyle).not.toMatch(/--color-/);

		// And the iframe explicitly opts into a light color-scheme — its
		// <html> style block hard-codes `background: #ffffff`.
		expect(iframe.srcdoc).toContain("background: #ffffff");
		expect(iframe.srcdoc).toContain("color-scheme: light");
	});

	it("switching the host theme after mount does not propagate into the iframe", async () => {
		const { container } = render(
			<EmailIframe body="<p>still isolated</p>" />,
		);
		const { doc } = await getIframeDocument(container);
		expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);

		// Flip the host theme after the iframe has mounted.
		document.documentElement.dataset.theme = "claude";

		// The iframe document is unchanged — no attribute crosses the boundary.
		expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);

		// Custom property reads on the iframe body do not pick up the host
		// value (the iframe is its own document context). jsdom does not
		// fully resolve cascaded custom properties, so we assert the
		// negative form: no host token resolves to a value here.
		const cs = doc.defaultView?.getComputedStyle(doc.body);
		const paperVar = cs?.getPropertyValue("--color-paper") ?? "";
		expect(paperVar.trim()).toBe("");
	});
});
