// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "~/lib/cn";

/**
 * WeMail Popover primitive (wraps @radix-ui/react-popover).
 *
 * Animation strategy: shares the `wm-overlay-enter` class with Dialog /
 * DropdownMenu so all overlays use the same 8px lift + 0.96→1 scale entrance
 * keyed off Radix's `data-state`. Keyframes live in `app/index.css`.
 */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverPortal = PopoverPrimitive.Portal;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = "center", sideOffset = 4, ...props }, ref) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				ref={ref}
				align={align}
				sideOffset={sideOffset}
				className={cn(
					"z-50 w-72 rounded-md border border-edge bg-paper p-4 text-ink shadow-lg outline-none",
					"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					"wm-overlay-enter",
					className,
				)}
				{...props}
			/>
		</PopoverPrimitive.Portal>
	);
});
PopoverContent.displayName = "PopoverContent";
