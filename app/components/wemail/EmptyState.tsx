import type { ReactNode } from "react";

export interface EmptyStateAction {
	label: string;
	onClick: () => void;
	variant?: "primary" | "secondary";
}

export interface EmptyStateProps {
	icon: ReactNode;
	title: string;
	description: string;
	actions?: EmptyStateAction[];
	kind?: "empty" | "error";
	className?: string;
	"data-testid"?: string;
}

export function EmptyState({
	icon,
	title,
	description,
	actions = [],
	kind = "empty",
	className = "",
	"data-testid": testId,
}: EmptyStateProps) {
	return (
		<div
			data-testid={testId}
			className={`flex h-full min-h-[280px] items-center justify-center px-6 py-10 ${className}`}
		>
			<div className="w-full max-w-[360px] text-center">
				<div aria-hidden className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border shadow-sm ${kind === "error" ? "border-red/20 bg-red-bg text-red" : "border-edge bg-paper-3 text-coral-2"}`}>
					{icon}
				</div>
				<div role={kind === "error" ? "alert" : undefined}>
					<h3 className="text-body font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{title}</h3>
					<p className="mx-auto mt-2 max-w-[300px] text-sm leading-relaxed text-ink-3 [overflow-wrap:anywhere]">{description}</p>
				</div>
				{actions.length > 0 ? (
					<div className="mt-5 flex flex-wrap items-center justify-center gap-2">
						{actions.map((action) => (
							<button
								key={action.label}
								type="button"
								onClick={action.onClick}
								className={
									action.variant === "primary"
										? "inline-flex min-h-11 items-center rounded-full bg-coral-2 px-4 text-ui font-medium text-paper-2 transition-colors hover:bg-coral-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										: "inline-flex min-h-11 items-center rounded-full border border-edge bg-paper-2 px-4 text-ui font-medium text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								}
							>
								{action.label}
							</button>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

export default EmptyState;
