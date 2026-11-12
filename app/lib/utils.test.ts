import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildQuotedReplyBlock,
	downloadFile,
	getSignatureBlock,
	resolveSignatureText,
	rewriteInlineImages,
} from "./utils";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("rewriteInlineImages", () => {
	it("rewrites cid image sources using attachment contentId metadata", () => {
		const html = '<p><img src="cid:chart-1"></p>';

		const rewritten = rewriteInlineImages("body " + html, "acct-1", "msg-1", [
			{
				id: "part-2",
				contentId: "chart-1",
				disposition: "inline",
			},
		]);

		expect(rewritten).toContain(
			"/api/mail/messages/msg-1/attachments/part-2",
		);
		expect(rewritten).not.toContain("cid:chart-1");
	});

	it("also rewrites multipart/related CID images with no Content-Disposition", () => {
		const html = '<p><img src="cid:logo"></p>';

		const rewritten = rewriteInlineImages(html, "acct-1", "msg-1", [
			{ id: "part-3", mimetype: "image/png", contentId: "logo" },
		]);

		expect(rewritten).toContain("/api/mail/messages/msg-1/attachments/part-3");
		expect(rewritten).not.toContain("cid:logo");
	});
});

describe("protected compose regions", () => {
	it("resolves the signature identity without hardcoded account data", () => {
		expect(
			resolveSignatureText({
				customText: "  Custom signature  ",
				displayName: "Alice",
				emailAddress: "alice@example.com",
			}),
		).toBe("Custom signature");
		expect(
			resolveSignatureText({
				customText: "",
				displayName: " Alice ",
				emailAddress: "alice@example.com",
			}),
		).toBe("Alice");
		expect(
			resolveSignatureText({
				customText: "",
				displayName: "",
				emailAddress: "173729896@163.com",
			}),
		).toBe("173729896");
		expect(
			resolveSignatureText({
				customText: "",
				directoryName: "eddiewang(王振宇)",
				displayName: "eddiewang",
				emailAddress: "eddiewang@example.com",
			}),
		).toBe("王振宇");
	});

	it("marks generated signature HTML as protected from AI rewriting", () => {
		const html = getSignatureBlock({
			signature: { enabled: true, text: "173729896" },
		});
		const wrapper = document.createElement("div");
		wrapper.innerHTML = html;
		const signature = wrapper.querySelector<HTMLElement>(
			'[data-wemail-signature="true"]',
		);
		const brand = wrapper.querySelector<HTMLElement>(
			'[data-wemail-signature-brand="true"]',
		);

		expect(html).toContain('data-wemail-signature="true"');
		expect(html).toContain("--<br><br>");
		expect(signature?.querySelector("div")?.style.fontWeight).toBe("400");
		expect(html).toContain("173729896");
		expect(brand).toHaveTextContent("Sent with Wemail");
		expect(brand).not.toHaveAttribute("contenteditable", "false");
		// No deployment brand URL in the open baseline: the brand renders as
		// plain text with no outbound link. Internal editions set the URL.
		expect(brand?.querySelector("a")).toBeNull();
		expect(brand?.querySelector("span")).toHaveAttribute(
			"style",
			"color: #d96f4a;",
		);
		expect(signature?.style.textAlign).toBe("left");
		expect(signature?.style.marginTop).toBe("18px");
		expect(brand?.style.marginTop).toBe("5px");
		expect(brand?.style.fontSize).toBe("11px");
		expect(brand?.previousElementSibling).not.toBeNull();
	});

	it("renders no identity or brand footer when signatures are disabled", () => {
		const html = getSignatureBlock({
			signature: { enabled: false, text: "Alice" },
		});

		expect(html).toBe("");
	});

	it("marks quoted replies as protected from AI rewriting", () => {
		const html = buildQuotedReplyBlock(
			"2026-07-16T10:00:00Z",
			"Dharmesh <dharmesh@example.com>",
			"Original message",
		);

		expect(html).toContain('data-wemail-quoted-reply="true"');
		expect(html).toContain("Original message");
	});

	it("removes embedded stylesheet text from quoted replies", () => {
		const html = buildQuotedReplyBlock(
			"2026-07-16T10:00:00Z",
			"sender@example.com",
			"<style>.mail { font-family: serif; color: red; }</style><p>Renewal reminder</p>",
		);

		expect(html).toContain("Renewal reminder");
		expect(html).not.toContain("font-family");
		expect(html).not.toContain(".mail");
	});
});

describe("downloadFile", () => {
	it("downloads a successful response through a blob URL", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const createObjectURL = vi.fn(() => "blob:attachment");
		const revokeObjectURL = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async () => new Response("data", { status: 200 })));
		vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

		await downloadFile("/attachment", "invoice.pdf");

		expect(fetch).toHaveBeenCalledWith("/attachment", { headers: { Accept: "*/*" } });
		expect(click).toHaveBeenCalledTimes(1);
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		const anchor = click.mock.instances[0] as HTMLAnchorElement;
		expect(anchor.download).toBe("invoice.pdf");
	});

	it("throws a readable backend error for failed downloads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ ok: false, error: "attachment fetch failed" }, { status: 502 }),
			),
		);

		await expect(downloadFile("/attachment", "invoice.pdf")).rejects.toThrow(
			"附件下载连接异常，请重试。",
		);
	});

	it("maps provider throttling to a user-facing retry message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{ ok: false, error: "邮箱服务器暂时限制附件下载，请稍后重试" },
					{ status: 502 },
				),
			),
		);

		await expect(downloadFile("/attachment", "invoice.pdf")).rejects.toThrow(
			"附件下载受邮箱服务器限制，请稍后重试。",
		);
	});
});
