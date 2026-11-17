import { describe, expect, it, vi } from "vitest";
import { openExternalUrl, sanitizeExternalUrl } from "./external-links";

describe("external link handling", () => {
	it("allows only http, https, and mailto URLs", () => {
		expect(sanitizeExternalUrl("http://portal.example.com")).toBe(
			"http://portal.example.com/",
		);
		expect(sanitizeExternalUrl("https://example.com/path")).toBe(
			"https://example.com/path",
		);
		expect(sanitizeExternalUrl("mailto:test@example.com")).toBe(
			"mailto:test@example.com",
		);

		expect(sanitizeExternalUrl("about:blank")).toBeNull();
		expect(sanitizeExternalUrl("file:///C:/Windows/win.ini")).toBeNull();
		expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
		expect(sanitizeExternalUrl("")).toBeNull();
	});

	it("uses the desktop bridge when available and falls back to browser navigation", async () => {
		const openExternal = vi.fn().mockResolvedValue({ ok: true });
		const originalOpen = window.open;
		const windowOpen = vi.fn();
		window.open = windowOpen as typeof window.open;
		window.wemailDesktop = { openExternal };

		try {
			await expect(openExternalUrl("https://example.com/doc")).resolves.toEqual({
				ok: true,
			});
			expect(openExternal).toHaveBeenCalledWith("https://example.com/doc");
			expect(windowOpen).not.toHaveBeenCalled();
		} finally {
			window.open = originalOpen;
			delete window.wemailDesktop;
		}
	});

	it("rejects unsafe URLs before calling any opener", async () => {
		const openExternal = vi.fn();
		window.wemailDesktop = { openExternal };

		try {
			await expect(openExternalUrl("javascript:alert(1)")).resolves.toEqual({
				ok: false,
				reason: "invalid-url",
			});
			expect(openExternal).not.toHaveBeenCalled();
		} finally {
			delete window.wemailDesktop;
		}
	});

	it("does not mistake a null noopener return for a definite failure", async () => {
		const originalOpen = window.open;
		const windowOpen = vi.fn().mockReturnValue(null);
		window.open = windowOpen as typeof window.open;
		try {
			await expect(openExternalUrl("https://example.com/doc")).resolves.toEqual({
				ok: false,
				reason: "open-unconfirmed",
			});
			expect(windowOpen).toHaveBeenCalledWith("https://example.com/doc", "_blank", "noopener,noreferrer");
		} finally {
			window.open = originalOpen;
		}
	});
});
