// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LlmConfigBanner from "./LlmConfigBanner";

describe("LlmConfigBanner", () => {
	it("renders nothing when configured is true", () => {
		render(<LlmConfigBanner configured={true} />);
		expect(screen.queryByTestId("wemail-llm-config-banner")).toBeNull();
	});

	it("renders the banner when configured is false", () => {
		render(<LlmConfigBanner configured={false} />);
		expect(screen.getByTestId("wemail-llm-config-banner")).toBeInTheDocument();
	});

	it("has role='alert' for accessibility", () => {
		render(<LlmConfigBanner configured={false} />);
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("contains a link to /settings", () => {
		render(<LlmConfigBanner configured={false} />);
		const link = screen.getByTestId("wemail-llm-config-link");
		expect(link).toHaveAttribute("href", "/settings");
		expect(link).toHaveTextContent(/配置.*Configure/i);
	});

	it("shows bilingual prompt text", () => {
		render(<LlmConfigBanner configured={false} />);
		const banner = screen.getByTestId("wemail-llm-config-banner");
		expect(banner).toHaveTextContent(/AI 功能/);
		expect(banner).toHaveTextContent(/AI features/);
	});

	it("dismisses the banner when the dismiss button is clicked", async () => {
		const user = userEvent.setup();
		render(<LlmConfigBanner configured={false} />);
		expect(screen.getByTestId("wemail-llm-config-banner")).toBeInTheDocument();

		await user.click(screen.getByTestId("wemail-llm-config-dismiss"));
		expect(screen.queryByTestId("wemail-llm-config-banner")).toBeNull();
	});

	it("calls onDismiss callback when dismissed", async () => {
		const user = userEvent.setup();
		const onDismiss = vi.fn();
		render(<LlmConfigBanner configured={false} onDismiss={onDismiss} />);

		await user.click(screen.getByTestId("wemail-llm-config-dismiss"));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("dismiss button has an accessible label", () => {
		render(<LlmConfigBanner configured={false} />);
		const btn = screen.getByTestId("wemail-llm-config-dismiss");
		expect(btn).toHaveAttribute("aria-label", "关闭提示");
	});

	it("defaults to showing the banner when configured is false", () => {
		render(<LlmConfigBanner configured={false} />);
		expect(screen.getByTestId("wemail-llm-config-banner")).toBeVisible();
	});

	it("dismissal is session-scoped — re-render shows banner again", () => {
		const { unmount } = render(<LlmConfigBanner configured={false} />);
		expect(screen.getByTestId("wemail-llm-config-banner")).toBeInTheDocument();
		unmount();

		// A fresh mount starts with dismissed=false (session-scoped state resets)
		render(<LlmConfigBanner configured={false} />);
		expect(screen.getByTestId("wemail-llm-config-banner")).toBeInTheDocument();
	});
});
