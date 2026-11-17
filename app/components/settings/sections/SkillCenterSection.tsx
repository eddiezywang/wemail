import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { FileIcon } from "@phosphor-icons/react/File";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { getUserFacingError } from "~/lib/user-facing-error";
import type {
	SkillContentEntry,
	SkillSummary,
} from "../../../../shared/wemail/skillCenter";
import { AgentMarkdown } from "~/components/agent/AgentMarkdown";
import { Button } from "~/components/ui/button";
import api from "~/services/api";

export function SkillCenterSection() {
	const queryClient = useQueryClient();
	const [scope, setScope] = useState<"all" | "builtin" | "personal">("all");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string>();
	const [importPath, setImportPath] = useState("");
	const [importPreview, setImportPreview] = useState<{
		displayName?: string;
		description?: string;
		contentHash: string;
		warnings: string[];
	}>();
	const [isDragging, setIsDragging] = useState(false);
	const skills = useQuery({
		queryKey: ["skill-center"],
		queryFn: () => api.listSkills(),
	});
	const visible = useMemo(
		() =>
			(skills.data?.skills ?? []).filter(
				(skill) =>
					(scope === "all" || skill.scope === scope) &&
					`${skill.displayName} ${skill.id} ${skill.description}`
						.toLowerCase()
						.includes(query.trim().toLowerCase()),
			),
		[query, scope, skills.data],
	);
	const selected =
		visible.find((skill) => skill.id === selectedId) ??
		(skills.data?.skills ?? []).find((skill) => skill.id === selectedId) ??
		visible[0];

	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["skill-center"] });
	const importSkill = useMutation({
		mutationFn: async (path: string) => {
			const preview = await api.previewSkillImport(path);
			if (!preview.valid || !preview.contentHash) {
				throw new Error(preview.issues.join("；") || "Skill 校验未通过");
			}
			return {
				displayName: preview.displayName,
				description: preview.description,
				contentHash: preview.contentHash,
				warnings: preview.warnings,
			};
		},
		onSuccess: (preview) => {
			setImportPreview(preview);
			toast.success("Skill 校验通过，请确认导入");
		},
		onError: showError,
	});
	const confirmImport = useMutation({
		mutationFn: () =>
			api.confirmSkillImport(importPath.trim(), importPreview!.contentHash),
		onSuccess: async () => {
			await refresh();
			setImportPath("");
			setImportPreview(undefined);
			toast.success("Skill 已导入");
		},
		onError: showError,
	});
	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setIsDragging(false);
		setImportPreview(undefined);
		const file = event.dataTransfer.files.item(0);
		if (!file) {
			toast.error("没有识别到 Skill 包，请拖入 ZIP 文件或 Skill 文件夹");
			return;
		}
		const path =
			window.wemailDesktop?.getPathForFile?.(file) ||
			(file as File & { path?: string }).path ||
			"";
		if (!path) {
			toast.error("无法读取本地路径，请在 WeMail 桌面应用中重新拖入");
			return;
		}
		setImportPath(path);
		importSkill.mutate(path);
	};

	return (
		<div
			className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
			data-testid="skill-center-settings-section"
		>
			<header className="shrink-0">
				<div className="mb-1 flex items-center gap-2">
					<h2 className="text-base font-semibold text-ink">Skill Center</h2>
					<span className="rounded-full bg-paper-3 px-2 py-0.5 font-mono text-xs text-ink-3">
						本机
					</span>
				</div>
				<p className="max-w-xl text-xs leading-5 text-ink-3">
					管理 WeMail 的 Skill，并随时查看每个 Skill 的提示词。
				</p>
			</header>

			<div
				data-testid="skill-import-dropzone"
				onDragEnter={(event) => {
					event.preventDefault();
					setIsDragging(true);
				}}
				onDragOver={(event) => {
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
					setIsDragging(true);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
						setIsDragging(false);
					}
				}}
				onDrop={handleDrop}
				aria-label="拖拽导入 Skill 包"
				className={`flex h-[72px] shrink-0 items-center justify-between gap-4 rounded-xl border border-dashed px-4 transition-colors ${
					isDragging
						? "border-coral bg-coral/5"
						: importPreview
							? "border-green/30 bg-green-bg"
							: "border-edge bg-paper-2"
				}`}
			>
				<div className="flex min-w-0 items-center gap-3">
					<span
						className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
							isDragging
								? "bg-coral text-white"
								: importPreview
									? "bg-green-bg text-green"
									: "bg-paper text-ink-3"
						}`}
					>
						<DownloadSimpleIcon size={18} weight="regular" />
					</span>
					<div className="min-w-0">
						<p className="text-sm font-semibold text-ink">
							{importSkill.isPending
								? "正在识别并校验 Skill 包…"
								: isDragging
									? "松开即可识别"
									: importPreview
										? `${importPreview.displayName ?? "个人 Skill"} 已准备好`
										: "导入 Skill"}
						</p>
						<p className="mt-1 text-xs leading-5 text-ink-3">
							{importPreview
								? "内容已校验，确认后会保存到本机。"
								: "将完整 Skill 文件夹或 ZIP 包拖拽到这里。"}
						</p>
					</div>
				</div>
				{importPreview ? (
					<Button
						size="sm"
						loading={confirmImport.isPending}
						onClick={() => confirmImport.mutate()}
					>
						确认导入
					</Button>
				) : null}
			</div>

			<div className="flex shrink-0 gap-2">
				<label className="relative min-w-0 flex-1">
					<MagnifyingGlassIcon
						size={15}
						className="pointer-events-none absolute left-3 top-2.5 text-ink-4"
					/>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索名称、用途或 ID"
						className="h-9 w-full rounded-lg border border-edge bg-paper pl-9 pr-3 text-sm text-ink outline-none focus:border-ink-4"
					/>
				</label>
				{(["all", "builtin", "personal"] as const).map((value) => (
					<button
						key={value}
						type="button"
						onClick={() => setScope(value)}
						className={`h-9 w-12 shrink-0 rounded-lg border text-xs transition-colors ${
							scope === value
								? "border-ink bg-ink text-paper"
								: "border-edge text-ink-3 hover:bg-paper-2"
						}`}
					>
						{value === "all" ? "全部" : value === "builtin" ? "内置" : "个人"}
					</button>
				))}
			</div>

			<div
				className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(160px,0.7fr)_minmax(0,1.3fr)] overflow-hidden rounded-xl border border-edge @min-[620px]/settings-section:grid-cols-[240px_minmax(0,1fr)] @min-[620px]/settings-section:grid-rows-1"
				data-testid="skill-workbench"
			>
				<div className="min-h-0 overflow-y-auto border-b border-edge bg-paper-2 p-2 [scrollbar-gutter:stable] sm:border-b-0 sm:border-r">
					{skills.isLoading ? (
						<p className="p-3 text-xs text-ink-3">正在读取本机 Skill…</p>
					) : visible.length === 0 ? (
						<p className="p-3 text-xs leading-5 text-ink-3">
							没有匹配的 Skill。你可以在上方导入 Skill 文件夹或 ZIP 包。
						</p>
					) : (
						visible.map((skill) => (
							<SkillRow
								key={skill.id}
								skill={skill}
								active={selected?.id === skill.id}
								onClick={() => setSelectedId(skill.id)}
							/>
						))
					)}
				</div>
				<div className="min-h-0 min-w-0 overflow-hidden">
					{selected ? (
						<SkillDetail
							key={selected.id}
							skill={selected}
							onChanged={refresh}
						/>
					) : (
						<div className="flex h-full items-center justify-center text-sm text-ink-3">
							选择一个 Skill 查看详情
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function SkillRow({
	skill,
	active,
	onClick,
}: {
	skill: SkillSummary;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left ${
				active ? "bg-paper shadow-sm" : "hover:bg-paper-3"
			}`}
		>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
					{skill.displayName}
				</span>
				<span
					aria-label={skill.enabled ? "已启用" : "已停用"}
					className={`h-1.5 w-1.5 rounded-full ${
						skill.enabled ? "bg-green" : "bg-ink-4"
					}`}
				/>
			</div>
			<p className="mt-1 truncate text-xs text-ink-4">{skill.description}</p>
		</button>
	);
}

