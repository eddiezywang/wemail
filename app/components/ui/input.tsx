// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import { cn } from "~/lib/cn";
import { useImeComposition } from "~/hooks/useImeComposition";

/**
 * WeMail Input primitive.
 *
 * Wires `useImeComposition` so `compositionstart` / `compositionend` are
 * tracked internally; if a caller passes their own composition handlers we
 * still call them. Submit-on-Enter behaviour stays in the consumer (e.g.
 * AskBox); the hook's `isComposing` flag is exposed there via its own
 * `useImeComposition()` call. This component does not block Enter itself.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{
		className,
		type = "text",
		onCompositionStart: onCompositionStartProp,
		onCompositionEnd: onCompositionEndProp,
		...props
	},
	ref,
) {
	const ime = useImeComposition();

	return (
		<input
			ref={ref}
			type={type}
			onCompositionStart={(event) => {
				ime.onCompositionStart();
				onCompositionStartProp?.(event);
			}}
			onCompositionEnd={(event) => {
				ime.onCompositionEnd();
				onCompositionEndProp?.(event);
			}}
			className={cn(
				"flex h-10 w-full min-w-0 rounded-md border border-edge bg-paper-2 px-3 py-2",
				"text-sm text-ink placeholder:text-ink-3",
				"shadow-[var(--shadow-1)]",
				"transition-colors outline-none",
				"focus-visible:border-coral focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				"aria-invalid:border-red aria-invalid:ring-2 aria-invalid:ring-red/40",
				"file:inline-flex file:h-9 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink",
				className,
			)}
			{...props}
		/>
	);
});

Input.displayName = "Input";
