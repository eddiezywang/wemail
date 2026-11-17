// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tiny helper around the View Transitions API for non-router-driven
 * state changes (e.g. swapping the selected email via a Zustand store).
 *
 * - Returns immediately and runs the update synchronously when the API
 *   isn't available (older browsers, SSR) or when the user has
 *   `prefers-reduced-motion: reduce` set.
 * - When available, wraps `update` in `document.startViewTransition` so
 *   any element with a matching `view-transition-name` participates in
 *   the cross-fade / shared-element morph.
 *
 * Caller is responsible for setting / clearing the `view-transition-name`
 * styles on the elements being morphed (typically by toggling a piece of
 * React state right before invoking this helper, then resetting it
 * afterwards if the source element is leaving the DOM).
 */
export function startViewTransitionSafe(update: () => void): void {
	if (typeof document === "undefined") {
		update();
		return;
	}
	const reduced =
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const doc = document as Document & {
		startViewTransition?: (cb: () => void) => unknown;
	};
	if (reduced || typeof doc.startViewTransition !== "function") {
		update();
		return;
	}
	doc.startViewTransition(() => {
		update();
	});
}

/**
 * Sanitize an arbitrary id into a valid CSS ident suffix so we can use
 * it inside `view-transition-name: mail-subject-<id>`. The View
 * Transitions spec requires names to be valid CSS identifiers; mail ids
 * may contain `/`, `:`, `@`, `.` which would break the property.
 */
export function sanitizeVTId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
