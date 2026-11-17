// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";
import { listCommands, type Command } from "~/lib/commandPalette";

/**
 * Listens to `keydown` on `window`, parses the combo, and dispatches
 * the matching registered command. Single-key shortcuts like `r` /
 * `j` / `k` would be hostile inside text inputs, so we skip the
 * handler entirely when the event target is editable.
 *
 * Mod resolution: `mod` resolves to `metaKey` on macOS and `ctrlKey`
 * elsewhere. Both modifiers are accepted as fallbacks so a user with
 * an external Mac keyboard on Windows still gets reasonable behaviour.
 */

interface ParsedCombo {
	key: string; // lower-case, e.g. "r", "enter", "backspace", ","
	ctrl: boolean;
	meta: boolean;
	mod: boolean; // platform-aware Cmd/Ctrl
	shift: boolean;
	alt: boolean;
}

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPhone|iPad/i.test(navigator.platform);
}

function parseCombo(combo: string): ParsedCombo | null {
	const tokens = combo
		.toLowerCase()
		.split("+")
		.map((t) => t.trim())
		.filter(Boolean);
	if (tokens.length === 0) return null;
	let ctrl = false;
	let meta = false;
	let mod = false;
	let shift = false;
	let alt = false;
	let key: string | null = null;
	for (const token of tokens) {
		switch (token) {
			case "ctrl":
			case "control":
				ctrl = true;
				break;
			case "cmd":
			case "meta":
				meta = true;
				break;
			case "mod":
				mod = true;
				break;
			case "shift":
				shift = true;
				break;
			case "alt":
			case "option":
				alt = true;
				break;
			default:
				key = token;
		}
	}
	if (!key) return null;
	return { key, ctrl, meta, mod, shift, alt };
}

/**
 * Normalises `KeyboardEvent.key` into the same shape as our combo
 * tokens. Single printable characters become lowercase ("R" -> "r"),
 * named keys keep their KeyboardEvent name lowercased ("ArrowDown" ->
 * "arrowdown"), and a small set of synonyms covers `space` / `esc`.
 */
function normalizeEventKey(event: KeyboardEvent): string {
	const k = event.key;
	if (k === " ") return "space";
	if (k === "Escape") return "escape";
	return k.toLowerCase();
}

function matches(combo: ParsedCombo, event: KeyboardEvent): boolean {
	const eventKey = normalizeEventKey(event);
	if (combo.key !== eventKey) {
		// Allow "esc" alias.
		if (!(combo.key === "esc" && eventKey === "escape")) return false;
	}
	const isMac = isMacPlatform();
	const wantsMod = combo.mod;
	const modSatisfied = wantsMod
		? isMac
			? event.metaKey
			: event.ctrlKey
		: true;
	if (!modSatisfied) return false;
	// Explicit ctrl/meta tokens still need to be satisfied alongside `mod`.
	if (combo.ctrl && !event.ctrlKey) return false;
	if (combo.meta && !event.metaKey) return false;
	if (combo.shift !== event.shiftKey) return false;
	if (combo.alt !== event.altKey) return false;
	// When neither mod nor explicit ctrl/meta were requested, reject
	// events that have a modifier — otherwise `r` would fire on Cmd+R
	// (refresh) and similar reserved combos.
	if (!combo.mod && !combo.ctrl && !combo.meta) {
		if (event.metaKey || event.ctrlKey) return false;
	}
	return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (target.isContentEditable) return true;
	// TipTap / ProseMirror set role="textbox" on the editor surface.
	if (target.getAttribute("role") === "textbox") return true;
	return false;
}

export function useGlobalShortcuts(): void {
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (isEditableTarget(event.target)) {
				// Always allow the palette opener even from inside an input
				// — that's the one shortcut users will reach for from a
				// search field. Every other binding stays inert.
				const palette = listCommands().find((c) => c.id === "app.openCommandPalette");
				if (palette?.shortcut) {
					const combo = parseCombo(palette.shortcut);
					if (combo && matches(combo, event)) {
						if (!palette.when || palette.when()) {
							event.preventDefault();
							palette.handler();
						}
					}
				}
				return;
			}
			const cmds = listCommands();
			for (const cmd of cmds) {
				if (!cmd.shortcut) continue;
				const combo = parseCombo(cmd.shortcut);
				if (!combo) continue;
				if (!matches(combo, event)) continue;
				if (cmd.when && !cmd.when()) continue;
				event.preventDefault();
				event.stopPropagation();
				dispatch(cmd);
				return;
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}

function dispatch(cmd: Command): void {
	try {
		cmd.handler();
	} catch (err) {
		// Swallow handler errors: a bad command shouldn't break the
		// keyboard layer. The handler is responsible for surfacing user
		// feedback (toast etc.).
		// eslint-disable-next-line no-console
		console.error(`[shortcuts] command "${cmd.id}" handler threw`, err);
	}
}
