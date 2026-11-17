// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "~/lib/cn";

/**
 * WeMail Tabs primitive (wraps @radix-ui/react-tabs).
 *
 * Animation strategy: plain `transition-colors` for trigger state changes
 * (no tailwindcss-animate dependency) — consistent across primitives.
 */

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
	React.ElementRef<typeof TabsPrimitive.List>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
	return (
		<TabsPrimitive.List
			ref={ref}
			className={cn(
				"inline-flex h-10 w-full items-center justify-start gap-1 border-b border-edge text-ink-3",
				className,
			)}
			{...props}
		/>
	);
});
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
	React.ElementRef<typeof TabsPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
	return (
		<TabsPrimitive.Trigger
			ref={ref}
			className={cn(
				"inline-flex items-center justify-center whitespace-nowrap px-3 py-2 text-sm font-medium",
				"-mb-px border-b-2 border-transparent",
				"text-ink-3 transition-colors outline-none",
				"hover:text-ink",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
				"disabled:pointer-events-none disabled:opacity-50",
				"data-[state=active]:border-coral data-[state=active]:text-coral",
				className,
			)}
			{...props}
		/>
	);
});
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = forwardRef<
	React.ElementRef<typeof TabsPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
	return (
		<TabsPrimitive.Content
			ref={ref}
			className={cn(
				"mt-2 outline-none",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
				className,
			)}
			{...props}
		/>
	);
});
TabsContent.displayName = "TabsContent";
