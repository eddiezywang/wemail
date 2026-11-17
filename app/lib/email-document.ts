import DOMPurify from "dompurify";
import { SIGNATURE_BRAND_COLOR } from "../../shared/wemail/signature";
import { resolveApiUrl } from "~/services/api";

const DOCUMENT_TEMPLATE_VERSION = "8";
const MAX_CACHE_ENTRIES = 20;
const MAX_CACHE_CHARS = 8 * 1024 * 1024;

interface PrepareEmailDocumentInput {
	body: string;
	highlightTerms?: string[];
	autoSize?: boolean;
}

interface CacheEntry {
	document: string;
	chars: number;
}

const documentCache = new Map<string, CacheEntry>();
let cachedChars = 0;
let cacheHits = 0;
let cacheMisses = 0;

function buildCacheKey({
	body,
	highlightTerms,
	autoSize,
}: PrepareEmailDocumentInput): string | null {
	if (!body) return null;
	const terms = normalizeTerms(highlightTerms);
	return `${DOCUMENT_TEMPLATE_VERSION}\u0000${resolveApiUrl("/api/mail/remote-images")}\u0000${autoSize ? "1" : "0"}\u0000${JSON.stringify(terms)}\u0000${body}`;
}

/**
 * Synchronous cache lookup for an already-prepared email document. Returns
 * the cached `srcdoc` string without re-running DOMPurify/transform, or
 * `undefined` on a miss. Lets callers (EmailIframe) restore a previously
 * viewed email body immediately instead of clearing and rebuilding the
 * iframe, which avoids the loading flash and the reparse cost when
 * navigating back to a mail that was already opened.
 */
export function getCachedEmailDocument(
	input: PrepareEmailDocumentInput,
): string | undefined {
	const key = buildCacheKey(input);
	if (!key) return undefined;
	const cached = documentCache.get(key);
	if (!cached) return undefined;
	documentCache.delete(key);
	documentCache.set(key, cached);
	cacheHits += 1;
	return cached.document;
}

function isLocalHttpImageSource(src: string): boolean {
	try {
		const url = new URL(src);
		return (
			url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" ||
				url.hostname === "localhost" ||
				url.hostname === "[::1]" ||
				url.hostname === "::1")
		);
	} catch {
		return false;
	}
}

