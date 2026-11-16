// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { getUserFacingError } from "~/lib/user-facing-error";
import { cn } from "~/lib/cn";

export interface ErrorSlotProps {
	error?: unknown;
	/** Fallback copy when the error carries no user-facing message. */
	fallback?: string;
	onRetry?: () => void;
	retryPending?: boolean;
	className?: string;
}

/**
 * Inline failure slot — failures stay where they happened.
 *
 * Short reason plus Retry, announced assertively; replaces disappearing
 * error toasts for in-place actions. Full-region failures still use
 * `AsyncState kind="error"`; this is the compact row/field variant.
 */
export function ErrorSlot({
	error,
	fallback = "操作没有完成，请稍后重试。",
	onRetry,
	retryPending = false,
	className,
}: ErrorSlotProps) {
	return (
		<div
			role="alert"
			className={cn("flex min-h-7 items-center gap-1.5 text-xs text-red", className)}
		>
			<WarningCircleIcon size={14} weight="fill" className="shrink-0" />
			<span className="min-w-0 flex-1 truncate">
				{getUserFacingError(error, fallback)}
			</span>
			{onRetry ? (
				<button
					type="button"
					onClick={onRetry}
					disabled={retryPending}
					className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-red hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<ArrowCounterClockwiseIcon size={12} className={retryPending ? "animate-spin motion-reduce:animate-none" : undefined} />
					重试
				</button>
			) : null}
		</div>
	);
}
