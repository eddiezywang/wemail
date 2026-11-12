// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Read-only workspace viewer (Route C / WP J.7).
 *
 * Two-pane viewer for the per-account agent workspace:
 * - Left: presentation-safe files grouped by user-facing knowledge type.
 * - Right: monospace `<pre>` content of the selected file.
 *
 * v1 is intentionally read-only. The server returns presentation-safe
 * Markdown, which is rendered as plain text without exposing raw runtime files.
 */

import { useQuery } from "@tanstack/react-query";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { SignInIcon } from "@phosphor-icons/react/SignIn";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useMemo, useState } from "react";
import { useCurrentAccount } from "~/queries/currentAccount";
import {
	getWorkspaceFile,
	listWorkspaceFiles,
	type WorkspaceFileEntry,
} from "~/services/api";
import EmptyState from "~/components/wemail/EmptyState";
import PageFrame from "~/components/wemail/PageFrame";

export function meta() {
	return [{ title: "工作空间 / Workspace" }];
}

const GROUP_ORDER: WorkspaceFileEntry["kind"][] = [
	"writing-style",
	"sender-preference",
	"category-rule",
	"learning-note",
];

const GROUP_LABELS: Record<WorkspaceFileEntry["kind"], string> = {
	"writing-style": "写作风格",
	"sender-preference": "联系人偏好",
	"category-rule": "分类规则",
	"learning-note": "学习记录",
};

const SAFE_WORKSPACE_PATH = /^(style|senders|categories|learnings)\/[a-z0-9][a-z0-9-]*\.md$/i;

function isSafeWorkspacePath(filePath: string): boolean {
	return !filePath.includes("..") && !filePath.includes("\\") && SAFE_WORKSPACE_PATH.test(filePath);
}

const WORKSPACE_TITLE = "工作空间";
const WORKSPACE_SUBTITLE = "这里仅展示可供查看的写作偏好、分类规则和学习摘要。";

function WorkspaceFrame({
	children,
	contentClassName,
}: {
	children: React.ReactNode;
	contentClassName?: string;
}) {
	return (
		<PageFrame
			title={WORKSPACE_TITLE}
			subtitle={WORKSPACE_SUBTITLE}
			testId="workspace-page"
			contentClassName={contentClassName}
		>
			{children}
		</PageFrame>
	);
}

interface FileGroup {
	key: WorkspaceFileEntry["kind"];
	label: string;
	files: WorkspaceFileEntry[];
}

function groupFiles(files: WorkspaceFileEntry[]): FileGroup[] {
	const onlyFiles = files.filter(
		(f) => f.type === "file" && isSafeWorkspacePath(f.path),
	);
	const groups = new Map<WorkspaceFileEntry["kind"], WorkspaceFileEntry[]>();
	for (const f of onlyFiles) {
		const key = f.kind;
		const existing = groups.get(key);
		if (existing) existing.push(f);
		else groups.set(key, [f]);
	}
	const ordered: FileGroup[] = [];
	for (const k of GROUP_ORDER) {
		const list = groups.get(k);
		if (list && list.length > 0) {
			ordered.push({
				key: k,
				label: GROUP_LABELS[k] ?? k,
				files: list,
			});
			groups.delete(k);
		}
	}
	return ordered;
}

