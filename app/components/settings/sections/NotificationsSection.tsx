import { BellRingingIcon } from "@phosphor-icons/react/BellRinging";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { SpeakerHighIcon } from "@phosphor-icons/react/SpeakerHigh";
import { WindowsLogoIcon } from "@phosphor-icons/react/WindowsLogo";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
	setUserPreference,
	useUserPreferences,
} from "~/hooks/useUserPreferences";

export function NotificationsSection() {
	const preferences = useUserPreferences();
	const canOpenWindowsSettings =
		typeof window !== "undefined" &&
		typeof window.wemailDesktop?.openWindowsNotificationSettings === "function";

	return (
		<div className="space-y-5">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">通知</h2>
				<p className="text-xs leading-5 text-ink-3">
					新邮件提醒默认开启，你可以按需要关闭或保持静音。
				</p>
			</div>

			<section className="overflow-hidden rounded-xl border border-edge bg-paper-2 shadow-[var(--shadow-1)]">
				<NotificationPreferenceRow
					icon={<BellRingingIcon size={17} weight="duotone" />}
					label="需要处理的事项"
					description="Agent 等待确认、邮箱登录失效或任务失败且需要你介入时提醒。"
					checked={preferences.actionRequiredNotifications}
					onCheckedChange={(value) =>
						setUserPreference("actionRequiredNotifications", value)
					}
				/>
				<NotificationPreferenceRow
					icon={<EnvelopeSimpleIcon size={17} weight="duotone" />}
					label="新邮件"
					description="所有实时收到的新邮件都会通过 Windows 通知提醒；关闭后仍保留任务栏角标。"
					checked={preferences.newMailNotifications}
					onCheckedChange={(value) =>
						setUserPreference("newMailNotifications", value)
					}
				/>
				<NotificationPreferenceRow
					icon={<SpeakerHighIcon size={17} weight="duotone" />}
					label="通知声音"
					description="控制 WeMail 通知是否播放系统提示音。"
					checked={preferences.notificationSound}
					onCheckedChange={(value) =>
						setUserPreference("notificationSound", value)
					}
					last
				/>
			</section>

			<section className="rounded-xl border border-edge bg-paper-2 px-5 py-4 shadow-[var(--shadow-1)]">
				<label
					htmlFor="notification-content-mode"
					className="text-sm font-semibold text-ink"
				>
					锁屏通知内容
				</label>
				<p id="notification-content-mode-help" className="mt-1 text-xs leading-5 text-ink-3">
					控制 Windows 通知中可以显示的邮件信息。企业环境可选择仅显示数量。
				</p>
				<Select
					value={preferences.notificationContentMode}
					onValueChange={(value) =>
						setUserPreference(
							"notificationContentMode",
							value as typeof preferences.notificationContentMode,
						)
					}
				>
					<SelectTrigger
						id="notification-content-mode"
						aria-describedby="notification-content-mode-help"
						className="mt-3 max-w-sm"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="count-only">仅显示新邮件数量</SelectItem>
						<SelectItem value="sender-only">显示发件人，不显示主题</SelectItem>
						<SelectItem value="full">显示发件人和主题</SelectItem>
					</SelectContent>
				</Select>
			</section>

			<section className="rounded-xl border border-edge bg-paper-2 px-5 py-4">
				<div className="flex items-start gap-3">
					<span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
						<WindowsLogoIcon size={17} weight="duotone" />
					</span>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-semibold text-ink">Windows 隐私与权限</div>
						<p className="mt-1 text-xs leading-5 text-ink-3">
							通知不会显示正文、附件内容或账户凭据。锁屏内容由上方隐私选项控制。
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="mt-3"
							disabled={!canOpenWindowsSettings}
							onClick={() =>
								void window.wemailDesktop?.openWindowsNotificationSettings?.()
							}
						>
							打开 Windows 通知设置
						</Button>
					</div>
				</div>
			</section>
		</div>
	);
}

function NotificationPreferenceRow({
	icon,
	label,
	description,
	checked,
	onCheckedChange,
	last = false,
}: {
	icon: ReactNode;
	label: string;
	description: string;
	checked: boolean;
	onCheckedChange: (value: boolean) => void;
	last?: boolean;
}) {
	const id = `notification-${label}`;
	return (
		<div
			className={`flex items-start justify-between gap-4 px-5 py-4 ${
				last ? "" : "border-b border-edge-3"
			}`}
		>
			<div className="flex min-w-0 gap-3">
				<span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
					{icon}
				</span>
				<div>
					<label htmlFor={id} className="text-sm font-semibold text-ink">
						{label}
					</label>
					<p className="mt-0.5 text-xs leading-5 text-ink-3">
						{description}
					</p>
				</div>
			</div>
			<Switch
				id={id}
				aria-label={label}
				checked={checked}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}
