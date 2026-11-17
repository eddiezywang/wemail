// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Helpers for rendering Markdown that is still streaming in.
 *
 * When a fenced code block is mid-stream, the closing fence has not arrived
 * yet, so a CommonMark parser will swallow the remainder of the document
 * (everything looks like code). To stop the bubble from re-flowing once
 * the real closing fence finally lands, the renderer auto-closes the open
 * fence with a synthetic one. We also expose a flag so the LAST code block
 * in a streaming message can wear a small "still arriving" indicator.
 *
 * These helpers are deliberately structural — no syntax highlighting, no
 * tokenisation. Rendering remains plain `<pre><code>`.
 */

const FENCE_RE = /^[ \t]{0,3}(```+|~~~+)/;

interface OpenFence {
	/** "```" or "~~~" — character that opened the unmatched fence. */
	marker: "`" | "~";
	/** Number of marker characters in the opening fence (>= 3). */
	length: number;
}

function scanFence(text: string): OpenFence | null {
	// Walk lines and track fence state. A fence opens with >=3 backticks or
	// tildes at the start of a line (with up to 3 spaces of indent). It
	// closes on a later line that uses the SAME marker char with >= the
	// same number of characters and nothing else but optional trailing
	// whitespace. We don't enforce the trailing-whitespace rule strictly
	// — close on any matching marker line, since we're trying to be
	// forgiving while a stream is in progress.
	const lines = text.split(/\r?\n/);
	let open: OpenFence | null = null;
	for (const line of lines) {
		const match = FENCE_RE.exec(line);
		if (!match) continue;
		const fence = match[1];
		const marker = fence[0] as "`" | "~";
		const length = fence.length;
		if (!open) {
			open = { marker, length };
		} else if (marker === open.marker && length >= open.length) {
			open = null;
		}
	}
	return open;
}

/**
 * Returns true if the text has an unclosed fenced code block.
 *
 * Recognises both ``` and ~~~ fences (CommonMark). Tilde fences only close
 * with a tilde fence of equal-or-greater length, and likewise for backtick.
 */
export function hasUnclosedCodeFence(text: string): boolean {
	if (!text) return false;
	return scanFence(text) !== null;
}

/**
 * If `text` has an unclosed fenced code block, append a matching synthetic
 * closing fence so a CommonMark parser treats the in-progress block as
 * closed. Returns the (possibly augmented) text.
 *
 * Also reports whether a synthetic close was added — the caller uses this
 * to decorate the last code block with a "still streaming" affordance.
 */
export function autoCloseStreamingFence(text: string): {
	text: string;
	didAutoClose: boolean;
} {
	if (!text) return { text, didAutoClose: false };
	const open = scanFence(text);
	if (!open) return { text, didAutoClose: false };
	const fence = open.marker.repeat(open.length);
	// Ensure the synthetic fence sits on its own line.
	const sep = text.endsWith("\n") ? "" : "\n";
	return { text: `${text}${sep}${fence}`, didAutoClose: true };
}

/**
 * Threshold (in px) above the bottom of the agent chat scroll container at
 * which we consider the user to have "scrolled away" from the latest
 * message — past this gap we surface the Jump-to-latest pill.
 */
export const JUMP_TO_LATEST_THRESHOLD_PX = 120;

/**
 * Pure helper — returns true when the scroll position is more than the
 * Jump-to-latest threshold away from the bottom of the container. Extracted
 * so the threshold check is unit-testable without mounting the panel.
 */
export function isFarFromBottom(metrics: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}): boolean {
	const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
	return distance > JUMP_TO_LATEST_THRESHOLD_PX;
}
