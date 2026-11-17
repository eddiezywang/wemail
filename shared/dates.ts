// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Consolidated date formatting utilities.
 *
 * Previously spread across `app/lib/utils.ts` (4 functions) and
 * `workers/lib/html.ts` (`formatEmailDate`). Now one canonical set
 * imported by both the frontend and backend.
 */

const WEEKDAYS_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

/** Parse safely — returns null on invalid dates instead of NaN-date. */
function safeParse(dateStr: string | undefined | null): Date | null {
	if (!dateStr) return null;
	try {
		const d = new Date(dateStr);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

/**
 * Email list rows.
 * - Today: "20:55"
 * - This year: "3月29日"
 * - Older: "2024年3月29日"
 */
export function formatListDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	}
	if (date.getFullYear() === now.getFullYear()) {
		return `${date.getMonth() + 1}月${date.getDate()}日`;
	}
	return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * Email detail header.
 * "3月29日 周日 20:55"
 */
export function formatDetailDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const m = date.getMonth() + 1;
	const d = date.getDate();
	const w = WEEKDAYS_CN[date.getDay()];
	return `${m}月${d}日 ${w} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Thread message headers.
 * - Today: "20:55"
 * - Other: "3月29日 20:55"
 */
export function formatShortDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const now = new Date();
	const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	if (date.toDateString() === now.toDateString()) {
		return time;
	}
	return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/**
 * Compose quoted replies & backend quoted blocks.
 * "Tue, Apr 15, 2026, 3:42 PM"
 *
 * Stays English on purpose — quoted-reply blocks may be sent to
 * recipients in any locale, so a deterministic en-US format is
 * the safer default.
 */
export function formatQuotedDate(dateStr: string | undefined): string {
	if (!dateStr) return "";
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}
