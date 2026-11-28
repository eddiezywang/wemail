import { Bolt } from "reicon/icons/Bolt";
import { Bell } from "reicon/icons/Bell";
import { CheckSquare } from "reicon/icons/CheckSquare";
import { Envelope } from "reicon/icons/Envelope";
import { File } from "reicon/icons/File";
import { Folder } from "reicon/icons/Folder";
import { Gear } from "reicon/icons/Gear";
import { Inbox } from "reicon/icons/Inbox";
import { PaperPlane } from "reicon/icons/PaperPlane";
import { Pen } from "reicon/icons/Pen";
import { Sidebar as SidebarGlyph } from "reicon/icons/Sidebar";
import { Star } from "reicon/icons/Star";
import { Timer } from "reicon/icons/Timer";
import { Trash } from "reicon/icons/Trash";
import { Users } from "reicon/icons/Users";
import { AlertTriangle } from "reicon/icons/AlertTriangle";
import { Reicon } from "~/components/ui/reicon";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Folders, FOLDER_DISPLAY_NAMES, isSentFolder, SYSTEM_FOLDER_IDS, VirtualFolders } from "shared/folders";
import { MailboxNavigationGroup } from "~/components/sidebar/MailboxNavigationGroup";
import {
	Tooltip,
	TooltipContent,
	TooltipPortal,
	TooltipProvider,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import { CreateSmartTagDialog } from "~/components/wemail/CreateSmartTagDialog";
import { ManageSmartTagDialog } from "~/components/wemail/ManageSmartTagDialog";
import { NavLink } from "~/components/wemail/NavLink";
import { useMailboxNavigationState } from "~/hooks/useMailboxNavigationState";
import { useUIStore } from "~/hooks/useUIStore";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useFolders } from "~/queries/folders";
import { useListCategories } from "~/queries/listCategories";
import { useMailbox } from "~/queries/mailboxes";
import { useScheduledDrafts } from "~/queries/scheduledDrafts";
import { useUserTags, type UserTag } from "~/queries/userTags";
import { useApplicationMessages } from "~/queries/applicationMessages";
import { useIntegrationStatus } from "~/queries/integrationStatus";
import { useWorkbenchNavigation } from "~/components/layout/Workbench";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";

const FOLDER_ICON_MAP: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <Reicon icon={Inbox} size={16} />,
	[Folders.SENT]: <Reicon icon={PaperPlane} size={16} />,
	[Folders.DRAFT]: <Reicon icon={File} size={16} />,
	[Folders.TRASH]: <Reicon icon={Trash} size={16} />,
	[Folders.SPAM]: <Reicon icon={AlertTriangle} size={16} />,
};

const MAILBOX_FOLDERS = [
	{ id: Folders.SENT, label: FOLDER_DISPLAY_NAMES[Folders.SENT] },
	{ id: Folders.DRAFT, label: FOLDER_DISPLAY_NAMES[Folders.DRAFT] },
];

/** Small section label for the Phase-1 sidebar groups (处理/智能视图/邮箱). */
function NavGroupLabel({ label, compact }: { label: string; compact: boolean }) {
	if (compact) return null;
	return (
		<div
			className="px-2 pb-1 pt-3 text-caption font-semibold uppercase tracking-wider text-ink-4"
			aria-hidden="true"
		>
			{label}
		</div>
	);
}

