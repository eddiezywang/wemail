// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToasterProps } from "sonner";
import { setTheme } from "~/hooks/useTheme";

// Unit boundary: this file tests OUR wrapper's contract (position/duration/
// theme mapping/token classNames), not sonner's DOM — jsdom never paints
// sonner's toast list, so the real component is replaced here.
const capturedProps: ToasterProps[] = [];
vi.mock("sonner", () => ({
	Toaster: (props: ToasterProps) => {
		capturedProps.push(props);
		return null;
	},
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { Toaster } = await import("./sonner");

describe("Toaster (S4 result toasts)", () => {
	afterEach(() => {
		cleanup();
		capturedProps.length = 0;
		setTheme("codex");
	});

	it("places result toasts top-centre with a 3s lifetime", () => {
		render(<Toaster />);
		const props = capturedProps.at(-1)!;
		expect(props.position).toBe("top-center");
		expect(props.duration).toBe(3000);
	});

	it("follows the resolved theme instead of hard-coded light", () => {
		setTheme("dark");
		render(<Toaster />);
		expect(capturedProps.at(-1)!.theme).toBe("dark");
	});

	it("uses the light palette for light themes", () => {
		setTheme("paper");
		render(<Toaster />);
		expect(capturedProps.at(-1)!.theme).toBe("light");
	});

	it("styles toasts with WeMail tokens (16px corners, green success tile)", () => {
		render(<Toaster />);
		const classNames = capturedProps.at(-1)!.toastOptions?.classNames ?? {};
		expect(classNames.toast).toContain("rounded-xl");
		expect(classNames.toast).toContain("border-edge");
		expect(classNames.success).toContain("bg-green-bg");
		expect(classNames.error).toContain("border-l-red");
	});
});
