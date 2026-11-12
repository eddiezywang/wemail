// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/cn";

/**
 * WeMail `AICard` — generic shell for any LLM-driven surface (summary,
 * original-text reveal, smart draft). It owns the visual state machine
 * (`empty | pending | success | failed`) so that downstream surfaces can
 * stay thin adapters.
 *
 * Per the `frontend-intelligence-ui` rule, the failure branch never
 * surfaces raw error strings; it always renders generic copy.
 */
export const aiCardVariants = cva(
	"rounded-md border border-edge bg-paper-2 p-3 text-sm",
	{
		variants: {
			variant: {
				summary: "",
				original: "",
				draft: "",
			},
			state: {
				empty: "text-ink-3",
				pending: "",
				success: "",
				failed: "",
			},
		},
		defaultVariants: {
			variant: "summary",
			state: "empty",
		},
	},
);

export type AICardVariant = NonNullable<
	VariantProps<typeof aiCardVariants>["variant"]
>;
export type AICardState = NonNullable<
	VariantProps<typeof aiCardVariants>["state"]
>;

const VARIANT_LABEL: Record<AICardVariant, string> = {
	summary: "Summary",
	original: "Original",
	draft: "Draft",
};

const FAILED_COPY = "Couldn't generate — please retry.";

export interface AICardProps
	extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
	variant: AICardVariant;
	state: AICardState;
	header?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
}

export const AICard = forwardRef<HTMLElement, AICardProps>(function AICard(
	{
		variant,
		state,
		header,
		actions,
		children,
		className,
		...rest
	},
	ref,
) {
	const showBody = state !== "failed";
	return (
		<section
			ref={ref}
			data-testid="ai-card"
			data-state={state}
			data-variant={variant}
			aria-busy={state === "pending" || undefined}
			className={cn(aiCardVariants({ variant, state }), className)}
			{...rest}
		>
			<header className="flex items-center justify-between pb-2">
				<span
					data-testid="ai-card-variant-label"
					className={cn(
						"inline-flex items-center rounded-md bg-paper-3 px-1.5 py-0.5",
						"text-xs font-semibold uppercase tracking-wide text-ink-3",
						"border border-edge",
					)}
				>
					{VARIANT_LABEL[variant]}
				</span>
				{header ? <div className="ml-2 min-w-0 flex-1">{header}</div> : null}
			</header>

			{state === "failed" ? (
				<p
					data-testid="ai-card-failed"
					className="text-ink-2"
				>
					{FAILED_COPY}
				</p>
			) : null}

			{showBody && children ? (
				<div data-testid="ai-card-body">{children}</div>
			) : null}

			{actions ? (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{actions}
				</div>
			) : null}
		</section>
	);
});

AICard.displayName = "AICard";

export default AICard;