export default function Sidebar({ compact: compactOverride }: { compact?: boolean } = {}) {
	const navigate = useNavigate();
	const location = useLocation();
	const {
		collapsed: workbenchNavigationCollapsed,
		toggle: toggleWorkbenchNavigation,
	} = useWorkbenchNavigation();
	const compact = compactOverride ?? workbenchNavigationCollapsed;
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: categories = [] } = useListCategories(mailboxId);
	const { data: smartTags = [] } = useUserTags(mailboxId);
	const { data: currentMailbox } = useMailbox(mailboxId);
	const { data: scheduledData } = useScheduledDrafts(mailboxId);
	const { data: applicationMessages } = useApplicationMessages(mailboxId);
	const { data: integrationStatus } = useIntegrationStatus();
	const features = useEditionFeatures();
	const { expanded, setExpanded } = useMailboxNavigationState(mailboxId);
	const [editingSmartTag, setEditingSmartTag] = useState<UserTag | null>(null);
	const startCompose = useUIStore((state) => state.startCompose);
	const closeSidebar = useUIStore((state) => state.closeSidebar);
	const openSettings = useUIStore((state) => state.openSettings);
	const isCreateTagDialogOpen = useUIStore((state) => state.isCreateTagDialogOpen);
	const openCreateTagDialog = useUIStore((state) => state.openCreateTagDialog);
	const closeCreateTagDialog = useUIStore((state) => state.closeCreateTagDialog);

	const customFolders = useMemo(
		() =>
			folders.filter(
				(folder) =>
					// Phase-1 dedupe: provider folders that mirror a local system
					// folder (the provider's own「已发送」is the common case) must
					// not surface as a second sidebar entry.
					!(SYSTEM_FOLDER_IDS as readonly string[]).includes(
						folder.id.toLowerCase(),
					) &&
					!isSentFolder(folder.id) &&
					!isSentFolder(folder.name),
			),
		[folders],
	);
	const getFolder = (folderId: string) =>
		folders.find((folder) => folder.id.toLowerCase() === folderId.toLowerCase());
	const getFolderUnreadCount = (folderId: string) =>
		getFolder(folderId)?.unreadCount ?? 0;
	const getFolderTitle = (folderId: string, label: string) => {
		const folder = getFolder(folderId);
		if (!folder) return label;
		return `${label} · ${folder.unreadCount ?? 0} 未读 · 共 ${folder.totalCount ?? folder.unreadCount ?? 0} 封`;
	};

	const displayName =
		currentMailbox?.settings?.fromName ||
		currentMailbox?.name ||
		currentMailbox?.email?.split("@")[0] ||
		"You";
	const scheduledCount = (scheduledData?.scheduled ?? []).filter(
		(draft) => draft.status === "pending",
	).length;
	const uncertainSendCount = (scheduledData?.scheduled ?? []).filter(
		(draft) => draft.status === "failed" || draft.status === "partial",
	).length;
	const applicationMessageUnread = applicationMessages?.unread ?? 0;
	const connectedIntegrations =
		integrationStatus?.entries?.filter((entry) => entry.state === "connected") ?? [];
	const handleNavClick = () => closeSidebar();
	const handleSmartTagCreated = (tag: UserTag) => {
		navigate(`/smart-tags/${encodeURIComponent(tag.id)}`);
		closeSidebar();
	};
	const handleSmartTagDeleted = (tag: UserTag) => {
		if (location.pathname === `/smart-tags/${encodeURIComponent(tag.id)}`) {
			navigate("/");
		}
	};
	const composeButton = (
		<button
			type="button"
			onClick={() => startCompose()}
			className={`group flex w-full items-center rounded-md py-2 text-ui font-semibold text-ink transition-colors hover:bg-paper-4 ${
				compact ? "justify-center px-0" : "gap-2.5 px-2.5"
			}`}
			aria-label="写邮件"
			data-testid="compose-button"
		>
			<Reicon icon={Pen} size={16} className="shrink-0 text-ink-2 group-hover:text-ink" />
			<span className={compact ? "sr-only" : "truncate"}>写邮件</span>
		</button>
	);

	return (
		<TooltipProvider>
			<aside
				className="flex h-full w-full shrink-0 flex-col overflow-hidden bg-sidebar"
				data-compact={compact ? "true" : "false"}
				data-testid="mail-sidebar"
			>
				<div className={compact ? "px-2 pb-2 pt-3" : "px-3 pb-2 pt-3"}>
					{compact ? (
						<Tooltip>
							<TooltipTrigger asChild>{composeButton}</TooltipTrigger>
							<TooltipPortal>
								<TooltipContent side="right">写邮件</TooltipContent>
							</TooltipPortal>
						</Tooltip>
					) : composeButton}
				</div>

				<nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
				<NavGroupLabel label="处理" compact={compact} />
					<NavLink
						to="/"
						end
						icon={FOLDER_ICON_MAP[Folders.INBOX]}
						label={FOLDER_DISPLAY_NAMES[Folders.INBOX]}
						count={getFolderUnreadCount(Folders.INBOX)}
						title={getFolderTitle(Folders.INBOX, FOLDER_DISPLAY_NAMES[Folders.INBOX])}
						onClick={handleNavClick}
						data-folder={Folders.INBOX}
						compact={compact}
					/>
					<NavLink
						to="/todos"
						icon={<Reicon icon={CheckSquare} size={16} />}
						label="待办"
						onClick={handleNavClick}
						data-folder={VirtualFolders.TODOS}
						compact={compact}
					/>
					<NavLink
						to="/notifications"
						icon={<Reicon icon={Bell} size={16} />}
						label="应用消息"
						count={applicationMessageUnread}
						onClick={handleNavClick}
						data-folder="application-messages"
						compact={compact}
					/>
					<NavLink
						to="/automation"
						icon={<Reicon icon={Bolt} size={16} />}
						label="自动化"
						onClick={handleNavClick}
						data-folder="automation"
						compact={compact}
					/>
					{features.enterpriseDirectory && (
						<NavLink
							to="/directory"
							icon={<Reicon icon={Users} size={16} />}
							label="通讯录"
							onClick={handleNavClick}
							data-folder="directory"
							compact={compact}
						/>
					)}

				<NavGroupLabel label="智能视图" compact={compact} />
					{compact ? (
						<NavLink
							to={`/folder/${VirtualFolders.ALL_MAIL}`}
							icon={<Reicon icon={Envelope} size={16} />}
							label="所有邮件"
							onClick={handleNavClick}
							data-folder={VirtualFolders.ALL_MAIL}
							compact
						/>
					) : (
						<MailboxNavigationGroup
							expanded={expanded}
							onExpandedChange={setExpanded}
							categories={categories}
							smartTags={smartTags}
							onNavigate={handleNavClick}
							onCreateSmartTag={openCreateTagDialog}
							onManageSmartTag={setEditingSmartTag}
						/>
					)}
					<NavLink
						to={`/folder/${VirtualFolders.STARRED}`}
						icon={<Reicon icon={Star} size={16} />}
						label="已加星标"
						onClick={handleNavClick}
						data-folder={VirtualFolders.STARRED}
						compact={compact}
					/>

				<NavGroupLabel label="邮箱" compact={compact} />
					<NavLink
						to="/scheduled"
						icon={<Reicon icon={Timer} size={16} />}
						label={uncertainSendCount > 0 ? "发送待确认" : "发件队列"}
						count={uncertainSendCount || scheduledCount}
						onClick={handleNavClick}
						data-folder={VirtualFolders.SCHEDULED}
						compact={compact}
					/>
					<NavLink
						to="/local-drafts"
						icon={<Reicon icon={File} size={16} />}
						label="本地草稿"
						onClick={handleNavClick}
						compact={compact}
					/>
					{MAILBOX_FOLDERS.map((folder) => (
						<NavLink
							key={folder.id}
							to={`/folder/${encodeURIComponent(folder.id)}`}
							icon={FOLDER_ICON_MAP[folder.id]}
							label={folder.label}
							count={getFolderUnreadCount(folder.id)}
							title={getFolderTitle(folder.id, folder.label)}
							onClick={handleNavClick}
							data-folder={folder.id}
							compact={compact}
						/>
					))}
					{customFolders.map((folder) => (
						<NavLink
							key={folder.id}
							to={`/folder/${encodeURIComponent(folder.id)}`}
							icon={<Reicon icon={Folder} size={16} />}
							label={folder.name}
							count={getFolderUnreadCount(folder.id)}
							title={getFolderTitle(folder.name, folder.name)}
							onClick={handleNavClick}
							data-folder={folder.id}
							compact={compact}
						/>
					))}
					<NavLink
						to={`/folder/${encodeURIComponent(Folders.SPAM)}`}
						icon={FOLDER_ICON_MAP[Folders.SPAM]}
						label={FOLDER_DISPLAY_NAMES[Folders.SPAM]}
						count={getFolderUnreadCount(Folders.SPAM)}
						title={getFolderTitle(Folders.SPAM, FOLDER_DISPLAY_NAMES[Folders.SPAM])}
						onClick={handleNavClick}
						data-folder={Folders.SPAM}
						compact={compact}
					/>
					<NavLink
						to={`/folder/${encodeURIComponent(Folders.TRASH)}`}
						icon={FOLDER_ICON_MAP[Folders.TRASH]}
						label={FOLDER_DISPLAY_NAMES[Folders.TRASH]}
						count={getFolderUnreadCount(Folders.TRASH)}
						title={getFolderTitle(Folders.TRASH, FOLDER_DISPLAY_NAMES[Folders.TRASH])}
						onClick={handleNavClick}
						data-folder={Folders.TRASH}
						compact={compact}
					/>
				</nav>

				{!compact && connectedIntegrations.length > 0 && (
					<div
						className="border-t border-edge px-2 py-2"
						data-testid="sidebar-connected-integrations"
					>
						<button
							type="button"
							onClick={() => openSettings("connections")}
							className="mb-1 w-full px-1.5 text-left text-caption font-semibold uppercase tracking-wider text-ink-4 hover:text-ink"
						>
							已连接
						</button>
						<div className="space-y-0.5">
							{connectedIntegrations.map((entry) => (
								<button
									key={entry.id}
									type="button"
									onClick={() => openSettings("connections", entry.id)}
									className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-meta text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink"
									aria-label={`${entry.label} 已连接`}
								>
									<span
										className="h-1.5 w-1.5 rounded-full bg-green"
										aria-hidden="true"
									/>
									<span>{entry.label}</span>
								</button>
							))}
						</div>
					</div>
				)}

				<div className={`border-t border-edge p-2 ${compact ? "flex flex-col items-center gap-1" : "flex items-center gap-1"}`}>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => openSettings()}
								className={`group flex min-w-0 items-center rounded-md py-1 text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink ${compact ? "h-9 w-9 justify-center px-0" : "flex-1 gap-2 px-1.5"}`}
								aria-label={`设置 — ${displayName}`}
								data-testid="sidebar-identity"
							>
								<span className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-ink-3">
									<Reicon icon={Gear} size={16} />
								</span>
								<span className={compact ? "sr-only" : "min-w-0 flex-1 text-left"}>
									<span className="block truncate text-xs font-semibold text-ink">
										{displayName}
									</span>
								</span>
							</button>
						</TooltipTrigger>
						<TooltipPortal>
							<TooltipContent side={compact ? "right" : "top"}>设置</TooltipContent>
						</TooltipPortal>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={toggleWorkbenchNavigation}
								className={`inline-flex shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-4 hover:text-ink ${compact ? "h-9 w-9" : "h-8 w-8"}`}
								aria-label={compact ? "展开导航栏" : "收起导航栏"}
								aria-expanded={!compact}
								data-testid="sidebar-collapse-toggle"
							>
								<Reicon icon={SidebarGlyph} size={16} className={`transition-transform duration-150 ${compact ? "rotate-180" : ""}`} />
							</button>
						</TooltipTrigger>
						<TooltipPortal>
							<TooltipContent side={compact ? "right" : "top"}>
								{compact ? "展开导航栏" : "收起导航栏"}
							</TooltipContent>
						</TooltipPortal>
					</Tooltip>
				</div>

				<CreateSmartTagDialog
					open={isCreateTagDialogOpen}
					onOpenChange={(next) =>
						next ? openCreateTagDialog() : closeCreateTagDialog()
					}
					accountId={mailboxId}
					onCreated={handleSmartTagCreated}
				/>
				<ManageSmartTagDialog
					open={!!editingSmartTag}
					onOpenChange={(next) => {
						if (!next) setEditingSmartTag(null);
					}}
					accountId={mailboxId}
					tag={editingSmartTag}
					onDeleted={handleSmartTagDeleted}
				/>
			</aside>
		</TooltipProvider>
	);
}
