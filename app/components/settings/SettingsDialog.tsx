import { BrainIcon } from "@phosphor-icons/react/Brain";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PaintBrushIcon } from "@phosphor-icons/react/PaintBrush";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { PuzzlePieceIcon } from "@phosphor-icons/react/PuzzlePiece";
import { UserIcon } from "@phosphor-icons/react/User";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "~/components/ui/dialog";
import { type SettingsSection, useUIStore } from "~/hooks/useUIStore";
import { useCurrentAccount } from "~/queries/currentAccount";
import api from "~/services/api";
import { getUserFacingError } from "~/lib/user-facing-error";

const AboutSection = lazy(() => import("./sections/AboutSection").then((module) => ({ default: module.AboutSection })));
const AccountSection = lazy(() => import("./sections/AccountSection").then((module) => ({ default: module.AccountSection })));
const AdvancedSection = lazy(() => import("./sections/AdvancedSection").then((module) => ({ default: module.AdvancedSection })));
const AiProfileSection = lazy(() => import("./sections/AiProfileSection").then((module) => ({ default: module.AiProfileSection })));
const AppearanceSection = lazy(() => import("./sections/AppearanceSection").then((module) => ({ default: module.AppearanceSection })));
const ConnectionsSection = lazy(() => import("./sections/ConnectionsSection").then((module) => ({ default: module.ConnectionsSection })));
const McpSection = lazy(() => import("./sections/McpSection").then((module) => ({ default: module.McpSection })));
const ModelSection = lazy(() => import("./sections/ModelSection").then((module) => ({ default: module.ModelSection })));
const SkillCenterSection = lazy(() => import("./sections/SkillCenterSection").then((module) => ({ default: module.SkillCenterSection })));

function SettingsSectionFallback() {
	return (
		<div className="flex min-h-48 items-center justify-center" role="status" aria-live="polite">
			<span className="h-7 w-7 animate-spin rounded-full border-2 border-current border-t-transparent text-ink-3 motion-reduce:animate-none" />
			<span className="sr-only">正在加载设置</span>
		</div>
	);
}

interface NavItem {
	id: SettingsSection;
	label: string;
	icon: ReactNode;
	secondary?: boolean;
}

export const SETTINGS_NAV_ITEMS: NavItem[] = [
	{ id: "account", label: "账户", icon: <UserIcon size={16} /> },
	{ id: "ai", label: "个性化", icon: <BrainIcon size={16} /> },
	{ id: "model", label: "AI 模型", icon: <BrainIcon size={16} /> },
	{ id: "mcp", label: "MCP", icon: <PlugsIcon size={16} /> },
	{ id: "connections", label: "连接", icon: <PlugsConnectedIcon size={16} /> },
	{ id: "skills", label: "Skill Center", icon: <PuzzlePieceIcon size={16} /> },
	{ id: "appearance", label: "外观", icon: <PaintBrushIcon size={16} /> },
	{ id: "about", label: "关于", icon: <InfoIcon size={16} /> },
	{
		id: "advanced",
		label: "高级设置",
		icon: <SlidersHorizontalIcon size={16} />,
		secondary: true,
	},
];

