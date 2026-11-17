// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/cn";

/**
 * WeMail Chip primitive — a small pill used for tags, labels, and status
 * markers. Five variants map onto the WeMail palette (coral / amber /
 * green / blue / ink). Optionally renders a remove affordance with an
 * accessible name of the form `Remove ${label}`.
 */
export const chipVariants = cva(
	[
		"inline-flex items-center gap-1 rounded-full border",
		"px-2 py-0.5 text-xs font-medium select-none",
	].join(" "),
	{
		variants: {
			variant: {
				coral: "bg-coral/10 text-coral border-coral/30",
				amber: "bg-amber-bg text-amber border-amber/30",
				green: "bg-green/10 text-green border-green/30",
				blue: "bg-blue/10 text-blue border-blue/30",
				ink: "bg-paper-2 text-ink border-edge",
			},
			disabled: {
				true: "opacity-50 cursor-not-allowed",
				false: "",
			},
		},
		defaultVariants: {
			variant: "ink",
			disabled: false,
		},
	},
);

export type ChipVariant = NonNullable<
	VariantProps<typeof chipVariants>["variant"]
>;

export interface ChipProps
	extends Omit<React.HTMLAttributes<HTMLSpanElement>, "onClick"> {
	variant: ChipVariant;
	label: string;
	disabled?: boolean;
	removable?: boolean;
	onRemove?: () => void;
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
	{
		variant,
		label,
		disabled = false,
		removable = false,
		onRemove,
		className,
		...rest
	},
	ref,
) {
	return (
		<span
			ref={ref}
			data-testid="chip"
			aria-disabled={disabled || undefined}
			className={cn(chipVariants({ variant, disabled }), className)}
			{...rest}
		>
			<span>{label}</span>
			{removable ? (
				<button
					type="button"
					aria-label={`Remove ${label}`}
					disabled={disabled}
					onClick={onRemove}
					className={cn(
						"inline-flex h-3.5 w-3.5 items-center justify-center",
						"rounded-full text-current opacity-70 hover:opacity-100",
						"focus:outline-none focus-visible:ring-1 focus-visible:ring-current",
					)}
				>
					<span aria-hidden="true" className="text-xs leading-none">
						×
					</span>
				</button>
			) : null}
		</span>
	);
});

Chip.displayName = "Chip";

export default Chip;
