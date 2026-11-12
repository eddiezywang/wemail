import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../../../../shared/wemail/update";
import { Button } from "~/components/ui/button";
import { SECURITY_FAILURE_MESSAGE } from "~/components/updates/DesktopUpdateCenter";
import { useDesktopUpdate } from "~/hooks/useDesktopUpdate";
import type { DesktopAppInfo } from "~/services/api";

function formatLastChecked(value: string | null) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function failureMessage(state: DesktopUpdateState) {
	switch (state.errorCode) {
		case "NETWORK_UNAVAILABLE":
			return "当前网络不可用，请检查连接后重试。";
		case "UPDATE_SERVER_UNAVAILABLE":
			return "更新服务器暂时不可用，请稍后重试。";
		case "INVALID_UPDATE_METADATA":
			return "更新信息无效，WeMail 已阻止本次更新。";
		case "INSUFFICIENT_DISK_SPACE":
			return "磁盘空间不足，清理空间后可重试下载。";
		case "DOWNLOAD_FAILED":
			return "更新下载失败，请重试或稍后再试。";
		case "SECURITY_VERIFICATION_FAILED":
			return SECURITY_FAILURE_MESSAGE;
		case "INSTALLER_START_FAILED":
			return "安装程序未能启动。请重新打开 WeMail 后再次检查更新。";
		default:
			return "更新操作未能完成。";
	}
}

export function formatUpdateStatus(state: DesktopUpdateState) {
	switch (state.status) {
		case "disabled":
			return "此构建未启用自动更新。";
		case "idle":
			return "尚未检查更新。";
		case "checking":
			return "正在检查更新…";
		case "up-to-date": {
			const checkedAt = formatLastChecked(state.lastCheckedAt);
			return checkedAt ? `已是最新版本 · 上次检查 ${checkedAt}` : "已是最新版本。";
		}
		case "available":
			return `发现新版本 ${state.availableVersion ?? ""}，下载前需要你的确认。`.trim();
		case "downloading":
			return `正在下载 ${state.availableVersion ?? "更新"} · ${Math.round(state.progress?.percent ?? 0)}%`;
		case "downloaded":
			return `版本 ${state.availableVersion ?? "更新"} 已下载并通过验证，等待安装。`;
		case "install-on-exit":
			return "已选择退出时安装；关闭窗口到托盘不会触发安装。";
		case "installing":
			return "正在退出并启动安装程序…";
		case "check-failed":
		case "download-failed":
		case "security-failed":
		case "install-failed":
			return failureMessage(state);
	}
}

export function AboutSection() {
	const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
	const update = useDesktopUpdate();
	const { state: updateState } = update;
	const canCheckUpdate = [
		"idle",
		"up-to-date",
		"available",
		"check-failed",
		"download-failed",
	].includes(updateState.status);

	useEffect(() => {
		let active = true;
		void window.wemailDesktop?.getAppInfo?.().then((info) => {
			if (active) setAppInfo(info);
		});
		return () => {
			active = false;
		};
	}, []);

	return (
		<div className="space-y-5">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">关于 WeMail</h2>
				<p className="text-xs text-ink-3">产品版本、软件更新与开源许可。</p>
			</div>
			<div className="flex items-center gap-4 rounded-xl border border-edge bg-paper-2 p-5">
				<div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-coral text-xl font-semibold text-paper">
					W
				</div>
				<div>
					<div className="text-base font-semibold text-ink">WeMail</div>
					<div className="text-xs text-ink-3">版本 {appInfo?.version ?? "—"}</div>
				</div>
			</div>
			<div className="space-y-3 rounded-xl border border-edge bg-paper-2 p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h3 className="text-sm font-semibold text-ink">软件更新</h3>
						<p className="text-xs text-ink-3">
							版本 {updateState.currentVersion || appInfo?.version || "未知"}
						</p>
					</div>
					<Button
						size="sm"
						variant="secondary"
						loading={updateState.status === "checking"}
						disabled={!updateState.enabled || !canCheckUpdate}
						onClick={() => void update.check()}
					>
						检查更新
					</Button>
				</div>
				<div
					role={updateState.status === "installing" ? "status" : undefined}
					aria-live={updateState.status === "installing" ? "assertive" : undefined}
					aria-busy={updateState.status === "installing" || undefined}
					className="flex items-center gap-2"
				>
					{updateState.status === "installing" ? (
						<span
							aria-hidden="true"
							className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-coral/20 border-t-coral motion-reduce:animate-none"
						/>
					) : null}
					<p
						className={`text-xs ${updateState.status === "security-failed" ? "text-red" : "text-ink-3"}`}
					>
						{formatUpdateStatus(updateState)}
					</p>
				</div>
				<UpdateActions update={update} />
			</div>
			<div className="flex items-center gap-2 rounded-xl border border-edge bg-paper-2 p-4 text-xs text-ink-3">
				<GithubLogoIcon size={15} />
				<span>Apache 2.0 开源许可</span>
			</div>
			<p className="text-xs text-ink-3">
				运行环境和诊断信息已移至“高级设置 → 诊断”。
			</p>
		</div>
	);
}

function UpdateActions({ update }: { update: ReturnType<typeof useDesktopUpdate> }) {
	switch (update.state.status) {
		case "available":
			return (
				<div className="flex justify-end">
					<Button size="sm" onClick={() => void update.download()}>
						立即更新
					</Button>
				</div>
			);
		case "downloading":
			return (
				<div className="flex justify-end">
					<Button size="sm" variant="secondary" onClick={() => void update.cancelDownload()}>
						取消下载
					</Button>
				</div>
			);
		case "download-failed":
			return (
				<div className="flex justify-end">
					<Button size="sm" onClick={() => void update.retryDownload()}>
						重试
					</Button>
				</div>
			);
		case "downloaded":
			return (
				<div className="flex flex-wrap justify-end gap-2">
					<Button size="sm" variant="secondary" onClick={() => void update.installOnExit()}>
						退出时安装
					</Button>
					<Button size="sm" onClick={() => void update.installNow()}>
						立即重启安装
					</Button>
				</div>
			);
		case "install-on-exit":
			return (
				<div className="flex justify-end">
					<Button size="sm" onClick={() => void update.installNow()}>
						立即重启安装
					</Button>
				</div>
			);
		default:
			return null;
	}
}
