// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMemo } from "react";
import type { IconFunction, IconWeight } from "reicon";
import { cn } from "~/lib/cn";

/**
 * React adapter for the Reicon (reicon.dev) vanilla-JS icon factories.
 *
 * Reicon renders with `currentColor`, so icons inherit text color and
 * switch with hover/active states just like the Phosphor icons they
 * replace. Default weight is Outline; Filled is reserved for active
 * states (DESIGN.md AI-UI rule 6).
 */
export function Reicon({
	icon,
	size = 16,
	weight = "Outline",
	strokeWidth,
	className,
}: {
	icon: IconFunction;
	/** 行内 14px、工具栏/空态 16px（DESIGN.md AI-UI 规则 6）。 */
	size?: number;
	weight?: IconWeight;
	strokeWidth?: number | string;
	className?: string;
}) {
	const html = useMemo(
		() => icon.toSvg({ size, weight, ...(strokeWidth != null ? { strokeWidth } : {}) }),
		[icon, size, weight, strokeWidth],
	);
	return (
		<span
			aria-hidden="true"
			className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

export default Reicon;
