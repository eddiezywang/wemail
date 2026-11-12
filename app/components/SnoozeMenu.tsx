// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SnoozeMenu — upstream-style preset chooser used by the "Snooze" entry in
 * the email more-menu and by the Compose "Schedule…" button.
 *
 * Four presets:
 *   - Later today (next 18:00, or +3h if already past 18:00)
 *   - Tomorrow morning (next day 09:00)
 *   - Next Monday (09:00)
 *   - Custom (datetime-local input)
 *
 * The component is generic over its action label / handler so the same
 * UI serves both snooze-an-email and schedule-send-a-draft. No new deps —
 * uses the existing Radix Popover wrapper.
 */

import { useEffect, useId, useMemo, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";

export interface SnoozePreset {
	id: string;
	label: string;
	subtitle: string;
	at: Date;
}

export function getDefaultSnoozePresets(now: Date = new Date()): SnoozePreset[] {
	const presets: SnoozePreset[] = [];

	// Later today: 18:00 of today, or +3h if it's already past 18:00.
	const laterToday = new Date(now);
	laterToday.setSeconds(0, 0);
	if (now.getHours() < 18) {
		laterToday.setHours(18, 0, 0, 0);
	} else {
		laterToday.setHours(now.getHours() + 3, 0, 0, 0);
	}
	presets.push({
		id: "later-today",
		label: "稍后今天",
		subtitle: formatPresetTime(laterToday),
		at: laterToday,
	});

	// Tomorrow morning: next day at 09:00.
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(9, 0, 0, 0);
	presets.push({
		id: "tomorrow",
		label: "明早",
		subtitle: formatPresetTime(tomorrow),
		at: tomorrow,
	});

	// Next Monday at 09:00.
	const nextMonday = new Date(now);
	const daysUntilMonday = (1 - nextMonday.getDay() + 7) % 7 || 7;
	nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
	nextMonday.setHours(9, 0, 0, 0);
	presets.push({
		id: "next-monday",
		label: "下周一",
		subtitle: formatPresetTime(nextMonday),
		at: nextMonday,
	});

	return presets;
}

function formatPresetTime(date: Date): string {
	try {
		return date.toLocaleString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return date.toISOString();
	}
}

function toLocalDateTimeInputValue(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}`;
}

interface SnoozeMenuProps {
	/** Element to render as the popover trigger. */
	children: React.ReactNode;
	/** Title shown at the top of the popover. */
	title?: string;
	/** Default custom-input value; falls back to "+1h". */
	customDefault?: Date;
	/** Disable the trigger (parent handles visibility). */
	disabled?: boolean;
	/** Called with the chosen wake/send time as a Date. */
	onPick: (at: Date) => void;
	/** Optional align for Radix Popover content. */
	align?: "start" | "center" | "end";
}

export default function SnoozeMenu({
	children,
	title = "选择时间",
	customDefault,
	disabled,
	onPick,
	align = "end",
}: SnoozeMenuProps) {
	const [open, setOpen] = useState(false);
	const presets = useMemo(() => getDefaultSnoozePresets(), [open]);
	const initialCustom = useMemo(() => {
		const fallback = new Date();
		fallback.setHours(fallback.getHours() + 1, 0, 0, 0);
		return toLocalDateTimeInputValue(customDefault ?? fallback);
	}, [customDefault, open]);
	const [custom, setCustom] = useState(initialCustom);
	const [customError, setCustomError] = useState<string | null>(null);
	const customInputId = useId();
	const customErrorId = `${customInputId}-error`;

	useEffect(() => {
		if (!open) return;
		setCustom(initialCustom);
		setCustomError(null);
	}, [initialCustom, open]);

	const handlePick = (at: Date) => {
		setOpen(false);
		onPick(at);
	};

	const handleCustomConfirm = () => {
		if (!custom) {
			setCustomError("请选择一个时间");
			return;
		}
		const at = new Date(custom);
		if (Number.isNaN(at.getTime())) {
			setCustomError("时间格式无效，请重新选择");
			return;
		}
		if (at.getTime() <= Date.now()) {
			setCustomError("请选择晚于当前时间的时间");
			return;
		}
		setCustomError(null);
		handlePick(at);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				{children}
			</PopoverTrigger>
			<PopoverContent
				align={align}
				className="w-[260px] p-2 text-sm"
				data-testid="snooze-menu"
			>
				<div className="px-2 pt-1 pb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
					{title}
				</div>
				<div className="space-y-0.5">
					{presets.map((preset) => (
						<button
							key={preset.id}
							type="button"
							onClick={() => handlePick(preset.at)}
							className="w-full text-left rounded-md px-2 py-1.5 hover:bg-paper-3 flex items-baseline justify-between gap-3"
						>
							<span className="text-ink">{preset.label}</span>
							<span className="text-xs text-ink-3">
								{preset.subtitle}
							</span>
						</button>
					))}
				</div>
				<div className="mt-2 border-t border-edge-3 pt-2 px-2">
					<label htmlFor={customInputId} className="mb-1 block text-xs text-ink-3">
						自定义时间
					</label>
					<input
						id={customInputId}
						type="datetime-local"
						value={custom}
						min={toLocalDateTimeInputValue(new Date(Date.now() + 60_000))}
						onChange={(e) => {
							setCustom(e.target.value);
							setCustomError(null);
						}}
						aria-invalid={customError ? "true" : undefined}
						aria-describedby={customError ? customErrorId : undefined}
						className="w-full rounded-md border border-edge bg-paper-2 px-2 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-coral/30 aria-[invalid=true]:border-amber"
					/>
					{customError ? (
						<p id={customErrorId} role="alert" className="mt-1 text-xs text-amber">
							{customError}
						</p>
					) : (
						<p className="mt-1 text-xs text-ink-3">仅可选择未来时间</p>
					)}
					<button
						type="button"
						onClick={handleCustomConfirm}
						className="mt-2 w-full rounded-md bg-coral text-paper text-xs font-semibold py-1.5 hover:opacity-90 transition-opacity"
					>
						确定
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
