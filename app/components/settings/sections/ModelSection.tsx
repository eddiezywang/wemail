// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → AI 模型.
 *
 * The desktop server's only writable settings endpoint is
 * `/api/settings/llm`. This section is the single entry point for
 * configuring the LLM provider, credentials, and per-capability model
 * routing (summary / draft / agent). A live status pill driven by
 * `/api/system/llm-status` shows whether the runtime can actually
 * reach the configured model.
 *
 * UX notes:
 *  - API key is write-only on the server (the GET payload only exposes
 *    a `hasApiKey` boolean). We keep the key field empty on load and
 *    surface a "已配置" chip when the server reports a key on file.
 *    Submitting without typing a new key preserves the stored secret.
 *  - The save action is a single explicit button — silent autosave is
 *    risky for credentials.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { toast } from "sonner";
import { getFreeTrialError, getUserFacingError } from "~/lib/user-facing-error";
import {
	useActivateFreeTrial,
	useDiscoverLlmModels,
	useFreeTrialResource,
	useLlmSettings,
	useLlmStatus,
	useSaveLlmSettings,
} from "~/queries/llmSettings";
import { useCurrentAccount } from "~/queries/currentAccount";
import { ModelPicker } from "~/components/llm/ModelPicker";
import {
	FreeTrialShimmer,
	FreeTrialSparkles,
} from "~/components/wemail/FreeTrialSparkles";
import type {
	DiscoveredLlmModel,
	FreeTrialResourceInfo,
	LlmSettings,
	LlmStatus,
	LlmStatusError,
} from "~/services/api";
import type { LlmReasoningEffort } from "../../../../shared/wemail/settings";

interface DraftSettings {
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	summaryModel: string;
	draftModel: string;
	agentModel: string;
	reasoningEffort: LlmReasoningEffort;
}

const EMPTY: DraftSettings = {
	baseUrl: "",
	apiKey: "",
	defaultModel: "",
	summaryModel: "",
	draftModel: "",
	agentModel: "",
	reasoningEffort: "auto",
};

