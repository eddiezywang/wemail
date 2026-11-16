import { BellIcon } from "@phosphor-icons/react/Bell";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { GaugeIcon } from "@phosphor-icons/react/Gauge";
import { SignatureIcon } from "@phosphor-icons/react/Signature";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { StethoscopeIcon } from "@phosphor-icons/react/Stethoscope";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getUserFacingError } from "~/lib/user-facing-error";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { ComposeSection } from "./ComposeSection";
import { NotificationsSection } from "./NotificationsSection";
import { PreferencesSection } from "./PreferencesSection";
import { StorageSection } from "./StorageSection";
import api, { type LoggingDiagnostics } from "~/services/api";
import {
	AI_WORKER_CONCURRENCY_DEFAULT,
	AI_WORKER_CONCURRENCY_MAX,
	AI_WORKER_CONCURRENCY_MIN,
} from "../../../../shared/wemail/settings";

type AdvancedPane = "signature" | "notifications" | "preferences" | "performance" | "data" | "diagnostics";

const PANES: Array<{
	id: AdvancedPane;
	label: string;
	description: string;
	icon: React.ReactNode;
}> = [
	{
		id: "signature",
		label: "签名",
		description: "设置写信时使用的默认签名",
		icon: <SignatureIcon size={18} />,
	},
	{
		id: "notifications",
		label: "通知",
		description: "管理新邮件和系统提醒",
		icon: <BellIcon size={18} />,
	},
	{
		id: "preferences",
		label: "用户偏好",
		description: "窗口行为等个性化选项",
		icon: <SlidersHorizontalIcon size={18} />,
	},
	{
		id: "performance",
		label: "性能",
		description: "AI 任务并发与吞吐调优",
		icon: <GaugeIcon size={18} />,
	},
	{
		id: "data",
		label: "数据与隐私",
		description: "本地存储与保留策略",
		icon: <DatabaseIcon size={18} />,
	},
	{
		id: "diagnostics",
		label: "诊断",
		description: "运行环境与诊断信息",
		icon: <StethoscopeIcon size={18} />,
	},
];