function isInlineAttachmentSource(src: string): boolean {
	try {
		const url = new URL(src);
		const expectedOrigin = new URL(resolveApiUrl("/api/mail/remote-images")).origin;
		return url.origin === expectedOrigin &&
			/^\/api\/mail\/messages\/[^/]+\/attachments\/[^/]+$/.test(url.pathname) &&
			!/[;\s"'<>]/.test(url.pathname) &&
			!url.search && !url.hash;
	} catch {
		return false;
	}
}

function remoteImageProxyUrl(source: string): string {
	return resolveApiUrl(`/api/mail/remote-images?url=${encodeURIComponent(source)}`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerms(terms: string[] | undefined): string[] {
	return Array.from(
		new Set((terms ?? []).map((term) => term.trim()).filter(Boolean)),
	).sort((a, b) => b.length - a.length);
}

function transformBody(cleanBody: string, terms: string[]): string {
	const template = document.createElement("template");
	template.innerHTML = cleanBody;
	// srcset bypasses the src rewriting and tracker filtering below.
	for (const element of template.content.querySelectorAll("[srcset]")) {
		element.removeAttribute("srcset");
	}

	for (const img of template.content.querySelectorAll("img[src]")) {
		const rawSrc = img.getAttribute("src")?.trim();
		const src = rawSrc?.startsWith("//") ? `https:${rawSrc}` : rawSrc;
		// CID attachments are rewritten to absolute API URLs before this stage.
		// Raw relative paths could otherwise invoke a local API endpoint.
		if (!src || !/^(?:https?:\/\/|data:|cid:)/i.test(src)) {
			img.remove();
			continue;
		}
		if (src && isLocalHttpImageSource(src) && !isInlineAttachmentSource(src)) {
			img.remove();
			continue;
		}
		if (src && /^https?:\/\//i.test(src) && !isLocalHttpImageSource(src)) {
			let parsed: URL;
			try {
				parsed = new URL(src);
			} catch {
				// A malformed image URL must not prevent the rest of the email rendering.
				img.remove();
				continue;
			}
			const width = Number.parseInt(img.getAttribute("width") ?? "", 10);
			const height = Number.parseInt(img.getAttribute("height") ?? "", 10);
			const isTrackingPixel = /\/wf\/open(?:$|[/?#])/i.test(parsed.pathname) ||
				(Number.isFinite(width) && width <= 2 && Number.isFinite(height) && height <= 2);
			if (isTrackingPixel) {
				img.remove();
				continue;
			}
			img.setAttribute("data-wemail-remote-image", "true");
			img.setAttribute("data-wemail-original-host", parsed.hostname);
			img.setAttribute("src", remoteImageProxyUrl(src));
			img.setAttribute("alt", img.getAttribute("alt") || "图片加载失败");
		}
	}

	for (const anchor of template.content.querySelectorAll("a[href]")) {
		anchor.setAttribute("data-wemail-email-link", "true");
		anchor.setAttribute("rel", "noreferrer");
		anchor.removeAttribute("target");
	}

	if (terms.length > 0) {
		const lowered = new Set(terms.map((term) => term.toLocaleLowerCase()));
		const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
		const walker = document.createTreeWalker(
			template.content,
			NodeFilter.SHOW_TEXT,
		);
		const textNodes: Text[] = [];
		let current = walker.nextNode();
		while (current) {
			const textNode = current as Text;
			if (
				textNode.nodeValue?.trim() &&
				!textNode.parentElement?.closest("style, title")
			) {
				textNodes.push(textNode);
			}
			current = walker.nextNode();
		}
		for (const textNode of textNodes) {
			const value = textNode.nodeValue ?? "";
			const parts = value.split(pattern);
			if (parts.length === 1) continue;
			const fragment = document.createDocumentFragment();
			for (const part of parts) {
				if (!part) continue;
				if (lowered.has(part.toLocaleLowerCase())) {
					const mark = document.createElement("mark");
					mark.className = "wemail-search-highlight";
					mark.textContent = part;
					fragment.appendChild(mark);
				} else {
					fragment.appendChild(document.createTextNode(part));
				}
			}
			textNode.parentNode?.replaceChild(fragment, textNode);
		}
	}

	return template.innerHTML;
}

function buildHeightScript(autoSize: boolean, nonce: string): string {
	if (!autoSize) return "";
	return `<script nonce="${nonce}">
		(function() {
			var scheduled = false;
			var lastHeight = 0;
			function reportHeight() {
				scheduled = false;
				var h = Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
				if (h > 0 && h !== lastHeight) {
					lastHeight = h;
					parent.postMessage({ __emailIframeHeight: true, height: h }, "*");
				}
			}
			function scheduleReport() {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(reportHeight);
			}
			if ("ResizeObserver" in window) {
				new ResizeObserver(scheduleReport).observe(document.body);
			} else {
				setTimeout(scheduleReport, 100);
			}
			document.querySelectorAll("img").forEach(function(img) {
				img.addEventListener("load", scheduleReport, { once: true });
				img.addEventListener("error", scheduleReport, { once: true });
			});
			if (document.readyState === "loading") {
				document.addEventListener("DOMContentLoaded", scheduleReport, { once: true });
			} else {
				scheduleReport();
			}
		})();
	<\/script>`;
}

function buildDocument(body: string, autoSize: boolean): string {
	const padding = autoSize ? "0" : "24px";
	const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	let imageSources = "data: cid:";
	try {
		const origin = new URL(resolveApiUrl("/api/mail/remote-images")).origin;
		if (origin !== "null") {
			imageSources += ` ${origin}/api/mail/remote-images`;
			const template = document.createElement("template");
			template.innerHTML = body;
			const attachmentPaths = new Set<string>();
			for (const img of template.content.querySelectorAll("img[src]")) {
				const src = img.getAttribute("src");
				if (src && isInlineAttachmentSource(src)) {
					attachmentPaths.add(`${origin}${new URL(src).pathname}`);
				}
			}
			for (const source of attachmentPaths) imageSources += ` ${source}`;
		}
	} catch {
		// Fail closed when the application API origin is unavailable.
	}
	const linkScript = `<script nonce="${nonce}">
		(function() {
			document.querySelectorAll("img[data-wemail-remote-image]").forEach(function(img) {
				img.addEventListener("error", function() {
					img.setAttribute("data-wemail-image-failed", "true");
					img.title = "图片加载失败（" + (img.getAttribute("data-wemail-original-host") || "远程服务器") + "）";
				}, { once: true });
			});
		})();
		document.addEventListener("click", function(event) {
			var target = event.target;
			var anchor = target && target.closest ? target.closest("a[href]") : null;
			if (!anchor) return;
			event.preventDefault();
			parent.postMessage({ __wemailOpenExternal: true, url: anchor.href }, "*");
		});
	<\/script>`;

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; script-src 'nonce-${nonce}';">
<style>
* { box-sizing: border-box; }
html { background: #ffffff; color-scheme: light; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: 14px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	padding: ${padding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] { position: relative !important; }
a { color: #2563eb; }
[data-wemail-signature-brand="true"] a,
[data-wemail-signature-brand="true"] strong,
[data-wemail-signature-brand="true"] span {
	color: ${SIGNATURE_BRAND_COLOR} !important;
	text-decoration: none;
}
img { max-width: 100%; height: auto; }
img[data-wemail-image-failed="true"] { min-width: 80px; min-height: 24px; border: 1px dashed #d1d5db; color: #6b7280; }
blockquote { border-left: 3px solid #d1d5db; padding-left: 1em; margin-left: 0; color: #6b7280; }
pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 4px 0; }
h1, h2, h3 { margin: 8px 0 4px; }
ul, ol { padding-left: 20px; margin: 4px 0; }
mark.wemail-search-highlight { background: rgba(245, 158, 11, 0.28); color: inherit; padding: 0 1px; border-radius: 2px; }
</style>
</head>
<body>${body}${buildHeightScript(autoSize, nonce)}${linkScript}</body>
</html>`;
}

export function prepareEmailDocument({
	body,
	highlightTerms,
	autoSize = false,
}: PrepareEmailDocumentInput): string {
	if (!body) return "";
	const terms = normalizeTerms(highlightTerms);
	const key = buildCacheKey({ body, highlightTerms, autoSize });
	if (!key) return "";
	const cached = documentCache.get(key);
	if (cached) {
		documentCache.delete(key);
		documentCache.set(key, cached);
		cacheHits += 1;
		return cached.document;
	}

	cacheMisses += 1;
	const t0 = import.meta.env.DEV ? performance.now() : 0;
	const cleanBody = DOMPurify.sanitize(body, {
		USE_PROFILES: { html: true },
		ADD_ATTR: ["target", "style"],
		FORCE_BODY: true,
	});
	const tSanitize = import.meta.env.DEV ? performance.now() : 0;
	const transformed = transformBody(cleanBody, terms);
	const tTransform = import.meta.env.DEV ? performance.now() : 0;
	const prepared = buildDocument(transformed, autoSize);
	if (import.meta.env.DEV) {
		console.debug(
			`[prepare-email-document] body=${(body.length / 1024).toFixed(1)}KB` +
				` sanitize=${Math.round(tSanitize - t0)}ms` +
				` transform=${Math.round(tTransform - tSanitize)}ms` +
				` total=${Math.round(tTransform - t0)}ms`,
		);
	}
	const chars = key.length + prepared.length;
	if (chars <= MAX_CACHE_CHARS) {
		documentCache.set(key, { document: prepared, chars });
		cachedChars += chars;
		while (
			documentCache.size > MAX_CACHE_ENTRIES ||
			cachedChars > MAX_CACHE_CHARS
		) {
			const oldestKey = documentCache.keys().next().value as string | undefined;
			if (!oldestKey) break;
			const oldest = documentCache.get(oldestKey);
			if (oldest) cachedChars -= oldest.chars;
			documentCache.delete(oldestKey);
		}
	}
	return prepared;
}

export function clearPreparedEmailDocumentCache(): void {
	documentCache.clear();
	cachedChars = 0;
	cacheHits = 0;
	cacheMisses = 0;
}

export function getPreparedEmailDocumentCacheStats() {
	return {
		entries: documentCache.size,
		chars: cachedChars,
		hits: cacheHits,
		misses: cacheMisses,
	};
}
