// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CheckIcon } from "@phosphor-icons/react/Check";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { ErrorSlot } from "~/components/ui/error-slot";
import { cn } from "~/lib/cn";

export type SaveStatusState = "saving" | "saved" | "error";

export interface SaveStatusProps {
	state: SaveStatusState;
	/** Used when state === "error" to render the inline reason. */
	error?: unknown;
	onRetry?: () => void;
	className?: string;
}

/**
 * Quiet save status for optimistic changes — 12px grey, start of the row's
 * last column. Saving shows a 12px spinner, Saved a green check, failure
 * swaps to an inline reason with Retry. Row shake on failure is the
 * consumer's job (add the `.wm-shake` class from app/index.css to the row).
 */
export function SaveStatus({ state, error, onRetry, className }: SaveStatusProps) {
	if (state === "error") {
		return (
			<ErrorSlot
				error={error}
				fallback="保存失败，请重试。"
				onRetry={onRetry}
				className={className}
			/>
		);
	}
	return (
		<span
			role="status"
			aria-live="polite"
			className={cn("inline-flex items-center gap-1 text-xs text-ink-3", className)}
		>
			{state === "saving" ? (
				<>
					<CircleNotchIcon size={12} className="animate-spin motion-reduce:animate-none" />
					保存中…
				</>
			) : (
				<>
					<CheckIcon size={12} weight="bold" className="text-green" />
					已保存
				</>
			)}
		</span>
	);
}
