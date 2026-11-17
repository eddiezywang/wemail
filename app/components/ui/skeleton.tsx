// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cn } from "~/lib/cn";

/**
 * WeMail skeleton primitives.
 *
 * `Skeleton` is a single placeholder shape: raised grey
 * (`--color-skeleton`), 6px corners, sized by the caller to mirror the real
 * content (12px lines under 14px text, circles for avatars) so nothing jumps
 * when data lands. The sweep band (`.skeleton-band`, one 320px 75%-white
 * highlight crossing the whole list at once, 1.2s) lives in app/index.css —
 * drop `<div className="skeleton-band" />` inside the relative container.
 * Reduced motion: the band stops and shapes hold their static fill.
 */
export function Skeleton({ className }: { className?: string }) {
	return (
		<div
			aria-hidden="true"
			className={cn("rounded-[6px] bg-[var(--color-skeleton)]", className)}
		/>
	);
}
