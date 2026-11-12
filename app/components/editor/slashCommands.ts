// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Slash command catalogue + filter for the compose editor.
 *
 * The command runtime ({@link slashSuggestion.ts}) detects a `/` trigger,
 * tracks the typed filter, and asks this module for the matching commands.
 * Commands fall in three groups:
 *
 *   - `template`  — static text snippets (Chinese phrasing presets)
 *   - `ai`        — paragraph rewrites that stream through the inline-AI
 *                   wire (same `streamAgentChat` call as Ctrl+K)
 *   - `insert`    — utility insertions (rule, current date / time)
 *
 * Filtering is intentionally simple: case-insensitive substring match
 * against the title plus a small `keywords` array. Pinyin / fuzzy is out
 * of scope for now.
 */

import type { Editor } from "@tiptap/react";
import type { ComponentType, ReactNode } from "react";

export type SlashCommandGroup = "template" | "ai" | "insert";

/**
 * Range to be replaced when the command runs. Always the slash itself
 * plus any filter text the user typed after it.
 */
export interface SlashRange {
	from: number;
	to: number;
}

/**
 * Runtime context handed to a command's `run` callback. The command is
 * responsible for clearing the `/filter` text — usually by calling
 * `editor.chain().focus().deleteRange(range).run()` (or replacing it
 * with the snippet) before doing anything else.
 */
export interface SlashContext {
	editor: Editor;
	range: SlashRange;
	/**
	 * Triggers an AI rewrite of the paragraph the slash trigger lives in
	 * (or of the current selection if non-empty). The host wires this to
	 * the same `useInlineAi` hook the BubbleMenu uses, so the user sees
	 * the existing Accept / Try-again / Discard pill once streaming
	 * settles.
	 */
	runAi: (instruction: string) => void;
}

export interface SlashCommand {
	id: string;
	group: SlashCommandGroup;
	/** Primary label (Chinese). */
	title: string;
	/** Optional one-liner subtext shown beneath the title. */
	hint?: string;
	keywords: string[];
	/** Optional Phosphor icon component, sized 14 by the menu. */
	icon?: ComponentType<{ size?: number; weight?: "regular" | "bold" | "fill" }>;
	run: (ctx: SlashContext) => void | Promise<void>;
}

export interface SlashGroup {
	group: SlashCommandGroup;
	heading: string;
	items: SlashCommand[];
}

import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { HandshakeIcon } from "@phosphor-icons/react/Handshake";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { NotePencilIcon } from "@phosphor-icons/react/NotePencil";
import { CalendarBlankIcon } from "@phosphor-icons/react/CalendarBlank";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { TextAaIcon } from "@phosphor-icons/react/TextAa";
import { ScissorsIcon } from "@phosphor-icons/react/Scissors";
import { BriefcaseIcon } from "@phosphor-icons/react/Briefcase";
import { TranslateIcon } from "@phosphor-icons/react/Translate";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import { CalendarDotIcon } from "@phosphor-icons/react/CalendarDot";
import { ClockIcon } from "@phosphor-icons/react/Clock";

/**
 * Replace the slash + filter range with a plain-text snippet, leaving
 * the cursor at the end of the inserted content. We hand-build the
 * insertion as paragraph splits where the snippet contains `\n\n` so
 * the editor ends up with real paragraph breaks instead of a raw
 * newline character (which TipTap renders as a space).
 */
function insertSnippet(ctx: SlashContext, snippet: string): void {
	const { editor, range } = ctx;
	const chain = editor.chain().focus().deleteRange(range);
	const blocks = snippet.split(/\n{2,}/);
	const content = blocks
		.map((block) => {
			const lines = block.split("\n");
			return {
				type: "paragraph",
				content: lines.flatMap((line, idx) => {
					const segs: Array<{ type: string; text?: string }> = [];
					if (line.length > 0) segs.push({ type: "text", text: line });
					if (idx < lines.length - 1) segs.push({ type: "hardBreak" });
					return segs;
				}),
			};
		})
		.filter((block) => block.content.length > 0 || blocks.length > 1);
	// Empty paragraphs become {type: 'paragraph'} with no content.
	const normalized = content.map((p) =>
		p.content.length === 0 ? { type: "paragraph" } : p,
	);
	chain.insertContent(normalized).run();
}

