// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import { cn } from "~/lib/cn";
import { useImeComposition } from "~/hooks/useImeComposition";

/**
 * WeMail Textarea primitive.
 *
 * Same IME wiring as `Input`. Resize is disabled — the Compose UI manages
 * height (auto-grow / drag handle) externally.
 */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
	{
		className,
		onCompositionStart: onCompositionStartProp,
		onCompositionEnd: onCompositionEndProp,
		...props
	},
	ref,
) {
	const ime = useImeComposition();

	return (
		<textarea
			ref={ref}
			onCompositionStart={(event) => {
				ime.onCompositionStart();
				onCompositionStartProp?.(event);
			}}
			onCompositionEnd={(event) => {
				ime.onCompositionEnd();
				onCompositionEndProp?.(event);
			}}
			className={cn(
				"flex min-h-20 w-full rounded-md border border-edge bg-paper-2 px-3 py-2",
				"text-sm text-ink placeholder:text-ink-3",
				"shadow-[var(--shadow-1)] resize-none",
				"transition-colors outline-none",
				"focus-visible:border-coral focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				"aria-invalid:border-red aria-invalid:ring-2 aria-invalid:ring-red/40",
				className,
			)}
			{...props}
		/>
	);
});

Textarea.displayName = "Textarea";