function isFreeTrialEntryVisible(
	resource: FreeTrialResourceInfo | null | undefined,
	accountEmail: string,
): boolean {
	if (!resource?.enabled) return false;
	if (resource.allowedDomains.length === 0 || !accountEmail) return true;
	const domain = accountEmail.slice(accountEmail.lastIndexOf("@") + 1).toLowerCase();
	return resource.allowedDomains.some(
		(allowedDomain) => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`),
	);
}

export function ModelSection() {
	const { data: settings, isLoading } = useLlmSettings();
	const { data: status } = useLlmStatus();
	const { data: freeTrialResource } = useFreeTrialResource();
	const { data: accountData } = useCurrentAccount();
	const freeTrialEntryVisible = isFreeTrialEntryVisible(
		freeTrialResource,
		accountData?.account?.emailAddress ?? "",
	);
	const saveMut = useSaveLlmSettings();
	const discoverMut = useDiscoverLlmModels();
	const runDiscovery = discoverMut.mutate;

	const [draft, setDraft] = useState<DraftSettings>(EMPTY);
	const [dirty, setDirty] = useState(false);
	const [models, setModels] = useState<DiscoveredLlmModel[]>([]);
	const autoDiscoveredRef = useRef<string | null>(null);
	// 免费额度模式下，用户可展开自定义模型配置（保存后切换，freeTrial=false）。
	const [showCustomConfig, setShowCustomConfig] = useState(false);

	// 切回免费额度 → 默认收起自定义表单（黑盒），一键切换完整。
	useEffect(() => {
		if (settings?.freeTrial === true) {
			setShowCustomConfig(false);
		}
	}, [settings?.freeTrial]);

	useEffect(() => {
		if (!settings) return;
		setDraft({
			baseUrl: settings.baseUrl ?? "",
			apiKey: "", // Never re-display the stored key.
			defaultModel: settings.defaultModel ?? "",
			summaryModel: settings.summaryModel ?? "",
			draftModel: settings.draftModel ?? "",
			agentModel: settings.agentModel ?? "",
			reasoningEffort: settings.reasoningEffort ?? "auto",
		});
		setDirty(false);
	}, [settings]);

	const discoverModels = useCallback((input?: { baseUrl?: string; apiKey?: string }) => {
		runDiscovery(
			{
				provider: settings?.provider,
				baseUrl: input?.baseUrl ?? (draft.baseUrl.trim() || undefined),
				...(input?.apiKey ?? draft.apiKey.trim()
					? { apiKey: input?.apiKey ?? draft.apiKey.trim() }
					: {}),
			},
			{
				onSuccess: (result) => {
					setModels(result.models);
					setDraft((previous) =>
						!previous.defaultModel && result.models.length === 1
							? { ...previous, defaultModel: result.models[0]!.id }
							: previous,
					);
				},
				onError: () => setModels([]),
			},
		);
	}, [draft.apiKey, draft.baseUrl, runDiscovery, settings?.provider]);

	useEffect(() => {
		if (!settings?.hasApiKey) {
			autoDiscoveredRef.current = null;
			return;
		}
		const discoveryKey = `${settings.provider}|${settings.baseUrl ?? ""}`;
		if (autoDiscoveredRef.current === discoveryKey) return;
		autoDiscoveredRef.current = discoveryKey;
		discoverModels({ baseUrl: settings.baseUrl });
	}, [discoverModels, settings]);

	useEffect(() => {
		if (!draft.apiKey.trim()) return;
		const timer = window.setTimeout(() => {
			discoverModels();
		}, 600);
		return () => window.clearTimeout(timer);
	}, [draft.apiKey, draft.baseUrl, discoverModels]);

	const setField = <K extends keyof DraftSettings>(
		key: K,
		value: DraftSettings[K],
	) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setDirty(true);
	};

	const onSave = () => {
		if (!draft.defaultModel.trim()) {
			toast.error("请填写默认模型");
			return;
		}
		const payload = {
			baseUrl: draft.baseUrl.trim() || undefined,
			defaultModel: draft.defaultModel.trim(),
			summaryModel: draft.summaryModel.trim() || undefined,
			draftModel: draft.draftModel.trim() || undefined,
			agentModel: draft.agentModel.trim() || undefined,
			reasoningEffort: draft.reasoningEffort,
			...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
		};
		saveMut.mutate(payload, {
			onSuccess: () => {
				toast.success("已保存模型设置");
				setDirty(false);
			},
			onError: (err) =>
				toast.error(getUserFacingError(err, "模型设置保存失败，请稍后重试。")),
		});
	};

	const hasKey = !!settings?.hasApiKey;
	const configured = !!status?.configured;

	/**
	 * 展开自定义模型表单：draft 始终预填用户自定义配置（主配置），
	 * 免费额度单独存储，表单绝不接触免费网关地址。
	 */
	const openCustomConfig = () => {
		setDirty(false);
		setShowCustomConfig(true);
	};
	const discoveryStatus = discoverMut.isPending
		? "loading"
		: discoverMut.isError
			? "error"
			: discoverMut.isSuccess
				? "success"
				: "idle";

	return (
		<div className="space-y-5">
			<div>
				<h2 className="text-base font-semibold text-ink mb-1">AI 模型</h2>
				<p className="text-xs text-ink-3">
					填写端点和密钥后会自动探测 OpenAI 兼容 / Anthropic 协议；已有密钥会自动复用，无需重复填写。
					摘要、草稿、Agent 会按下方对应字段路由模型。
				</p>
			</div>

			<FreeTrialCard
				settings={settings ?? undefined}
				failure={
					settings?.freeTrial === true &&
					status?.health?.availability === "unreachable"
						? status.health.lastError ?? undefined
						: undefined
				}
				onActivated={(expiresAt) => {
					toast.success("免费额度已恢复");
					setShowCustomConfig(false);
					setDirty(false);
				}}
			/>

			<StatusPill
				configured={configured}
				status={status}
				loading={isLoading}
				freeTrial={settings?.freeTrial === true}
				hasFreeTrialEntry={freeTrialEntryVisible}
			/>

			{settings?.freeTrial === true ? (
				// 免费额度：黑盒展示，模型由免费额度提供（不可换）；
				// 但保留切换到用户自定义模型的入口。
				<div className="rounded-md border border-edge bg-paper-2 p-4">
					<div className="flex items-center justify-between gap-3">
						<div className="text-xs leading-5 text-ink-3">
							AI 功能由免费额度提供，无需任何配置。
							{showCustomConfig
								? "填写自己的模型配置并保存后，将使用自定义模型（不再使用免费额度）。"
								: "如需使用自己的模型，可切换到自定义配置。"}
						</div>
						{!showCustomConfig ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={openCustomConfig}
							>
								使用自定义模型
							</Button>
						) : null}
					</div>
					{showCustomConfig ? (
						<div className="mt-4 space-y-4">
							<CustomModelFields
								draft={draft}
								setField={setField}
								hasKey={hasKey}
								models={models}
								setModels={setModels}
								discoverMut={discoverMut}
								discoverModels={discoverModels}
								discoveryStatus={discoveryStatus}
							/>
							<div className="flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setShowCustomConfig(false)}
									disabled={dirty}
								>
									取消
								</Button>
								<Button
									type="button"
									onClick={onSave}
									disabled={!dirty || saveMut.isPending}
									loading={saveMut.isPending}
								>
									保存并切换
								</Button>
							</div>
						</div>
					) : null}
				</div>
			) : (
				<>
					<CustomModelFields
						draft={draft}
						setField={setField}
						hasKey={hasKey}
						models={models}
						setModels={setModels}
						discoverMut={discoverMut}
						discoverModels={discoverModels}
						discoveryStatus={discoveryStatus}
					/>

					<div className="flex items-center justify-end gap-2">
						{dirty ? (
							<span className="text-xs text-ink-3">尚未保存</span>
						) : null}
						<Button
							type="button"
							onClick={onSave}
							disabled={!dirty || saveMut.isPending}
							loading={saveMut.isPending}
						>
							保存
						</Button>
					</div>
				</>
			)}
		</div>
	);
}

/**
 * 免费额度卡片：AI 功能免费使用。
 * 未开通 → 一键开通；已开通（freeTrial 生效）→ 展示“使用中”置灰状态；
 * 探测到 401 失效时展示恢复入口。
 */
function FreeTrialCard({
	settings,
	failure,
	onActivated,
}: {
	settings: LlmSettings | undefined;
	/** 免费模型网关不可达时展示错误和恢复入口。 */
	failure?: LlmStatusError;
	onActivated: (expiresAt?: string) => void;
}) {
	const { data: resource } = useFreeTrialResource();
	const { data: accountData } = useCurrentAccount();
	const activate = useActivateFreeTrial();
	const unreachable = Boolean(failure);
	const failureMessage = failure?.status === 401
		? "免费额度凭证已失效，请点击恢复。"
		: failure?.status === 429
			? "免费 AI 服务当前繁忙，请稍后重试，或切换到自定义模型。"
			: failure?.status && failure.status >= 500
				? "免费 AI 服务暂时不可用，请稍后重试，或切换到自定义模型。"
				: "当前网络无法连接免费 AI 服务。请检查网络；恢复连接后会自动继续，也可切换到自定义模型。";
	const accountEmail = accountData?.account?.emailAddress ?? "";
	if (!isFreeTrialEntryVisible(resource, accountEmail)) return null;

	// 免费额度是否为当前生效配置：以服务端 freeTrial 标志为准。
	// 注意 settings.baseUrl/hasApiKey 反映的是用户自定义主配置，免费额度激活时
	// 它们并不指向免费网关，不能据此判定免费额度是否在使用中。
	const alreadyActive = settings?.freeTrial === true;

	if (alreadyActive) {
		const username = accountData?.account?.emailAddress?.split("@")[0] ?? "";
		const email = accountData?.account?.emailAddress ?? "";
		return (
			<div
				className={`relative overflow-hidden rounded-md border px-4 py-3 ${
					unreachable
						? "border-red/40 bg-red-bg/40"
						: "free-trial-halo border-green/40 bg-green/5"
				}`}
			>
				{!unreachable ? (
					<>
						<FreeTrialShimmer slow />
						<FreeTrialSparkles />
					</>
				) : null}
				<div className="relative flex items-center justify-between gap-3">
					<div className="flex items-center gap-2 text-xs text-ink">
						{unreachable ? (
							<WarningCircleIcon size={14} weight="fill" className="shrink-0 text-red" />
						) : (
							<CheckCircleIcon size={14} weight="fill" className="shrink-0 text-green" />
						)}
						<span>
							{unreachable ? failureMessage : "免费额度使用中 —"}{" "}
							{!unreachable ? (
								<>
									<span className="inline-flex items-center gap-1 rounded bg-green/15 px-1.5 py-0.5 font-mono-meta text-xs font-semibold uppercase tracking-wider text-green">
										free
									</span>{" "}
									<code className="text-ink-2">{settings?.freeTrialModel ?? resource?.model}</code>
								</>
							) : null}
						</span>
					</div>
					{failure?.status === 401 ? (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							disabled={activate.isPending || !username}
							loading={activate.isPending}
							onClick={() => {
								if (!username) return;
								activate.mutate(
									{ username, email },
									{
										onSuccess: (data) => onActivated(data.expiresAt),
									},
								);
							}}
						>
							恢复
						</Button>
					) : unreachable ? (
						<Button type="button" variant="secondary" size="sm" disabled>
							暂不可用
						</Button>
					) : (
						// 免费额度使用中：置灰禁用，避免重复“免费使用”诱导。
						<Button type="button" variant="secondary" size="sm" disabled>
							使用中
						</Button>
					)}
				</div>
			</div>
		);
	}

	const username = accountData?.account?.emailAddress?.split("@")[0] ?? "";
	const email = accountData?.account?.emailAddress ?? "";
	return (
		<div className="relative overflow-hidden rounded-md border border-green/40 bg-green-bg/50 px-4 py-3">
			<FreeTrialShimmer />
			<FreeTrialSparkles count={2} />
			<div className="relative flex items-center justify-between gap-3">
				<div className="min-w-0 text-xs leading-5 text-ink-2">
					<span className="font-medium text-ink">免费 AI 额度</span>
					<div className="text-ink-3">
						无需任何配置，直接免费使用 AI 功能。
					</div>
					{activate.isError ? (
						<div role="alert" className="mt-1 text-red">
							{getFreeTrialError(activate.error)}
						</div>
					) : null}
				</div>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					disabled={activate.isPending || !username}
					loading={activate.isPending}
					onClick={() => {
						if (!username) return;
						activate.mutate(
							{ username, email },
							{
								onSuccess: (data) => onActivated(data.expiresAt),
							},
						);
					}}
				>
					免费使用
				</Button>
			</div>
		</div>
	);
}

function StatusPill({
	configured,
	status,
	loading,
	freeTrial = false,
	hasFreeTrialEntry = false,
}: {
	configured: boolean;
	status: LlmStatus | undefined;
	loading: boolean;
	/** 免费额度模式：不展示 provider/model 等配置细节。 */
	freeTrial?: boolean;
	/** 免费额度入口可用：未配置时不再重复“停摆”文案，交给 FreeTrialCard 引导。 */
	hasFreeTrialEntry?: boolean;
}) {
	if (loading) {
		return (
			<div className="rounded-md border border-edge-3 border-dashed bg-paper-2 px-3 py-2 text-xs text-ink-3">
				正在读取当前配置…
			</div>
		);
	}
	// 免费额度模式：状态由 FreeTrialCard 展示，StatusPill 不渲染（避免出现"未配置"等歧义文案）。
	if (freeTrial) {
		return null;
	}
	const lastError = status?.health?.lastError;
	if (configured && status?.health?.availability === "unreachable") {
		const errorLabel = [
			lastError?.status === undefined ? null : `HTTP ${lastError.status}`,
			lastError?.code,
		].filter(Boolean).join(" · ") || "模型请求失败";
		return (
			<div className="rounded-md border border-red/40 bg-red-bg px-3 py-2 text-xs text-ink">
				<div className="flex items-start gap-2">
					<WarningCircleIcon size={14} weight="fill" className="mt-0.5 text-red" />
					<div className="min-w-0">
						<div className="font-medium">模型不可达 — {errorLabel}</div>
						{lastError?.message ? (
							<div className="mt-0.5 break-words text-ink-2">最近错误：{lastError.message}</div>
						) : null}
						<div className="mt-0.5 text-ink-3">后台摘要已暂停并按指数退避，恢复后会自动继续。</div>
					</div>
				</div>
			</div>
		);
	}
	if (configured) {
		return (
			<div className="space-y-2">
				<div className="rounded-md border border-green/40 bg-green/5 px-3 py-2 text-xs text-ink flex items-center gap-2">
					<CheckCircleIcon size={14} weight="fill" className="text-green" />
					<span>
						已就绪 — <strong>{status?.provider ?? "?"}</strong> ·{" "}
						<code className="text-ink-2">{status?.model ?? "?"}</code>
					</span>
				</div>
				{lastError ? (
					<div className="rounded-md border border-amber/30 bg-amber/5 px-3 py-2 text-xs text-ink-2">
						最近一次模型错误：{lastError.status === undefined ? lastError.code : `HTTP ${lastError.status}`} · {lastError.message}
					</div>
				) : null}
			</div>
		);
	}
	if (hasFreeTrialEntry) return null;
	return (
		<div className="rounded-md border border-amber/40 bg-amber/5 px-3 py-2 text-xs text-ink flex items-center gap-2">
			<WarningCircleIcon size={14} weight="fill" className="text-amber" />
			<span>未配置或无可用密钥；摘要、草稿、Agent 都会停摆。</span>
		</div>
	);
}

/**
 * 自定义模型配置表单（Base URL + API Key + 模型路由）。
 * 免费额度模式与自定义模式共用同一套字段，确保“使用自定义模型”展开全部配置项。
 */
function CustomModelFields({
	draft,
	setField,
	hasKey,
	models,
	setModels,
	discoverMut,
	discoverModels,
	discoveryStatus,
}: {
	draft: DraftSettings;
	setField: <K extends keyof DraftSettings>(key: K, value: DraftSettings[K]) => void;
	hasKey: boolean;
	models: DiscoveredLlmModel[];
	setModels: (next: DiscoveredLlmModel[]) => void;
	discoverMut: ReturnType<typeof useDiscoverLlmModels>;
	discoverModels: (input?: { baseUrl?: string; apiKey?: string }) => void;
	discoveryStatus: "idle" | "loading" | "success" | "error";
}) {
	return (
		<>
			<div className="rounded-md border border-edge bg-paper-2 p-4 space-y-4">
				<div>
					<label
						htmlFor="llm-base-url"
						className="block text-xs font-medium uppercase tracking-wider text-ink-3 mb-1"
					>
						Base URL（可选）
					</label>
					<Input
						id="llm-base-url"
						value={draft.baseUrl}
						onChange={(e) => {
							setModels([]);
							discoverMut.reset();
							setField("baseUrl", e.target.value);
						}}
						onBlur={() => {
							if (hasKey && !draft.apiKey.trim()) discoverModels();
						}}
						placeholder="https://api.openai.com/v1 或 https://api.anthropic.com"
					/>
					<p className="text-xs text-ink-3 mt-1">
						首次配置或端点、密钥变化时会验证连接；仅调整模型路由会立即保存。
					</p>
				</div>

				<div>
					<div className="flex items-center justify-between mb-1">
						<label
							htmlFor="llm-api-key"
							className="block text-xs font-medium uppercase tracking-wider text-ink-3"
						>
							API Key
						</label>
						{hasKey ? (
							<span className="text-xs uppercase tracking-wider text-green px-2 py-0.5 rounded-full border border-green/40 bg-green/10">
								已加密保存
							</span>
						) : null}
					</div>
					<Input
						id="llm-api-key"
						type="password"
						autoComplete="off"
						value={draft.apiKey}
						onChange={(e) => {
							setModels([]);
							discoverMut.reset();
							setField("apiKey", e.target.value);
						}}
						placeholder={hasKey ? "保留现有密钥（输入新值以替换）" : "sk-..."}
					/>
					<p className="text-xs text-ink-3 mt-1">
						{hasKey
							? "密钥已加密保存在本机，不会明文显示；输入新值可替换，留空保留。"
							: "密钥保存在本地，使用系统加密存储；不会写入日志或上传。"}
					</p>
				</div>
			</div>

			<div className="rounded-md border border-edge bg-paper-2 p-4 space-y-4">
				<div className="flex items-center justify-between gap-3">
					<h3 className="text-sm font-semibold text-ink">模型路由</h3>
					<div className="flex items-center gap-2">
						<span className="text-xs text-ink-3">
							{discoveryStatus === "loading"
								? "正在获取模型…"
								: discoveryStatus === "success"
									? `已发现 ${models.length} 个模型`
									: discoveryStatus === "error"
										? "获取失败，可手动输入"
										: "留空 = 使用默认模型"}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => discoverModels()}
							disabled={discoverMut.isPending || (!hasKey && !draft.apiKey.trim())}
						>
							<ArrowClockwiseIcon size={13} className={discoverMut.isPending ? "animate-spin motion-reduce:animate-none" : ""} />
							获取模型
						</Button>
					</div>
				</div>
				<ModelInput
					label="默认模型"
					required
					value={draft.defaultModel}
					onChange={(v) => setField("defaultModel", v)}
					models={models}
					status={discoveryStatus}
					placeholder="搜索或输入模型 ID"
				/>
				<ModelInput
					label="摘要模型"
					value={draft.summaryModel}
					onChange={(v) => setField("summaryModel", v)}
					models={models}
					status={discoveryStatus}
					placeholder="留空时继承默认模型"
				/>
				<ModelInput
					label="草稿模型"
					value={draft.draftModel}
					onChange={(v) => setField("draftModel", v)}
					models={models}
					status={discoveryStatus}
					placeholder="留空时继承默认模型"
				/>
				<ModelInput
					label="Agent 模型"
					value={draft.agentModel}
					onChange={(v) => setField("agentModel", v)}
					models={models}
					status={discoveryStatus}
					placeholder="留空时继承默认模型"
				/>
			</div>

			<details className="rounded-md border border-edge bg-paper-2 p-4">
				<summary className="cursor-pointer text-sm font-medium text-ink">
					高级设置
				</summary>
				<div className="mt-4 flex items-start justify-between gap-4">
					<div className="min-w-0">
						<label htmlFor="llm-reasoning-effort" className="text-sm text-ink">
							推理强度
						</label>
						<p id="llm-reasoning-effort-hint" className="mt-1 max-w-lg text-xs leading-5 text-ink-3">
							控制 OpenAI 兼容请求的 reasoning_effort。遇到参数不兼容时，可选择“不发送”；手动选项会覆盖模型自动策略。
						</p>
					</div>
					<Select
						value={draft.reasoningEffort}
						onValueChange={(value) => setField("reasoningEffort", value as LlmReasoningEffort)}
					>
						<SelectTrigger
							id="llm-reasoning-effort"
							aria-describedby="llm-reasoning-effort-hint"
							className="w-52 shrink-0"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">自动（推荐）</SelectItem>
							<SelectItem value="omit">不发送</SelectItem>
							<SelectItem value="none">关闭（none）</SelectItem>
							<SelectItem value="low">低（low）</SelectItem>
							<SelectItem value="medium">中（medium）</SelectItem>
							<SelectItem value="high">高（high）</SelectItem>
							<SelectItem value="xhigh">极高（xhigh）</SelectItem>
							<SelectItem value="max">最高（max）</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</details>
		</>
	);
}

function ModelInput({
	label,
	required,
	value,
	onChange,
	models,
	status,
	placeholder,
}: {
	label: string;
	required?: boolean;
	value: string;
	onChange: (v: string) => void;
	models: DiscoveredLlmModel[];
	status: "idle" | "loading" | "success" | "error";
	placeholder?: string;
}) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="pt-1.5">
				<span className="block text-sm text-ink">{label}</span>
				{required ? (
					<span className="text-xs text-ink-3">必填</span>
				) : null}
			</div>
			<div className="flex-1 max-w-md">
				<ModelPicker
					value={value}
					onChange={onChange}
					models={models}
					status={status}
					placeholder={placeholder}
				/>
			</div>
		</div>
	);
}
