// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Slash command trigger plugin.
 *
 * `@tiptap/suggestion` is not in the dependency tree, so we hand-roll
 * the trigger detection as a thin ProseMirror plugin. The plugin keeps
 * a small piece of state describing the open slash trigger:
 *
 *   - the absolute position of the `/`
 *   - the filter text typed since
 *   - a screen-space anchor (top/left of the slash glyph)
 *
 * Whenever the document or selection changes we re-derive the trigger
 * from the line preceding the cursor:
 *
 *   - It is at the start of a paragraph, OR preceded by whitespace
 *   - The cursor sits inside the run that starts with `/`
 *   - The filter text contains no whitespace (typing a space closes
 *     the menu, matching Notion / Slack)
 *
 * The plugin is purely a sensor — the React menu reads the state via a
 * subscription installed by {@link createSlashSuggestion} and dispatches
 * commands itself by calling `editor.chain().deleteRange(...)` etc.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export interface SlashTriggerState {
	active: boolean;
	/** Position of the `/` glyph (inclusive). */
	from: number;
	/** Position immediately after the last filter char. */
	to: number;
	/** Text typed after the slash, lowercased / not normalized. */
	query: string;
	/** Pixel coords of the slash relative to viewport. */
	clientRect: { top: number; left: number; bottom: number } | null;
}

export const SLASH_PLUGIN_KEY = new PluginKey<SlashTriggerState>(
	"wemailSlashSuggestion",
);

const INACTIVE: SlashTriggerState = {
	active: false,
	from: 0,
	to: 0,
	query: "",
	clientRect: null,
};

export type SlashListener = (state: SlashTriggerState) => void;

interface CreateSlashOptions {
	onChange: SlashListener;
	/** Allows the React layer to swallow Arrow / Enter / Esc when the menu is open. */
	onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * Walks back from the cursor to find a `/` that:
 *   - lives in the same text node run
 *   - is at the start of the parent block, or preceded by whitespace
 * The substring from `/` to the cursor must contain no whitespace.
 */
function detect(
	view: EditorView,
): Pick<SlashTriggerState, "from" | "to" | "query"> | null {
	const { selection } = view.state;
	if (!selection.empty) return null;
	const $from = selection.$from;
	const parent = $from.parent;
	// Only fire inside text-bearing blocks.
	if (!parent.isTextblock) return null;
	// Limit the walk to the start of the current block — slash triggers
	// don't span paragraphs.
	const blockStart = $from.start();
	const cursor = $from.pos;
	if (cursor <= blockStart) return null;

	// Pull the text between blockStart and cursor.
	const text = view.state.doc.textBetween(blockStart, cursor, "\n", "￼");
	if (!text) return null;

	// Find the LAST `/` that satisfies the gating rules.
	let slashRel = -1;
	for (let i = text.length - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === "/") {
			slashRel = i;
			break;
		}
		// A whitespace before the slash terminates the search — there's
		// no point looking further back; nothing in between can host a
		// trigger.
		if (/\s/.test(ch)) return null;
	}
	if (slashRel === -1) return null;

	// Gate: must be at start-of-block or after whitespace.
	if (slashRel > 0) {
		const prev = text[slashRel - 1];
		if (!/\s/.test(prev)) return null;
	}

	const query = text.slice(slashRel + 1);
	// Whitespace inside the query closes the trigger.
	if (/\s/.test(query)) return null;

	const from = blockStart + slashRel;
	const to = cursor;
	return { from, to, query };
}

/**
 * Build the TipTap Extension that owns the slash suggestion plugin.
 * Callers pass in `onChange` (state updates) and `onKeyDown` (returns
 * true if the React menu handled the key — typically Arrow / Enter /
 * Esc when the menu is open).
 */
export function createSlashSuggestion(
	options: CreateSlashOptions,
): Extension {
	return Extension.create({
		name: "wemailSlashSuggestion",
		addProseMirrorPlugins() {
			return [
				new Plugin<SlashTriggerState>({
					key: SLASH_PLUGIN_KEY,
					state: {
						init(): SlashTriggerState {
							return INACTIVE;
						},
						apply(tr, prev): SlashTriggerState {
							// Position-only changes (selection moves) keep the
							// previous range valid via mapping; we recompute on
							// view update below to keep the screen anchor live.
							const meta = tr.getMeta(SLASH_PLUGIN_KEY);
							if (meta && typeof meta === "object") {
								return meta as SlashTriggerState;
							}
							if (!prev.active) return prev;
							// Map positions through document changes.
							try {
								const from = tr.mapping.map(prev.from);
								const to = tr.mapping.map(prev.to);
								if (from >= to) return INACTIVE;
								return { ...prev, from, to };
							} catch {
								return INACTIVE;
							}
						},
					},
					view(view) {
						const update = (v: EditorView) => {
							const detected = detect(v);
							let next: SlashTriggerState;
							if (!detected) {
								next = INACTIVE;
							} else {
								let rect: SlashTriggerState["clientRect"] = null;
								try {
									const start = v.coordsAtPos(detected.from);
									rect = {
										top: start.top,
										left: start.left,
										bottom: start.bottom,
									};
								} catch {
									rect = null;
								}
								next = {
									active: true,
									from: detected.from,
									to: detected.to,
									query: detected.query,
									clientRect: rect,
								};
							}
							const prev = SLASH_PLUGIN_KEY.getState(v.state) ?? INACTIVE;
							const changed =
								prev.active !== next.active ||
								prev.from !== next.from ||
								prev.to !== next.to ||
								prev.query !== next.query ||
								prev.clientRect?.top !== next.clientRect?.top ||
								prev.clientRect?.left !== next.clientRect?.left;
							if (changed) {
								v.dispatch(v.state.tr.setMeta(SLASH_PLUGIN_KEY, next));
								options.onChange(next);
							}
						};
						update(view);
						return {
							update(v: EditorView) {
								update(v);
							},
							destroy() {
								options.onChange(INACTIVE);
							},
						};
					},
					props: {
						handleKeyDown(view, event) {
							const state =
								SLASH_PLUGIN_KEY.getState(view.state) ?? INACTIVE;
							if (!state.active) return false;
							return options.onKeyDown(event);
						},
					},
				}),
			];
		},
	});
}

export const INACTIVE_SLASH_STATE = INACTIVE;
