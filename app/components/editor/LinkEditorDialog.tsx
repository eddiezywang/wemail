import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

interface LinkEditorDialogProps {
	open: boolean;
	initialValue?: string;
	onOpenChange: (open: boolean) => void;
	onSubmit: (url: string) => void;
}

function normalizeLink(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed, "https://example.invalid");
		if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
		return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	} catch {
		return null;
	}
}

export function LinkEditorDialog({
	open,
	initialValue = "",
	onOpenChange,
	onSubmit,
}: LinkEditorDialogProps) {
	const [value, setValue] = useState(initialValue);
	const [error, setError] = useState("");

	useEffect(() => {
		if (open) {
			setValue(initialValue);
			setError("");
		}
	}, [initialValue, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						const normalized = normalizeLink(value);
						if (normalized === null) {
							setError("请输入有效的网页或邮件链接。");
							return;
						}
						onSubmit(normalized);
						onOpenChange(false);
					}}
					className="grid gap-4"
				>
					<DialogHeader>
						<DialogTitle>编辑链接</DialogTitle>
						<DialogDescription>输入网页地址或邮件地址；留空可移除链接。</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<label htmlFor="editor-link-url" className="text-sm font-medium text-ink">
							链接地址
						</label>
						<Input
							id="editor-link-url"
							value={value}
							onChange={(event) => {
								setValue(event.target.value);
								setError("");
							}}
							placeholder="https://example.com"
							autoFocus
							aria-invalid={!!error}
							aria-describedby={error ? "editor-link-error" : undefined}
						/>
						{error ? <p id="editor-link-error" role="alert" className="text-xs text-red">{error}</p> : null}
					</div>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>取消</Button>
						<Button type="submit">保存</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
