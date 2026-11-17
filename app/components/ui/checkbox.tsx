// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef } from "react";
import { cn } from "~/lib/cn";

/**
 * WeMail Checkbox primitive — a native input for semantics plus an SVG
 * overlay whose tick is *drawn* on (Kinetics "Checkbox Draw"): the path's
 * stroke-dashoffset animates from full to 0 over ~320ms with a short delay,
 * so checking reads as a pen stroke rather than a glyph toggle.
 *
 * Sizing/styling of the box flows through `boxClassName` so call sites keep
 * their per-surface border/radius tokens; `label` becomes the input's
 * aria-label (accessible name).
 */

export interface CheckboxProps
	extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> {
	checked: boolean;
	onChange?: (checked: boolean) => void;
	label?: string;
	/** Box size in px (default 16). */
	size?: number;
	/** Extra classes for the visible box (radius, unchecked border, bg). */
	boxClassName?: string;
}

const TICK_PATH_LENGTH = 16;

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
	{ checked, onChange, disabled, label, size = 16, boxClassName, className, ...props },
	ref,
) {
	return (
		<span
			className={cn("relative inline-block", className)}
			style={{ width: size, height: size }}
		>
			<input
				ref={ref}
				type="checkbox"
				checked={checked}
				disabled={disabled}
				aria-label={label}
				onChange={(event) => onChange?.(event.currentTarget.checked)}
				className={cn(
					"peer absolute inset-0 h-full w-full cursor-pointer appearance-none border bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35",
					checked ? "border-coral bg-coral" : "border-edge-2",
					boxClassName,
				)}
				{...props}
			/>
			<svg
				aria-hidden="true"
				viewBox="0 0 14 14"
				className="pointer-events-none absolute inset-0 h-full w-full text-paper-2"
			>
				<path
					d="M3 7.5 L6 10.5 L11 3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeDasharray={TICK_PATH_LENGTH}
					className={cn(
						"transition-[stroke-dashoffset] duration-[320ms] delay-[40ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
						checked ? "[stroke-dashoffset:0]" : "[stroke-dashoffset:16px]",
					)}
				/>
			</svg>
		</span>
	);
});
Checkbox.displayName = "Checkbox";
