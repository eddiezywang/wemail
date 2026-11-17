import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";

export interface ConfirmActionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	confirmLabel: string;
	onConfirm: () => void;
	pending?: boolean;
	destructive?: boolean;
	cancelLabel?: string;
}

export function ConfirmActionDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
	pending = false,
	destructive = true,
	cancelLabel = "取消",
}: ConfirmActionDialogProps) {
	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent className="max-w-[440px]" showClose={!pending}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription asChild>
						<div className="text-sm leading-6 text-ink-3">{description}</div>
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
						{cancelLabel}
					</Button>
					<Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} loading={pending}>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
