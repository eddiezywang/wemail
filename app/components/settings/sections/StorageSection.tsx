// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useState } from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { FolderOpenIcon } from "@phosphor-icons/react/FolderOpen";
import { ShieldIcon } from "@phosphor-icons/react/Shield";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";

type DataDirectoryInfo = NonNullable<
	Awaited<
		ReturnType<
			NonNullable<NonNullable<Window["wemailDesktop"]>["storage"]>["getDataDirectory"]
		>
	>
>;

export function StorageSection() {
	const storage =
		typeof window !== "undefined" ? window.wemailDesktop?.storage : undefined;
	const [info, setInfo] = useState<DataDirectoryInfo | null>(null);
	const [targetPath, setTargetPath] = useState<string | null>(null);
	const [choosing, setChoosing] = useState(false);
	const [migrating, setMigrating] = useState(false);
	const [restarting, setRestarting] = useState(false);

	useEffect(() => {
		let active = true;
		void storage?.getDataDirectory().then((result) => {
			if (active && result) setInfo(result);
		});
		return () => {
			active = false;
		};
	}, [storage]);

	const chooseDirectory = async () => {
		if (!storage) return;
		setChoosing(true);
		try {
			const result = await storage.chooseDataDirectory();
			if (!result.canceled && result.path) setTargetPath(result.path);
		} catch (error) {
			toast.error(getUserFacingError(error, "无法打开目录选择器，请稍后重试。"));
		} finally {
			setChoosing(false);
		}
	};

	const migrate = async () => {
		if (!storage || !targetPath) return;
		setMigrating(true);
		try {
			const result = await storage.migrateDataDirectory(targetPath);
			if (!result.ok) {
				toast.error(getUserFacingError(result.error, "数据迁移未能开始，请检查目标目录后重试。"));
				return;
			}
			setRestarting(true);
			toast.success("迁移已安排，WeMail 即将重启");
		} catch (error) {
			toast.error(getUserFacingError(error, "无法开始迁移，请稍后重试。"));
		} finally {
			setMigrating(false);
		}
	};

	const fallbackHint =
		window.wemailDesktop?.platform === "win32"
			? "%APPDATA%\\wemail\\data"
			: "本机应用数据目录";
	const currentPath = info?.currentPath ?? fallbackHint;

	return (
		<div className="space-y-5">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">存储</h2>
				<p className="text-xs text-ink-3">
					邮件、附件、AI 摘要全部存放在本机。可将数据迁移到空间更充足的磁盘。
				</p>
			</div>

			{info?.lastMigration ? (
				<div
					className={`flex items-start gap-2.5 rounded-md border px-3.5 py-3 text-xs ${
						info.lastMigration.status === "success"
							? "border-green/30 bg-green/5 text-ink"
							: "border-red/30 bg-red-bg/30 text-red"
					}`}
				>
					{info.lastMigration.status === "success" ? (
						<CheckCircleIcon size={17} className="mt-0.5 shrink-0 text-green" />
					) : (
						<WarningCircleIcon size={17} className="mt-0.5 shrink-0" />
					)}
					<div>
						<div className="font-medium">
							{info.lastMigration.status === "success"
								? "数据目录迁移完成"
								: "数据目录迁移未完成，仍在使用原目录"}
						</div>
						{info.lastMigration.message ? (
							<div className="mt-0.5 opacity-75">{info.lastMigration.message}</div>
						) : null}
					</div>
				</div>
			) : null}

			<div className="overflow-hidden rounded-md border border-edge bg-paper-2">
				<div className="flex items-center gap-3 px-4 py-4">
					<span className="text-ink-3">
						<FloppyDiskIcon size={17} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2 text-sm text-ink">
							数据目录
							{info?.custom ? (
								<span className="rounded-full bg-paper-3 px-2 py-0.5 text-xs text-ink-3">
									自定义
								</span>
							) : null}
						</div>
						<div className="mt-0.5 break-all font-mono text-xs text-ink-3">
							{currentPath}
						</div>
					</div>
					<Button
						variant="outline"
						size="sm"
						loading={choosing}
						disabled={!storage || info?.managedByEnvironment}
						onClick={() => void chooseDirectory()}
					>
						<FolderOpenIcon size={15} />
						更改位置
					</Button>
				</div>
				<div className="border-t border-edge-3 px-4 py-2.5 text-xs text-ink-3">
					{info?.managedByEnvironment
						? "当前路径由启动环境管理，请通过部署配置修改。"
						: "迁移要求目标目录为空；迁移时应用会重启，原目录仅在复制校验成功后清理。"}
				</div>
			</div>

			<div className="divide-y divide-edge-3 rounded-md border border-edge bg-paper-2">
				<Row
					icon={<ClockCounterClockwiseIcon size={16} />}
					title="正文与附件保留"
					body="邮件正文和附件元数据默认长期保留；应用日志和审计日志按 30 天周期清理。"
				/>
				<Row
					icon={<ShieldIcon size={16} />}
					title="LLM 凭据"
					body="保存在系统 Keychain / DPAPI；不会随数据目录迁移复制明文凭据。"
				/>
			</div>

			<Dialog
				open={targetPath !== null}
				onOpenChange={(open) => {
					if (!open && !migrating && !restarting) setTargetPath(null);
				}}
			>
				<DialogContent className="max-w-[500px]">
					<DialogHeader>
						<DialogTitle>{restarting ? "正在重启 WeMail" : "迁移数据目录？"}</DialogTitle>
						<DialogDescription>
							{restarting
								? "应用退出后会在数据库启动前完成复制与校验，请不要强制结束进程。"
								: "邮件数据库、附件、日志和本地 AI 数据都将移动到新位置。迁移期间 WeMail 会自动重启。"}
						</DialogDescription>
					</DialogHeader>
					<div className="rounded-lg border border-edge bg-paper-3 px-3.5 py-3">
						<div className="break-all font-mono text-xs text-ink-3">{currentPath}</div>
						<ArrowRightIcon size={16} className="my-2 text-coral" />
						<div className="break-all font-mono text-xs text-ink">{targetPath}</div>
					</div>
					{!restarting ? (
						<div className="flex items-start gap-2 text-xs text-ink-3">
							<WarningCircleIcon size={15} className="mt-0.5 shrink-0 text-coral" />
							<span>请确保目标磁盘在今后启动 WeMail 时可用，并避免选择移动硬盘或网络目录。</span>
						</div>
					) : null}
					<DialogFooter>
						{!restarting ? (
							<>
								<Button
									variant="outline"
									disabled={migrating}
									onClick={() => setTargetPath(null)}
								>
									取消
								</Button>
								<Button loading={migrating} onClick={() => void migrate()}>
									迁移并重启
								</Button>
							</>
						) : (
							<Button disabled>正在关闭服务…</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function Row({
	icon,
	title,
	body,
}: {
	icon: React.ReactNode;
	title: string;
	body: string;
}) {
	return (
		<div className="flex items-start gap-3 px-4 py-3.5">
			<span className="mt-0.5 text-ink-3">{icon}</span>
			<div className="min-w-0 flex-1">
				<div className="text-sm text-ink">{title}</div>
				<div className="text-xs text-ink-3">{body}</div>
			</div>
		</div>
	);
}