function WorkspaceFileList({
	files,
	selectedPath,
	onSelect,
}: {
	files: WorkspaceFileEntry[];
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	const grouped = useMemo(() => groupFiles(files), [files]);
	if (grouped.length === 0) {
		return (
			<div className="px-4 py-5 text-sm text-ink-3">暂无文件</div>
		);
	}
	return (
		<nav className="space-y-3 p-2" aria-label="工作空间文件">
			{grouped.map((group) => (
				<section key={group.key}>
					<div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
						{group.label}
					</div>
					<ul className="space-y-0.5">
						{group.files.map((f) => {
							const isSelected = f.path === selectedPath;
							return (
								<li key={f.path}>
									<button
										type="button"
										onClick={() => onSelect(f.path)}
										className={`flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left font-mono transition-colors ${
											isSelected
												? "bg-paper-3 text-ink"
												: "text-ink-2 hover:bg-paper-3 hover:text-ink"
										}`}
										data-testid="workspace-file-item"
										data-path={f.path}
										aria-current={isSelected ? "true" : undefined}
									>
										<span className="truncate flex-1">{f.path}</span>
										<span className="text-ink-3 shrink-0">{f.size}B</span>
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</nav>
	);
}

function WorkspaceFileContent({
	filePath,
	accountId,
}: {
	filePath: string | null;
	accountId: string | null;
}) {
	// accountId is part of the cache key so a logout/login switch never
	// shows the previous account's file content for the staleTime window.
	const fileQuery = useQuery({
		queryKey: ["workspace-file", accountId, filePath],
		queryFn: () => (filePath ? getWorkspaceFile(filePath) : Promise.resolve(null)),
		enabled: !!filePath && !!accountId && isSafeWorkspacePath(filePath),
		staleTime: 5_000,
	});
	if (!filePath || !isSafeWorkspacePath(filePath)) {
		return (
			<EmptyState
				icon={<FileTextIcon size={22} weight="regular" />}
				title="选择一个文件查看内容"
				description="左侧文件记录了 AI 的写作风格、标签规则和学习结果。"
				data-testid="workspace-select-file"
			/>
		);
	}
	if (fileQuery.isLoading) {
		return (
			<div
				className="flex h-full items-center justify-center text-sm text-ink-3"
				role="status"
				aria-live="polite"
			>
				正在读取文件…
			</div>
		);
	}
	if (fileQuery.isError) {
		return (
			<EmptyState
				icon={<WarningCircleIcon size={22} weight="regular" />}
				title="文件读取失败"
				description="当前文件暂时无法读取，可以重试或选择其他文件。"
				actions={[{ label: "重试", onClick: () => void fileQuery.refetch(), variant: "primary" }]}
				data-testid="workspace-file-error"
			/>
		);
	}
	const data = fileQuery.data;
	if (!data) {
		return (
			<EmptyState
				icon={<FileTextIcon size={22} weight="regular" />}
				title="文件不存在"
				description="这个文件可能已经被后台清理，重新选择左侧文件即可继续查看。"
				data-testid="workspace-file-not-found"
			/>
		);
	}
	return (
		<div className="flex h-full flex-col">
			<div className="px-4 py-2 border-b border-edge-3 text-xs font-mono text-ink-2 shrink-0">
				{data.path}
			</div>
			<div className="flex-1 min-h-0 overflow-auto p-4">
				<pre
					className="text-xs font-mono whitespace-pre-wrap text-ink"
					data-testid="workspace-file-content"
				>
					{data.content}
				</pre>
			</div>
		</div>
	);
}

export function WorkspaceWorkspace() {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const accountQuery = useCurrentAccount();
	const accountId = accountQuery.data?.account?.id ?? null;

	// Reset the selected file whenever the active account changes so the
	// right-pane content query never re-runs against a stale path that
	// belonged to the previous account's tree.
	useEffect(() => {
		setSelectedPath(null);
	}, [accountId]);

	const filesQuery = useQuery({
		queryKey: ["workspace-files", accountId],
		queryFn: () => listWorkspaceFiles(),
		enabled: !!accountId,
		staleTime: 5_000,
	});

	const files = filesQuery.data ?? [];
	const hasFiles = groupFiles(files).length > 0;

	if (!accountQuery.isLoading && !accountId) {
		return (
			<WorkspaceFrame>
				<EmptyState
					icon={<SignInIcon size={22} weight="regular" />}
					title="登录后查看工作空间"
					description="AI 的学习记录和规则文件会保存在当前邮箱账号下。"
					className="min-h-[520px]"
					data-testid="workspace-no-account"
				/>
			</WorkspaceFrame>
		);
	}

	if (!filesQuery.isLoading && !filesQuery.isError && !hasFiles) {
		return (
			<WorkspaceFrame>
				<EmptyState
					icon={<FolderOpenIcon size={22} weight="regular" />}
					title="工作空间还没有内容"
					description="AI 运行过摘要、写作或学习任务后，相关规则和记录会出现在这里。"
					className="min-h-[520px]"
					data-testid="workspace-empty"
				/>
			</WorkspaceFrame>
		);
	}

	return (
		<WorkspaceFrame contentClassName="p-0 md:p-0">
			<div className="flex h-full min-h-0 flex-row overflow-hidden">
				<aside className="w-64 shrink-0 overflow-y-auto border-r border-edge-3 bg-paper-2">
					{filesQuery.isLoading ? (
						<div className="p-6 text-sm text-ink-3" role="status" aria-live="polite">
							正在加载工作空间…
						</div>
					) : filesQuery.isError ? (
						<div className="space-y-3 p-6 text-sm text-ink-2" role="alert">
							<p>工作空间暂时无法加载。</p>
							<button
								type="button"
								onClick={() => void filesQuery.refetch()}
								className="min-h-10 rounded-full border border-edge bg-paper-2 px-4 font-medium text-ink transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								重试
							</button>
						</div>
					) : (
						<WorkspaceFileList
							files={files}
							selectedPath={selectedPath}
							onSelect={setSelectedPath}
						/>
					)}
				</aside>
				<div className="min-w-0 flex-1 bg-paper-2">
					<WorkspaceFileContent filePath={selectedPath} accountId={accountId} />
				</div>
			</div>
		</WorkspaceFrame>
	);
}

export default function WorkspaceRoute() {
	return <WorkspaceWorkspace />;
}
