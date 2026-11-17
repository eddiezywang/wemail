// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "~/lib/cn";

/**
 * WeMail Switch primitive (wraps @radix-ui/react-switch).
 *
 * Animation strategy: colors crossfade while the thumb travels on a spring
 * curve (cubic-bezier(0.34,1.56,0.64,1)) so it overshoots its resting
 * position before settling — no tailwindcss-animate dependency.
 */

export const Switch = forwardRef<
	React.ElementRef<typeof SwitchPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
	return (
		<SwitchPrimitive.Root
			ref={ref}
			className={cn(
				"peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent",
				"transition-colors outline-none",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"disabled:cursor-not-allowed disabled:opacity-50",
				"data-[state=unchecked]:bg-edge data-[state=checked]:bg-coral",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				className={cn(
					"pointer-events-none block h-5 w-5 rounded-full bg-paper shadow-[var(--shadow-1)]",
					"transition-transform duration-[400ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:duration-150",
					"data-[state=unchecked]:translate-x-0.5 data-[state=checked]:translate-x-[1.375rem]",
				)}
			/>
		</SwitchPrimitive.Root>
	);
});
Switch.displayName = "Switch";
