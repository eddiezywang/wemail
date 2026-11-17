import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateSmartTagDialog } from "./CreateSmartTagDialog";

const mocks = vi.hoisted(() => ({
	preview: {
		mutateAsync: vi.fn(),
		reset: vi.fn(),
		isPending: false,
	},
	createPromotion: {
		mutateAsync: vi.fn(),
		reset: vi.fn(),
		isPending: false,
	},
	createTag: {
		mutateAsync: vi.fn(),
		reset: vi.fn(),
		isPending: false,
	},
}));

vi.mock("~/queries/smartTagPromotions", () => ({
	usePreviewSmartTagPromotion: () => mocks.preview,
	useCreateSmartTagPromotion: () => mocks.createPromotion,
}));

vi.mock("~/queries/userTags", () => ({
	useCreateUserTag: () => mocks.createTag,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const candidate = {
	name: "构建日报",
	confidence: 0.92,
	source: "ai" as const,
	tier: "auto" as const,
	topicId: "topic-1",
};

const createdTag = {
	id: "tag-1",
	accountId: "acct-1",
	name: "构建日报",
	description: "持续集成系统发送的构建结果日报。",
	prompt: "compiled prompt",
	effectivePrompt: "compiled prompt",
	createdAt: "2026-08-09T00:00:00.000Z",
	updatedAt: "2026-08-09T00:00:00.000Z",
};

beforeEach(() => {
	mocks.preview.mutateAsync.mockReset().mockResolvedValue({
		name: candidate.name,
		description: createdTag.description,
		topicId: candidate.topicId,
		sourceEmailId: "mail-1",
		generationStatus: "generated",
	});
	mocks.preview.reset.mockReset();
	mocks.preview.isPending = false;
	mocks.createPromotion.mutateAsync.mockReset().mockResolvedValue({ tag: createdTag });
	mocks.createPromotion.reset.mockReset();
	mocks.createPromotion.isPending = false;
	mocks.createTag.mutateAsync.mockReset().mockResolvedValue(createdTag);
	mocks.createTag.reset.mockReset();
	mocks.createTag.isPending = false;
});

describe("CreateSmartTagDialog", () => {
	it("uses the standard name and description flow for manual creation", async () => {
		const user = userEvent.setup();
		render(
			<CreateSmartTagDialog open onOpenChange={vi.fn()} accountId="acct-1" />,
		);
		await user.type(screen.getByTestId("smart-tag-name-input"), "客户退款");
		await user.type(screen.getByTestId("smart-tag-description-input"), "客户提出退款申请的邮件");
		await user.click(screen.getByTestId("smart-tag-create-submit"));

		expect(mocks.createTag.mutateAsync).toHaveBeenCalledWith({
			accountId: "acct-1",
			name: "客户退款",
			description: "客户提出退款申请的邮件",
		});
	});

	it("prefills a candidate description then submits through candidate-aware creation", async () => {
		const user = userEvent.setup();
		const onCreated = vi.fn();
		render(
			<CreateSmartTagDialog
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
				candidateSource={{ emailId: "mail-1", candidate }}
				onCreated={onCreated}
			/>,
		);

		expect(await screen.findByDisplayValue(createdTag.description)).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "创建智能标签" })).toBeInTheDocument();
		expect(screen.queryByText("完整分类提示词")).not.toBeInTheDocument();
		await user.click(screen.getByTestId("smart-tag-create-submit"));

		expect(mocks.createPromotion.mutateAsync).toHaveBeenCalledWith({
			emailId: "mail-1",
			candidateName: candidate.name,
			topicId: candidate.topicId,
			name: candidate.name,
			description: createdTag.description,
		});
		expect(onCreated).toHaveBeenCalledWith(createdTag);
	});

	it("regenerates the description with the refresh flag", async () => {
		const user = userEvent.setup();
		render(
			<CreateSmartTagDialog
				open
				onOpenChange={vi.fn()}
				accountId="acct-1"
				candidateSource={{ emailId: "mail-1", candidate }}
			/>,
		);

		expect(await screen.findByDisplayValue(createdTag.description)).toBeInTheDocument();
		await user.click(screen.getByTestId("smart-tag-regenerate-description"));

		expect(mocks.preview.mutateAsync).toHaveBeenCalledWith({
			emailId: "mail-1",
			candidateName: candidate.name,
			topicId: candidate.topicId,
			refresh: true,
		});
	});
});
