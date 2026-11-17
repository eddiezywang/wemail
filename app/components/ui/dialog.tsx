// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "~/lib/cn";

const CloseIcon = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</svg>
);

/**
 * WeMail Dialog primitive (wraps @radix-ui/react-dialog).
 *
 * Animation strategy: tailwindcss-animate / tw-animate-css are NOT installed.
 * Entrance/exit are driven by the global `wm-overlay-*` keyframes in
 * `app/index.css`, which key off Radix's `data-state` attribute. The overlay
 * itself stays fade-only; the content panel adds an 8px lift + 0.96→1 scale
 * over `--duration-base` with `--ease-out-quart`.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
	React.ElementRef<typeof DialogPrimitive.Overlay>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
	return (
		<DialogPrimitive.Overlay
			ref={ref}
			className={cn(
				"fixed inset-0 z-50 bg-ink/50",
				"wm-overlay-fade",
				className,
			)}
			{...props}
		/>
	);
});
DialogOverlay.displayName = "DialogOverlay";

export const DialogContent = forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
		showClose?: boolean;
	}
>(function DialogContent(
	{ className, children, showClose = true, ...props },
	ref,
) {
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				ref={ref}
				className={cn(
					"fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
					"bg-paper-2 text-ink border border-edge rounded-xl shadow-[var(--shadow-3)]",
					"p-6 grid gap-4",
					"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					"wm-overlay-enter",
					className,
				)}
				{...props}
			>
				{children}
				{showClose ? (
					<DialogPrimitive.Close
						className={cn(
							"absolute right-4 top-4 rounded-sm opacity-70 transition-opacity",
							"hover:opacity-100",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							"disabled:pointer-events-none",
						)}
					>
						<CloseIcon />
						<span className="sr-only">关闭</span>
					</DialogPrimitive.Close>
				) : null}
			</DialogPrimitive.Content>
		</DialogPortal>
	);
});
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("flex flex-col gap-1.5 text-left", className)}
		{...props}
	/>
);
DialogHeader.displayName = "DialogHeader";

export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
		{...props}
	/>
);
DialogFooter.displayName = "DialogFooter";

export const DialogTitle = forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
	return (
		<DialogPrimitive.Title
			ref={ref}
			className={cn(
				"text-title font-semibold leading-none tracking-tight text-ink",
				className,
			)}
			{...props}
		/>
	);
});
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
	return (
		<DialogPrimitive.Description
			ref={ref}
			className={cn("text-sm text-ink-3", className)}
			{...props}
		/>
	);
});
DialogDescription.displayName = "DialogDescription";
