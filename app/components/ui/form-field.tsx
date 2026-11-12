import { useId, type ReactElement, type ReactNode } from "react";
import { cloneElement } from "react";
import { cn } from "~/lib/cn";

export interface FormFieldProps {
	label: string;
	children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
	description?: ReactNode;
	error?: ReactNode;
	required?: boolean;
	className?: string;
}

export function FormField({ label, children, description, error, required, className }: FormFieldProps) {
	const generatedId = useId();
	const inputId = children.props.id ?? `${generatedId}-control`;
	const descriptionId = description ? `${generatedId}-description` : undefined;
	const errorId = error ? `${generatedId}-error` : undefined;
	const describedBy = [children.props["aria-describedby"], descriptionId, errorId].filter(Boolean).join(" ") || undefined;
	return (
		<div className={cn("space-y-1.5", className)}>
			<label htmlFor={inputId} className="block text-sm font-medium text-ink-2">
				{label}{required ? <span className="ml-1 text-red" aria-hidden="true">*</span> : null}
			</label>
			{cloneElement(children, { id: inputId, "aria-describedby": describedBy, "aria-invalid": !!error || undefined })}
			{description ? <p id={descriptionId} className="text-xs leading-5 text-ink-3">{description}</p> : null}
			{error ? <p id={errorId} role="alert" className="text-xs leading-5 text-red">{error}</p> : null}
		</div>
	);
}
