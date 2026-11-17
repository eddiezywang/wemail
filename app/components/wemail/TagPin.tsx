// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type TagPinVariant = "coral" | "amber" | "green" | "blue" | "ink";

export interface TagPinProps {
	label: string;
	variant?: TagPinVariant;
}

const DOT_BG: Record<TagPinVariant, string> = {
	coral: "bg-coral",
	amber: "bg-amber",
	green: "bg-green",
	blue: "bg-blue",
	ink: "bg-ink-3",
};

const TEXT_COLOR: Record<TagPinVariant, string> = {
	coral: "text-coral",
	amber: "text-amber",
	green: "text-green",
	blue: "text-blue",
	ink: "text-ink-2",
};

/**
 * Compact tag visual: small color dot + label, suitable for dense list
 * rows and the message detail header. Shares a palette with `Chip` but
 * is non-interactive and quieter.
 */
export function TagPin({ label, variant = "ink" }: TagPinProps) {
	return (
		<span
			data-testid="tag-pin"
			data-variant={variant}
			className={`inline-flex items-center gap-1 text-xs ${TEXT_COLOR[variant]}`}
		>
			<span
				aria-hidden="true"
				className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_BG[variant]}`}
			/>
			<span>{label}</span>
		</span>
	);
}

export default TagPin;
