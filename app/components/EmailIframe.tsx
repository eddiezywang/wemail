// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getApiEndpointGeneration, subscribeApiEndpointRuntimeState } from "~/services/api";
import { openExternalUrlWithFeedback } from "~/lib/external-links";
import {
	getCachedEmailDocument,
	prepareEmailDocument,
	readEmailPalette,
} from "~/lib/email-document";
import { useTheme } from "~/hooks/useTheme";

interface EmailIframeProps {
	body: string;
	highlightTerms?: string[];
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
	onPaint?: () => void;
}

/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its body height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access the parent DOM.
 * - A CSP meta tag limits images to data/CID and the configured local API's
 *   message and remote-image paths; this is defense in depth, not authentication.
 *   It also restricts script execution to the document's generated nonce.
 */
export default function EmailIframe({ body, highlightTerms, autoSize, onPaint }: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [srcDoc, setSrcDoc] = useState("");
	const apiGeneration = useSyncExternalStore(subscribeApiEndpointRuntimeState, getApiEndpointGeneration, () => 0);
	// Re-resolved on every render; theme changes rebuild the srcdoc with the
	// new palette (colors are inlined at build time — see readEmailPalette).
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		let cancelled = false;
		const palette = readEmailPalette();
		// Fast path: if this body was already prepared (same mail revisited,
		// or an identical body/highlight/autoSize/palette combo), restore the cached
		// document synchronously instead of clearing the iframe and waiting
		// a frame for the async rebuild. Avoids the loading flash and the
		// reparse cost when navigating back to a previously opened mail.
		const cached = getCachedEmailDocument({ body, highlightTerms, autoSize, palette });
		if (cached !== undefined) {
			setSrcDoc(cached);
			return () => {
				cancelled = true;
			};
		}
		setSrcDoc("");
		const timer = window.setTimeout(() => {
			if (cancelled) return;
			setSrcDoc(prepareEmailDocument({ body, highlightTerms, autoSize, palette }));
		}, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [body, highlightTerms, autoSize, apiGeneration, resolvedTheme]);

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			// Only accept messages from our own iframe
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__wemailOpenExternal &&
				typeof event.data.url === "string"
			) {
				void openExternalUrlWithFeedback(event.data.url);
				return;
			}
			if (!autoSize) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__emailIframeHeight &&
				typeof event.data.height === "number" &&
				event.data.height > 0
			) {
				const nextHeight = Math.ceil(event.data.height);
				setHeight((current) => (current === nextHeight ? current : nextHeight));
			}
		},
		[autoSize],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	if (!srcDoc) {
		return <div className="h-14 animate-pulse rounded bg-paper-2 motion-reduce:animate-none" aria-label="正在准备邮件正文" />;
	}

	return (
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			srcDoc={srcDoc}
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts"
			title="邮件正文"
			onLoad={() => requestAnimationFrame(() => onPaint?.())}
		/>
	);
}
