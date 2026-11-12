import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { EnvelopeIcon } from "@phosphor-icons/react/Envelope";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { StarIcon } from "@phosphor-icons/react/Star";
import { CheckSquareIcon } from "@phosphor-icons/react/CheckSquare";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { useState } from "react";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import { NavLink as RouterNavLink, useLocation } from "react-router";
import { VirtualFolders } from "shared/folders";
import type { Folder } from "~/types";
import type { ListCategory } from "~/queries/listCategories";
import type { UserTag } from "~/queries/userTags";
import { mailCategoryLabel } from "~/lib/mail-categories";

function countBadge(count: number | undefined, active: boolean) {
	if (!count) return null;
	return (
		<span
			className={`min-w-7 text-right text-caption font-medium tabular-nums ${
				active ? "text-coral" : "text-ink-3"
			}`}
		>
			{count}
		</span>
	);
}
function SecondaryLink({
	to,
	icon,
	label,
	count,
	dataFolder,
	onNavigate,
	active,
	tone = "default",
}: {
	to: string;
	icon: React.ReactNode;
	label: string;
	count?: number;
	dataFolder: string;
	onNavigate: () => void;
	active: boolean;
	tone?: "default" | "system" | "user";
}) {
	const activeTone = tone === "user" ? "text-blue" : "text-coral";
	const iconTone = tone === "user" ? "text-blue" : tone === "system" ? "text-coral" : "text-ink-3";
	return (
		<RouterNavLink
			to={to}
			onClick={onNavigate}
			data-folder={dataFolder}
			title={label}
			className={() =>
				`grid h-10 grid-cols-[20px_20px_minmax(0,1fr)_auto] items-center rounded-md px-1.5 text-control transition-colors ${
					active
						? activeTone
						: "text-ink-3 hover:bg-sidebar-hover hover:text-ink-2"
				}`
			}
		>
			{() => (
				<>
					<span aria-hidden className="flex h-full items-center justify-center">
						<span
							className={`rounded-full transition-all ${
								"h-3.5 w-px bg-edge-3"
							}`}
						/>
					</span>
					<span
						className={`flex items-center justify-center ${active ? iconTone : tone === "default" ? "text-ink-3" : iconTone}`}
					>
						{icon}
					</span>
					<span className="truncate px-1.5">{label}</span>
					{countBadge(count, active)}
				</>
			)}
		</RouterNavLink>
	);
}

function GroupHeading({
	label,
	expanded,
	onToggle,
	controls,
	testId,
	icon,
	tone = "default",
}: {
	label: string;
	expanded: boolean;
	onToggle: () => void;
	controls: string;
	testId: string;
	icon: React.ReactNode;
	tone?: "default" | "system" | "user";
}) {
	const iconTone = tone === "system"
		? "text-coral"
		: tone === "user"
			? "text-blue"
			: "text-ink-3";
	return (
		<button
			type="button"
			onClick={onToggle}
			className="grid h-10 w-full grid-cols-[20px_20px_minmax(0,1fr)_16px] items-center rounded-md px-1.5 text-control font-semibold text-ink-3 transition-colors hover:bg-sidebar-hover hover:text-ink-2"
			aria-expanded={expanded}
			aria-controls={controls}
			aria-label={`${expanded ? "收起" : "展开"}${label}`}
			data-testid={testId}
		>
			<span aria-hidden />
			<span className={`flex items-center justify-center ${iconTone}`}>{icon}</span>
			<span className="truncate px-1.5 text-left">{label}</span>
			<span className="flex items-center justify-center text-ink-3">
				<CaretRightIcon
					size={10}
					weight="bold"
					className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
				/>
			</span>
		</button>
	);
}

