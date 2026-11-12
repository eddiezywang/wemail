// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/ArrowCounterClockwise";
import { LinkBreakIcon } from "@phosphor-icons/react/LinkBreak";
import { LinkSimpleIcon } from "@phosphor-icons/react/LinkSimple";
import { ListBulletsIcon } from "@phosphor-icons/react/ListBullets";
import { ListNumbersIcon } from "@phosphor-icons/react/ListNumbers";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import { QuotesIcon } from "@phosphor-icons/react/Quotes";
import { TextBIcon } from "@phosphor-icons/react/TextB";
import { TextItalicIcon } from "@phosphor-icons/react/TextItalic";
import { TextStrikethroughIcon } from "@phosphor-icons/react/TextStrikethrough";
import { TextUnderlineIcon } from "@phosphor-icons/react/TextUnderline";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { BubbleToolbar } from "./editor/BubbleToolbar";
import { InlineAiPrompt } from "./editor/InlineAiPrompt";
import { LinkEditorDialog } from "./editor/LinkEditorDialog";
import { useInlineAi } from "./editor/useInlineAi";
import { SlashCommandMenu, type SlashMenuApi } from "./editor/SlashCommandMenu";
import {
	ProtectedBlockquote,
	ProtectedParagraph,
	SignatureBrand,
	SignatureBlock,
} from "./editor/protectedComposeExtensions";
import { ForwardedMessage } from "./editor/ForwardedMessage";
import {
	SpellcheckExemptions,
	updateSpellcheckExemptWords,
} from "./editor/SpellcheckExemptions";
import {
	createSlashSuggestion,
	INACTIVE_SLASH_STATE,
	type SlashTriggerState,
} from "./editor/slashSuggestion";
import type { SlashCommand } from "./editor/slashCommands";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
	toolbarVisible?: boolean;
	composeSurface?: boolean;
	emptyGuidance?: ReactNode;
	spellcheckExemptWords?: readonly string[];
}

interface ToolbarButtonProps {
	tooltip: string;
	icon: ReactNode;
	onClick: () => void;
	active?: boolean;
	disabled?: boolean;
	"aria-label": string;
}

