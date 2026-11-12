import { forwardRef } from "react";
import { cn } from "~/lib/cn";

export interface IconActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	label: string;
	size?: "sm" | "md" | "lg";
}

export const IconAction = forwardRef<HTMLButtonElement, IconActionProps>(function IconAction(
	{ label, size = "md", className, type = "button", children, ...props },
	ref,
) {
	return (
		<button
			ref={ref}
			type={type}
			aria-label={label}
			title={props.title ?? label}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors",
				"hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"disabled:pointer-events-none disabled:opacity-50",
				size === "sm" && "h-9 w-9",
				size === "md" && "h-10 w-10",
				size === "lg" && "h-11 w-11",
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
});

IconAction.displayName = "IconAction";
