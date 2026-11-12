import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
	findSpellcheckExemptRanges,
	normalizeSpellcheckExemptWords,
} from "~/lib/spellcheck";

interface SpellcheckExemptionOptions {
	words: string[];
}

interface SpellcheckExemptionPluginState {
	words: string[];
	decorations: DecorationSet;
}

interface SpellcheckExemptionMeta {
	words: string[];
}

export const spellcheckExemptionsPluginKey =
	new PluginKey<SpellcheckExemptionPluginState>("wemailSpellcheckExemptions");

function sameWords(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		left.every((word, index) => word === right[index])
	);
}

function buildDecorations(
	doc: ProseMirrorNode,
	words: readonly string[],
): DecorationSet {
	if (words.length === 0) return DecorationSet.empty;
	const decorations: Decoration[] = [];
	doc.descendants((node, position) => {
		if (!node.isText || !node.text) return;
		for (const range of findSpellcheckExemptRanges(node.text, words)) {
			decorations.push(
				Decoration.inline(position + range.from, position + range.to, {
					"data-wemail-spellcheck-exempt": "true",
					spellcheck: "false",
				}),
			);
		}
	});
	return DecorationSet.create(doc, decorations);
}

function buildDecorationsInRange(
	doc: ProseMirrorNode,
	words: readonly string[],
	from: number,
	to: number,
): Decoration[] {
	if (words.length === 0 || from >= to) return [];
	const decorations: Decoration[] = [];
	doc.nodesBetween(from, to, (node, position) => {
		if (!node.isText || !node.text) return;
		for (const range of findSpellcheckExemptRanges(node.text, words)) {
			decorations.push(
				Decoration.inline(position + range.from, position + range.to, {
					"data-wemail-spellcheck-exempt": "true",
					spellcheck: "false",
				}),
			);
		}
	});
	return decorations;
}

interface DocumentRange {
	from: number;
	to: number;
}

function textblockRangeAt(doc: ProseMirrorNode, position: number): DocumentRange {
	const safePosition = Math.max(0, Math.min(position, doc.content.size));
	const resolved = doc.resolve(safePosition);
	for (let depth = resolved.depth; depth > 0; depth -= 1) {
		if (resolved.node(depth).isTextblock) {
			return { from: resolved.start(depth), to: resolved.end(depth) };
		}
	}
	return { from: 0, to: doc.content.size };
}

function mergeRanges(ranges: DocumentRange[]): DocumentRange[] {
	const sorted = ranges
		.filter((range) => range.from < range.to)
		.sort((left, right) => left.from - right.from);
	const merged: DocumentRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (!previous || range.from > previous.to) {
			merged.push({ ...range });
		} else {
			previous.to = Math.max(previous.to, range.to);
		}
	}
	return merged;
}

export const SpellcheckExemptions = Extension.create<SpellcheckExemptionOptions>({
	name: "spellcheckExemptions",

	addOptions() {
		return { words: [] };
	},

	addProseMirrorPlugins() {
		const initialWords = normalizeSpellcheckExemptWords(this.options.words);
		return [
			new Plugin<SpellcheckExemptionPluginState>({
				key: spellcheckExemptionsPluginKey,
				state: {
					init: (_, state) => ({
						words: initialWords,
						decorations: buildDecorations(state.doc, initialWords),
					}),
					apply: (transaction, current) => {
						const meta = transaction.getMeta(
							spellcheckExemptionsPluginKey,
						) as SpellcheckExemptionMeta | undefined;
						const words = meta
							? normalizeSpellcheckExemptWords(meta.words)
							: current.words;
						if (
							!transaction.docChanged &&
							(!meta || sameWords(words, current.words))
						) {
							return current;
						}
						if (meta && !sameWords(words, current.words)) {
							return {
								words,
								decorations: buildDecorations(transaction.doc, words),
							};
						}

						let decorations = current.decorations.map(
							transaction.mapping,
							transaction.doc,
						);
						const changedBlocks: DocumentRange[] = [];
						transaction.mapping.maps.forEach((stepMap, index) => {
							stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
								const remaining = transaction.mapping.slice(index + 1);
								const finalStart = remaining.map(newStart, -1);
								const finalEnd = remaining.map(Math.max(newStart, newEnd - 1), 1);
								changedBlocks.push(textblockRangeAt(transaction.doc, finalStart));
								changedBlocks.push(textblockRangeAt(transaction.doc, finalEnd));
							});
						});

						for (const range of mergeRanges(changedBlocks)) {
							decorations = decorations.remove(decorations.find(range.from, range.to));
							decorations = decorations.add(
								transaction.doc,
								buildDecorationsInRange(transaction.doc, words, range.from, range.to),
							);
						}

						return { words, decorations };
					},
				},
				props: {
					decorations: (state) =>
						spellcheckExemptionsPluginKey.getState(state)?.decorations ?? null,
				},
			}),
		];
	},
});

export function updateSpellcheckExemptWords(
	editor: Editor,
	words: readonly string[],
) {
	const normalized = normalizeSpellcheckExemptWords(words);
	const current = spellcheckExemptionsPluginKey.getState(editor.state)?.words ?? [];
	if (sameWords(normalized, current)) return;
	editor.view.dispatch(
		editor.state.tr.setMeta(spellcheckExemptionsPluginKey, {
			words: normalized,
		} satisfies SpellcheckExemptionMeta),
	);
}