function formatToday(): string {
	const d = new Date();
	const yyyy = d.getFullYear().toString().padStart(4, "0");
	const mm = (d.getMonth() + 1).toString().padStart(2, "0");
	const dd = d.getDate().toString().padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatNow(): string {
	const d = new Date();
	const hh = d.getHours().toString().padStart(2, "0");
	const mm = d.getMinutes().toString().padStart(2, "0");
	return `${hh}:${mm}`;
}

function insertText(ctx: SlashContext, text: string): void {
	const { editor, range } = ctx;
	editor.chain().focus().deleteRange(range).insertContent(text).run();
}

function runAiCommand(ctx: SlashContext, instruction: string): void {
	// Consume the slash trigger so the user doesn't see the literal
	// `/润色` linger while the rewrite spins up.
	ctx.editor.chain().focus().deleteRange(ctx.range).run();
	ctx.runAi(instruction);
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	// Templates
	{
		id: "tpl-greeting",
		group: "template",
		title: "问候",
		hint: "插入礼貌问候语",
		keywords: ["greeting", "hello", "hi", "wenhou", "问候"],
		icon: ChatCircleIcon,
		run: (ctx) =>
			insertSnippet(ctx, "您好，希望您一切顺利。\n\n"),
	},
	{
		id: "tpl-thanks",
		group: "template",
		title: "感谢",
		hint: "感谢对方回复",
		keywords: ["thanks", "thank", "ganxie", "感谢"],
		icon: HandshakeIcon,
		run: (ctx) => insertSnippet(ctx, "感谢您的回复。\n\n"),
	},
	{
		id: "tpl-decline",
		group: "template",
		title: "婉拒",
		hint: "礼貌地婉拒对方请求",
		keywords: ["decline", "reject", "wanju", "婉拒"],
		icon: XCircleIcon,
		run: (ctx) =>
			insertSnippet(
				ctx,
				"感谢您的来信。经过认真考虑，我们目前暂时无法推进此事。如有变化我会再与您联系。\n\n",
			),
	},
	{
		id: "tpl-meeting-followup",
		group: "template",
		title: "会议跟进",
		hint: "会议要点 + 后续行动模板",
		keywords: ["meeting", "followup", "huiyi", "会议"],
		icon: NotePencilIcon,
		run: (ctx) =>
			insertSnippet(
				ctx,
				"今天的会议讨论了以下要点：\n\n1. \n2. \n3. \n\n后续行动：",
			),
	},
	{
		id: "tpl-meeting-invite",
		group: "template",
		title: "会议邀请",
		hint: "约时间讨论",
		keywords: ["invite", "schedule", "yaoqing", "会议"],
		icon: CalendarBlankIcon,
		run: (ctx) =>
			insertSnippet(
				ctx,
				"想约您一个时间讨论。下周二/周三 14:00 是否方便？请告知。",
			),
	},

	// AI
	{
		id: "ai-polish",
		group: "ai",
		title: "润色",
		hint: "保留原意，让措辞更自然",
		keywords: ["polish", "rewrite", "runse", "润色"],
		icon: SparkleIcon,
		run: (ctx) =>
			runAiCommand(ctx, "在保持原意的前提下润色措辞，使其更自然得体"),
	},
	{
		id: "ai-concise",
		group: "ai",
		title: "简洁",
		hint: "缩写为更精炼的版本",
		keywords: ["concise", "shorter", "jianjie", "简洁"],
		icon: ScissorsIcon,
		run: (ctx) =>
			runAiCommand(ctx, "缩写为更简洁的版本，保留关键信息"),
	},
	{
		id: "ai-formal",
		group: "ai",
		title: "正式",
		hint: "改写为商务正式语气",
		keywords: ["formal", "business", "zhengshi", "正式"],
		icon: BriefcaseIcon,
		run: (ctx) => runAiCommand(ctx, "改写为更正式的商务表达"),
	},
	{
		id: "ai-translate-en",
		group: "ai",
		title: "翻译英文",
		hint: "翻译为英文",
		keywords: ["translate", "english", "fanyi", "翻译"],
		icon: TranslateIcon,
		run: (ctx) => runAiCommand(ctx, "翻译为英文，保持邮件语气"),
	},
	{
		id: "ai-translate-zh",
		group: "ai",
		title: "翻译中文",
		hint: "翻译为中文",
		keywords: ["translate", "chinese", "fanyi", "翻译"],
		icon: TextAaIcon,
		run: (ctx) => runAiCommand(ctx, "翻译为中文，保持邮件语气"),
	},

	// Insert
	{
		id: "insert-hr",
		group: "insert",
		title: "横线",
		hint: "插入分隔横线",
		keywords: ["divider", "hr", "horizontal", "hengxian", "横线"],
		icon: MinusIcon,
		run: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setHorizontalRule().run();
		},
	},
	{
		id: "insert-date",
		group: "insert",
		title: "日期",
		hint: "插入今天的日期 (YYYY-MM-DD)",
		keywords: ["date", "today", "riqi", "日期"],
		icon: CalendarDotIcon,
		run: (ctx) => insertText(ctx, formatToday()),
	},
	{
		id: "insert-time",
		group: "insert",
		title: "时间",
		hint: "插入当前时间 (HH:mm)",
		keywords: ["time", "now", "shijian", "时间"],
		icon: ClockIcon,
		run: (ctx) => insertText(ctx, formatNow()),
	},
];