export function MailboxNavigationGroup({
	expanded,
	onExpandedChange,
	categories,
	smartTags,
	customFolders,
	onNavigate,
	onCreateSmartTag,
	onManageSmartTag,
}: {
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	categories: ListCategory[];
	smartTags: UserTag[];
	customFolders: Folder[];
	onNavigate: () => void;
	onCreateSmartTag: () => void;
	onManageSmartTag: (tag: UserTag) => void;
}) {
	const location = useLocation();
	const [systemExpanded, setSystemExpanded] = useState(true);
	const [smartTagsExpanded, setSmartTagsExpanded] = useState(true);
	const [mailboxFoldersExpanded, setMailboxFoldersExpanded] = useState(true);
	const searchParams = new URLSearchParams(location.search);
	const allMailPath = `/folder/${VirtualFolders.ALL_MAIL}`;
	const isAllMailPath = location.pathname === allMailPath;
	const activeCategory = isAllMailPath ? searchParams.get("category") : null;
	const allMailActive = isAllMailPath && !activeCategory && !searchParams.get("tag");
	// P2.6: the invoice system category is an edition module capability; the
	// open edition hides the entry even when legacy rows carry the category.
	const { allowanceInvoice } = useEditionFeatures();
	const systemOrder = ["important", "action_required", ...(allowanceInvoice ? ["invoice"] : [])];
	const visibleCategories = systemOrder
		.map((id) => categories.find((category) => category.system && category.id === id))
		.filter((category): category is ListCategory => Boolean(category));
	const systemIcon = (id: string) => id === "important"
		? <StarIcon size={14} weight="regular" />
		: id === "action_required"
			? <CheckSquareIcon size={14} weight="regular" />
			: <FileTextIcon size={14} weight="regular" />;

	return (
		<div className="space-y-0.5" data-testid="all-mail-navigation-group">
			<div
				className={`group/all-mail relative flex h-10 w-full items-center rounded-md text-ui transition-colors ${
					allMailActive
						? "text-coral"
						: "text-ink-2 hover:bg-sidebar-hover hover:text-ink"
				}`}
			>
				{allMailActive ? (
					<span
						aria-hidden
						className="absolute left-0.5 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-coral"
					/>
				) : null}
				<RouterNavLink
					to={`/folder/${VirtualFolders.ALL_MAIL}`}
					onClick={onNavigate}
					data-folder={VirtualFolders.ALL_MAIL}
					className="relative flex h-full min-w-0 flex-1 items-center gap-2.5 pl-3.5 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				>
					<EnvelopeIcon size={17} weight="regular" />
					<span className="truncate px-1.5">所有邮件</span>
				</RouterNavLink>
				<button
					type="button"
					onClick={() => onExpandedChange(!expanded)}
					className="mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-transparent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					aria-label={`${expanded ? "收起" : "展开"}所有邮件分类`}
					aria-expanded={expanded}
					data-testid="all-mail-toggle"
				>
					<CaretRightIcon
						size={11}
						weight="bold"
						className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
					/>
				</button>
			</div>

			{expanded ? (
				<div className="space-y-0.5" data-testid="all-mail-children">
					<GroupHeading
						label="智能分类"
						expanded={systemExpanded}
						onToggle={() => setSystemExpanded((value) => !value)}
						controls="system-classification-items"
						testId="system-classification-heading"
						icon={<StarIcon size={12} weight="fill" />}
						tone="system"
					/>
					{systemExpanded ? (
						<div id="system-classification-items" className="space-y-0.5" data-testid="system-classification-items">
							{visibleCategories.map((category) => (
								<SecondaryLink
									key={`category-${category.id}`}
									to={`/folder/${VirtualFolders.ALL_MAIL}?category=${encodeURIComponent(category.id)}`}
									icon={systemIcon(category.id)}
									label={mailCategoryLabel(category.id, category.label)}
									count={category.unreadCount}
									dataFolder={`category:${category.id}`}
									onNavigate={onNavigate}
									active={activeCategory === category.id}
									tone="system"
								/>
							))}
						</div>
					) : null}

					<GroupHeading
						label="我的智能标签"
						expanded={smartTagsExpanded}
						onToggle={() => setSmartTagsExpanded((value) => !value)}
						controls="user-smart-tags-items"
						testId="user-smart-tags-heading"
						icon={<TagIcon size={12} weight="fill" />}
						tone="user"
					/>
					{smartTagsExpanded ? (
						<div id="user-smart-tags-items" className="space-y-0.5" data-testid="user-smart-tags-items">
							{smartTags.map((tag) => (
								<div key={tag.id} className="group relative">
									<SecondaryLink
										to={`/smart-tags/${encodeURIComponent(tag.id)}`}
										icon={<TagIcon size={14} weight="regular" />}
										label={tag.name}
										count={tag.count}
										dataFolder={`smart-tag:${tag.id}`}
										onNavigate={onNavigate}
										active={location.pathname === `/smart-tags/${encodeURIComponent(tag.id)}`}
										tone="user"
									/>
									<button
										type="button"
										onClick={() => onManageSmartTag(tag)}
										className="absolute right-0 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 opacity-0 transition-opacity hover:bg-sidebar-hover hover:text-ink group-hover:opacity-100 focus:opacity-100 motion-reduce:transition-none"
										aria-label={`管理智能标签 ${tag.name}`}
									>
										<span aria-hidden className="text-base leading-none">···</span>
									</button>
								</div>
							))}

							<button
								type="button"
								onClick={onCreateSmartTag}
								className="grid h-10 w-full grid-cols-[20px_20px_minmax(0,1fr)] items-center rounded-md px-1.5 text-control text-ink-3 transition-colors hover:bg-sidebar-hover hover:text-ink-2"
								data-testid="sidebar-create-smart-label-row"
							>
								<span aria-hidden className="flex h-full items-center justify-center">
									<span className="h-3.5 w-px rounded-full bg-edge-3" />
								</span>
								<PlusIcon size={14} />
								<span className="truncate px-1.5 text-left">创建智能标签</span>
							</button>
						</div>
					) : null}

					<GroupHeading
						label="邮箱文件夹"
						expanded={mailboxFoldersExpanded}
						onToggle={() => setMailboxFoldersExpanded((value) => !value)}
						controls="mailbox-folder-items"
						testId="mailbox-folders-heading"
						icon={<FolderIcon size={12} weight="fill" />}
					/>
					{mailboxFoldersExpanded ? (
						<div id="mailbox-folder-items" className="space-y-0.5" data-testid="mailbox-folder-items">
							{customFolders.map((folder) => (
								<SecondaryLink
									key={folder.id}
									to={`/folder/${encodeURIComponent(folder.id)}`}
									icon={<FolderIcon size={14} weight="regular" />}
									label={folder.name}
									count={folder.unreadCount}
									dataFolder={folder.id}
									onNavigate={onNavigate}
									active={location.pathname === `/folder/${encodeURIComponent(folder.id)}`}
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
