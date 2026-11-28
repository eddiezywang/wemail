import { CaretRight } from "reicon/icons/CaretRight";
import { CheckSquare } from "reicon/icons/CheckSquare";
import { Envelope } from "reicon/icons/Envelope";
import { FileText } from "reicon/icons/FileText";
import { Plus } from "reicon/icons/Plus";
import { Star } from "reicon/icons/Star";
import { Tag } from "reicon/icons/Tag";
import { Reicon } from "~/components/ui/reicon";
import { useState } from "react";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import { NavLink as RouterNavLink, useLocation } from "react-router";
import { VirtualFolders } from "shared/folders";
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

/**
 * Phase-1 flattened "智能视图" group: the All Mail row plus its system
 * categories and user smart tags as direct children. The former
 * 智能分类 / 我的智能标签 / 邮箱文件夹 sub-group headings are gone —
 * mailbox folders live in the Sidebar's「邮箱」group instead.
 */
export function MailboxNavigationGroup({
	expanded,
	onExpandedChange,
	categories,
	smartTags,
	onNavigate,
	onCreateSmartTag,
	onManageSmartTag,
}: {
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	categories: ListCategory[];
	smartTags: UserTag[];
	onNavigate: () => void;
	onCreateSmartTag: () => void;
	onManageSmartTag: (tag: UserTag) => void;
}) {
	const location = useLocation();
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
		? <Reicon icon={Star} size={14} />
		: id === "action_required"
			? <Reicon icon={CheckSquare} size={14} />
			: <Reicon icon={FileText} size={14} />;

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
					<Reicon icon={Envelope} size={16} />
					<span className="truncate px-1.5">所有邮件</span>
				</RouterNavLink>
				<button
					type="button"
					onClick={() => onExpandedChange(!expanded)}
					className="mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-transparent hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					aria-label={`${expanded ? "收起" : "展开"}所有邮件分类`}
					aria-expanded={expanded}
					data-testid="all-mail-toggle"
				>
					<Reicon
						icon={CaretRight}
						size={11}
						strokeWidth={2.5}
						className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
					/>
				</button>
			</div>

			{expanded ? (
				<div className="space-y-0.5" data-testid="all-mail-children">
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

					{smartTags.map((tag) => (
						<div key={tag.id} className="group relative">
							<SecondaryLink
								to={`/smart-tags/${encodeURIComponent(tag.id)}`}
								icon={<Reicon icon={Tag} size={14} />}
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
						<Reicon icon={Plus} size={14} />
						<span className="truncate px-1.5 text-left">创建智能标签</span>
					</button>
				</div>
			) : null}
		</div>
	);
}
