import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationDetail } from "../../../shared/wemail/automationCenter";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter";
import { TemplateVersionDialog } from "./TemplateVersionDialog";

const mocks = vi.hoisted(() => ({
	getVersion: vi.fn(),
	preview: vi.fn(),
	confirm: vi.fn(),
	rollback: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("~/services/api", () => ({
	default: {
		getUnifiedAutomationTemplateVersion: mocks.getVersion,
		previewUnifiedAutomationTemplateUpgrade: mocks.preview,
		confirmUnifiedAutomationTemplateUpgrade: mocks.confirm,
		rollbackUnifiedAutomationTemplate: mocks.rollback,
	},
}));

vi.mock("sonner", () => ({
	toast: { success: mocks.success, error: mocks.error },
}));

const upgrade = {
	available: true,
	currentVersion: "1.0.0",
	targetVersion: "1.1.0",
	targetHash: "new-hash",
	summary: ["新增趋势图", "调整投递摘要"],
	requiresPreview: true,
};

const draft = {
	id: "draft-upgrade",
	accountId: "acct-1",
	revision: 1,
	mode: "automation",
	steps: [],
	skillSnapshots: [],
	capabilitySnapshots: [],
	reviews: [
		{
			id: "artifact-review",
			target: "artifact",
			policy: "required",
			status: "pending",
			draftRevision: 1,
			targetVersion: 1,
			contentHash: "review-hash",
			dependsOn: [],
		},
	],
	validation: { status: "not_validated", issues: [] },
	createdAt: "2026-07-30T00:00:00.000Z",
	updatedAt: "2026-07-30T00:00:00.000Z",
} satisfies ExecutionPipelineDraft;

const detail = {
	id: "rule-1",
	schemaVersion: 2,
	version: 3,
	accountId: "acct-1",
	name: "邮箱速览",
	template: {
		templateId: "subscription-daily-insight",
		templateVersion: "1.0.0",
		templateHash: "old-hash",
		resultSchemaId: "subscription-insight",
		resultSchemaVersion: 1,
		rendererId: "subscription-insight",
		rendererVersion: "1.0.0",
		configuration: {},
	},
	upgrade,
} as unknown as AutomationDetail;

describe("TemplateVersionDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getVersion.mockResolvedValue({
			ok: true,
			upgrade,
			versions: [
				{ version: 3, templateVersion: "1.0.0", createdAt: "now", current: true },
				{ version: 2, templateVersion: "0.9.0", createdAt: "before", current: false },
			],
		});
	});

	it("regenerates an upgrade preview and requires the exact phrase before creating a draft", async () => {
		const user = userEvent.setup();
		mocks.preview.mockResolvedValue({
			ok: true,
			preview: {
				previewId: "preview-1",
				previewHash: "preview-hash",
				draft,
				expiresAt: "2026-07-30T01:00:00.000Z",
				upgrade,
			},
		});
		mocks.confirm.mockResolvedValue({
			ok: true,
			draft,
			next: { type: "review_and_confirm", message: "继续评审" },
		});
		const onUpgradeDraft = vi.fn();

		render(
			<TemplateVersionDialog
				accountId="acct-1"
				detail={detail}
				open
				onOpenChange={vi.fn()}
				onUpgradeDraft={onUpgradeDraft}
				onRolledBack={vi.fn()}
			/>,
		);

		expect(await screen.findByText(/新增趋势图/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "生成升级预览" }));
		expect(await screen.findByText("1 个评审检查点需要确认")).toBeInTheDocument();
		const confirmButton = screen.getByRole("button", { name: "确认并打开升级草稿" });
		expect(confirmButton).toBeDisabled();
		await user.type(screen.getByLabelText(/输入“升级到版本 1.1.0”/), "升级到版本 1.1.0");
		await user.click(confirmButton);

		await waitFor(() =>
			expect(mocks.confirm).toHaveBeenCalledWith("rule-1", {
				accountId: "acct-1",
				previewId: "preview-1",
				previewHash: "preview-hash",
				targetVersion: "1.1.0",
				confirmation: "升级到版本 1.1.0",
			}),
		);
		expect(onUpgradeDraft).toHaveBeenCalledWith(draft);
	});

	it("requires an exact rollback phrase and preserves version history", async () => {
		const user = userEvent.setup();
		mocks.rollback.mockResolvedValue({ ok: true, automation: {} });
		const onRolledBack = vi.fn();
		render(
			<TemplateVersionDialog
				accountId="acct-1"
				detail={detail}
				open
				onOpenChange={vi.fn()}
				onUpgradeDraft={vi.fn()}
				onRolledBack={onRolledBack}
			/>,
		);

		await screen.findByText(/新增趋势图/);
		await user.click(screen.getByText("回退到历史规则版本"));
		const rollbackButton = screen.getByRole("button", { name: "创建回退版本" });
		expect(rollbackButton).toBeDisabled();
		await user.type(screen.getByLabelText(/输入“回退到版本 2”/), "回退到版本 2");
		await user.click(rollbackButton);
		await waitFor(() => expect(mocks.rollback).toHaveBeenCalled());
		expect(onRolledBack).toHaveBeenCalledTimes(1);
	});
});