function SkillDetail({
	skill,
	onChanged,
}: {
	skill: SkillSummary;
	onChanged: () => Promise<unknown>;
}) {
	const [detailView, setDetailView] = useState<"structure" | "preview">("structure");
	const [exportDirectory, setExportDirectory] = useState("");
	const content = useQuery({
		queryKey: ["skill-center", skill.id, "content"],
		queryFn: () => api.getSkillContent(skill.id),
	});
	const enabled = useMutation({
		mutationFn: () => api.setSkillEnabled(skill.id, !skill.enabled),
		onSuccess: async () => {
			await onChanged();
			toast.success(skill.enabled ? "Skill 已停用" : "Skill 已启用");
		},
		onError: showError,
	});
	const exportSkill = useMutation({
		mutationFn: () =>
			api.exportSkill(
				skill.id,
				skill.activeVersion,
				exportDirectory.trim(),
			),
		onSuccess: (result) => toast.success(`已导出到 ${result.path}`),
		onError: showError,
	});

	return (
		<div className="flex h-full min-h-0 flex-col p-5">
			<div className="flex shrink-0 items-start gap-4">
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-lg font-semibold text-ink">{skill.displayName}</h3>
					<p className="mt-1 line-clamp-2 text-sm leading-6 text-ink-3">
						{skill.description}
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					disabled={skill.protected}
					loading={enabled.isPending}
					onClick={() => enabled.mutate()}
				>
					{skill.enabled ? "停用" : "启用"}
				</Button>
			</div>

			<section
				className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-edge bg-paper-2"
				data-testid="skill-content-frame"
			>
				<div className="flex h-11 shrink-0 items-center justify-between border-b border-edge px-3">
					<div className="flex min-w-0 items-center gap-2">
						{detailView === "structure" ? (
							<FolderIcon size={15} weight="fill" className="shrink-0 text-amber" />
						) : (
							<FileTextIcon size={15} className="shrink-0 text-coral" />
						)}
						<h4 className="truncate text-xs font-semibold text-ink">
							{detailView === "structure" ? "Skill 组织结构" : "SKILL.md"}
						</h4>
					</div>
					<Button
						size="sm"
						variant="ghost"
						className="h-9 px-3 text-xs"
						onClick={() =>
							setDetailView((value) =>
								value === "structure" ? "preview" : "structure",
							)
						}
					>
						{detailView === "structure" ? (
							<>
								<FileTextIcon size={14} />
								查看 MD 内容
							</>
						) : (
							<>
								<ArrowLeftIcon size={14} />
								返回组织结构
							</>
						)}
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
					{content.isLoading ? (
						<div className="flex h-full items-center justify-center text-xs text-ink-3">
							正在读取 Skill…
						</div>
					) : content.isError ? (
						<div className="flex h-full items-center justify-center text-xs text-red">
							Skill 内容读取失败，请稍后重试。
						</div>
					) : detailView === "structure" ? (
						<SkillStructure
							displayName={skill.displayName}
							entries={effectiveSkillEntries(content.data)}
						/>
					) : (
						<AgentMarkdown
							text={(content.data?.markdown
								? promptBody(content.data.markdown)
								: "") || "此 Skill 暂无说明内容。"}
							className="text-xs text-ink"
						/>
					)}
				</div>
			</section>

			{skill.scope === "personal" ? (
				<div className="mt-4 flex shrink-0 gap-2 border-t border-edge pt-4">
					<input
						value={exportDirectory}
						onChange={(event) => setExportDirectory(event.target.value)}
						placeholder="导出目录"
						aria-label="导出目录"
						className="h-9 min-w-0 flex-1 rounded-md border border-edge bg-paper px-2 font-mono text-xs"
					/>
					<Button
						size="sm"
						variant="ghost"
						disabled={!exportDirectory.trim()}
						loading={exportSkill.isPending}
						onClick={() => exportSkill.mutate()}
					>
						导出
					</Button>
				</div>
			) : null}
		</div>
	);
}

