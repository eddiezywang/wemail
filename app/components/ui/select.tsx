// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "~/lib/cn";

/**
 * WeMail Select primitive (wraps @radix-ui/react-select).
 *
 * Animation strategy: plain `transition-opacity` + `data-[state=*]` toggles
 * (no tailwindcss-animate dependency) — consistent across overlay primitives.
 */

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

const ChevronDownIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<polyline points="6 9 12 15 18 9" />
	</svg>
);

const ChevronUpIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<polyline points="18 15 12 9 6 15" />
	</svg>
);

const CheckIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<polyline points="20 6 9 17 4 12" />
	</svg>
);

export const SelectTrigger = forwardRef<
	React.ElementRef<typeof SelectPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
	return (
		<SelectPrimitive.Trigger
			ref={ref}
			className={cn(
				"flex h-10 w-full items-center justify-between gap-2 rounded-md border border-edge bg-paper-2 px-3 py-2",
				"text-sm text-ink placeholder:text-ink-3",
				"shadow-[var(--shadow-1)]",
				"transition-colors outline-none",
				"focus-visible:border-coral focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				"aria-invalid:border-red aria-invalid:ring-2 aria-invalid:ring-red/40",
				"data-[placeholder]:text-ink-3",
				"[&>span]:line-clamp-1",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon asChild>
				<span className="text-ink-3">
					<ChevronDownIcon />
				</span>
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
});
SelectTrigger.displayName = "SelectTrigger";

export const SelectScrollUpButton = forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(function SelectScrollUpButton({ className, ...props }, ref) {
	return (
		<SelectPrimitive.ScrollUpButton
			ref={ref}
			className={cn(
				"flex cursor-default items-center justify-center py-1 text-ink-3",
				className,
			)}
			{...props}
		>
			<ChevronUpIcon />
		</SelectPrimitive.ScrollUpButton>
	);
});
SelectScrollUpButton.displayName = "SelectScrollUpButton";

export const SelectScrollDownButton = forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(function SelectScrollDownButton({ className, ...props }, ref) {
	return (
		<SelectPrimitive.ScrollDownButton
			ref={ref}
			className={cn(
				"flex cursor-default items-center justify-center py-1 text-ink-3",
				className,
			)}
			{...props}
		>
			<ChevronDownIcon />
		</SelectPrimitive.ScrollDownButton>
	);
});
SelectScrollDownButton.displayName = "SelectScrollDownButton";

export const SelectContent = forwardRef<
	React.ElementRef<typeof SelectPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				ref={ref}
				position={position}
				className={cn(
					"relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-edge bg-paper text-ink shadow-lg",
					"transition-opacity duration-150",
					"data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
					position === "popper" &&
						"data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
					className,
				)}
				{...props}
			>
				<SelectScrollUpButton />
				<SelectPrimitive.Viewport
					className={cn(
						"p-1",
						position === "popper" &&
							"h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
					)}
				>
					{children}
				</SelectPrimitive.Viewport>
				<SelectScrollDownButton />
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	);
});
SelectContent.displayName = "SelectContent";

export const SelectLabel = forwardRef<
	React.ElementRef<typeof SelectPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
	return (
		<SelectPrimitive.Label
			ref={ref}
			className={cn("px-2 py-1.5 text-xs font-medium text-ink-3", className)}
			{...props}
		/>
	);
});
SelectLabel.displayName = "SelectLabel";

export const SelectItem = forwardRef<
	React.ElementRef<typeof SelectPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
	return (
		<SelectPrimitive.Item
			ref={ref}
			className={cn(
				"relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
				"text-ink transition-colors",
				"focus:bg-paper-3 focus:text-ink",
				"data-[state=checked]:text-ink",
				"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center text-coral">
				<SelectPrimitive.ItemIndicator>
					<CheckIcon />
				</SelectPrimitive.ItemIndicator>
			</span>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	);
});
SelectItem.displayName = "SelectItem";

export const SelectSeparator = forwardRef<
	React.ElementRef<typeof SelectPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(function SelectSeparator({ className, ...props }, ref) {
	return (
		<SelectPrimitive.Separator
			ref={ref}
			className={cn("-mx-1 my-1 h-px bg-edge", className)}
			{...props}
		/>
	);
});
SelectSeparator.displayName = "SelectSeparator";
