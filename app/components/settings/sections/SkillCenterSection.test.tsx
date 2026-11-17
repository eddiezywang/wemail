import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillCenterSection } from "./SkillCenterSection";

const api = vi.hoisted(() => ({
	listSkills: vi.fn(),
	inspectSkill: vi.fn(),
	listSkillUsage: vi.fn(),
	previewSkillImport: vi.fn(),
	confirmSkillImport: vi.fn(),
	setSkillEnabled: vi.fn(),
	activateSkillVersion: vi.fn(),
	deleteSkillVersion: vi.fn(),
	exportSkill: vi.fn(),
	getSkillContent: vi.fn(),
	createSkillDraft: vi.fn(),
	validateSkillDraft: vi.fn(),
	installSkillDraft: vi.fn(),
}));

vi.mock("~/services/api", () => ({ default: api }));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

describe("SkillCenterSection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.wemailDesktop = {
			getPathForFile: vi.fn(() => "D:\\skills\\report.zip"),
		};
	});

	it("puts import first, hides technical metadata, and supports viewing the prompt", async () => {
		api.listSkills.mockResolvedValue({
			skills: [{
				id: "personal-report",
				scope: "personal",
				displayName: "个人日报",
				description: "生成日报",
				activeVersion: "1.0.0",
				enabled: true,
				protected: false,
				compatibility: "compatible",
				requestedPermissions: [],
				toolAllowlist: [],
				versions: ["1.0.0"],
				usageCount: 2,
				source: "manual",
			}],
		});
		api.getSkillContent.mockResolvedValue({
			skillId: "personal-report",
			version: "1.0.0",
			contentHash: "installed-hash",
			markdown: [
				"\uFEFF---",
				"name: 个人日报",
				"description: 生成日报",
				"---",
				"",
				"处理每日销售数据，并生成简洁的日报。",
				"",
				"参考 [日报示例](references/example.md)。",
			].join("\n"),
		});
		api.previewSkillImport.mockResolvedValue({
			valid: true,
			displayName: "导入日报",
			description: "导入",
			contentHash: "exact-import-hash",
			issues: [],
			warnings: [],
		});
		api.confirmSkillImport.mockResolvedValue({});

		renderWithQuery(<SkillCenterSection />);
		expect((await screen.findAllByText("个人日报")).length).toBe(2);
		const importDropzone = screen.getByTestId("skill-import-dropzone");
		const searchInput = screen.getByPlaceholderText("搜索名称、用途或 ID");
		const workbench = screen.getByTestId("skill-workbench");
		expect(workbench).toHaveClass("min-h-0", "flex-1");
		for (const label of ["全部", "内置", "个人"]) {
			expect(screen.getByRole("button", { name: label })).toHaveClass(
				"h-9",
				"w-12",
				"border",
			);
		}
		expect(
			importDropzone.compareDocumentPosition(searchInput) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.queryByText("本机个人")).not.toBeInTheDocument();
		expect(screen.queryByText("2 条")).not.toBeInTheDocument();
		expect(screen.queryByText("v1.0.0")).not.toBeInTheDocument();
		expect(screen.queryByText("兼容")).not.toBeInTheDocument();
		expect(screen.queryByText("来源")).not.toBeInTheDocument();
		expect(screen.queryByText("自动化引用")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "创建 Skill" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByPlaceholderText("输入 Skill 文件夹或 ZIP 的本地路径"),
		).not.toBeInTheDocument();

		const droppedFile = new File(["skill"], "report.zip", {
			type: "application/zip",
		});
		expect(await screen.findByRole("tree", { name: "个人日报 组织结构" })).toBeInTheDocument();
		expect(screen.getByText("Skill 组织结构")).toBeInTheDocument();
		expect(screen.getByText("SKILL.md")).toBeInTheDocument();
		expect(screen.getByText("references")).toBeInTheDocument();
		expect(screen.getByText("example.md")).toBeInTheDocument();
		expect(screen.queryByText("处理每日销售数据，并生成简洁的日报。")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "查看 MD 内容" }));
		const prompt =
			await screen.findByText("处理每日销售数据，并生成简洁的日报。");
		expect(prompt).toBeInTheDocument();
		expect(screen.getByTestId("skill-content-frame")).toContainElement(prompt);
		expect(screen.queryByText("name: 个人日报")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "返回组织结构" })).toBeInTheDocument();
		expect(api.getSkillContent).toHaveBeenCalledWith("personal-report");
		fireEvent.click(screen.getByRole("button", { name: "个人" }));
		expect(screen.getByRole("button", { name: "个人" })).toHaveClass(
			"w-12",
			"border",
		);

		fireEvent.drop(importDropzone, {
			dataTransfer: {
				files: {
					item: (index: number) => (index === 0 ? droppedFile : null),
				},
			},
		});
		await waitFor(() =>
			expect(api.previewSkillImport).toHaveBeenCalledWith(
				"D:\\skills\\report.zip",
			),
		);
		expect(await screen.findByText("导入日报 已准备好")).toBeInTheDocument();
		expect(screen.queryByText("exact-import-hash")).not.toBeInTheDocument();
		expect(api.confirmSkillImport).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
		await waitFor(() =>
			expect(api.confirmSkillImport).toHaveBeenCalledWith(
				"D:\\skills\\report.zip",
				"exact-import-hash",
			),
		);
	});
});

function renderWithQuery(node: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
}
