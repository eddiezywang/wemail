// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useRef } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";

export interface AgentActionConfirmDialogProps {
	open: boolean;
	title: string;
	description: string;
	onConfirm: () => void;
	onCancel: () => void;
	dangerous?: boolean;
	confirmLabel?: string;
	cancelLabel?: string;
	feedback?: {
		status: "running" | "success" | "error";
		title: string;
		description: string;
		detail?: string;
		progressText?: string;
		closeLabel?: string;
	};
}

/**
 * Generic confirmation modal consumed by Packages I (WeCLI non-ls/list
 * commands) and J (PI agent tool calls). Uses the shared shadcn Dialog
 * so the overlay / focus-trap / animation stay consistent with the rest
 * of the app. Packages I and J must NOT fork this component.
 */
export default function AgentActionConfirmDialog({
	open,
	title,
	description,
	onConfirm,
	onCancel,
	dangerous,
	confirmLabel,
	cancelLabel,
	feedback,
}: AgentActionConfirmDialogProps) {
	const confirmRef = useRef<HTMLButtonElement | null>(null);
	const blocking = feedback?.status === "running";

	useEffect(() => {
		if (!open || feedback) return;
		// Focus the confirm button after the dialog animates in
		const timer = setTimeout(() => confirmRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, [feedback, open]);

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !blocking) onCancel();
			}}
		>
			<DialogContent
				data-testid="wemail-confirm-dialog"
				data-dangerous={dangerous ? "true" : "false"}
				data-phase={feedback?.status ?? "confirm"}
				className={`max-w-md ${dangerous ? "border-red" : ""}`}
				showClose={!blocking}
				onEscapeKeyDown={(event) => {
					if (blocking) event.preventDefault();
				}}
				onPointerDownOutside={(event) => {
					if (blocking) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (blocking) event.preventDefault();
				}}
			>
				<DialogTitle
					className={`text-sm font-semibold ${
						dangerous ? "text-red" : ""
					}`}
					data-testid="wemail-confirm-title"
				>
					{title}
				</DialogTitle>
				<DialogDescription className="whitespace-pre-wrap text-sm text-ink">
					{description}
				</DialogDescription>
				{feedback ? (
					<div
						className={`rounded-xl border px-3.5 py-3 ${
							feedback.status === "success"
								? "border-green/30 bg-green-bg"
								: feedback.status === "error"
									? "border-red/30 bg-red-bg"
									: "border-amber/30 bg-amber-bg"
						}`}
						role={feedback.status === "error" ? "alert" : "status"}
						aria-live="polite"
						data-testid="wemail-confirm-feedback"
					>
						<div className="flex items-start gap-2.5">
							<span
								className={`mt-0.5 shrink-0 ${
									feedback.status === "success"
										? "text-green"
										: feedback.status === "error"
											? "text-red"
											: "text-amber"
								}`}
								aria-hidden="true"
							>
								{feedback.status === "success" ? (
									<CheckCircleIcon size={18} weight="fill" />
								) : feedback.status === "error" ? (
									<WarningCircleIcon size={18} weight="fill" />
								) : (
									<SpinnerGapIcon size={18} className="animate-spin motion-reduce:animate-none" />
								)}
							</span>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-semibold text-ink">
									{feedback.title}
								</div>
								<p className="mt-1 select-text text-xs leading-5 text-ink-2">
									{feedback.description}
								</p>
								{feedback.status === "running" ? (
									<div className="mt-3" aria-label="安装进行中">
									<div className="h-1.5 overflow-hidden rounded-full bg-edge-3">
											<div className="h-full w-2/3 animate-pulse rounded-full bg-coral motion-reduce:animate-none" />
										</div>
										{feedback.progressText ? (
											<div className="mt-1.5 text-xs text-ink-3">
												{feedback.progressText}
											</div>
										) : null}
									</div>
								) : null}
								{feedback.detail ? (
									<pre
										className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-black/5 bg-white/70 px-2.5 py-2 font-mono text-xs leading-4 text-ink-2 select-text"
										data-testid="wemail-confirm-feedback-detail"
									>
										{feedback.detail}
									</pre>
								) : null}
							</div>
						</div>
					</div>
				) : null}
				{feedback?.status === "running" ? (
					<p className="mt-1 text-right text-xs text-ink-3">
						安装完成或失败后才能关闭此窗口
					</p>
				) : (
					<div className="mt-4 flex justify-end gap-2">
						{feedback ? null : (
							<button
								type="button"
								data-testid="wemail-confirm-cancel"
								onClick={onCancel}
								className="rounded border border-edge px-3 py-1 text-xs hover:bg-paper-3"
							>
								{cancelLabel ?? "取消 / Cancel"}
							</button>
						)}
						<button
							ref={feedback ? undefined : confirmRef}
							type="button"
							data-testid={
								feedback
									? "wemail-confirm-close-result"
									: "wemail-confirm-confirm"
							}
							onClick={feedback ? onCancel : onConfirm}
							className={`rounded px-3 py-1 text-xs font-medium text-white ${
								feedback?.status === "success"
									? "bg-green hover:opacity-90"
									: feedback?.status === "error" || dangerous
										? "bg-red hover:bg-red-2"
										: "bg-green hover:bg-green/80"
							}`}
						>
							{feedback
								? feedback.closeLabel ?? "关闭"
								: confirmLabel ??
									(dangerous ? "确认 / Proceed" : "确认 / Confirm")}
						</button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
