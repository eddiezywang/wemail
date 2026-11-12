// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Action Center — Curator insights section (Route C / WP 3H).
 *
 * The Curator runtime (Route C / WP J.5–J.6) is not built yet, so v1
 * shows a placeholder when the latest learnings file is missing. When
 * the file does exist, the markdown is rendered verbatim in a
 * monospace `<pre>` — no markdown renderer is wired up because the
 * goal is for the user to see exactly what the Curator wrote.
 */

import type { ActionCenterPayload } from "~/services/api";

export function CuratorInsightsSection({
	insights,
}: {
	insights: ActionCenterPayload["curatorInsights"];
}) {
	if (!insights) {
		return (
			<section
				data-testid="action-center-curator-empty"
				className="rounded-lg border border-edge-3 bg-paper-2 p-4 text-sm text-ink-3"
			>
				<h2 className="text-sm font-semibold text-ink mb-1">
					每日学习 / Curator insights
				</h2>
				<p>
					Curator hasn't run yet — your daily learnings will appear here
					once it has.
				</p>
			</section>
		);
	}
	return (
		<section
			data-testid="action-center-curator"
			aria-labelledby="action-center-curator-heading"
			className="rounded-lg border border-edge-3 bg-paper-2"
		>
			<header className="flex items-center justify-between px-4 py-2 border-b border-edge-3">
				<h2
					id="action-center-curator-heading"
					className="text-sm font-semibold text-ink"
				>
					每日学习 / Curator insights
				</h2>
				<span
					className="text-xs text-ink-3 font-mono"
					data-testid="action-center-curator-date"
				>
					{insights.date}
				</span>
			</header>
			<div className="p-4">
				<pre
					data-testid="action-center-curator-content"
					className="text-xs font-mono whitespace-pre-wrap text-ink"
				>
					{insights.content}
				</pre>
			</div>
		</section>
	);
}

export default CuratorInsightsSection;
