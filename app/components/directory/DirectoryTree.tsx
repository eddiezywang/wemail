import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { SpinnerGapIcon } from "@phosphor-icons/react/SpinnerGap";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DirectoryDepartment } from "../../../shared/wemail/directory";
import { cn } from "~/lib/cn";
import api from "~/services/api";

interface DirectoryTreeProps {
	selectedDepartmentId?: string;
	onSelect: (department?: DirectoryDepartment) => void;
}

export function DirectoryTree({
	selectedDepartmentId,
	onSelect,
}: DirectoryTreeProps) {
	const roots = useQuery({
		queryKey: ["directory", "departments", { parentId: null }],
		queryFn: () => api.listDirectoryDepartments(),
	});
	const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
	const initialized = useRef(false);

	useEffect(() => {
		if (initialized.current || !roots.data?.departments.length) return;
		initialized.current = true;
		setExpandedIds(
			new Set(
				roots.data.departments
					.filter((department) => department.childCount > 0)
					.map((department) => department.id),
			),
		);
	}, [roots.data?.departments]);

	const toggleExpanded = (id: string) => {
		setExpandedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<aside className="flex h-full w-64 shrink-0 flex-col border-r border-edge bg-paper-2/35">
			<div className="border-b border-edge px-3 py-3">
				<div className="flex items-center gap-2 text-xs font-semibold text-ink-2">
					<BuildingsIcon size={15} className="text-coral" />
					组织通讯录
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				<TreeButton
					label="全部同事"
					selected={!selectedDepartmentId}
					onClick={() => onSelect(undefined)}
					icon={<UsersThreeIcon size={15} />}
				/>

				{roots.isLoading ? (
					<div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-3">
						<SpinnerGapIcon size={14} className="animate-spin motion-reduce:animate-none" />
						正在读取组织架构…
					</div>
				) : roots.isError ? (
					<div className="px-3 py-3 text-xs text-red">
						<div>组织架构读取失败</div>
						<button
							type="button"
							onClick={() => void roots.refetch()}
							className="mt-2 text-coral hover:underline"
						>
							重试
						</button>
					</div>
				) : roots.data?.departments.length ? (
					<div className="mt-1 space-y-0.5">
						{roots.data.departments.map((department) => (
							<DirectoryTreeNode
								key={department.id}
								department={department}
								depth={0}
								selectedDepartmentId={selectedDepartmentId}
								expandedIds={expandedIds}
								onSelect={onSelect}
								onToggle={toggleExpanded}
							/>
						))}
					</div>
				) : (
					<div className="px-3 py-4 text-xs leading-5 text-ink-3">
						尚未同步到组织架构。
					</div>
				)}
			</div>
		</aside>
	);
}

interface DirectoryTreeNodeProps {
	department: DirectoryDepartment;
	depth: number;
	selectedDepartmentId?: string;
	expandedIds: Set<string>;
	onSelect: (department: DirectoryDepartment) => void;
	onToggle: (id: string) => void;
}

function DirectoryTreeNode({
	department,
	depth,
	selectedDepartmentId,
	expandedIds,
	onSelect,
	onToggle,
}: DirectoryTreeNodeProps) {
	const hasChildren = department.childCount > 0;
	const expanded = hasChildren && expandedIds.has(department.id);
	const children = useQuery({
		queryKey: ["directory", "departments", { parentId: department.id }],
		queryFn: () => api.listDirectoryDepartments(department.id),
		enabled: expanded,
		staleTime: 5 * 60_000,
	});

	return (
		<div>
			<div
				className={cn(
					"group flex h-8 items-center rounded-md text-xs transition-colors",
					selectedDepartmentId === department.id
						? "bg-coral/10 text-coral"
						: "text-ink-2 hover:bg-paper-3 hover:text-ink",
				)}
				style={{ paddingLeft: `${6 + depth * 16}px` }}
				title={department.path}
			>
				<button
					type="button"
					onClick={() => hasChildren && onToggle(department.id)}
					className={cn(
						"mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
						hasChildren ? "hover:bg-black/5" : "cursor-default",
					)}
					aria-label={
						hasChildren
							? `${expanded ? "收起" : "展开"}${department.name}`
							: undefined
					}
					tabIndex={hasChildren ? 0 : -1}
				>
					{hasChildren ? (
						<CaretRightIcon
							size={13}
							className={cn(
								"transition-transform duration-150",
								expanded && "rotate-90",
							)}
						/>
					) : (
						<span className="h-1 w-1 rounded-full bg-ink-3/45" />
					)}
				</button>
				<button
					type="button"
					onClick={() => onSelect(department)}
					className="min-w-0 flex-1 truncate pr-2 text-left"
				>
					{department.name}
				</button>
			</div>

			{expanded ? (
				<div>
					{children.isLoading ? (
						<div
							className="flex h-9 items-center gap-2 text-xs text-ink-3"
							style={{ paddingLeft: `${34 + depth * 16}px` }}
						>
							<SpinnerGapIcon size={12} className="animate-spin motion-reduce:animate-none" />
							加载中…
						</div>
					) : children.isError ? (
						<button
							type="button"
							onClick={() => void children.refetch()}
							className="h-9 text-xs text-red hover:underline"
							style={{ paddingLeft: `${34 + depth * 16}px` }}
						>
							加载失败，点击重试
						</button>
					) : (
						children.data?.departments.map((child) => (
							<DirectoryTreeNode
								key={child.id}
								department={child}
								depth={depth + 1}
								selectedDepartmentId={selectedDepartmentId}
								expandedIds={expandedIds}
								onSelect={onSelect}
								onToggle={onToggle}
							/>
						))
					)}
				</div>
			) : null}
		</div>
	);
}

function TreeButton({
	label,
	selected,
	onClick,
	icon,
}: {
	label: string;
	selected: boolean;
	onClick: () => void;
	icon: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs transition-colors",
				selected
					? "bg-coral/10 font-medium text-coral"
					: "text-ink-2 hover:bg-paper-3 hover:text-ink",
			)}
		>
			{icon}
			<span className="truncate">{label}</span>
		</button>
	);
}
