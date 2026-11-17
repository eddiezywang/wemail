// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Selection-triggered floating toolbar for the rich text editor.
 *
 * Mounts inside `RichTextEditor` and uses TipTap's `BubbleMenu` from
 * `@tiptap/react/menus` (already in deps via override pinning) to
 * position itself above any non-empty selection.
 *
 * Layout (approved design section 05): AI intent actions lead with
 * labeled buttons — 解释 opens the free-form inline prompt, while
 * 改进/缩短/语气/语法 fire preset rewrites via `onRunIntent`
 * (`useInlineAi.runOnRange`, the same engine the slash commands use).
 * Formatting (bold / italic / underline / strike / code / link /
 * highlight) follows after a divider as compact icon buttons.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CodeIcon } from "@phosphor-icons/react/Code";
import { HighlighterIcon } from "@phosphor-icons/react/Highlighter";
import { LinkSimpleIcon } from "@phosphor-icons/react/LinkSimple";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { TextBIcon } from "@phosphor-icons/react/TextB";
import { TextItalicIcon } from "@phosphor-icons/react/TextItalic";
import { TextStrikethroughIcon } from "@phosphor-icons/react/TextStrikethrough";
import { TextUnderlineIcon } from "@phosphor-icons/react/TextUnderline";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { LinkEditorDialog } from "./LinkEditorDialog";

interface BubbleToolbarProps {
	editor: Editor;
	onTriggerAi: () => void;
	/** Fires a preset inline rewrite over the current selection. */
	onRunIntent?: (instruction: string) => void;
}

const INTENT_INSTRUCTIONS: Array<{ label: string; instruction: string }> = [
	{
		label: "改进",
		instruction: "改写这段文字，使其更清晰、自然、可直接使用，不改变事实。",
	},
	{
		label: "缩短",
		instruction: "缩短这段文字，保留核心信息。",
	},
	{
		label: "语气",
		instruction: "调整这段文字的语气，使其自然、专业、得体。",
	},
	{
		label: "语法",
		instruction: "只修正这段文字的语法、拼写和不自然表达，不改变含义。",
	},
];

function AiIntentButton({
	onClick,
	label,
	testId,
}: {
	onClick: () => void;
	label: string;
	testId?: string;
}) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				onClick();
			}}
			onMouseDown={(e) => e.preventDefault()}
			className="inline-flex h-7 items-center rounded-md px-2 text-xs text-ink-2 transition-colors hover:bg-coral-bg hover:text-coral-2"
			aria-label={`AI ${label}选中文字`}
			data-testid={testId}
		>
			{label}
		</button>
	);
}

const HIGHLIGHT_SWATCHES: { color: string; label: string }[] = [
	{ color: "#fde68a", label: "黄色" },
	{ color: "#bbf7d0", label: "绿色" },
	{ color: "#bfdbfe", label: "蓝色" },
	{ color: "#fbcfe8", label: "粉色" },
	{ color: "#e9d5ff", label: "紫色" },
];

