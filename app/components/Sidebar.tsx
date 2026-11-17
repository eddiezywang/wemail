import { CheckSquareIcon } from "@phosphor-icons/react/CheckSquare";
import { FileIcon } from "@phosphor-icons/react/File";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { StarIcon } from "@phosphor-icons/react/Star";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { TrayIcon } from "@phosphor-icons/react/Tray";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { EnvelopeIcon } from "@phosphor-icons/react/Envelope";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { SidebarSimpleIcon } from "@phosphor-icons/react/SidebarSimple";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS, VirtualFolders } from "shared/folders";
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
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
	[Folders.SPAM]: <WarningIcon size={18} weight="regular" />,
};

const MAILBOX_FOLDERS = [
	{ id: Folders.DRAFT, label: "草稿" },
	{ id: Folders.SENT, label: "已发送" },
	{ id: Folders.SPAM, label: "垃圾邮件" },
	{ id: Folders.TRASH, label: "回收站" },
];

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
					!(SYSTEM_FOLDER_IDS as readonly string[]).includes(
						folder.id.toLowerCase(),
					),
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
		integrationStatus?.entries.filter((entry) => entry.state === "connected") ?? [];
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
			<PencilSimpleIcon
				size={16}
				weight="regular"
				className="shrink-0 text-ink-2 group-hover:text-ink"
			/>
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

				<nav className="space-y-0.5 px-2">
					<NavLink
						to="/"
						end
						icon={FOLDER_ICON_MAP[Folders.INBOX]}
						label="收件箱"
						count={getFolderUnreadCount(Folders.INBOX)}
						title={getFolderTitle(Folders.INBOX, "收件箱")}
						onClick={handleNavClick}
						data-folder={Folders.INBOX}
						compact={compact}
					/>
					<NavLink
						to="/todos"
						icon={<CheckSquareIcon size={18} weight="regular" />}
						label="待办"
						onClick={handleNavClick}
						data-folder={VirtualFolders.TODOS}
						compact={compact}
					/>
					<NavLink
						to="/notifications"
						icon={<BellIcon size={18} weight="regular" />}
						label="应用消息"
						count={applicationMessageUnread}
						onClick={handleNavClick}
						data-folder="application-messages"
						compact={compact}
					/>
					<NavLink
						to="/automation"
						icon={<LightningIcon size={18} weight="regular" />}
						label="自动化"
						onClick={handleNavClick}
						data-folder="automation"
						compact={compact}
					/>
					{features.enterpriseDirectory && (
						<NavLink
							to="/directory"
							icon={<UsersThreeIcon size={18} weight="regular" />}
							label="通讯录"
							onClick={handleNavClick}
							data-folder="directory"
							compact={compact}
						/>
					)}
				</nav>

				<nav className={`${compact ? "mt-2" : "mt-3"} min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2`}>
					{compact ? (
						<NavLink
							to={`/folder/${VirtualFolders.ALL_MAIL}`}
							icon={<EnvelopeIcon size={18} weight="regular" />}
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
							customFolders={customFolders}
							onNavigate={handleNavClick}
							onCreateSmartTag={openCreateTagDialog}
							onManageSmartTag={setEditingSmartTag}
						/>
					)}
					<div className="pt-1.5">
						<NavLink
							to={`/folder/${VirtualFolders.STARRED}`}
							icon={<StarIcon size={18} weight="regular" />}
							label="已加星标"
							onClick={handleNavClick}
							data-folder={VirtualFolders.STARRED}
							compact={compact}
						/>
						<NavLink
							to="/local-drafts"
							icon={<FileIcon size={18} weight="regular" />}
							label="本地草稿"
							onClick={handleNavClick}
							compact={compact}
						/>
						<NavLink
							to="/scheduled"
							icon={<TimerIcon size={18} weight="regular" />}
							label={uncertainSendCount > 0 ? "发送待确认" : "发件队列"}
							count={uncertainSendCount || scheduledCount}
							onClick={handleNavClick}
							data-folder={VirtualFolders.SCHEDULED}
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
					</div>
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
									<GearSixIcon size={19} weight="regular" />
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
								<SidebarSimpleIcon
									size={17}
									weight="regular"
									className={`transition-transform duration-150 ${compact ? "rotate-180" : ""}`}
								/>
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
