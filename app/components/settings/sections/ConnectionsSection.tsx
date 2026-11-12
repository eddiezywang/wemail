import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { QrCodeIcon } from "@phosphor-icons/react/QrCode";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
	ChannelBotProfile,
	ChannelBotSetup,
	IntegrationConnectionId,
	IntegrationConnectionSummary,
	WecliRuntimeMeta,
} from "../../../../shared/wemail/channels";
import type {
	WecliCatalogCommand,
	WecliSetupResult,
	WecliSetupStepStatus,
	WecliUpdateCheckResult,
} from "../../../../shared/wemail/wecliTypes";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";
import { Button } from "~/components/ui/button";
import { CopyButton } from "~/components/ui/copy-button";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	integrationStatusKey,
	useDetectIntegrationStatus,
	useIntegrationStatus,
} from "~/queries/integrationStatus";
import api from "~/services/api";

const BOT_ENTRIES: Array<{ id: IntegrationConnectionId; label: string; short: string }> = [
	{ id: "feishu", label: "飞书", short: "FS" },
	{ id: "wecom", label: "企业微信", short: "WX" },
];

export function ConnectionsSection({
	initialSelected = "feishu",
}: {
	initialSelected?: IntegrationConnectionId;
}) {
	const features = useEditionFeatures();
	const wecliEnabled = features.wecli;
	// WeCLI is an edition-only connection. Without the feature the tab list,
	// its pane and every WeCLI API call are unreachable in the open build.
	const entries = useMemo(
		() => (wecliEnabled
			? [{ id: "wecli" as const, label: "WeCLI", short: "CLI" }, ...BOT_ENTRIES]
			: BOT_ENTRIES),
		[wecliEnabled],
	);
	const [selected, setSelected] = useState<IntegrationConnectionId>(initialSelected);
	const effectiveSelected = !wecliEnabled && selected === "wecli" ? "feishu" : selected;
	const { data: snapshot } = useIntegrationStatus();

	return (
		<div
			className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
			data-testid="connections-settings-section"
		>
			<header className="shrink-0">
				<div className="flex items-baseline gap-3">
					<h2 className="font-serif-display text-lg font-semibold text-ink">连接</h2>
					<p className="truncate text-xs text-ink-4">机器人、主人与消息链路集中管理</p>
				</div>
			</header>

			<div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-edge bg-paper @min-[620px]/settings-section:grid-cols-[138px_minmax(0,1fr)] @min-[620px]/settings-section:grid-rows-1">
				<nav className="flex max-h-44 min-h-0 flex-col overflow-y-auto border-b border-edge bg-paper-2 p-2 @min-[620px]/settings-section:max-h-none @min-[620px]/settings-section:border-b-0 @min-[620px]/settings-section:border-r" aria-label="连接列表">
					<div className="px-2 pb-2 pt-1 font-mono text-xs uppercase tracking-[0.18em] text-ink-4">
						连接渠道
					</div>
					{entries.map((entry) => {
						const status = snapshot?.entries.find((item) => item.id === entry.id);
						const active = effectiveSelected === entry.id;
						return (
							<button
								key={entry.id}
								type="button"
								onClick={() => setSelected(entry.id)}
								className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
									active ? "bg-paper font-semibold text-ink shadow-sm" : "text-ink-3 hover:bg-paper-3"
								}`}
							>
								<span className={`grid h-6 w-6 place-items-center rounded-md font-mono text-xs ${active ? "bg-ink text-paper" : "border border-edge text-ink-4"}`}>
									{entry.short}
								</span>
								<span className="min-w-0 flex-1 truncate">{entry.label}</span>
								<StatusDot connected={status?.state === "connected"} />
							</button>
						);
					})}
				</nav>
				<div className="min-h-0 min-w-0 overflow-hidden p-4">
					{effectiveSelected === "wecli" && wecliEnabled ? (
					<WecliConnectionPane />
				) : (
					<BotConnectionPane platform={effectiveSelected === "wecli" ? "feishu" : effectiveSelected} />
				)}
				</div>
			</div>
		</div>
	);
}

function StatusDot({ connected }: { connected: boolean }) {
	return connected ? (
		<CheckCircleIcon size={15} weight="fill" className="shrink-0 text-green" aria-label="已连接" />
	) : (
		<CircleIcon size={12} className="shrink-0 text-ink-4" aria-hidden="true" />
	);
}

function WecliConnectionPane() {
	const { data } = useIntegrationStatus();
	const detect = useDetectIntegrationStatus("wecli");
	const item = data?.entries.find((entry) => entry.id === "wecli");
	const state = item?.state;
	const isMissing = item?.reasonCode === "wecli-not-installed";

	// Proactively detect on first mount when there's no usable observation, so
	// the connected view + catalog render from cache without a manual click.
	const probedRef = useRef(false);
	useEffect(() => {
		if (probedRef.current) return;
		if (!item?.observedAt || state === "unknown") {
			probedRef.current = true;
			detect.mutate();
		}
	}, [item?.observedAt, state, detect]);

	let body: React.ReactNode;
	if (state === "connected") {
		body = (
			<WecliConnectedBody
				meta={item?.meta}
				observation={item}
				onDetect={() => detect.mutate()}
				detecting={detect.isPending}
			/>
		);
	} else if (isMissing || state === "disconnected") {
		body = <WecliSetupCard missing={isMissing} observation={item} />;
	} else {
		body = (
			<div className="flex h-full min-h-0 items-center justify-center rounded-xl border border-dashed border-edge bg-paper-2/50 text-center">
				<div className="max-w-sm px-6">
					<div className="text-sm font-semibold text-ink">本地运行时</div>
					<p className="mt-1 text-xs leading-5 text-ink-3">正在检测 WeCLI 是否可用，以及当前桌面端能否正常调用。</p>
					<Button className="mt-3" size="sm" onClick={() => detect.mutate()} loading={detect.isPending}>检测连接</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
			<ConnectionHeader title="WeCLI" description="本地命令能力与运行环境" observation={item} />
			<div className="min-h-0 flex-1 overflow-hidden">{body}</div>
		</div>
	);
}

function WecliConnectedBody({
	meta,
	observation,
	onDetect,
	detecting,
}: {
	meta?: WecliRuntimeMeta;
	observation?: IntegrationConnectionSummary;
	onDetect: () => void;
	detecting: boolean;
}) {
	// doctor passing ⇒ the browser extension is connected, so the extension
	// only needs UI real estate when it is NOT connected.
	const extensionConnected = meta?.extension?.connected === true;
	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<WecliStatusBar
				meta={meta}
				observation={observation}
				onDetect={onDetect}
				detecting={detecting}
			/>
			{!extensionConnected && <WecliExtensionInstall downloadUrl={meta?.extensionDownloadUrl} />}
			<WecliCatalog />
		</div>
	);
}

function WecliStatusBar({
	meta,
	observation,
	onDetect,
	detecting,
}: {
	meta?: WecliRuntimeMeta;
	observation?: IntegrationConnectionSummary;
	onDetect: () => void;
	detecting: boolean;
}) {
	const queryClient = useQueryClient();
	const ext = meta?.extension;
	const version = meta?.version;
	const [updateCheck, setUpdateCheck] = useState<WecliUpdateCheckResult | null>(null);

	const refreshAfterUpdate = () => {
		void api
			.refreshIntegrationStatus("wecli")
			.then((snapshot) => queryClient.setQueryData(integrationStatusKey, snapshot))
			.catch(() => undefined);
		void api
			.getWecliCatalog({ refresh: true })
			.then((catalog) => queryClient.setQueryData(["wecli", "catalog"], catalog))
			.catch(() => undefined);
	};

	const checkUpdate = useMutation({
		mutationFn: () => api.checkWecliUpdate(),
		onSuccess: setUpdateCheck,
		onError: (error) => toast.error(getUserFacingError(error, "检测更新失败。")),
	});
	const performUpdate = useMutation({
		mutationFn: () => api.performWecliUpdate(),
		onSuccess: (result) => {
			setUpdateCheck(null);
			if (result.updated) toast.success("WeCLI 已更新");
			else toast.info(result.detail ?? "未执行更新");
			refreshAfterUpdate();
		},
		onError: (error) => toast.error(getUserFacingError(error, "更新失败，请稍后重试。")),
	});

	return (
		<section
			className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl border border-edge bg-paper-2/60 px-3 py-2"
			title={observation?.observedAt ? `检测于 ${formatRelativeTime(observation.observedAt)}` : undefined}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				<span className="inline-flex items-center gap-1.5 font-medium text-ink">
					<StatusPip ok /> wecli 已安装
				</span>
				{version && <span className="font-mono text-ink-4">v{version}</span>}
				<span className="text-ink-4">·</span>
				<span className={`inline-flex items-center gap-1.5 ${ext && !ext.connected ? "text-amber" : "text-ink-3"}`}>
					<StatusPip ok={ext?.connected} />
					{ext ? (ext.connected ? "插件已连接" : "插件未连接") : "插件未检测"}
				</span>
				{updateCheck?.updateAvailable && updateCheck.latestVersion && (
					<span className="inline-flex items-center gap-1 text-coral">可更新到 v{updateCheck.latestVersion}</span>
				)}
				{updateCheck && !updateCheck.updateAvailable && (
					<span className="text-ink-4">已是最新</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Button size="sm" variant="ghost" onClick={() => checkUpdate.mutate()} loading={checkUpdate.isPending}>检测更新</Button>
				{updateCheck?.updateAvailable && (
					<Button size="sm" variant="secondary" onClick={() => performUpdate.mutate()} loading={performUpdate.isPending}>更新</Button>
				)}
				<Button size="sm" variant="ghost" onClick={onDetect} loading={detecting} aria-label="检测连接"><ArrowClockwiseIcon size={14} /></Button>
			</div>
		</section>
	);
}

function WecliExtensionInstall({ downloadUrl }: { downloadUrl?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<section className="flex shrink-0 flex-col rounded-lg border border-amber/30 bg-amber-bg/50 px-3 py-2 text-xs">
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1.5">
					<WarningIcon size={13} className="shrink-0 text-amber" />
					<span className="text-ink-2">浏览器插件未连接，部分命令需要它</span>
					<button type="button" onClick={() => setOpen((value) => !value)} className="text-ink-4 hover:text-ink-2">
						{open ? "收起" : "安装步骤"}
					</button>
				</div>
				{downloadUrl && (
					<a
						href={downloadUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-coral px-2.5 text-xs font-medium text-paper hover:bg-coral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<DownloadSimpleIcon size={13} />下载插件
					</a>
				)}
			</div>
			{open && (
				<ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-ink-3">
					<li>下载并解压 <span className="font-mono">wecli-extension-modern.zip</span>。</li>
					<li>Chrome 打开 <span className="font-mono">chrome://extensions</span>。</li>
					<li>开启「开发者模式」→「加载已解压的扩展程序」，选择解压目录。</li>
				</ol>
			)}
		</section>
	);
}

function WecliCatalog() {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<"all" | "browser" | "deprecated">("all");
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const catalog = useQuery({
		queryKey: ["wecli", "catalog"],
		queryFn: () => api.getWecliCatalog(),
		staleTime: 10 * 60_000,
		gcTime: 30 * 60_000,
		refetchOnWindowFocus: false,
	});

	const searching = query.trim().length > 0;
	const sites = useMemo(() => {
		const all = catalog.data?.sites ?? [];
		const q = query.trim().toLowerCase();
		return all
			.map((site) => ({
				name: site.name,
				commands: site.commands.filter((cmd) => {
					if (filter === "browser" && !cmd.browser) return false;
					if (filter === "deprecated" && !cmd.deprecated) return false;
					if (!q) return true;
					return `${cmd.name} ${cmd.description} ${cmd.site}`.toLowerCase().includes(q);
				}),
			}))
			.filter((site) => site.commands.length > 0);
	}, [catalog.data, query, filter]);

	const toggle = (name: string) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	const copy = (cmd: WecliCatalogCommand) => {
		void navigator.clipboard.writeText(`wecli ${cmd.command}`);
		toast.success(`已复制 wecli ${cmd.command}`);
	};

	return (
		<section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-edge bg-paper" data-testid="wecli-catalog">
			<header className="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-3 py-2">
				<div className="flex min-w-0 items-baseline gap-2 text-xs">
					<span className="font-medium text-ink">命令目录</span>
					<span className="text-ink-4">{catalog.data ? `${catalog.data.total} · ${catalog.data.siteCount} 站点` : ""}</span>
				</div>
				<div className="flex items-center gap-0.5">
					{(["all", "browser", "deprecated"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setFilter(value)}
							className={`h-7 rounded-md px-2 text-xs transition-colors ${filter === value ? "bg-ink text-paper" : "text-ink-3 hover:bg-paper-3"}`}
						>
							{value === "all" ? "全部" : value === "browser" ? "需浏览器" : "已弃用"}
						</button>
					))}
				</div>
			</header>
			<div className="shrink-0 border-b border-edge px-3 py-1.5">
				<label className="relative block">
					<MagnifyingGlassIcon size={13} className="pointer-events-none absolute left-2 top-2 text-ink-4" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索命令、用途或站点"
						className="h-7 w-full rounded-md border border-edge bg-paper-2 pl-7 pr-3 text-xs outline-none focus:border-ink-4"
					/>
				</label>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
				{catalog.isLoading ? (
					<p className="p-3 text-xs text-ink-3">正在读取命令目录…</p>
				) : catalog.isError ? (
					<div className="p-3 text-xs text-red">
						命令目录读取失败。
						<button type="button" onClick={() => catalog.refetch()} className="ml-2 text-coral hover:underline">重试</button>
					</div>
				) : sites.length === 0 ? (
					<p className="p-3 text-xs text-ink-4">没有匹配的命令。</p>
				) : (
					sites.map((site) => {
						const isCollapsed = !searching && collapsed.has(site.name);
						return (
							<div key={site.name} className="pt-1.5">
								<button
									type="button"
									onClick={() => toggle(site.name)}
									className="flex w-full items-center gap-2 px-3 pb-1 text-left text-ink-4 hover:text-ink-3"
								>
									{isCollapsed ? <CaretRightIcon size={10} /> : <CaretDownIcon size={10} />}
									<span className="font-mono text-xs uppercase tracking-[0.14em] text-ink-3">{site.name}</span>
									<span className="h-px flex-1 bg-edge" />
									<span className="text-xs tabular-nums text-ink-4">{site.commands.length}</span>
								</button>
								{!isCollapsed && (
									<ul className="divide-y divide-edge/70">
										{site.commands.map((cmd) => (
											<CommandRow key={cmd.command} cmd={cmd} onCopy={() => copy(cmd)} />
										))}
									</ul>
								)}
							</div>
						);
					})
				)}
			</div>
		</section>
	);
}

function CommandRow({ cmd, onCopy }: { cmd: WecliCatalogCommand; onCopy: () => void }) {
	return (
		<li>
			<button
				type="button"
				onClick={onCopy}
				className="group flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-paper-2"
				title={`复制 wecli ${cmd.command}`}
			>
				<code className="min-w-[5rem] max-w-[9rem] shrink-0 truncate font-mono text-xs text-ink">{cmd.name}</code>
				<span className="min-w-0 flex-1 truncate text-xs text-ink-3" title={cmd.description}>{cmd.description || "—"}</span>
				<span className="flex shrink-0 items-center gap-1 text-ink-4">
					{cmd.browser && <GlobeIcon size={11} aria-label="需浏览器" />}
					{cmd.strategy === "public" && <span className="h-1 w-1 rounded-full bg-blue" title="public" />}
					{cmd.deprecated && <span className="text-xs text-amber">弃用</span>}
					<CopyIcon size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />
				</span>
			</button>
		</li>
	);
}

function WecliSetupCard({
	missing,
	observation,
}: {
	missing: boolean;
	observation?: IntegrationConnectionSummary;
}) {
	const queryClient = useQueryClient();
	const [result, setResult] = useState<WecliSetupResult | null>(null);
	const setup = useMutation({
		mutationFn: () => api.setupWecli(),
		onSuccess: (res) => {
			setResult(res);
			void queryClient.invalidateQueries({ queryKey: ["skill-center"] });
			void api
				.refreshIntegrationStatus("wecli")
				.then((snapshot) => queryClient.setQueryData(integrationStatusKey, snapshot))
				.catch(() => undefined);
			void api
				.getWecliCatalog({ refresh: true })
				.then((catalog) => queryClient.setQueryData(["wecli", "catalog"], catalog))
				.catch(() => undefined);
			if (res.succeeded) toast.success("WeCLI 安装完成");
			else toast.error("WeCLI 安装未成功，请查看步骤详情");
		},
		onError: (error) => toast.error(getUserFacingError(error, "安装失败，请稍后重试。")),
	});

	return (
		<section className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-edge bg-paper-2/40 p-4" data-testid="wecli-setup">
			<div>
				<div className="flex items-center gap-2">
					<WarningIcon size={16} className="text-amber" />
					<h4 className="text-sm font-semibold text-ink">{missing ? "未检测到 WeCLI" : "WeCLI 连接异常"}</h4>
				</div>
				<p className="mt-1 text-xs leading-5 text-ink-3">
					{missing
						? "WeMail 的本地能力（命令目录、机器人动作）依赖 WeCLI。一键安装命令本体与使用技能；浏览器插件需手动加载。"
						: observation?.nextAction ?? "WeCLI 已安装但自检未通过，可重新安装或检测。"}
				</p>
			</div>
			<div>
				<Button onClick={() => setup.mutate()} loading={setup.isPending} disabled={setup.isPending}>
					{setup.isPending ? "正在安装…" : missing ? "安装 WeCLI" : "重新安装并检测"}
				</Button>
			</div>
			<SetupSteps result={result} />
			<WecliExtensionInstall />
		</section>
	);
}

function SetupSteps({ result }: { result: WecliSetupResult | null }) {
	if (!result) {
		return (
			<div className="rounded-lg border border-edge bg-paper px-3 py-2.5 text-xs text-ink-3">
				<p className="font-medium text-ink-2">安装步骤</p>
				<ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
					<li><span className="font-mono">wecli</span> 命令本体（npm，必须）</li>
					<li>wecli-usage 使用技能（pm-cli，失败不阻塞）</li>
					<li>浏览器插件（手动下载加载）</li>
				</ol>
				<p className="mt-1.5 text-ink-4">安装约需 1–3 分钟，请保持窗口打开。</p>
			</div>
		);
	}
	const rows: Array<{ label: string; status: WecliSetupStepStatus["status"] | "manual"; detail?: string }> = [
		{ label: "wecli 命令本体", status: result.cli.status, detail: result.cli.detail },
		{
			label: "wecli-usage 技能",
			status: result.skill.status,
			detail: result.skill.registered ? undefined : result.skill.detail ?? "未成功，不影响使用",
		},
		{ label: "浏览器插件", status: "manual" },
	];
	return (
		<ul className="space-y-1.5">
			{rows.map((row) => (
				<li key={row.label} className="flex items-start gap-2 text-xs">
					<StepMark status={row.status} />
					<span className="text-ink-2">{row.label}</span>
					{row.detail && (
						<span className="min-w-0 flex-1 truncate text-ink-4" title={row.detail}>{row.detail}</span>
					)}
				</li>
			))}
		</ul>
	);
}

function StepMark({ status }: { status: WecliSetupStepStatus["status"] | "manual" }) {
	if (status === "ok") return <CheckCircleIcon size={14} weight="fill" className="mt-px shrink-0 text-green" />;
	if (status === "failed") return <WarningIcon size={14} weight="fill" className="mt-px shrink-0 text-amber" />;
	if (status === "skipped") return <CheckCircleIcon size={14} className="mt-px shrink-0 text-ink-4" />;
	return <span className="mt-px shrink-0 rounded-sm bg-paper-3 px-1 text-xs text-ink-4">手动</span>;
}

function StatusPip({ ok }: { ok?: boolean }) {
	const cls = ok === undefined ? "bg-ink-4" : ok ? "bg-green" : "bg-amber";
	return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

function formatRelativeTime(iso: string): string {
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return iso;
	const minutes = Math.round((Date.now() - time) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return new Date(time).toLocaleDateString();
}

function BotConnectionPane({ platform }: { platform: "feishu" | "wecom" }) {
	const queryClient = useQueryClient();
	const label = platform === "feishu" ? "飞书" : "企业微信";
	const [reconfigure, setReconfigure] = useState(false);
	const { data: status } = useIntegrationStatus();
	const profiles = useQuery({
		queryKey: ["channels", "profiles"],
		queryFn: () => api.listChannelProfiles(),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const profile = useMemo(
		() => profiles.data?.profiles.find((item) => item.platform === platform),
		[platform, profiles.data],
	);
	const observation = status?.entries.find((entry) => entry.id === platform);
	const refresh = async (): Promise<ChannelBotProfile[]> => {
		const result = await profiles.refetch();
		const fresh = await api.getIntegrationStatus();
		queryClient.setQueryData(integrationStatusKey, fresh);
		return result.data?.profiles ?? [];
	};

	useEffect(() => setReconfigure(false), [platform]);

	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
			<ConnectionHeader
				title={label}
				description={`WeMail Bot Core · ${platform === "feishu" ? "飞书官方 SDK" : "企业微信官方 SDK"}长连接`}
				observation={observation}
				profile={profile}
				reconfigure={reconfigure}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{profile && !reconfigure ? (
					<ProfileConsole profile={profile} observation={observation} onRefresh={refresh} onReconfigure={() => setReconfigure(true)} />
				) : (
					<GatewaySetup
						platform={platform}
						onBack={profile ? () => setReconfigure(false) : undefined}
						onCompleted={() => {
							setReconfigure(false);
							void refresh();
						}}
					/>
				)}
			</div>
		</div>
	);
}

function ConnectionHeader({
	title,
	description,
	observation,
	profile,
	reconfigure = false,
}: {
	title: string;
	description: string;
	observation?: { state: string; observedAt: string | null; reasonCode?: string; nextAction?: string };
	profile?: ChannelBotProfile;
	reconfigure?: boolean;
}) {
	// In reconfigure mode the user is re-entering Bot credentials, so the
	// progress bar must drop back to the Bot step regardless of the profile's
	// persisted onboarding state — otherwise the bar advertises "Bot 已就绪"
	// directly above a "请输入 Bot ID/Secret" form.
	const stage = !profile ? 0 : reconfigure ? 0 : stageFor(profile.onboardingState);
	return (
		<header className="shrink-0 border-b border-edge pb-3">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h3 className="font-serif-display text-xl font-semibold leading-none text-ink">{title}</h3>
					<p className="mt-1.5 truncate text-xs text-ink-3">{description}</p>
				</div>
				<div className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${observation?.state === "connected" ? "bg-green-bg text-green" : "bg-paper-3 text-ink-3"}`}>
					{observation?.state === "connected" ? "已连接" : statusLabel(observation?.state)}
				</div>
			</div>
			{profile && (
				<div className="mt-3 flex items-center gap-2" aria-label="连接进度">
					{["Bot", "主人", "就绪"].map((label, index) => {
						const complete = stage > index;
						const current = stage === index;
						return (
							<div key={label} data-testid={index === 0 ? "stage-bot" : index === 1 ? "stage-owner" : "stage-ready"} data-state={complete ? "complete" : current ? "current" : "pending"} className="flex min-w-0 flex-1 items-center gap-2">
								<span className={`h-1.5 min-w-0 flex-1 rounded-full ${complete ? "bg-green" : current ? "bg-coral" : "bg-paper-3"}`} />
								<span className={`text-xs uppercase tracking-wider ${complete || current ? "text-ink-2" : "text-ink-4"}`}>{label}</span>
							</div>
						);
					})}
				</div>
			)}
			{observation?.nextAction && observation.state !== "connected" && (
				<p className="mt-2 truncate text-xs text-amber">{observation.nextAction}</p>
			)}
		</header>
	);
}

function GatewaySetup({
	platform,
	onCompleted,
	onBack,
}: {
	platform: "feishu" | "wecom";
	onCompleted: () => void;
	onBack?: () => void;
}) {
	const [mode, setMode] = useState<"create" | "existing">("create");
	return (
		<div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
			<div className="flex shrink-0 items-center gap-2">
				<div className="grid min-w-0 flex-1 grid-cols-2 rounded-lg border border-edge bg-paper-2 p-1" role="tablist" aria-label="Bot 配置方式">
					<SetupModeButton active={mode === "create"} label="新增 Bot" onClick={() => setMode("create")} />
					<SetupModeButton active={mode === "existing"} label="使用现存 Bot" onClick={() => setMode("existing")} />
				</div>
				{onBack && <Button size="sm" variant="ghost" onClick={onBack}>返回</Button>}
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				{mode === "create" ? <CreateBotSetup platform={platform} onCompleted={onCompleted} /> : <ExistingBotSetup platform={platform} onCompleted={onCompleted} />}
			</div>
		</div>
	);
}

function SetupModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
	return (
		<button type="button" role="tab" aria-selected={active} onClick={onClick} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${active ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>
			{label}
		</button>
	);
}

function CreateBotSetup({ platform, onCompleted }: { platform: "feishu" | "wecom"; onCompleted: () => void }) {
	const label = platform === "feishu" ? "飞书" : "企业微信";
	const [setup, setSetup] = useState<ChannelBotSetup | null>(null);
	const [qrDataUrl, setQrDataUrl] = useState("");
	const start = useMutation({
		mutationFn: () => api.startChannelBotSetup(platform),
		onSuccess: ({ setup: result }) => setSetup(result),
		onError: (error) => toast.error(getUserFacingError(error, "配置链接生成失败，请稍后重试。")),
	});
	const cancel = useMutation({
		mutationFn: (setupId: string) => api.cancelChannelBotSetup(setupId),
		onSettled: () => {
			setSetup(null);
			setQrDataUrl("");
		},
	});

	useEffect(() => {
		setSetup(null);
		setQrDataUrl("");
	}, [platform]);

	useEffect(() => {
		if (!setup?.qrPayload) {
			setQrDataUrl("");
			return;
		}
		let disposed = false;
		void QRCode.toDataURL(setup.qrPayload, {
			errorCorrectionLevel: "M",
			margin: 1,
			width: 160,
			color: { dark: "#18201b", light: "#ffffff" },
		}).then((value) => {
			if (!disposed) setQrDataUrl(value);
		}).catch(() => {
			if (!disposed) setQrDataUrl("");
		});
		return () => {
			disposed = true;
		};
	}, [setup?.qrPayload]);

	useEffect(() => {
		if (!setup || setup.status !== "waiting") return;
		let disposed = false;
		let timer: number;
		const poll = async () => {
			try {
				const result = await api.getChannelBotSetup(setup.id);
				if (disposed) return;
				setSetup(result.setup);
				if (result.setup.status === "connected") {
					toast.success(`${label} Bot 已创建并安全连接`);
					onCompleted();
				}
			} catch (error) {
				if (!disposed) {
					toast.error(getUserFacingError(error, "扫码状态检查失败，请稍后重试。"));
					timer = window.setTimeout(poll, 5_000);
				}
			}
		};
		timer = window.setTimeout(poll, Math.max(1_500, setup.retryAfterMs));
		return () => {
			disposed = true;
			window.clearTimeout(timer);
		};
	}, [label, onCompleted, setup]);

	if (!setup) {
		return (
			<section className="flex h-full min-h-0 items-center rounded-xl border border-edge bg-paper-2/40 px-5">
				<div className="grid w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-4">
					<div className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-paper text-coral"><QrCodeIcon size={22} weight="duotone" /></div>
					<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-semibold text-ink">扫码新增 {label} Bot <span className="rounded-full bg-green-bg px-2 py-0.5 text-xs text-green">推荐</span></div>
					<p className="mt-1 max-w-lg text-xs leading-4 text-ink-3">生成官方配置链接与二维码；确认后自动创建、保存凭据并建立长连接。</p>
					</div>
					<Button size="sm" onClick={() => start.mutate()} loading={start.isPending}>生成链接与二维码</Button>
				</div>
			</section>
		);
	}

	if (setup.status === "connected") {
		return <CompactNotice tone="success" title="Bot 已创建并连接" detail="正在进入主人配对。" />;
	}

	if (setup.status === "failed" || setup.status === "expired") {
		return (
			<CompactNotice tone="warning" title={setup.status === "expired" ? "配置链接已过期" : "自动创建未完成"} detail="可以重新生成，或切换到现存 Bot。">
				<Button size="sm" variant="secondary" onClick={() => start.mutate()} loading={start.isPending}>重新生成</Button>
			</CompactNotice>
		);
	}

	return (
		<section className="grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-xl border border-edge bg-paper @min-[560px]/settings-section:grid-cols-[176px_minmax(0,1fr)]">
			<div className="grid place-items-center border-b border-edge bg-paper-2 p-3 sm:border-b-0 sm:border-r">
				{qrDataUrl ? <img src={qrDataUrl} alt={`${label} Bot 配置二维码`} className="h-36 w-36 rounded-lg border border-edge bg-white p-1.5 shadow-sm" /> : <div className="h-36 w-36 animate-pulse rounded-lg bg-paper-3 motion-reduce:animate-none" />}
			</div>
			<div className="flex min-w-0 flex-col justify-center p-4">
				<div className="flex items-center gap-2 text-sm font-semibold text-ink"><span className="h-2 w-2 animate-pulse rounded-full bg-coral motion-reduce:animate-none" />等待扫码确认</div>
				<p className="mt-1 text-xs text-ink-3">使用{label}手机端扫码，或打开同一个官方配置链接。</p>
				<div className="mt-3 flex flex-wrap gap-2">
					<a href={setup.configurationUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-coral px-3 text-xs font-medium text-paper hover:bg-coral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">打开配置链接<ArrowSquareOutIcon size={14} /></a>
					<CopyButton size="sm" variant="secondary" text={setup.configurationUrl} labels={{ idle: "复制链接", copied: "配置链接已复制" }} />
					<Button size="sm" variant="ghost" onClick={() => cancel.mutate(setup.id)} loading={cancel.isPending}>取消</Button>
				</div>
				<div className="mt-3 truncate rounded-md border border-edge bg-paper-2 px-2 py-1.5 font-mono text-xs text-ink-4" title={setup.configurationUrl}>{setup.configurationUrl}</div>
				<div className="mt-2 text-xs text-ink-4">有效期至 {new Date(setup.expiresAt).toLocaleTimeString()}</div>
			</div>
		</section>
	);
}

function ExistingBotSetup({ platform, onCompleted }: { platform: "feishu" | "wecom"; onCompleted: () => void }) {
	const [botId, setBotId] = useState("");
	const [botSecret, setBotSecret] = useState("");
	const connect = useMutation({
		mutationFn: () => platform === "feishu"
			? api.saveBotChannelConfiguration(platform, { appId: botId, appSecret: botSecret })
			: api.saveBotChannelConfiguration(platform, { botId, botSecret }),
		onSuccess: () => {
			setBotSecret("");
			onCompleted();
			toast.success("配置已安全保存，Bot Core 正在建立长连接");
		},
		onError: (error) => toast.error(getUserFacingError(error, "机器人连接配置失败，请稍后重试。")),
	});
	const label = platform === "feishu" ? "飞书应用" : "企业微信智能机器人";
	return (
		<section className="grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-xl border border-edge @min-[560px]/settings-section:grid-cols-[minmax(0,0.8fr)_minmax(260px,1.2fr)]">
			<div className="flex flex-col justify-center border-b border-edge bg-paper-2 p-4 sm:border-b-0 sm:border-r">
				<div className="flex items-center gap-2 text-sm font-semibold text-ink"><RobotIcon size={18} className="text-coral" />接入现存{label}</div>
				<p className="mt-2 text-xs leading-4 text-ink-3">{platform === "feishu" ? "确认应用已启用机器人能力、消息事件与长连接，并完成版本发布。" : "确认智能机器人已启用 API 模式与长连接。"}</p>
				<a href={platform === "feishu" ? "https://open.feishu.cn/app" : "https://work.weixin.qq.com/wework_admin/frame#apps"} target="_blank" rel="noreferrer" className="mt-3 text-xs text-coral hover:underline">打开官方后台 <ArrowSquareOutIcon size={12} className="inline" /></a>
			</div>
			<div className="flex flex-col justify-center p-4">
				<label className="text-xs font-medium text-ink-3">{platform === "feishu" ? "App ID" : "Bot ID"}</label>
				<input value={botId} onChange={(event) => setBotId(event.target.value)} placeholder={platform === "feishu" ? "cli_xxxxxxxxx" : "Bot ID"} className="mt-1 w-full rounded-lg border border-edge bg-paper px-3 py-2 text-sm outline-none focus:border-coral" aria-label={platform === "feishu" ? "飞书 App ID" : "企微 Bot ID"} />
				<label className="mt-2 text-xs font-medium text-ink-3">{platform === "feishu" ? "App Secret" : "Bot Secret"}</label>
				<input value={botSecret} onChange={(event) => setBotSecret(event.target.value)} type="password" placeholder="••••••••••••" className="mt-1 w-full rounded-lg border border-edge bg-paper px-3 py-2 text-sm outline-none focus:border-coral" aria-label={platform === "feishu" ? "飞书 App Secret" : "企微 Bot Secret"} />
				<div className="mt-3 flex items-center justify-between gap-3">
					<span className="text-xs text-ink-4">凭据加密保存，不会回显。</span>
					<Button size="sm" onClick={() => connect.mutate()} loading={connect.isPending} disabled={!botId || !botSecret}>保存并连接</Button>
				</div>
			</div>
		</section>
	);
}

function ProfileConsole({ profile, observation, onRefresh, onReconfigure }: { profile: ChannelBotProfile; observation?: IntegrationConnectionSummary; onRefresh: () => Promise<ChannelBotProfile[]>; onReconfigure: () => void }) {
	const [confirmReset, setConfirmReset] = useState(false);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const [command, setCommand] = useState("");
	const pairing = useMutation({
		mutationFn: () => api.createOwnerPairing(profile.id),
		onSuccess: ({ pairing: result }) => {
			setCommand(result.command);
		},
		onError: (error) => toast.error(getUserFacingError(error, "配对命令生成失败，请稍后重试。")),
	});
	const cancelPairing = useMutation({
		mutationFn: () => api.cancelOwnerPairing(profile.id),
		onSuccess: async () => {
			setCommand("");
			toast.success(profile.owner ? "已保留当前主人" : "已退出主人配对");
			await onRefresh();
		},
		onError: (error) => toast.error(getUserFacingError(error, "退出重新绑定失败，请稍后重试。")),
	});
	const detect = useMutation({ mutationFn: () => api.detectChannelProfile(profile.id), onSuccess: onRefresh });
	const testMessage = useMutation({
		mutationFn: () => api.sendChannelTestMessage(profile.id),
		onSuccess: () => toast.success("测试消息已进入发送队列"),
		onError: (error) => toast.error(getUserFacingError(error, "测试消息发送失败，请稍后重试。")),
	});
	const retryInitialization = useMutation({
		mutationFn: () => api.retryChannelInitialization(profile.id),
		onSuccess: async () => { toast.success("初始化消息已重新进入发送队列"); await onRefresh(); },
		onError: (error) => toast.error(getUserFacingError(error, "初始化重试失败，请稍后重试。")),
	});
	const disconnect = useMutation({
		mutationFn: () => api.disconnectChannelProfile(profile.id),
		onSuccess: async () => { setConfirmDisconnect(false); toast.success("机器人连接已断开"); await onRefresh(); },
		onError: (error) => toast.error(getUserFacingError(error, "断开连接失败，请稍后重试。")),
	});
	const reset = useMutation({
		mutationFn: () => api.resetChannelProfile(profile.id),
		onSuccess: async () => {
			setCommand("");
			setConfirmReset(false);
			toast.success("旧连接状态已清理，请重新绑定主人");
			await onRefresh();
		},
		onError: (error) => toast.error(getUserFacingError(error, "连接状态清理失败，请稍后重试。")),
	});
	const checkPairing = useMutation({
		mutationFn: () => onRefresh(),
		onSuccess: (freshProfiles) => {
			const updated = freshProfiles.find((item) => item.id === profile.id);
			if (!updated) {
				toast.error("未能读取到当前机器人状态");
				return;
			}
			if (updated.onboardingState === "ready" && updated.owner) {
				toast.success("配对完成，机器人已就绪");
			} else if (updated.owner) {
				toast.success("主人已验证，正在发送初始化消息");
			} else if (updated.lastErrorCode) {
				toast.error(`配对未完成：${updated.lastErrorCode}`);
			} else {
				toast.info("暂未检测到配对，请确认命令已在私聊中发出");
			}
		},
		onError: (error) => toast.error(getUserFacingError(error, "检查配对结果失败，请稍后重试。")),
	});
	const destinations = useQuery({
		queryKey: ["channels", profile.id, "destinations"],
		queryFn: () => api.listChannelDestinations(profile.id),
		enabled: profile.onboardingState === "ready",
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const dependentRules = useQuery({
		queryKey: ["channels", profile.id, "dependent-rules"],
		queryFn: () => api.listChannelDependentRules(profile.id),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const needsRuleReview = dependentRules.data?.rules.some((rule) => rule.needsReauthorization);
	const deliberatelyDisconnected = profile.onboardingState === "bot_selected" && profile.lastErrorCode === "channel-disconnected-by-user";
	const pairingActive = profile.onboardingState === "owner_pairing" || Boolean(command);
	const lifecycleConflict =
		profile.onboardingState === "bot_selected" &&
		profile.lastErrorCode !== "channel-disconnected-by-user" &&
		Boolean(profile.owner || profile.initializedAt);
	const isCredentialReason = (code?: string) => code === "platform-authentication-failed" || code === "platform-credential-invalid";
	// A live platform-side disconnect (Bot Core could not establish the long
	// connection) blocks pairing — the command cannot be received. This is
	// distinct from a user-chosen disconnect (channel-disconnected-by-user),
	// which `deliberatelyDisconnected` handles first.
	const connectionDown = observation?.state === "disconnected" && profile.lastErrorCode !== "channel-disconnected-by-user";

	useEffect(() => {
		if (!command) return;
		const timer = window.setInterval(() => {
			void onRefresh();
		}, 2_500);
		return () => window.clearInterval(timer);
	}, [command, profile.onboardingState]);

	const lifecycleRef = useRef({ id: profile.id, owner: !!profile.owner, ready: profile.onboardingState === "ready" });
	useEffect(() => {
		const prev = lifecycleRef.current;
		const next = { id: profile.id, owner: !!profile.owner, ready: profile.onboardingState === "ready" };
		lifecycleRef.current = next;
		if (prev.id !== next.id) return; // skip spurious transitions across profile/platform switches
		if (!prev.owner && next.owner) {
			toast.success("配对成功，正在发送初始化消息");
		} else if (!prev.ready && next.ready && next.owner) {
			toast.success("机器人已就绪");
		}
	}, [profile.id, profile.owner, profile.onboardingState]);

	// Clear the pairing command only when it genuinely completes — the profile
	// transitions INTO ready with an owner. Clearing whenever the (possibly stale)
	// snapshot is already ready would wipe a freshly-generated "replace owner"
	// command before the server-side owner_pairing state arrives.
	const prevOnboardingRef = useRef(profile.onboardingState);
	useEffect(() => {
		if (
			command &&
			profile.onboardingState === "ready" &&
			profile.owner &&
			prevOnboardingRef.current !== "ready"
		) {
			setCommand("");
		}
		prevOnboardingRef.current = profile.onboardingState;
	}, [command, profile.onboardingState, profile.owner]);

	const dialogs = (
		<>
			<ConfirmActionDialog
				open={confirmReset}
				onOpenChange={setConfirmReset}
				title="重置连接？"
				description="Bot 凭据会保留；旧主人、邮箱绑定、配对命令和消息目的地将失效，随后需要重新绑定主人。已发送历史不会删除。"
				confirmLabel="重置并重新绑定"
				destructive
				pending={reset.isPending}
				onConfirm={() => reset.mutate()}
			/>
			<ConfirmActionDialog
				open={confirmDisconnect}
				onOpenChange={setConfirmDisconnect}
				title="断开机器人连接？"
				description="Bot 将暂停接收和发送消息（凭据与主人保留）。重新连接后需要重新配对主人并完成初始化。"
				confirmLabel="断开连接"
				destructive
				pending={disconnect.isPending}
				onConfirm={() => disconnect.mutate()}
			/>
		</>
	);

	let body: React.ReactNode;
	if (lifecycleConflict) {
		body = (
			<CompactNotice tone="warning" title="连接状态需要重置" detail="检测到当前 Bot 与已保存的主人或初始化记录不一致。重置后即可重新绑定，不会删除 Bot 凭据。">
				<Button size="sm" onClick={() => setConfirmReset(true)}>重置连接</Button>
				<Button size="sm" variant="secondary" onClick={onRefresh}>重新检测</Button>
			</CompactNotice>
		);
	} else if (deliberatelyDisconnected) {
		body = (
			<CompactNotice title="Bot 已断开" detail="凭据仍保留；更换凭据或重置前不会接收或发送消息。">
				<Button size="sm" onClick={onReconfigure}>更换 Bot 凭据</Button>
				<Button size="sm" variant="secondary" onClick={onRefresh}>刷新状态</Button>
				<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>重置连接</Button>
			</CompactNotice>
		);
	} else if (connectionDown) {
		const credentialReason = isCredentialReason(observation?.reasonCode);
		body = (
			<CompactNotice tone="critical" title="机器人连接未建立" detail={`配对命令暂时无法接收，因为机器人与平台的连接未建立。${observation?.nextAction ?? "请检查平台机器人凭据与长连接配置。"}`}>
				<Button size="sm" onClick={credentialReason ? onReconfigure : () => detect.mutate()} loading={!credentialReason && detect.isPending}>{credentialReason ? "更换 Bot 凭据" : "重新检测连接"}</Button>
				<Button size="sm" variant="secondary" onClick={credentialReason ? () => detect.mutate() : onReconfigure} loading={credentialReason && detect.isPending}>{credentialReason ? "重新检测连接" : "更换 Bot 凭据"}</Button>
				<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>重置连接</Button>
			</CompactNotice>
		);
	} else if (pairingActive || !profile.owner) {
		body = (
			<section className="flex min-h-[260px] items-start rounded-xl border border-edge bg-paper-2/40 p-5">
				<div className="w-full">
					<div className="flex items-start justify-between gap-4">
						<div>
							<div className="text-sm font-semibold text-ink">{profile.owner ? "重新绑定等待中" : "绑定主人"}</div>
							<p className="mt-1 text-xs leading-4 text-ink-3">{command ? `让新主人在与「${profile.displayName}」的私聊中发送：` : profile.owner ? "原主人仍被保留；生成新命令即可切换。" : `让主人在与「${profile.displayName}」的私聊中发送一次性命令。`}</p>
						</div>
						<div className="flex shrink-0 items-center gap-3">
							<span className="rounded-full bg-amber-bg px-2 py-1 text-xs text-amber">等待主人</span>
						</div>
					</div>
					{command && (
						<div className="mt-3 flex items-center gap-2 rounded-lg border border-edge bg-paper px-3 py-2">
							<code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{command}</code>
							<CopyButton variant="ghost" size="sm" iconOnly iconSize={16} className="h-8 w-8 p-0 text-ink-3 hover:text-ink" text={command} labels={{ idle: "复制配对命令", copied: "已复制" }} aria-label="复制配对命令" />
						</div>
					)}
					<div className="mt-4 flex flex-wrap items-center gap-2">
						{!command && <Button size="sm" onClick={() => pairing.mutate()} loading={pairing.isPending}>{profile.owner ? "重新生成命令" : "生成配对命令"}</Button>}
						<Button size="sm" variant="secondary" onClick={() => checkPairing.mutate()} loading={checkPairing.isPending}>检查配对结果</Button>
						<Button size="sm" variant="ghost" onClick={() => cancelPairing.mutate()} loading={cancelPairing.isPending}>{profile.owner ? "保留当前主人" : "退出配对"}</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(true)}>断开连接</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>重置连接</Button>
					</div>
					{needsRuleReview && <p className="mt-3 text-xs text-amber">主人变化后，相关自动化规则需要重新确认。</p>}
				</div>
			</section>
		);
	} else if (profile.onboardingState !== "ready") {
		body = (
			<CompactNotice tone={profile.lastErrorCode ? "warning" : "neutral"} title={profile.lastErrorCode ? "初始化消息发送失败" : "正在完成初始化"} detail={profile.lastErrorCode ? "初始化消息发送失败。连接不会显示为已连接，重试成功后会自动进入就绪状态。" : "主人已验证；初始化消息送达后会自动进入就绪状态。"}>
				{profile.lastErrorCode && <span className="mr-auto text-meta text-amber">失败原因：{profile.lastErrorCode}</span>}
				{profile.lastErrorCode && <Button size="sm" onClick={() => retryInitialization.mutate()} loading={retryInitialization.isPending}>重试初始化消息</Button>}
				<Button size="sm" variant="secondary" onClick={onRefresh}>刷新状态</Button>
				<Button size="sm" variant="ghost" onClick={onReconfigure}>更换 Bot 凭据</Button>
				<Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(true)}>断开连接</Button>
				<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>重置连接</Button>
			</CompactNotice>
		);
	} else {
		const destinationCount = destinations.data?.destinations.length ?? 0;
		body = (
			<section className="flex min-h-[250px] flex-col gap-4 rounded-xl border border-edge bg-paper-2/40 p-5">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
					<div className="min-w-0">
						<div className="truncate text-sm font-semibold text-ink">{profile.displayName}</div>
						<div className="mt-1 text-xs text-ink-3">主人：{profile.owner.displayName || maskId(profile.owner.userId)}</div>
					</div>
					<div className="flex items-start gap-3 text-right font-mono text-xs leading-4 text-ink-4">
						<div>OWNER v{profile.owner.bindingVersion}<br />INIT v{profile.initializationVersion}</div>
					</div>
				</div>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					<Metric label="连接状态" value="运行中" tone="success" />
					<Metric label="消息目的地" value={destinationCount ? `${destinationCount} 个已配置` : "默认仅向主人发送"} />
					<Metric label="初始化" value="已送达" />
				</div>
				{needsRuleReview && <div className="rounded-lg border border-amber/30 bg-amber-bg px-3 py-2 text-xs text-amber">有自动化规则仍绑定旧主人版本，请重新预览并确认。</div>}
				<div className="flex flex-wrap gap-2 border-t border-edge pt-3">
					<Button size="sm" onClick={() => detect.mutate()} loading={detect.isPending}>检测连接</Button>
					<Button size="sm" variant="secondary" onClick={() => testMessage.mutate()} loading={testMessage.isPending}>发送测试消息</Button>
					<Button size="sm" variant="ghost" onClick={() => pairing.mutate()} loading={pairing.isPending}>更换主人</Button>
					<Button size="sm" variant="ghost" onClick={onReconfigure}>更换 Bot 凭据</Button>
					<Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(true)}>断开连接</Button>
					<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>重置连接</Button>
				</div>
			</section>
		);
	}

	return (<>{body}{dialogs}</>);
}

function CompactNotice({ title, detail, tone = "neutral", children }: { title: string; detail: string; tone?: "neutral" | "success" | "warning" | "critical"; children?: React.ReactNode }) {
	const toneClass = tone === "success" ? "border-green/30 bg-green-bg" : tone === "warning" ? "border-amber/30 bg-amber-bg" : tone === "critical" ? "border-red/30 bg-red/5" : "border-edge bg-paper-2/40";
	return (
		<section className={`flex h-full min-h-0 items-center rounded-xl border p-5 ${toneClass}`}>
			<div className="w-full">
				<div className="text-sm font-semibold text-ink">{title}</div>
				<p className="mt-1 max-w-xl text-xs leading-4 text-ink-3">{detail}</p>
				{children && <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>}
			</div>
		</section>
	);
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "success" }) {
	return (
		<div className="min-w-0 rounded-lg border border-edge bg-paper px-3 py-2">
			<div className="text-xs uppercase tracking-wider text-ink-4">{label}</div>
			<div className={`mt-1 truncate text-xs font-medium ${tone === "success" ? "text-green" : "text-ink-2"}`}>{value}</div>
		</div>
	);
}

/** Map a profile's onboarding state to a 0..3 progress-bar stage.
 *  0 = Bot step, 1 = 主人 (pairing), 2 = 就绪 (initializing), 3 = ready. */
function stageFor(state: ChannelBotProfile["onboardingState"]): number {
	switch (state) {
		case "ready":
			return 3;
		case "owner_verified":
		case "initialization_pending":
			return 2;
		case "bot_selected":
		case "owner_pairing":
			return 1;
		case "draft":
		case "gateway_verified":
		default:
			return 0;
	}
}

function statusLabel(state?: string) {
	if (state === "attention") return "需要配置";
	if (state === "disconnected") return "连接异常";
	if (state === "not_configured") return "尚未配置";
	if (state === "unknown") return "等待检测";
	return "状态未知";
}

function maskId(value: string) {
	return value.length <= 8 ? value : `…${value.slice(-6)}`;
}
