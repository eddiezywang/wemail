import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { cn } from "~/lib/cn";

type AsyncStateKind = "loading" | "empty" | "error" | "degraded" | "not-found";

export interface AsyncStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
	kind: AsyncStateKind;
	title: string;
	description?: string;
	actionLabel?: string;
	onAction?: () => void;
	actionPending?: boolean;
	icon?: ReactNode;
	/**
	 * Delay the loading state (S1): nothing renders for the first 300ms and
	 * a shown state stays at least 500ms. Off by default so existing fast
	 * surfaces keep their behaviour; opt in on queries that can be quick.
	 */
	delayed?: boolean;
	className?: string;
}

export function AsyncState({
	kind,
	title,
	description,
	actionLabel,
	onAction,
	actionPending = false,
	icon,
	delayed = false,
	className,
	...props
}: AsyncStateProps) {
	const delayedVisible = useDelayedFlag(kind === "loading" && delayed);
	if (delayed && !delayedVisible) return null;
	const live = kind === "loading" ? "polite" : kind === "error" ? "assertive" : undefined;
	const role = kind === "error" ? "alert" : kind === "loading" ? "status" : undefined;
	return (
		<div
			{...props}
			role={role}
			aria-live={live}
			aria-busy={kind === "loading" || actionPending || undefined}
			className={cn("flex min-h-40 flex-col items-center justify-center px-6 py-8 text-center", className)}
		>
			<div aria-hidden="true" className={cn("mb-3 text-ink-3", kind === "error" && "text-red")}>
				{icon ?? (kind === "loading" ? (
					<SpinnerGapIcon size={16} className="animate-spin motion-reduce:animate-none" />
				) : kind === "error" ? (
					<WarningCircleIcon size={16} />
				) : null)}
			</div>
			<h3 className="text-sm font-semibold text-ink">{title}</h3>
			{description ? <p className="mt-1 max-w-md text-sm leading-6 text-ink-3">{description}</p> : null}
			{actionLabel && onAction ? (
				<Button className="mt-4" size="sm" variant="secondary" onClick={onAction} loading={actionPending}>
					{actionLabel}
				</Button>
			) : null}
		</div>
	);
}
