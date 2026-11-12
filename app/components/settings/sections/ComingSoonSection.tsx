// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

interface ComingSoonSectionProps {
	title: string;
	description: string;
}

/**
 * Placeholder pane for settings sections that are part of the upstream-style
 * navigation skeleton but not yet implemented. Shipping the nav with
 * stubs lets us land the settings architecture without blocking on each
 * pane's content.
 */
export function ComingSoonSection({
	title,
	description,
}: ComingSoonSectionProps) {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-base font-semibold text-ink mb-1">{title}</h2>
				<p className="text-xs text-ink-3">{description}</p>
			</div>
			<div className="rounded-lg border border-edge border-dashed bg-paper-2 p-6 text-center">
				<p className="text-sm text-ink-3">Coming soon.</p>
			</div>
		</div>
	);
}