export function AdvancedSection() {
	const [pane, setPane] = useState<AdvancedPane>("signature");

	return (
		<div className="space-y-5">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">高级设置</h2>
				<p className="text-xs text-ink-3">
					用于管理常规偏好、本地数据与排查问题。
				</p>
			</div>
			<div className="grid gap-2 @min-[520px]/settings-section:grid-cols-3">
				{PANES.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => setPane(item.id)}
						aria-pressed={pane === item.id}
						className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
							pane === item.id
								? "border-coral bg-coral/5"
								: "border-edge bg-paper-2 hover:bg-paper-3"
						}`}
					>
						<span className="mt-0.5 text-ink-3">{item.icon}</span>
						<span>
							<span className="block text-sm font-medium text-ink">{item.label}</span>
							<span className="block text-xs text-ink-3">{item.description}</span>
						</span>
					</button>
				))}
			</div>
			<div className="border-t border-edge-3 pt-5">
				{pane === "signature" ? <ComposeSection /> : null}
				{pane === "notifications" ? <NotificationsSection /> : null}
				{pane === "preferences" ? <PreferencesSection /> : null}
				{pane === "performance" ? <PerformancePane /> : null}
				{pane === "data" ? <StorageSection /> : null}
				{pane === "diagnostics" ? <DiagnosticsPane /> : null}
			</div>
		</div>
	);
}

function PerformancePane() {
	const [concurrency, setConcurrency] = useState<number | null>(null);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void api
			.getAiWorkerConcurrency()
			.then((result) => {
				if (!cancelled) setConcurrency(result.concurrency);
			})
			.catch(() => {
				if (!cancelled) setConcurrency(AI_WORKER_CONCURRENCY_DEFAULT);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const apply = async (next: number): Promise<void> => {
		const clamped = Math.max(
			AI_WORKER_CONCURRENCY_MIN,
			Math.min(AI_WORKER_CONCURRENCY_MAX, Math.trunc(next)),
		);
		if (clamped === concurrency) return;
		setConcurrency(clamped);
		setPending(true);
		try {
			const result = await api.saveAiWorkerConcurrency(clamped);
			setConcurrency(result.concurrency);
			toast.success(`AI 并发已更新为 ${result.concurrency}`);
		} catch (error) {
			toast.error(getUserFacingError(error, "保存 AI 并发失败，请稍后重试。"));
			void api
				.getAiWorkerConcurrency()
				.then((result) => setConcurrency(result.concurrency))
				.catch(() => undefined);
		} finally {
			setPending(false);
		}
	};

	const display = concurrency ?? AI_WORKER_CONCURRENCY_DEFAULT;
	const atMin = display <= AI_WORKER_CONCURRENCY_MIN;
	const atMax = display >= AI_WORKER_CONCURRENCY_MAX;

	return (
		<div className="space-y-4">
			<div>
				<h2 className="mb-1 text-base font-semibold text-ink">性能</h2>
				<p className="text-xs text-ink-3">调整智能任务的并发处理能力。</p>
			</div>
			<section className="rounded-xl border border-edge bg-paper-2 p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h4 className="text-sm font-medium text-ink">AI 任务并发数</h4>
						<p className="mt-1 max-w-xl text-xs leading-5 text-ink-3">
							智能任务（摘要、智能标签、回复判断）同时处理的数量。调大可加快批量回填速度，但不应超过 LLM 服务商的并发请求上限——过高会触发限流，反而降低吞吐。
						</p>
					</div>
					<span className="min-w-[3rem] rounded-lg border border-edge bg-paper px-3 py-1 text-center text-lg font-semibold text-ink">
						{concurrency ?? "—"}
					</span>
				</div>
				<div className="mt-4 flex items-center gap-3">
					<button
						type="button"
						aria-label="减少并发数"
						disabled={pending || concurrency === null || atMin}
						onClick={() => void apply(display - 1)}
						className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge bg-paper text-base text-ink transition-colors hover:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-40"
					>
						−
					</button>
					<input
						type="range"
						min={AI_WORKER_CONCURRENCY_MIN}
						max={AI_WORKER_CONCURRENCY_MAX}
						step={1}
						value={display}
						disabled={pending || concurrency === null}
						onChange={(event) => void apply(Number(event.target.value))}
						className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-edge accent-coral disabled:cursor-not-allowed"
					/>
					<button
						type="button"
						aria-label="增加并发数"
						disabled={pending || concurrency === null || atMax}
						onClick={() => void apply(display + 1)}
						className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge bg-paper text-base text-ink transition-colors hover:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-40"
					>
						+
					</button>
				</div>
				<p className="mt-2 text-xs text-ink-3">
					范围 {AI_WORKER_CONCURRENCY_MIN}–{AI_WORKER_CONCURRENCY_MAX}，默认 {AI_WORKER_CONCURRENCY_DEFAULT}。改动立即生效，无需重启。
				</p>
			</section>
		</div>
	);
}

function DiagnosticsPane() {
	const [telemetryEnabled, setTelemetryEnabled] = useState(true);
	const [telemetryReady, setTelemetryReady] = useState(false);
	const [logging, setLogging] = useState<LoggingDiagnostics | null>(null);
	const [loggingPending, setLoggingPending] = useState(false);
	const [exportPending, setExportPending] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void window.wemailDesktop?.telemetry?.getEnabled().then((enabled) => {
			if (!cancelled) {
				setTelemetryEnabled(enabled);
				setTelemetryReady(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	useEffect(() => {
		let cancelled = false;
		void api.getLoggingDiagnostics().then((value) => {
			if (!cancelled) setLogging(value);
		}).catch(() => {
			if (!cancelled) setLogging(null);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	useEffect(() => {
		if (!logging?.debugEnabled || !logging.expiresAt) return;
		const timer = window.setInterval(() => {
			const remainingSeconds = Math.max(
				0,
				Math.ceil((new Date(logging.expiresAt!).getTime() - Date.now()) / 1000),
			);
			if (remainingSeconds === 0) {
				void api.getLoggingDiagnostics().then(setLogging).catch(() => undefined);
				return;
			}
			setLogging((current) => current ? { ...current, remainingSeconds } : current);
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [logging?.debugEnabled, logging?.expiresAt]);
	return (
		<div className="space-y-3">
			<h3 className="text-sm font-semibold text-ink">运行诊断</h3>
			<div className="divide-y divide-edge-3 rounded-xl border border-edge bg-paper-2">
				<DiagnosticRow label="运行平台" value={window.wemailDesktop?.platform ?? "Web"} />
				<DiagnosticRow label="Electron 版本" value={window.wemailDesktop?.versions?.electron ?? "未知"} />
			</div>
			<div className="rounded-xl border border-edge bg-paper-2 p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h4 className="text-sm font-medium text-ink">使用数据</h4>
						<p className="mt-1 max-w-xl text-xs leading-5 text-ink-3">
							上报操作系统用户名、安装标识、应用版本和功能行为，用于产品与稳定性分析。不会上报邮件内容、主题、联系人、搜索词或 AI 输入输出。
						</p>
					</div>
					<Switch
						aria-label="允许上报使用数据"
						checked={telemetryEnabled}
						disabled={!telemetryReady || !window.wemailDesktop?.telemetry}
						onCheckedChange={(enabled) => {
							setTelemetryEnabled(enabled);
							void window.wemailDesktop?.telemetry?.setEnabled(enabled).then((result) => {
								setTelemetryEnabled(result.enabled);
							});
						}}
					/>
				</div>
			</div>
			<div className="rounded-xl border border-edge bg-paper-2 p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h4 className="text-sm font-medium text-ink">导出本地诊断包</h4>
						<p className="mt-1 max-w-xl text-xs leading-5 text-ink-3">
							生成经过脱敏的本地诊断文件，不会自动上传；文件将在 7 天后自动清理。
						</p>
					</div>
					<Button
						variant="outline"
						disabled={exportPending}
						onClick={() => {
							setExportPending(true);
							void api.exportDiagnostics().then(async ({ package: diagnosticPackage }) => {
								const saved = await window.wemailDesktop?.saveDiagnosticsPackage?.(diagnosticPackage.fileName);
								if (saved?.canceled) return;
								toast.success(saved?.ok
									? "诊断包已导出。"
									: `诊断包已生成：${diagnosticPackage.fileName}`);
							}).catch((error) => {
								toast.error(getUserFacingError(error, "导出诊断包失败，请稍后重试。"));
							}).finally(() => setExportPending(false));
						}}
					>
						{exportPending ? "正在导出…" : "导出诊断包"}
					</Button>
				</div>
			</div>
			<div className="rounded-xl border border-edge bg-paper-2 p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h4 className="text-sm font-medium text-ink">调试日志</h4>
						<p className="mt-1 max-w-xl text-xs leading-5 text-ink-3">
							{logging?.debugEnabled
								? `正在记录详细诊断信息，${formatDebugRemaining(logging.remainingSeconds)}后自动关闭。`
								: "普通模式只保留关键运行结果与错误信息。开启后持续 30 分钟。"}
						</p>
						<p className="mt-1 text-xs leading-5 text-ink-3">
							不会记录邮件正文、密码、令牌或 API Key。
						</p>
					</div>
					<Switch
						aria-label="开启调试日志"
						checked={logging?.debugEnabled ?? false}
						disabled={!logging || loggingPending}
						onCheckedChange={(debugEnabled) => {
							setLoggingPending(true);
							void api.setDebugLogging(debugEnabled).then((value) => {
								setLogging(value);
								toast.success(debugEnabled ? "调试日志已开启，将在 30 分钟后关闭" : "调试日志已关闭");
							}).catch((error) => {
								toast.error(getUserFacingError(error, "更新调试日志失败，请稍后重试。"));
								void api.getLoggingDiagnostics().then(setLogging).catch(() => undefined);
							}).finally(() => setLoggingPending(false));
						}}
					/>
				</div>
			</div>
		</div>
	);
}

function formatDebugRemaining(seconds: number): string {
	const minutes = Math.floor(Math.max(0, seconds) / 60);
	const remainder = Math.max(0, seconds) % 60;
	return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3 px-4 py-3 text-xs">
			<span className="text-ink-3">{label}</span>
			<span className="break-all font-mono text-ink">{value}</span>
		</div>
	);
}
