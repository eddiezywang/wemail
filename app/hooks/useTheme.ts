// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useSyncExternalStore } from "react";

/**
 * Theme system for the WeMail renderer.
 *
 * - Themes: `paper` (warm stone, the default light surface), `codex`
 *   (monochrome light, opt-in), `dark`, `claude` (legacy).
 * - Persisted under `localStorage[wemail.theme]`.
 * - Applied via `document.documentElement.dataset.theme` so the matching
 *   `:root[data-theme="…"]` block in `app/styles/themes/*.css` activates.
 * - The active value is held in a tiny external store so multiple
 *   `useTheme()` consumers (settings, root, future preview UI) stay in
 *   lock-step without prop drilling.
 *
 * The host theme MUST NOT propagate into the email iframe — `EmailIframe`
 * uses `srcdoc` with no `allow-same-origin`, so the iframe document
 * receives no `data-theme` attribute and resolves no host CSS variables.
 * `EmailIframe.test.tsx` locks this invariant.
 */

export type Theme = "system" | "paper" | "dark" | "claude" | "codex";

export const THEME_STORAGE_KEY = "wemail.theme";
const THEME_MIGRATED_KEY = "wemail.theme.migrated.paper-default";

const THEMES: readonly Theme[] = ["system", "paper", "dark", "claude", "codex"] as const;
const DEFAULT_THEME: Theme = "system";

function isTheme(value: unknown): value is Theme {
	return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function readStoredTheme(): Theme {
	if (typeof window === "undefined") return DEFAULT_THEME;
	try {
		// One-time migration: `claude` was an earlier default light surface and
		// has no tab in the appearance picker; fold it into the current default
		// (paper / warm stone), exactly once. Stored `codex` values are treated
		// as explicit choices and preserved.
		const migrated = window.localStorage.getItem(THEME_MIGRATED_KEY);
		const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
		if (!migrated && raw === "claude") {
			window.localStorage.setItem(THEME_STORAGE_KEY, "paper");
			window.localStorage.setItem(THEME_MIGRATED_KEY, "1");
			return "paper";
		}
		return isTheme(raw) ? raw : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

function resolvedTheme(theme: Theme): Exclude<Theme, "system"> {
	if (theme !== "system") return theme;
	return typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-color-scheme: dark)").matches
		? "dark"
		: "paper";
}

function applyThemeAttribute(theme: Theme) {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = resolvedTheme(theme);
}

// Tiny external store. We avoid a zustand slice here because the value is a
// single primitive and we want `useSyncExternalStore` semantics for SSR
// safety (`getServerSnapshot` returns the default during hydration).
let currentTheme: Theme | null = null;
const listeners = new Set<() => void>();
let stopSystemThemeListener: (() => void) | null = null;

function getSnapshot(): Theme {
	// When no consumers are mounted, re-hydrate from localStorage so that
	// external changes (other tabs, test fixtures) are picked up on next
	// mount. While at least one consumer is active the in-memory value is
	// authoritative — `setTheme` is the only writer.
	if (currentTheme === null || listeners.size === 0) {
		currentTheme = readStoredTheme();
	}
	return currentTheme;
}

function getServerSnapshot(): Theme {
	return DEFAULT_THEME;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!stopSystemThemeListener && typeof window !== "undefined" && window.matchMedia) {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const handleChange = () => {
			if (getSnapshot() === "system") applyThemeAttribute("system");
		};
		media.addEventListener?.("change", handleChange);
		stopSystemThemeListener = () => media.removeEventListener?.("change", handleChange);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && stopSystemThemeListener) {
			stopSystemThemeListener();
			stopSystemThemeListener = null;
		}
	};
}

function emit() {
	for (const listener of listeners) listener();
}

export function setTheme(theme: Theme) {
	currentTheme = theme;
	if (typeof window !== "undefined") {
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, theme);
		} catch {
			// localStorage unavailable (private mode, quota); ignore — the
			// in-memory snapshot still drives the UI for this session.
		}
	}
	applyThemeAttribute(theme);
	emit();
}

/**
 * Synchronously apply the persisted theme to `<html data-theme>`.
 *
 * Useful for non-document entry points and tests. The main document path uses
 * `getThemeInitScript()` so theme selection is applied before hydration starts.
 */
export function applyStoredTheme() {
	if (typeof document === "undefined") return;
	const theme = readStoredTheme();
	currentTheme = theme;
	applyThemeAttribute(theme);
}

export function getThemeInitScript() {
	return `(() => {
  const storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
  const migratedKey = ${JSON.stringify(THEME_MIGRATED_KEY)};
  const themes = new Set(["system", "paper", "dark", "claude", "codex"]);
  let theme = "system";
  try {
    const migrated = window.localStorage.getItem(migratedKey);
    let storedTheme = window.localStorage.getItem(storageKey);
    if (!migrated && storedTheme === "claude") {
      storedTheme = "paper";
      window.localStorage.setItem(storageKey, "paper");
      window.localStorage.setItem(migratedKey, "1");
    }
    if (themes.has(storedTheme)) theme = storedTheme;
  } catch {}
  document.documentElement.dataset.theme =
    theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : theme === "system" ? "paper" : theme;
})();`;
}

export function useTheme(): {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	resolvedTheme: Exclude<Theme, "system">;
} {
	const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	// Resolved concrete theme ("system" folded to "dark"/"paper") — what
	// `data-theme` on <html> actually is right now. Useful for non-tokenized
	// surfaces (sonner) that must pick a palette variant.
	return { theme, setTheme, resolvedTheme: resolvedTheme(theme) };
}
