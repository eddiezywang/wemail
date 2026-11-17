// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";

export interface LlmConfigBannerProps {
	configured: boolean;
	onDismiss?: () => void;
}

/**
 * Dismissible global banner that shows when the LLM is not configured.
 * When `configured === true`, renders nothing.
 * Dismissal is session-scoped (local state, not persistent).
 */
export default function LlmConfigBanner({
	configured,
	onDismiss,
}: LlmConfigBannerProps) {
	const [dismissed, setDismissed] = useState(false);

	if (configured || dismissed) {
		return null;
	}

	return (
		<div
			data-testid="wemail-llm-config-banner"
			className="flex items-center justify-between gap-3 border-b border-amber/30 bg-amber-bg px-4 py-2 text-sm"
			role="alert"
		>
			<span className="text-amber">
				AI 功能需要配置 LLM 模型。 / AI features require an LLM model to be
				configured.{" "}
				<a
					href="/settings"
					data-testid="wemail-llm-config-link"
					className="underline hover:no-underline"
				>
					配置 / Configure
				</a>
			</span>
			<button
				type="button"
				onClick={() => {
					setDismissed(true);
					onDismiss?.();
				}}
				data-testid="wemail-llm-config-dismiss"
				aria-label="关闭提示"
				className="rounded p-1 text-amber hover:bg-paper-3"
			>
				{"×"}
			</button>
		</div>
	);
}
