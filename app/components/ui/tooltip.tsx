// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef, type ComponentProps } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "~/lib/cn";

/**
 * WeMail Tooltip primitive (wraps @radix-ui/react-tooltip).
 *
 * Animation strategy: plain `transition-opacity` + `data-[state=*]` toggles
 * (no tailwindcss-animate dependency) — consistent across overlay primitives.
 *
 * Convention: consumers compose `<Tooltip><TooltipTrigger /><TooltipContent />`
 * explicitly (shadcn pattern). No combined convenience wrapper is exported.
 */

export function TooltipProvider({
	delayDuration = 300,
	...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
	return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}
TooltipProvider.displayName = "TooltipProvider";

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

export const TooltipContent = forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 4, ...props }, ref) {
	return (
		<TooltipPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			className={cn(
				"z-50 overflow-hidden rounded-md bg-ink px-2.5 py-1.5 text-xs text-paper shadow-md",
				"transition-opacity duration-150",
				"data-[state=delayed-open]:opacity-100 data-[state=instant-open]:opacity-100 data-[state=closed]:opacity-0",
				className,
			)}
			{...props}
		/>
	);
});
TooltipContent.displayName = "TooltipContent";
