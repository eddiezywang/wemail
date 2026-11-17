// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef, useState } from "react";

export interface DelayedFlagOptions {
	/** Delay before the busy flag turns on. Default 300ms: nothing shows under 300ms. */
	delay?: number;
	/** Minimum time the flag stays on once shown, so it never flashes. Default 500ms. */
	min?: number;
}

/**
 * Shared delayed-busy gate for spinners, skeletons and progress UI.
 *
 * `useDelayedFlag(active)` stays false for the first `delay` ms of a wait
 * (fast answers render no loader at all), then turns true — and once true it
 * stays on for at least `min` ms even if `active` drops, so the loader never
 * flashes in and out. One helper for every delayed wait in the app.
 */
export function useDelayedFlag(
	active: boolean,
	{ delay = 300, min = 500 }: DelayedFlagOptions = {},
): boolean {
	const [visible, setVisible] = useState(false);
	const shownAtRef = useRef(0);

	useEffect(() => {
		if (active) {
			const timer = window.setTimeout(() => {
				shownAtRef.current = Date.now();
				setVisible(true);
			}, delay);
			return () => window.clearTimeout(timer);
		}
		if (!visible) return;
		const remaining = Math.max(0, shownAtRef.current + min - Date.now());
		const timer = window.setTimeout(() => setVisible(false), remaining);
		return () => window.clearTimeout(timer);
	}, [active, delay, min]);

	return visible;
}
