// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useRef } from "react";
import { cn } from "~/lib/cn";

/**
 * A number that pops with a spring scale whenever its value changes
 * (Kinetics "Number Counter"). The first render settles silently — only
 * real changes animate. `.animate-number-bump` lives in app/index.css.
 */
export function PopNumber({
	value,
	className,
	format = (n) => n.toLocaleString(),
}: {
	value: number;
	className?: string;
	format?: (value: number) => string;
}) {
	const prevRef = useRef<number>(value);
	const changed = prevRef.current !== value;
	prevRef.current = value;
	return (
		// Re-keying on change replays the bump animation cleanly.
		<span
			key={changed ? `bump-${value}` : "steady"}
			className={cn("inline-block tabular-nums motion-reduce:animate-none", changed && "animate-number-bump", className)}
		>
			{format(value)}
		</span>
	);
}