function SkillStructure({
	displayName,
	entries,
}: {
	displayName: string;
	entries: SkillContentEntry[];
}) {
	return (
		<div role="tree" aria-label={`${displayName} 组织结构`} className="text-xs">
			<div className="flex h-9 items-center gap-2 font-medium text-ink" role="treeitem">
				<FolderIcon size={16} weight="fill" className="text-amber" />
				<span className="truncate">{displayName}</span>
			</div>
			{entries.map((entry) => {
				const parts = entry.path.split("/");
				const name = parts.at(-1) ?? entry.path;
				const isMarkdown = entry.kind === "file" && /\.md$/i.test(name);
				return (
					<div
						key={entry.path}
						role="treeitem"
						aria-label={entry.path}
						className="flex h-9 items-center gap-2 rounded-md pr-2 text-ink-3 hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						style={{ paddingLeft: `${parts.length * 18}px` }}
					>
						{entry.kind === "directory" ? (
							<FolderIcon size={15} weight="fill" className="shrink-0 text-amber/80" />
						) : isMarkdown ? (
							<FileTextIcon size={15} className="shrink-0 text-coral" />
						) : (
							<FileIcon size={15} className="shrink-0 text-ink-4" />
						)}
						<span className="truncate">{name}</span>
					</div>
				);
			})}
		</div>
	);
}

function effectiveSkillEntries(content?: {
	markdown: string;
	entries?: SkillContentEntry[];
}): SkillContentEntry[] {
	if (content?.entries?.length) return content.entries;

	const entries = new Map<string, SkillContentEntry>();
	const add = (path: string, kind: SkillContentEntry["kind"]) => {
		if (!entries.has(path)) entries.set(path, { path, kind });
	};
	add("SKILL.md", "file");

	for (const match of content?.markdown.matchAll(/\]\(([^)]+)\)/g) ?? []) {
		const target = match[1]
			.trim()
			.replace(/^<|>$/g, "")
			.split(/[?#]/, 1)[0]
			.replace(/^\.\//, "")
			.replace(/\\/g, "/");
		if (!target || /^(?:[a-z]+:|\/|\.\.)/i.test(target)) continue;
		const parts = target.split("/").filter(Boolean);
		for (let index = 1; index < parts.length; index += 1) {
			add(parts.slice(0, index).join("/"), "directory");
		}
		add(parts.join("/"), "file");
	}

	add("wemail.skill.json", "file");
	return Array.from(entries.values());
}

function promptBody(markdown: string) {
	return markdown
		.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "")
		.trim();
}

function showError(error: unknown) {
	toast.error(getUserFacingError(error, "技能操作失败，请稍后重试。"));
}
