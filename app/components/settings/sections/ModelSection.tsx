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
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	useDiscoverLlmModels,
	useLlmSettings,
	useLlmStatus,
	useSaveLlmSettings,
} from "~/queries/llmSettings";
import { ModelPicker } from "~/components/llm/ModelPicker";
import type {
	DiscoveredLlmModel,
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

export function ModelSection() {
	const { data: settings, isLoading } = useLlmSettings();
	const { data: status } = useLlmStatus();
	const saveMut = useSaveLlmSettings();
	const discoverMut = useDiscoverLlmModels();
	const runDiscovery = discoverMut.mutate;

	const [draft, setDraft] = useState<DraftSettings>(EMPTY);
	const [dirty, setDirty] = useState(false);
	const [models, setModels] = useState<DiscoveredLlmModel[]>([]);
	const autoDiscoveredRef = useRef<string | null>(null);
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
			onSuccess: (result) => {
				if (result.runtimeReloaded === false) {
					toast.error("模型设置已保存，但运行时重载未完成。请重启应用或修改后重新保存。");
				} else if (!result.probe.ok) {
					toast.warning("模型设置已保存，但连接验证失败。请检查端点、密钥和网络。");
				} else {
					toast.success("已保存模型设置");
				}
				setDirty(false);
			},
			onError: (err) =>
				toast.error(getUserFacingError(err, "模型设置保存失败，请稍后重试。")),
		});
	};

	const hasKey = !!settings?.hasApiKey;
	const configured = !!status?.configured;

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

			<StatusPill
				configured={configured}
				status={status}
				loading={isLoading}
			/>

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
				{dirty ? <span className="text-xs text-ink-3">尚未保存</span> : null}
				<Button type="button" onClick={onSave} disabled={!dirty || saveMut.isPending} loading={saveMut.isPending}>
					保存
				</Button>
			</div>
		</div>
	);
}

function StatusPill({
	configured,
	status,
	loading,
}: {
	configured: boolean;
	status: LlmStatus | undefined;
	loading: boolean;
}) {
	if (loading) {
		return (
			<div className="rounded-md border border-edge-3 border-dashed bg-paper-2 px-3 py-2 text-xs text-ink-3">
				正在读取当前配置…
			</div>
		);
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
	return (
		<div className="rounded-md border border-amber/40 bg-amber/5 px-3 py-2 text-xs text-ink flex items-center gap-2">
			<WarningCircleIcon size={14} weight="fill" className="text-amber" />
			<span>未配置或无可用密钥；摘要、草稿、Agent 都会停摆。</span>
		</div>
	);
}

/**
 * 自定义模型配置表单（Base URL + API Key + 模型路由）。
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