export default function SettingsDialog() {
	const isSettingsOpen = useUIStore((state) => state.isSettingsOpen);
	const settingsSection = useUIStore((state) => state.settingsSection);
	const settingsConnectionDetail = useUIStore((state) => state.settingsConnectionDetail);
	const closeSettings = useUIStore((state) => state.closeSettings);
	const setSettingsSection = useUIStore((state) => state.setSettingsSection);
	const [confirmMailboxChangeOpen, setConfirmMailboxChangeOpen] = useState(false);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: currentAccount } = useCurrentAccount();
	const account = currentAccount?.account;
	const displayName =
		account?.displayName || account?.emailAddress?.split("@")[0] || "";

	const changeMailbox = useMutation({
		mutationFn: () => api.logoutAccount(),
		onSuccess: async () => {
			if (account?.id) {
				await window.wemailDesktop?.agentDrafts?.clearAccount(account.id).catch(() => undefined);
			}
			queryClient.setQueryData(["account", "current"], { account: null });
			await queryClient.invalidateQueries();
			closeSettings();
			toast.success("已退出当前邮箱连接");
			requestAnimationFrame(() =>
				navigate("/onboarding?chooseProvider=1", { replace: true }),
			);
		},
		onError: (error) =>
			toast.error(getUserFacingError(error, "更换邮箱失败，请稍后重试。")),
	});

	const content = !account ? (
		<div className="flex justify-center py-20">
			<div role="status" aria-live="polite" className="flex items-center gap-3 text-ui text-ink-3">
				<span
					aria-hidden="true"
					className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
				/>
				<span>正在加载设置</span>
			</div>
		</div>
	) : settingsSection === "account" ? (
		<AccountSection
			displayName={displayName}
			email={account.emailAddress}
			currentMailboxId={account.id}
			onChangeMailbox={() => setConfirmMailboxChangeOpen(true)}
			isChangingMailbox={changeMailbox.isPending}
		/>
	) : settingsSection === "ai" ? (
		<AiProfileSection />
	) : settingsSection === "model" ? (
		<ModelSection />
	) : settingsSection === "mcp" ? (
		<McpSection />
	) : settingsSection === "connections" ? (
		<ConnectionsSection initialSelected={settingsConnectionDetail} />
	) : settingsSection === "skills" ? (
		<SkillCenterSection />
	) : settingsSection === "appearance" ? (
		<AppearanceSection />
	) : settingsSection === "about" ? (
		<AboutSection />
	) : (
		<AdvancedSection />
	);

	return (
		<>
			<Dialog
				open={isSettingsOpen}
				onOpenChange={(open) => {
					if (!open) {
						setConfirmMailboxChangeOpen(false);
						closeSettings();
					}
				}}
			>
				<DialogContent
					data-testid="settings-dialog"
					className="grid min-h-0 h-[86vh] max-h-[680px] w-[94vw] max-w-[960px] grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[78vh] sm:grid-cols-[200px_minmax(0,1fr)] sm:grid-rows-1"
				>
					<DialogTitle className="sr-only">设置</DialogTitle>
					<DialogDescription className="sr-only">
						管理账户、个性化、AI 模型、MCP 和应用设置。
					</DialogDescription>
					<aside className="min-h-0 max-h-40 overflow-y-auto border-b border-edge bg-paper-2 px-2 py-3 sm:h-full sm:max-h-none sm:border-b-0 sm:border-r">
						<div className="mb-2 flex items-center gap-2 px-3 py-1 text-ink-3">
							<GearSixIcon size={14} />
							<span className="text-xs font-medium uppercase tracking-wider">设置</span>
						</div>
						<nav aria-label="设置分类">
							<div className="space-y-0.5">
								{SETTINGS_NAV_ITEMS.filter((item) => !item.secondary).map((item) => (
									<NavButton
										key={item.id}
										item={item}
										active={settingsSection === item.id}
										onClick={() => setSettingsSection(item.id)}
									/>
								))}
							</div>
							<div className="mt-3 border-t border-edge-3 pt-3">
								{SETTINGS_NAV_ITEMS.filter((item) => item.secondary).map((item) => (
									<NavButton
										key={item.id}
										item={item}
										active={settingsSection === item.id}
										onClick={() => setSettingsSection(item.id)}
									/>
								))}
							</div>
						</nav>
					</aside>
					<div
						className="@container/settings-section min-h-0 h-full min-w-0 flex-1 overscroll-contain overflow-y-auto px-4 py-5 sm:px-8 sm:py-6"
						data-testid="settings-section-content"
					>
						<Suspense fallback={<SettingsSectionFallback />}>
							{content}
						</Suspense>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={confirmMailboxChangeOpen} onOpenChange={setConfirmMailboxChangeOpen}>
				<DialogContent className="max-w-[420px]">
					<DialogTitle>确认更换邮箱？</DialogTitle>
					<DialogDescription>
						当前邮箱连接会退出，本地邮件数据会保留。之后可以连接另一个邮箱。
					</DialogDescription>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => setConfirmMailboxChangeOpen(false)}>
							取消
						</Button>
						<Button
							onClick={() => {
								setConfirmMailboxChangeOpen(false);
								changeMailbox.mutate();
							}}
							loading={changeMailbox.isPending}
						>
							确认更换
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function NavButton({
	item,
	active,
	onClick,
}: {
	item: NavItem;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-testid={`settings-nav-${item.id}`}
			className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
				active
					? "bg-paper-3 font-semibold text-ink"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink"
			}`}
		>
			{item.icon}
			<span className="truncate">{item.label}</span>
		</button>
	);
}
