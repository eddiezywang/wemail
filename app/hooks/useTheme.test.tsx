// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemeInitScript, useTheme } from "./useTheme";

const STORAGE_KEY = "wemail.theme";

describe("useTheme", () => {
	beforeEach(() => {
		localStorage.clear();
		delete document.documentElement.dataset.theme;
	});

	afterEach(() => {
		localStorage.clear();
		delete document.documentElement.dataset.theme;
	});

	it("defaults to following the system when no localStorage entry exists", () => {
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("system");
	});

	it("reads existing localStorage value on mount", () => {
		localStorage.setItem(STORAGE_KEY, "dark");
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("dark");
	});

	it("migrates legacy claude default to paper exactly once", () => {
		localStorage.setItem(STORAGE_KEY, "claude");
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("paper");
		expect(localStorage.getItem(STORAGE_KEY)).toBe("paper");
		expect(localStorage.getItem("wemail.theme.migrated.paper-default")).toBe(
			"1",
		);
	});

	it("keeps explicitly stored codex and paper values as-is", () => {
		localStorage.setItem(STORAGE_KEY, "codex");
		const codex = renderHook(() => useTheme());
		expect(codex.result.current.theme).toBe("codex");
		codex.unmount();
		localStorage.setItem(STORAGE_KEY, "paper");
		const paper = renderHook(() => useTheme());
		expect(paper.result.current.theme).toBe("paper");
	});

	it("system light resolves to the warm stone default (paper)", () => {
		const { result } = renderHook(() => useTheme());
		act(() => {
			result.current.setTheme("system");
		});
		// jsdom matches no media queries, so "system" falls to the light surface.
		expect(document.documentElement.dataset.theme).toBe("paper");
		expect(result.current.resolvedTheme).toBe("paper");
	});

	it("setTheme('dark') updates document.documentElement.dataset.theme", () => {
		const { result } = renderHook(() => useTheme());
		act(() => {
			result.current.setTheme("dark");
		});
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(result.current.theme).toBe("dark");
	});

	it("setTheme persists to localStorage under 'wemail.theme'", () => {
		const { result } = renderHook(() => useTheme());
		act(() => {
			result.current.setTheme("dark");
		});
		expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
	});

	it("setTheme('paper') sets data-theme to 'paper'", () => {
		const { result } = renderHook(() => useTheme());
		act(() => {
			result.current.setTheme("dark");
		});
		act(() => {
			result.current.setTheme("paper");
		});
		expect(document.documentElement.dataset.theme).toBe("paper");
		expect(localStorage.getItem(STORAGE_KEY)).toBe("paper");
	});

	it("setTheme('codex') sets data-theme to 'codex'", () => {
		const { result } = renderHook(() => useTheme());
		act(() => {
			result.current.setTheme("codex");
		});
		expect(document.documentElement.dataset.theme).toBe("codex");
		expect(localStorage.getItem(STORAGE_KEY)).toBe("codex");
	});

	it("multiple consumers stay in sync (external store)", () => {
		const a = renderHook(() => useTheme());
		const b = renderHook(() => useTheme());
		act(() => {
			a.result.current.setTheme("claude");
		});
		expect(a.result.current.theme).toBe("claude");
		expect(b.result.current.theme).toBe("claude");
	});

	it("provides a document init script that applies the stored theme before hydration", () => {
		localStorage.setItem(STORAGE_KEY, "dark");

		// eslint-disable-next-line no-new-func
		new Function(getThemeInitScript())();

		expect(document.documentElement.dataset.theme).toBe("dark");
	});
});