const GROUP_HEADINGS: Record<SlashCommandGroup, string> = {
	template: "模板",
	ai: "AI",
	insert: "插入",
};

const GROUP_ORDER: readonly SlashCommandGroup[] = ["template", "ai", "insert"];

/**
 * Case-insensitive substring filter against title + keywords. Returns
 * the catalogue regrouped, with empty groups dropped.
 */
export function filterSlashCommands(query: string): SlashGroup[] {
	const q = query.trim().toLowerCase();
	const matches = SLASH_COMMANDS.filter((cmd) => {
		if (!q) return true;
		if (cmd.title.toLowerCase().includes(q)) return true;
		return cmd.keywords.some((kw) => kw.toLowerCase().includes(q));
	});
	const grouped: SlashGroup[] = [];
	for (const group of GROUP_ORDER) {
		const items = matches.filter((c) => c.group === group);
		if (items.length === 0) continue;
		grouped.push({
			group,
			heading: GROUP_HEADINGS[group],
			items,
		});
	}
	return grouped;
}

/** Flatten grouped results back to a sequential list (selection index). */
export function flattenGroups(groups: SlashGroup[]): SlashCommand[] {
	const out: SlashCommand[] = [];
	for (const g of groups) for (const item of g.items) out.push(item);
	return out;
}

/** Locate a flat index inside the grouped structure. Used by the menu
 *  to draw the highlight on the right item after Arrow-key nav. */
export function indexInGroups(
	groups: SlashGroup[],
	flatIndex: number,
): { group: number; item: number } | null {
	let acc = 0;
	for (let g = 0; g < groups.length; g++) {
		const groupLen = groups[g].items.length;
		if (flatIndex < acc + groupLen) {
			return { group: g, item: flatIndex - acc };
		}
		acc += groupLen;
	}
	return null;
}

// Re-export for tests / consumers that want to render an icon outside
// the menu (kept here so consumers don't import phosphor twice).
export type SlashIcon = ReactNode;