function ToolbarButton({
	tooltip,
	icon,
	onClick,
	active,
	disabled,
	"aria-label": ariaLabel,
}: ToolbarButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant={active ? "secondary" : "ghost"}
					size="sm"
					className="h-8 w-8 p-0"
					onClick={onClick}
					disabled={disabled}
					aria-label={ariaLabel}
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export default function RichTextEditor({
	value,
	onChange,
	toolbarVisible = true,
	composeSurface = false,
	emptyGuidance,
	spellcheckExemptWords = [],
}: RichTextEditorProps) {
	// Inline-AI shortcut. Wired as a TipTap extension so we don't need
	// a global keyboard listener — the shortcut is only active when the
	// editor itself is focused, which avoids stomping on other Cmd-K
	// surfaces the renderer might add later.
	const triggerInlineAiRef = useRef<() => void>(() => {});
	const InlineAiShortcut = useMemo(
		() =>
			Extension.create({
				name: "inlineAiShortcut",
				addKeyboardShortcuts() {
					return {
						"Mod-k": () => {
							triggerInlineAiRef.current();
							return true;
						},
					};
				},
			}),
		[],
	);

	// Slash command state — owned by the React layer; the suggestion
	// plugin pushes updates and reads back the keyboard nav handler via
	// refs (avoids re-creating the plugin on each state change).
	const [slashState, setSlashState] = useState<SlashTriggerState>(
		INACTIVE_SLASH_STATE,
	);
	const [linkDialogOpen, setLinkDialogOpen] = useState(false);
	const [linkDialogValue, setLinkDialogValue] = useState("");
	const slashApiRef = useRef<SlashMenuApi | null>(null);
	const SlashSuggestion = useMemo(
		() =>
			createSlashSuggestion({
				onChange: (next) => setSlashState(next),
				onKeyDown: (event) => {
					const api = slashApiRef.current;
					if (!api || api.count() === 0) {
						// Even with zero results, swallow Esc so the menu closes
						// without ProseMirror processing it.
						if (event.key === "Escape") {
							setSlashState(INACTIVE_SLASH_STATE);
							return true;
						}
						return false;
					}
					if (event.key === "ArrowDown") {
						event.preventDefault();
						api.move(1);
						return true;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						api.move(-1);
						return true;
					}
					if (event.key === "Enter") {
						event.preventDefault();
						return api.commitSelected();
					}
					if (event.key === "Escape") {
						event.preventDefault();
						setSlashState(INACTIVE_SLASH_STATE);
						return true;
					}
					return false;
				},
			}),
		[],
	);
	const isSyncingValueRef = useRef(false);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({ blockquote: false, paragraph: false }),
			ProtectedBlockquote,
			SignatureBrand,
			ProtectedParagraph,
			SignatureBlock,
			ForwardedMessage,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
			TiptapImage,
			TextStyle,
			Color,
			Highlight.configure({ multicolor: true }),
			InlineAiShortcut,
			SlashSuggestion,
			SpellcheckExemptions.configure({ words: [...spellcheckExemptWords] }),
		],
		content: value,
		editorProps: {
			attributes: {
				class:
					`prose prose-sm max-w-none focus:outline-none min-h-[180px] p-3 ${composeSurface ? "compose-editor" : "text-ui"} [&_blockquote]:border-l [&_blockquote]:border-edge [&_blockquote]:pl-3 [&_blockquote]:text-ink-3 [&_blockquote]:bg-paper-2 [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-meta [&_blockquote]:rounded-r-sm`,
			},
		},
		onUpdate: ({ editor }) => {
			if (isSyncingValueRef.current) return;
			onChange(editor.getHTML());
		},
	});
	const spellcheckExemptWordsKey = spellcheckExemptWords.join("\u0000");

	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		updateSpellcheckExemptWords(editor, spellcheckExemptWords);
	}, [editor, spellcheckExemptWordsKey]);

	const inlineAi = useInlineAi(editor);
	// Bind the shortcut handler late so the extension always sees the
	// current open() callback even though it is created once.
	triggerInlineAiRef.current = inlineAi.open;

	// Selection-intent entry (改进/缩短/语气/语法 in the bubble toolbar):
	// fires a preset rewrite over the current selection without showing
	// the free-form instruction pill — same engine as the slash commands.
	const runSelectionIntent = useCallback(
		(instruction: string) => {
			if (!editor || editor.isDestroyed) return;
			const { from, to } = editor.state.selection;
			if (from === to) return;
			const text = editor.state.doc.textBetween(from, to, "\n");
			if (!text.trim()) return;
			inlineAi.runOnRange(text, from, to, instruction);
		},
		[editor, inlineAi.runOnRange],
	);

	const editorRootRef = useRef<HTMLDivElement | null>(null);

	// Translate the suggestion plugin's viewport-space rect into the
	// editor-root local coords used by SlashCommandMenu.
	const slashAnchor = useMemo(() => {
		if (!slashState.active || !slashState.clientRect) return null;
		const root = editorRootRef.current;
		if (!root) return null;
		const rootRect = root.getBoundingClientRect();
		return {
			top: slashState.clientRect.bottom - rootRect.top + 4,
			left: slashState.clientRect.left - rootRect.left,
		};
	}, [slashState]);

	const closeSlashMenu = useCallback(() => {
		setSlashState(INACTIVE_SLASH_STATE);
		// Move the editor selection forward one position so the trigger
		// detector immediately sees an empty query / no slash; otherwise
		// the next keystroke would re-open the same menu.
		if (editor && slashState.active) {
			editor
				.chain()
				.focus()
				.setTextSelection({ from: slashState.to, to: slashState.to })
				.run();
		}
	}, [editor, slashState.active, slashState.to]);

	const onSlashSelect = useCallback(
		(cmd: SlashCommand) => {
			if (!editor) return;
			const range = { from: slashState.from, to: slashState.to };
			cmd.run({
				editor,
				range,
				runAi: (instruction) => {
					// Pull the surrounding paragraph as the rewrite target.
					// The slash trigger has already been deleted by the
					// command itself; we re-resolve the cursor's parent.
					const { selection, doc } = editor.state;
					const $from = selection.$from;
					const blockStart = $from.start();
					const blockEnd = $from.end();
					const text = doc.textBetween(blockStart, blockEnd, "\n");
					if (!text.trim()) {
						// Empty paragraph — bail to avoid a no-op stream.
						return;
					}
					inlineAi.runOnRange(text, blockStart, blockEnd, instruction);
				},
			});
			setSlashState(INACTIVE_SLASH_STATE);
		},
		[editor, inlineAi, slashState.from, slashState.to],
	);

	useEffect(() => {
		if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
			isSyncingValueRef.current = true;
			editor.commands.setContent(value);
			isSyncingValueRef.current = false;
			// Place cursor at the start of the document (above quoted text)
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus('start');
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor]);

	const setLink = useCallback(() => {
		if (!editor) return;
		setLinkDialogValue(editor.getAttributes("link").href ?? "");
		setLinkDialogOpen(true);
	}, [editor]);

	if (!editor) return null;

	return (
		<TooltipProvider>
			<div
				className={
					composeSurface
						? "flex h-full flex-col overflow-visible bg-paper"
						: "rounded-lg border border-edge overflow-visible flex flex-col h-full transition-[border-color,box-shadow] duration-150 focus-within:border-coral focus-within:ring-2 focus-within:ring-coral/30"
				}
			>
				{/* Toolbar */}
				{toolbarVisible ? (
				<div
					data-testid="formatting-toolbar"
					className="flex flex-wrap items-center gap-0.5 bg-paper-3 px-2 py-1.5 border-b border-edge shrink-0"
				>
					{/* Text formatting */}
					<ToolbarButton
						tooltip="加粗"
						icon={<TextBIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBold().run()}
						active={editor.isActive("bold")}
						aria-label="加粗"
					/>
					<ToolbarButton
						tooltip="斜体"
						icon={<TextItalicIcon size={16} />}
						onClick={() => editor.chain().focus().toggleItalic().run()}
						active={editor.isActive("italic")}
						aria-label="斜体"
					/>
					<ToolbarButton
						tooltip="下划线"
						icon={<TextUnderlineIcon size={16} />}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						active={editor.isActive("underline")}
						aria-label="下划线"
					/>
					<ToolbarButton
						tooltip="删除线"
						icon={<TextStrikethroughIcon size={16} />}
						onClick={() => editor.chain().focus().toggleStrike().run()}
						active={editor.isActive("strike")}
						aria-label="删除线"
					/>

					<div className="mx-1 h-5 w-px bg-paper-3" />

					{/* Lists */}
					<ToolbarButton
						tooltip="项目符号列表"
						icon={<ListBulletsIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBulletList().run()}
						active={editor.isActive("bulletList")}
						aria-label="项目符号列表"
					/>
					<ToolbarButton
						tooltip="编号列表"
						icon={<ListNumbersIcon size={16} />}
						onClick={() => editor.chain().focus().toggleOrderedList().run()}
						active={editor.isActive("orderedList")}
						aria-label="编号列表"
					/>

					<div className="mx-1 h-5 w-px bg-paper-3" />

					{/* Block formatting */}
					<ToolbarButton
						tooltip="引用"
						icon={<QuotesIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBlockquote().run()}
						active={editor.isActive("blockquote")}
						aria-label="引用"
					/>
					<ToolbarButton
						tooltip="编辑链接"
						icon={<LinkSimpleIcon size={16} />}
						onClick={setLink}
						active={editor.isActive("link")}
						aria-label="编辑链接"
					/>
					{editor.isActive("link") && (
						<ToolbarButton
							tooltip="移除链接"
							icon={<LinkBreakIcon size={16} />}
							onClick={() => editor.chain().focus().unsetLink().run()}
							aria-label="移除链接"
						/>
					)}
					<ToolbarButton
						tooltip="分隔线"
						icon={<MinusIcon size={16} />}
						onClick={() => editor.chain().focus().setHorizontalRule().run()}
						aria-label="分隔线"
					/>

					<div className="mx-1 h-5 w-px bg-paper-3" />

					{/* Undo/Redo */}
					<ToolbarButton
						tooltip="撤销"
						icon={<ArrowCounterClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().undo().run()}
						disabled={!editor.can().undo()}
						aria-label="撤销"
					/>
					<ToolbarButton
						tooltip="重做"
						icon={<ArrowClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().redo().run()}
						disabled={!editor.can().redo()}
						aria-label="重做"
					/>
				</div>
				) : null}

				{/* Selection-triggered floating bar */}
				<BubbleToolbar editor={editor} onTriggerAi={inlineAi.open} onRunIntent={runSelectionIntent} />

				{/* Editor content */}
				<div
					data-editor-root
					ref={editorRootRef}
					className="relative flex-1 overflow-y-auto"
				>
					<EditorContent editor={editor} />
					{emptyGuidance ? (
						<div
							data-testid="empty-guidance-overlay"
							className="pointer-events-none absolute left-3 top-3 z-10"
						>
							{emptyGuidance}
						</div>
					) : null}
				<InlineAiPrompt
						state={inlineAi.state}
						onChangeInstruction={inlineAi.setInstruction}
						onSubmit={inlineAi.submit}
						onCancel={inlineAi.close}
						onAccept={inlineAi.accept}
						onDiscard={inlineAi.discard}
						onTryAgain={inlineAi.tryAgain}
				/>
				<LinkEditorDialog
					open={linkDialogOpen}
					initialValue={linkDialogValue}
					onOpenChange={setLinkDialogOpen}
					onSubmit={(url) => {
						if (!url) {
							editor.chain().focus().extendMarkRange("link").unsetLink().run();
							return;
						}
						editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
					}}
				/>
					<SlashCommandMenu
						open={slashState.active}
						query={slashState.query}
						anchor={slashAnchor}
						onSelect={onSlashSelect}
						onClose={closeSlashMenu}
						apiRef={slashApiRef}
					/>
				</div>
			</div>
		</TooltipProvider>
	);
}
