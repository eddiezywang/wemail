// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "~/lib/cn";

/**
 * WeMail DropdownMenu primitive (wraps @radix-ui/react-dropdown-menu).
 *
 * Animation strategy: uses the global `wm-overlay-enter` class (defined in
 * `app/index.css`) so menus, submenus, dialogs, and popovers all share the
 * same 8px lift + 0.96→1 scale entrance keyed off Radix's `data-state`.
 */

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

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

const DotIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 24 24"
		fill="currentColor"
		stroke="none"
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="4" />
	</svg>
);

const ChevronRightIcon = () => (
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
		<polyline points="9 18 15 12 9 6" />
	</svg>
);

export const DropdownMenuSubTrigger = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
		inset?: boolean;
	}
>(function DropdownMenuSubTrigger({ className, inset, children, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.SubTrigger
			ref={ref}
			className={cn(
				"flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
				"text-ink",
				"focus:bg-paper-3 focus:text-ink",
				"data-[state=open]:bg-paper-3",
				inset && "pl-8",
				className,
			)}
			{...props}
		>
			{children}
			<span className="ml-auto">
				<ChevronRightIcon />
			</span>
		</DropdownMenuPrimitive.SubTrigger>
	);
});
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.SubContent
			ref={ref}
			className={cn(
				"z-50 min-w-[8rem] overflow-hidden rounded-md border border-edge bg-paper p-1 text-ink shadow-lg",
				"wm-overlay-enter",
				className,
			)}
			{...props}
		/>
	);
});
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export const DropdownMenuContent = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				ref={ref}
				sideOffset={sideOffset}
				className={cn(
					"z-50 min-w-[8rem] overflow-hidden rounded-md border border-edge bg-paper p-1 text-ink shadow-lg",
					"wm-overlay-enter",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
});
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
		inset?: boolean;
	}
>(function DropdownMenuItem({ className, inset, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.Item
			ref={ref}
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
				"text-ink transition-colors",
				"focus:bg-paper-3 focus:text-ink",
				"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
});
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, checked, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.CheckboxItem
			ref={ref}
			className={cn(
				"relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
				"text-ink transition-colors",
				"focus:bg-paper-3 focus:text-ink",
				"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			checked={checked}
			{...props}
		>
			<span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
				<DropdownMenuPrimitive.ItemIndicator>
					<CheckIcon />
				</DropdownMenuPrimitive.ItemIndicator>
			</span>
			{children}
		</DropdownMenuPrimitive.CheckboxItem>
	);
});
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuRadioItem = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.RadioItem
			ref={ref}
			className={cn(
				"relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
				"text-ink transition-colors",
				"focus:bg-paper-3 focus:text-ink",
				"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
				<DropdownMenuPrimitive.ItemIndicator>
					<DotIcon />
				</DropdownMenuPrimitive.ItemIndicator>
			</span>
			{children}
		</DropdownMenuPrimitive.RadioItem>
	);
});
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

export const DropdownMenuLabel = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
		inset?: boolean;
	}
>(function DropdownMenuLabel({ className, inset, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.Label
			ref={ref}
			className={cn(
				"px-2 py-1.5 text-xs font-medium text-ink-3",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
});
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
	return (
		<DropdownMenuPrimitive.Separator
			ref={ref}
			className={cn("-mx-1 my-1 h-px bg-edge", className)}
			{...props}
		/>
	);
});
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export const DropdownMenuShortcut = ({
	className,
	...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
	<span
		className={cn("ml-auto text-xs tracking-widest text-ink-3 font-mono-meta", className)}
		{...props}
	/>
);
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
