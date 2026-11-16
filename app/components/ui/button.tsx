// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/cn";

/**
 * WeMail Button primitive.
 *
 * All styling flows through WeMail design tokens (paper / ink / coral / edge)
 * exposed as Tailwind utilities via `app/styles/tokens.css`. shadcn-aliased
 * tokens (`bg-background`, `text-foreground`, `border-border`, `ring-ring`)
 * resolve to WeMail tokens, so either spelling is acceptable.
 *
 * Press feel (Kinetics "Squish Button"): :active scales down fast
 * (~100ms ease-out) while release springs back on an overshooting
 * cubic-bezier(0.34,1.56,0.64,1) — the asymmetric timing is what reads
 * as a physical press. Suppressed under prefers-reduced-motion.
 */
export const buttonVariants = cva(
	[
		"inline-flex items-center justify-center gap-2 whitespace-nowrap",
		"rounded-md font-medium select-none",
		"[transition-property:color,background-color,border-color,transform] [transition-duration:150ms,150ms,150ms,500ms] [transition-timing-function:ease,ease,ease,cubic-bezier(0.34,1.56,0.64,1)] outline-none",
		"active:scale-[0.97] active:[transition-duration:150ms,150ms,150ms,100ms] active:ease-out",
		"motion-reduce:transform-none",
		"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
		"disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0",
	].join(" "),
	{
		variants: {
			variant: {
				default: "bg-coral-2 text-paper-2 hover:bg-coral-strong",
				secondary: "bg-paper-2 text-ink hover:bg-paper-3 border border-edge",
				ghost: "bg-transparent text-ink hover:bg-paper-3",
				destructive: "bg-red text-paper hover:bg-coral-2",
				outline: "border border-edge bg-transparent text-ink hover:bg-paper-3",
			},
			size: {
				sm: "h-8 px-3 text-sm",
				md: "h-10 px-4 text-sm",
				lg: "h-12 px-6 text-base",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "md",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	loading?: boolean;
}

// Loading (S2): children keep their box (opacity only) so label and width
// never move; a 16px spinner cross-fades in centred over 180ms. The button
// stays keyboard-reachable — `aria-disabled` instead of `disabled` — and
// clicks are swallowed while busy. `disabled` still applies as before.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, variant, size, loading = false, disabled, children, type, onClick, ...props },
	ref,
) {
	const busy = loading;
	return (
		<button
			ref={ref}
			type={type ?? "button"}
			disabled={disabled}
			aria-disabled={busy || disabled || undefined}
			aria-busy={busy || undefined}
			data-loading={busy || undefined}
			onClick={(event) => {
				if (busy) {
					event.preventDefault();
					return;
				}
				onClick?.(event);
			}}
			className={cn(buttonVariants({ variant, size }), "relative", className)}
			{...props}
		>
			<span className={cn("inline-flex items-center gap-2", busy && "opacity-0")}>
				{children}
			</span>
			{busy ? (
				<span
					aria-hidden="true"
					className="wm-btn-spinner absolute inset-0 flex items-center justify-center"
				>
					<span className="inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent" />
				</span>
			) : null}
		</button>
	);
});

Button.displayName = "Button";
