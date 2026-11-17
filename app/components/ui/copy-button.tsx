// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { forwardRef, useEffect, useRef, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";

/**
 * Copy-to-clipboard button with inline confirmation (Kinetics "Copy
 * Button"): the copy glyph crossfades into a springing check while the
 * label swaps to the copied text, reverting after ~1.4s. Supersedes a
 * success toast for the common case — the feedback lives on the button
 * the user just pressed.
 */

const REVERT_MS = 1400;

export interface CopyButtonProps {
	text?: string;
	/**
	 * Custom copy routine (e.g. desktop IPC) that resolves false when the
	 * copy failed — it is expected to surface its own error toast. Defaults
	 * to `navigator.clipboard.writeText(text)`.
	 */
	copyAction?: () => Promise<boolean>;
	/** Label pair; defaults to 复制 / 已复制. Ignored when iconOnly. */
	labels?: { idle: string; copied: string };
	/** Icon-only affordance — pass aria-label via props. */
	iconOnly?: boolean;
	iconSize?: number;
	onCopied?: () => void;
	onError?: (error: unknown) => void;
}

export const CopyButton = forwardRef<
	HTMLButtonElement,
	CopyButtonProps & Omit<React.ComponentPropsWithoutRef<typeof Button>, "onClick" | "children">
>(function CopyButton(
	{
		text = "",
		copyAction,
		labels,
		iconOnly = false,
		iconSize = 14,
		onCopied,
		onError,
		disabled,
		...props
	},
	ref,
) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, []);

	const handleClick = async () => {
		try {
			if (copyAction) {
				if (!(await copyAction())) return;
			} else {
				await navigator.clipboard.writeText(text);
			}
		} catch (error) {
			onError?.(error);
			return;
		}
		setCopied(true);
		onCopied?.();
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		timerRef.current = window.setTimeout(() => setCopied(false), REVERT_MS);
	};

	return (
		<Button
			ref={ref}
			disabled={disabled || (!copyAction && !text)}
			onClick={() => void handleClick()}
			{...props}
		>
			<span
				aria-hidden
				className="relative inline-block shrink-0"
				style={{ width: iconSize, height: iconSize }}
			>
				<CopyIcon
					size={iconSize}
					className={cn(
						"absolute inset-0 transition-[opacity,transform] duration-200",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
					)}
				/>
				<CheckIcon
					size={iconSize}
					weight="bold"
					className={cn(
						"absolute inset-0 text-green transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
					)}
				/>
			</span>
			{iconOnly ? null : (
				<span>{copied ? (labels?.copied ?? "已复制") : (labels?.idle ?? "复制")}</span>
			)}
		</Button>
	);
});
CopyButton.displayName = "CopyButton";
