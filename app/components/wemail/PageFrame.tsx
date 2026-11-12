import type { ReactNode } from "react";

export interface PageFrameProps {
	title: string;
	subtitle?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	appearance?: "card" | "workspace";
	className?: string;
	contentClassName?: string;
	testId?: string;
}

export function PageFrame({
	title,
	subtitle,
	actions,
	children,
	appearance = "card",
	className = "",
	contentClassName = "",
	testId,
}: PageFrameProps) {
	const isWorkspaceSurface = appearance === "workspace";
	return (
		<div
			className={`flex h-full flex-col overflow-hidden ${
				isWorkspaceSurface
					? "bg-transparent"
					: "rounded-xl border border-edge bg-paper-2 shadow-[var(--shadow-2)]"
			} ${className}`}
			data-testid={testId}
		>
			<header
				className={`shrink-0 border-b border-edge-3 px-8 pb-5 pt-7 md:px-12 ${
					isWorkspaceSurface ? "bg-transparent" : "bg-paper-2"
				}`}
			>
				<div className="flex flex-wrap items-end justify-between gap-6">
					<div className="min-w-0">
						<h1 className="text-[28px] font-semibold leading-none tracking-tight text-ink">
							{title}
						</h1>
						{subtitle ? (
							<p className="mt-2 text-xs font-medium text-ink-3">
								{subtitle}
							</p>
						) : null}
					</div>
					{actions ? (
						<div className="flex shrink-0 items-center gap-2">{actions}</div>
					) : null}
				</div>
			</header>
			<div
				className={`min-h-0 flex-1 overflow-y-auto px-8 py-6 md:px-12 ${contentClassName}`}
			>
				{children}
			</div>
		</div>
	);
}

export default PageFrame;
