import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import { ManageSmartTagDialog } from "./ManageSmartTagDialog";

vi.mock("~/services/api", () => ({
	default: {
		deleteUserTag: vi.fn(),
		restoreOriginalUserTag: vi.fn(),
		updateUserTag: vi.fn(),
	},
}));

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ManageSmartTagDialog
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
				tag={{
					id: "tag-1",
					accountId: "acct-1",
					name: "版本交付",
					description: "版本交付邮件",
					prompt: "用户原始定义",
					optimizedPrompt: "AI 验证通过后的精确版本交付定义",
					optimizedPromptVersion: "v2",
					effectivePrompt: "AI 验证通过后的精确版本交付定义",
					createdAt: "2026-07-01T00:00:00.000Z",
					updatedAt: "2026-07-23T00:00:00.000Z",
					latestLearningRun: {
						id: "run-1",
						status: "activated",
						sampleCount: 24,
						positiveCount: 12,
						negativeCount: 12,
						validationCount: 8,
						currentCorrect: 5,
						candidateCorrect: 8,
						correctedCount: 3,
						regressionCount: 0,
						createdAt: "2026-07-23T00:00:00.000Z",
					},
					latestRetagRun: {
						id: "retag-1",
						status: "running",
						queuedCount: 10,
						processedCount: 4,
						failedCount: 1,
						retainedCount: 3,
						removedCount: 1,
					},
				}}
			/>
		</QueryClientProvider>,
	);
}

describe("ManageSmartTagDialog", () => {
	it("shows the generated rule and active optimized prompt as read-only", async () => {
		vi.mocked(api.restoreOriginalUserTag).mockResolvedValue({
			ok: true,
			tag: {
				id: "tag-1",
				accountId: "acct-1",
				name: "版本交付",
				description: "版本交付邮件",
				prompt: "用户原始定义",
				effectivePrompt: "用户原始定义",
				createdAt: "2026-07-01T00:00:00.000Z",
				updatedAt: "2026-07-23T00:00:00.000Z",
			},
		});
		const user = userEvent.setup();
		renderDialog();

		expect(screen.getByLabelText("系统生成的判定规则")).toHaveValue(
			"用户原始定义",
		);
		expect(screen.getByLabelText("系统生成的判定规则")).toHaveAttribute("readonly");
		expect(screen.getByLabelText("当前 AI 优化提示词")).toHaveValue(
			"AI 验证通过后的精确版本交付定义",
		);
		expect(screen.getByLabelText("当前 AI 优化提示词")).toHaveAttribute("readonly");
		expect(screen.getByTestId("smart-tag-learning-status")).toHaveTextContent(
			"验证 5/8 → 8/8",
		);
		expect(screen.getByTestId("smart-tag-retag-status")).toHaveTextContent(
			"5/10",
		);

		await user.click(screen.getByTestId("manage-smart-tag-restore-original"));
		expect(api.restoreOriginalUserTag).toHaveBeenCalledWith("tag-1");
	});
});
