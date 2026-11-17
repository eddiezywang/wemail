export interface ExternalLinkOpenResult {
	ok: boolean;
	reason?: "invalid-url" | "open-failed" | "open-unconfirmed";
}

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function sanitizeExternalUrl(rawUrl: string | null | undefined): string | null {
	const value = rawUrl?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
	} catch {
		return null;
	}
}

export async function openExternalUrl(
	rawUrl: string | null | undefined,
): Promise<ExternalLinkOpenResult> {
	const url = sanitizeExternalUrl(rawUrl);
	if (!url) return { ok: false, reason: "invalid-url" };

	if (window.wemailDesktop?.openExternal) {
		return window.wemailDesktop.openExternal(url);
	}

	try {
		// With noopener the browser returns null even when navigation succeeds,
		// so it cannot reliably distinguish success from popup blocking.
		window.open(url, "_blank", "noopener,noreferrer");
		return { ok: false, reason: "open-unconfirmed" };
	} catch {
		return { ok: false, reason: "open-failed" };
	}
}

export async function openExternalUrlWithFeedback(
	rawUrl: string | null | undefined,
): Promise<ExternalLinkOpenResult> {
	const result = await openExternalUrl(rawUrl);
	if (!result.ok && result.reason !== "open-unconfirmed") {
		toast.error(
			result.reason === "invalid-url"
				? "这个链接无法安全打开。"
				: "链接没有打开，请稍后重试。",
		);
	}
	return result;
}

export function handleExternalLinkClick(
	event: Pick<
		MouseEvent,
		| "button"
		| "metaKey"
		| "ctrlKey"
		| "shiftKey"
		| "altKey"
		| "preventDefault"
	>,
	url: string | null | undefined,
) {
	if (
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	) {
		return;
	}
	event.preventDefault();
	void openExternalUrlWithFeedback(url);
}
import { toast } from "sonner";