function ToolbarIconButton({
	active,
	onClick,
	title,
	children,
	"data-testid": dataTestId,
}: {
	active?: boolean;
	onClick: () => void;
	title: string;
	children: React.ReactNode;
	"data-testid"?: string;
}) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				onClick();
			}}
			onMouseDown={(e) => e.preventDefault()}
			className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-xs transition-colors ${
				active
					? "bg-coral/15 text-coral"
					: "text-ink-2 hover:bg-paper-3 hover:text-ink"
			}`}
			title={title}
			aria-label={title}
			aria-pressed={active}
			data-testid={dataTestId}
		>
			{children}
		</button>
	);
}

export function BubbleToolbar({ editor, onTriggerAi, onRunIntent }: BubbleToolbarProps) {
	const [highlightOpen, setHighlightOpen] = useState(false);
	const [linkOpen, setLinkOpen] = useState(false);
	const highlightWrapRef = useRef<HTMLDivElement | null>(null);

	const setLink = useCallback(() => {
		if (editor.isActive("link")) {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		setLinkOpen(true);
	}, [editor]);

	useEffect(() => {
		if (!highlightOpen) return;
		const focusFrame = requestAnimationFrame(() => {
			const first = highlightWrapRef.current?.querySelector<HTMLButtonElement>(
				'[role="menuitem"]',
			);
			first?.focus();
		});
		const onDocClick = (e: MouseEvent) => {
			if (!highlightWrapRef.current?.contains(e.target as Node)) {
				setHighlightOpen(false);
			}
		};
		document.addEventListener("mousedown", onDocClick);
		return () => {
			cancelAnimationFrame(focusFrame);
			document.removeEventListener("mousedown", onDocClick);
		};
	}, [highlightOpen]);

	return (
		<>
		<BubbleMenu
			editor={editor}
			data-testid="bubble-toolbar"
			className="z-50 flex items-center gap-1 rounded-lg border border-edge bg-paper-2 px-1.5 py-1 shadow-[var(--shadow-2)] motion-safe:animate-[overlay-enter_120ms_ease-out]"
		>
			<span
				className="inline-flex items-center gap-0.5 pl-1 pr-0.5 text-xs font-semibold text-coral"
				aria-hidden="true"
			>
				<SparkleIcon size={12} weight="fill" />
				AI
			</span>
			<AiIntentButton label="解释" onClick={onTriggerAi} testId="bubble-ai-trigger" />
			{onRunIntent
				? INTENT_INSTRUCTIONS.map((intent) => (
						<AiIntentButton
							key={intent.label}
							label={intent.label}
							onClick={() => onRunIntent(intent.instruction)}
						/>
					))
				: null}
			<div className="mx-1 h-4 w-px bg-edge" aria-hidden />
			<ToolbarIconButton
				active={editor.isActive("bold")}
				onClick={() => editor.chain().focus().toggleBold().run()}
				title="加粗"
				data-testid="bubble-bold"
			>
				<TextBIcon size={14} />
			</ToolbarIconButton>
			<ToolbarIconButton
				active={editor.isActive("italic")}
				onClick={() => editor.chain().focus().toggleItalic().run()}
				title="斜体"
			>
				<TextItalicIcon size={14} />
			</ToolbarIconButton>
			<ToolbarIconButton
				active={editor.isActive("underline")}
				onClick={() => editor.chain().focus().toggleUnderline().run()}
				title="下划线"
			>
				<TextUnderlineIcon size={14} />
			</ToolbarIconButton>
			<ToolbarIconButton
				active={editor.isActive("strike")}
				onClick={() => editor.chain().focus().toggleStrike().run()}
				title="删除线"
			>
				<TextStrikethroughIcon size={14} />
			</ToolbarIconButton>
			<ToolbarIconButton
				active={editor.isActive("code")}
				onClick={() => editor.chain().focus().toggleCode().run()}
				title="行内代码"
			>
				<CodeIcon size={14} />
			</ToolbarIconButton>
			<ToolbarIconButton
				active={editor.isActive("link")}
				onClick={setLink}
				title={editor.isActive("link") ? "移除链接" : "添加链接"}
			>
				<LinkSimpleIcon size={14} />
			</ToolbarIconButton>
			<div className="relative" ref={highlightWrapRef}>
				<ToolbarIconButton
					active={editor.isActive("highlight")}
					onClick={() => setHighlightOpen((v) => !v)}
					title="高亮"
				>
					<HighlighterIcon size={14} />
				</ToolbarIconButton>
				{highlightOpen ? (
					<div
						role="menu"
						aria-label="选择高亮颜色"
						onKeyDown={(event) => {
							const items = Array.from(
								event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
							);
							const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
							if (event.key === "Escape") {
								event.preventDefault();
								setHighlightOpen(false);
								highlightWrapRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
							} else if (["ArrowRight", "ArrowDown"].includes(event.key)) {
								event.preventDefault();
								items[(current + 1) % items.length]?.focus();
							} else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
								event.preventDefault();
								items[(current - 1 + items.length) % items.length]?.focus();
							} else if (event.key === "Home") {
								event.preventDefault();
								items[0]?.focus();
							} else if (event.key === "End") {
								event.preventDefault();
								items.at(-1)?.focus();
							}
						}}
						className="absolute left-0 top-full z-50 mt-1 flex items-center gap-1 rounded-md border border-edge bg-paper-2 p-1 shadow-[var(--shadow-2)]"
					>
						{HIGHLIGHT_SWATCHES.map((s) => (
							<button
								key={s.color}
								type="button"
								role="menuitem"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									editor
										.chain()
										.focus()
										.toggleHighlight({ color: s.color })
										.run();
									setHighlightOpen(false);
								}}
								className="h-9 w-9 rounded-md border border-edge"
								style={{ backgroundColor: s.color }}
								aria-label={`高亮为${s.label}`}
								title={s.label}
							/>
						))}
						<button
								type="button"
								role="menuitem"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								editor.chain().focus().unsetHighlight().run();
								setHighlightOpen(false);
							}}
							className="ml-1 min-h-9 px-2 text-xs text-ink-3 hover:text-ink"
						>
							清除
						</button>
					</div>
				) : null}
			</div>
		</BubbleMenu>
		<LinkEditorDialog
			open={linkOpen}
			onOpenChange={setLinkOpen}
			onSubmit={(url) => {
				if (!url) return;
				editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
			}}
		/>
		</>
	);
}
