import { describe, expect, it, vi } from "vitest";
import {
	createExternalLinkOpener,
	getMainWindowNavigationDecision,
	getExternalLinkWindowAction,
	sanitizeExternalUrl,
} from "./external-links.js";

describe("desktop external link handling", () => {
	it("denies Electron child windows for all external link requests", () => {
		const openExternal = vi.fn();
		const action = getExternalLinkWindowAction(
			{ url: "https://example.com" },
			openExternal,
		);

		expect(action).toEqual({ action: "deny" });
		expect(openExternal).toHaveBeenCalledWith("https://example.com/");
	});

	it("does not open unsafe or blank URLs", () => {
		const openExternal = vi.fn();

		expect(sanitizeExternalUrl("about:blank")).toBeNull();
		expect(sanitizeExternalUrl("file:///C:/Windows/win.ini")).toBeNull();
		expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
		expect(getExternalLinkWindowAction({ url: "about:blank" }, openExternal)).toEqual({
			action: "deny",
		});
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("reports whether shell.openExternal succeeded", async () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		const opener = createExternalLinkOpener(openExternal);

		await expect(opener("mailto:test@example.com")).resolves.toEqual({
			ok: true,
		});
		expect(openExternal).toHaveBeenCalledWith("mailto:test@example.com");

		await expect(opener("file:///C:/Windows/win.ini")).resolves.toEqual({
			ok: false,
			reason: "invalid-url",
		});
	});

	it("allows same-origin app navigation and blocks unsafe main-window navigation", () => {
		expect(
			getMainWindowNavigationDecision(
				"http://127.0.0.1:63241/inbox",
				"http://127.0.0.1:63241/",
			),
		).toEqual({ prevent: false });

		expect(
			getMainWindowNavigationDecision(
				"http://portal.example.com/",
				"http://127.0.0.1:63241/",
			),
		).toEqual({ prevent: true, openExternalUrl: "http://portal.example.com/" });

		expect(
			getMainWindowNavigationDecision(
				"file:///C:/Windows/win.ini",
				"http://127.0.0.1:63241/",
			),
		).toEqual({ prevent: true });
	});
});
