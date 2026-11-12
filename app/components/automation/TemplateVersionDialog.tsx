import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
	AutomationDetail,
	AutomationTemplateUpgrade,
} from "../../../shared/wemail/automationCenter";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter";
import api from "~/services/api";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { getUserFacingError } from "~/lib/user-facing-error";

interface RuleVersionItem {
	version: number;
	templateVersion?: string;
	createdAt: string;
	current: boolean;
}

export function TemplateVersionDialog({
	accountId,
	detail,
	open,
	onOpenChange,
	onUpgradeDraft,
	onRolledBack,
}: {
	accountId: string;
	detail: AutomationDetail;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onUpgradeDraft: (draft: ExecutionPipelineDraft) => void;
	onRolledBack: () => void;
}) {
	const [upgrade, setUpgrade] = useState<AutomationTemplateUpgrade>(
		detail.upgrade ?? { available: false, requiresPreview: true },
	);
	const [versions, setVersions] = useState<RuleVersionItem[]>([]);
	const [preview, setPreview] = useState<Awaited<
		ReturnType<typeof api.previewUnifiedAutomationTemplateUpgrade>
	>["preview"]>();
	const [upgradeConfirmation, setUpgradeConfirmation] = useState("");
	const [rollbackVersion, setRollbackVersion] = useState<number>();
	const [rollbackConfirmation, setRollbackConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [loadError, setLoadError] = useState<string>();

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setPreview(undefined);
		setUpgradeConfirmation("");
		setRollbackConfirmation("");
		setLoadError(undefined);
		void api
			.getUnifiedAutomationTemplateVersion(detail.id, accountId)
			.then((result) => {
				if (cancelled) return;
				setUpgrade(result.upgrade);
				setVersions(result.versions);
				setRollbackVersion(result.versions.find((item) => !item.current)?.version);
			})
			.catch((error) => {
				if (!cancelled) setLoadError(messageOf(error, "无法读取模板版本"));
			});
		return () => {
			cancelled = true;
		};
	}, [accountId, detail.id, open]);

	const upgradePhrase = upgrade.targetVersion
		? `升级到版本 ${upgrade.targetVersion}`
		: "";
	const rollbackPhrase = rollbackVersion
		? `回退到版本 ${rollbackVersion}`
		: "";
	const previousVersions = useMemo(
		() => versions.filter((item) => !item.current),
		[versions],
	);

	const generatePreview = async () => {
		setBusy(true);
		try {
			const result = await api.previewUnifiedAutomationTemplateUpgrade(
				detail.id,
				accountId,
			);
			setPreview(result.preview);
			setUpgrade(result.preview.upgrade);
		} catch (error) {
			toast.error(messageOf(error, "升级预览生成失败"));
		} finally {
			setBusy(false);
		}
	};

	const continueUpgrade = async () => {
		if (!preview || !upgrade.targetVersion) return;
		setBusy(true);
		try {
			const result = await api.confirmUnifiedAutomationTemplateUpgrade(
				detail.id,
				{
					accountId,
					previewId: preview.previewId,
					previewHash: preview.previewHash,
					targetVersion: upgrade.targetVersion,
					confirmation: upgradeConfirmation,
				},
			);
			onOpenChange(false);
			onUpgradeDraft(result.draft);
			toast.success("升级草稿已创建；旧版本会继续运行到最终确认");
		} catch (error) {
			toast.error(messageOf(error, "无法创建升级草稿"));
		} finally {
			setBusy(false);
		}
	};

	const rollback = async () => {
		if (!rollbackVersion) return;
		setBusy(true);
		try {
			await api.rollbackUnifiedAutomationTemplate(detail.id, {
				accountId,
				targetVersion: rollbackVersion,
				expectedCurrentVersion: detail.version,
				confirmation: rollbackConfirmation,
			});
			onOpenChange(false);
			onRolledBack();
			toast.success(`已创建版本 ${detail.version + 1}，内容回退到版本 ${rollbackVersion}`);
		} catch (error) {
			toast.error(messageOf(error, "回退失败"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[86vh] max-w-xl overflow-y-auto">
				<DialogTitle>模板版本管理</DialogTitle>
				<DialogDescription>
					升级不会静默修改正在运行的规则；先生成草稿和预览，完成评审及最终确认后才生效。
				</DialogDescription>
				{loadError ? (
					<p role="alert" className="rounded-lg border border-red/30 bg-red/5 p-3 text-xs text-red">
						{loadError}
					</p>
				) : null}

				{upgrade.available ? (
					<section className="space-y-3 rounded-lg border border-coral/20 bg-coral/[0.04] p-4">
						<div>
							<h3 className="text-sm font-semibold text-ink">
								可升级：{upgrade.currentVersion} → {upgrade.targetVersion}
							</h3>
							<ul className="mt-2 space-y-1 text-xs text-ink-2">
								{(upgrade.summary ?? ["模板实现已更新"]).map((item) => (
									<li key={item}>• {item}</li>
								))}
							</ul>
						</div>
						{preview ? (
							<>
								<div className="rounded-md border border-edge bg-paper-2 p-3 text-xs text-ink-2">
									<p className="font-medium text-ink">升级预览已重新生成</p>
									<p className="mt-1">
										{preview.draft.reviews.length
											? `${preview.draft.reviews.length} 个评审检查点需要确认`
											: "进入草稿后检查配置并完成最终确认"}
									</p>
								</div>
								<label className="block text-xs text-ink-2">
									输入“{upgradePhrase}”继续进入评审
									<Input
										className="mt-1.5"
										value={upgradeConfirmation}
										onChange={(event) => setUpgradeConfirmation(event.target.value)}
									/>
								</label>
								<Button
									disabled={busy || upgradeConfirmation !== upgradePhrase}
									onClick={() => void continueUpgrade()}
								>
									确认并打开升级草稿
								</Button>
							</>
						) : (
							<Button disabled={busy} onClick={() => void generatePreview()}>
								生成升级预览
							</Button>
						)}
					</section>
				) : (
					<p className="rounded-lg bg-paper-2 p-3 text-xs text-ink-2">
						当前模板已是最新版本。
					</p>
				)}

				{previousVersions.length ? (
					<details className="rounded-lg border border-edge">
						<summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">
							回退到历史规则版本
						</summary>
						<div className="space-y-3 border-t border-edge-3 p-4">
							<label className="block text-xs text-ink-2">
								历史版本
								<select
									className="mt-1.5 h-10 w-full rounded-md border border-edge bg-paper-2 px-3 text-sm"
									value={rollbackVersion}
									onChange={(event) => {
										setRollbackVersion(Number(event.target.value));
										setRollbackConfirmation("");
									}}
								>
									{previousVersions.map((item) => (
										<option key={item.version} value={item.version}>
											规则版本 {item.version}
											{item.templateVersion ? ` · 模板 ${item.templateVersion}` : ""}
										</option>
									))}
								</select>
							</label>
							<label className="block text-xs text-ink-2">
								输入“{rollbackPhrase}”确认
								<Input
									className="mt-1.5"
									value={rollbackConfirmation}
									onChange={(event) => setRollbackConfirmation(event.target.value)}
								/>
							</label>
							<Button
								variant="outline"
								disabled={busy || rollbackConfirmation !== rollbackPhrase}
								onClick={() => void rollback()}
							>
								创建回退版本
							</Button>
						</div>
					</details>
				) : null}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function messageOf(error: unknown, fallback: string) {
	return getUserFacingError(error, fallback);
}
