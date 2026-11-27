import { CopyButton } from "~/components/ui/copy-button";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { getUserFacingError } from "~/lib/user-facing-error";
import {
	useConfigureMcp,
	useMcpState,
	useResetMcpCredential,
	useTerminateMcpSession,
} from "~/queries/mcp";
import {
	WEMAIL_MCP_DEFAULT_BODY_CHARACTERS,
	WEMAIL_MCP_DEFAULT_MAX_BATCH_MESSAGES,
	WEMAIL_MCP_DEFAULT_MAX_BODY_CHARACTERS,
	WEMAIL_MCP_DEFAULT_MAX_PAGE_SIZE,
	WEMAIL_MCP_DEFAULT_MAX_PENDING_OPERATIONS,
	WEMAIL_MCP_DEFAULT_MAX_RECIPIENTS,
	WEMAIL_MCP_DEFAULT_PAGE_SIZE,
	WEMAIL_MCP_DEFAULT_PORT,
	WEMAIL_MCP_DEFAULT_TOOL_TIMEOUT_SECONDS,
	WEMAIL_MCP_MAX_BATCH_MESSAGES,
	WEMAIL_MCP_MAX_BODY_CHARACTERS,
	WEMAIL_MCP_MAX_PAGE_SIZE,
	WEMAIL_MCP_MAX_PENDING_OPERATIONS,
	WEMAIL_MCP_MAX_RECIPIENTS,
	WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS,
	WEMAIL_MCP_SERVER_NAME,
	type WemailMcpConfigurationTarget,
	type WemailMcpSettingsInput,
} from "../../../../shared/wemail/mcp";

function maskedConfiguration(
	target: WemailMcpConfigurationTarget,
	endpoint: string,
) {
	const connection = {
		type: target === "claude" ? "http" : "streamablehttp",
		url: endpoint,
		headers: { Authorization: "Bearer ••••••••••••••••" },
	};
	return JSON.stringify(
		target === "claude"
			? { mcpServers: { [WEMAIL_MCP_SERVER_NAME]: connection } }
			: { [WEMAIL_MCP_SERVER_NAME]: connection },
		null,
		2,
	);
}

const errorMessages = {
	port_conflict: "端口已被其他应用占用，请在 MCP 设置中更换端口。",
	listener_failed: "MCP 服务启动失败，请检查 MCP 设置中的连接状态。",
	emergency_disabled: "MCP 已被安全策略停用。",
	credential_unavailable: "Windows 安全存储暂不可用，无法创建本机连接凭据。",
	credential_corrupt: "本机连接凭据损坏，请在 MCP 设置中重置。",
} as const;

function parseBoundedInteger(value: string, minimum: number, maximum: number) {
	if (!/^\d+$/.test(value.trim())) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
		? parsed
		: null;
}

type AdvancedSettingKey = Exclude<keyof WemailMcpSettingsInput, "enabled">;

const advancedFields: Array<{
	key: AdvancedSettingKey;
	label: string;
	minimum: number;
	maximum: number;
	recommended: number;
	unit?: string;
	help: string;
}> = [
	{ key: "port", label: "固定端口", minimum: 1, maximum: 65_535, recommended: WEMAIL_MCP_DEFAULT_PORT, help: "仅监听 127.0.0.1；修改后重新建立连接。" },
	{ key: "defaultBodyCharacters", label: "默认正文长度", minimum: 1, maximum: WEMAIL_MCP_MAX_BODY_CHARACTERS, recommended: WEMAIL_MCP_DEFAULT_BODY_CHARACTERS, unit: "字符", help: "客户端未指定长度时，每封邮件默认返回的正文。" },
	{ key: "maxBodyCharacters", label: "正文长度上限", minimum: 1, maximum: WEMAIL_MCP_MAX_BODY_CHARACTERS, recommended: WEMAIL_MCP_DEFAULT_MAX_BODY_CHARACTERS, unit: "字符", help: "客户端可请求的每封邮件正文最大长度。" },
	{ key: "defaultPageSize", label: "默认分页数量", minimum: 1, maximum: WEMAIL_MCP_MAX_PAGE_SIZE, recommended: WEMAIL_MCP_DEFAULT_PAGE_SIZE, unit: "项", help: "客户端未指定 pageSize 时使用。" },
	{ key: "maxPageSize", label: "分页数量上限", minimum: 1, maximum: WEMAIL_MCP_MAX_PAGE_SIZE, recommended: WEMAIL_MCP_DEFAULT_MAX_PAGE_SIZE, unit: "项", help: "客户端单次列表或线程请求可返回的最大项数。" },
	{ key: "maxRecipients", label: "收件人上限", minimum: 1, maximum: WEMAIL_MCP_MAX_RECIPIENTS, recommended: WEMAIL_MCP_DEFAULT_MAX_RECIPIENTS, unit: "人", help: "单封草稿或发送操作的收件人总数。" },
	{ key: "maxBatchMessages", label: "批量邮件上限", minimum: 1, maximum: WEMAIL_MCP_MAX_BATCH_MESSAGES, recommended: WEMAIL_MCP_DEFAULT_MAX_BATCH_MESSAGES, unit: "封", help: "单次归档、移动或删除操作可处理的邮件数。" },
	{ key: "maxPendingOperations", label: "待提交操作上限", minimum: 1, maximum: WEMAIL_MCP_MAX_PENDING_OPERATIONS, recommended: WEMAIL_MCP_DEFAULT_MAX_PENDING_OPERATIONS, unit: "项", help: "同一邮箱可保留的待提交 MCP 操作数。" },
	{ key: "toolTimeoutSeconds", label: "工具超时", minimum: 1, maximum: WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS, recommended: WEMAIL_MCP_DEFAULT_TOOL_TIMEOUT_SECONDS, unit: "秒", help: "单次工具调用超过该时间后自动取消。" },
];

export function McpSection() {
	const stateQuery = useMcpState();
	const configure = useConfigureMcp();
	const resetCredential = useResetMcpCredential();
	const terminateSession = useTerminateMcpSession();
	const [advancedDraft, setAdvancedDraft] = useState<Partial<Record<AdvancedSettingKey, string>>>({});
	const [target, setTarget] = useState<WemailMcpConfigurationTarget>("codex");
	const [resetCredentialOpen, setResetCredentialOpen] = useState(false);
	const state = stateQuery.data;
	const operations = state?.operations ?? [];
	const advancedValues = Object.fromEntries(advancedFields.map((field) => [
		field.key,
		advancedDraft[field.key] ?? String(state?.[field.key] ?? field.recommended),
	])) as Record<AdvancedSettingKey, string>;
	const parsedAdvanced = Object.fromEntries(advancedFields.map((field) => [
		field.key,
		parseBoundedInteger(advancedValues[field.key], field.minimum, field.maximum),
	])) as Record<AdvancedSettingKey, number | null>;
	const advancedSettingsChanged = advancedFields.some(
		(field) => advancedDraft[field.key] !== undefined && advancedDraft[field.key] !== String(state?.[field.key]),
	);
	const advancedSettingsValid = advancedFields.every((field) => parsedAdvanced[field.key] !== null) &&
		(parsedAdvanced.defaultBodyCharacters ?? Infinity) <= (parsedAdvanced.maxBodyCharacters ?? -Infinity) &&
		(parsedAdvanced.defaultPageSize ?? Infinity) <= (parsedAdvanced.maxPageSize ?? -Infinity);
	const recommendedSettings = Object.fromEntries(
		advancedFields.map((field) => [field.key, String(field.recommended)]),
	) as Record<AdvancedSettingKey, string>;
	const toolGroups = state
		? Object.entries(Object.groupBy(state.tools, (tool) => tool.domain))
		: [];
	const ready =
		state?.enabled &&
		(state.listenerState === "listening" || state.listenerState === "attached") &&
		state.credentialState === "ready";
	const operationLabels: Record<string, string> = {
		prepared: "已准备",
		awaiting_confirmation: "旧版操作等待授权",
		approved: "已准备，等待客户端提交",
		committing: "正在提交",
		succeeded: "已完成",
		failed_retryable: "提交失败，可安全重试",
		cancelled: "已取消或拒绝",
		expired: "已过期",
		outcome_unknown: "结果未知，请勿自动重试",
	};

	const configureEnabled = (enabled: boolean) => {
		configure.mutate(
			{ enabled },
			{
				onError: (error) =>
					toast.error(getUserFacingError(error, "MCP 设置失败，请稍后重试。")),
			},
		);
	};

	const saveAdvancedSettings = () => {
		if (!advancedSettingsValid) return;
		configure.mutate(
			{
				enabled: state?.enabled ?? false,
				...(parsedAdvanced as Record<AdvancedSettingKey, number>),
			},
			{
				onSuccess: () => {
					setAdvancedDraft({});
					toast.success("MCP 高级设置已保存");
				},
				onError: (error) =>
					toast.error(getUserFacingError(error, "保存 MCP 高级设置失败，请稍后重试。")),
			},
		);
	};

	const copyConfiguration = async (): Promise<boolean> => {
		const result = await window.wemailDesktop?.copyMcpConfiguration?.(target);
		if (!result) {
			toast.error("请在 WeMail 桌面应用中复制 MCP 配置");
			return false;
		}
		if (!result.ok) {
			toast.error(
				result.error === "credential_corrupt"
					? "连接凭据损坏，请重置后重试"
					: result.error === "credential_unavailable"
						? "Windows 安全存储暂不可用"
						: "MCP 尚未就绪",
			);
			return false;
		}
		return true;
	};

	if (stateQuery.isLoading || !state) {
		return (
			<div className="py-16 text-center text-sm text-ink-3">
				正在加载 MCP 状态…
			</div>
		);
	}

	return (
		<div className="space-y-5" data-testid="mcp-settings-section">
			<div>
				<div className="flex items-center gap-2">
					<PlugsIcon size={20} className="text-coral" weight="duotone" />
					<h2 className="text-base font-semibold text-ink">MCP 连接</h2>
				</div>
				<p className="mt-1 text-xs leading-relaxed text-ink-3">
					让 Codex、Claude 等本机客户端访问当前邮箱。凭据由 WeMail
					自动管理；持有凭据的客户端可直接发送、删除和批量操作邮件，
					无需在 WeMail 再次确认。请只向可信客户端提供配置。
				</p>
			</div>

			<div className="rounded-lg border border-edge bg-paper-2">
				<div className="flex items-center justify-between gap-4 px-4 py-3.5">
					<div>
						<div className="text-sm font-medium text-ink">启用本地 MCP</div>
						<div className="text-xs text-ink-3">
							仅监听 127.0.0.1；开启后自动准备本机连接凭据。
						</div>
					</div>
					<Switch
						aria-label="启用本地 MCP"
						checked={state.enabled}
						disabled={configure.isPending}
						onCheckedChange={configureEnabled}
					/>
				</div>
			</div>

			<div
				className="flex items-center gap-2 text-xs text-ink-3"
				role="status"
				aria-live="polite"
			>
				<span
					aria-hidden="true"
					className={`h-2 w-2 rounded-full ${
						ready
							? "bg-green"
							: state.listenerState === "error"
								? "bg-red"
								: "bg-ink-4"
					}`}
				/>
				{ready
					? state.listenerState === "attached"
						? "MCP 已就绪（由常驻服务提供），可以复制配置"
						: "MCP 已就绪，可以复制配置"
					: state.errorCode
						? errorMessages[state.errorCode]
						: state.enabled
							? "正在准备本机 MCP…"
							: "MCP 当前已关闭"}
			</div>

			<div className="space-y-3 rounded-lg border border-edge p-4">
				<div className="flex items-start justify-between gap-3">
					<div>
						<div className="text-sm font-medium text-ink">连接配置</div>
						<div className="mt-0.5 text-xs text-ink-3">
							复制完整 JSON 后直接粘贴到客户端，无需创建或保存 API Key。
						</div>
					</div>
					<select
						aria-label="MCP 客户端格式"
						className="rounded-md border border-edge bg-paper px-2 py-1 text-xs text-ink outline-none"
						value={target}
						onChange={(event) =>
							setTarget(event.target.value as WemailMcpConfigurationTarget)
						}
					>
						<option value="codex">Codex / 通用</option>
						<option value="claude">Claude</option>
					</select>
				</div>
				<pre className="max-h-48 overflow-auto rounded-md bg-paper-3 p-3 text-xs leading-relaxed text-ink-2">
					{maskedConfiguration(target, state.endpoint)}
				</pre>
				<CopyButton
					size="sm"
					disabled={!ready}
					copyAction={copyConfiguration}
					labels={{ idle: "复制 MCP 配置", copied: "已复制，可直接粘贴" }}
				/>
			</div>

			<details className="space-y-4 rounded-lg border border-edge bg-paper-2 p-4">
				<summary className="cursor-pointer text-sm font-medium text-ink">
					诊断与高级连接信息
				</summary>
				<div className="mt-4 space-y-4 border-b border-edge-3 pb-4">
					<div>
						<div className="text-sm font-medium text-ink">高级限制</div>
						<div className="mt-0.5 text-xs leading-5 text-ink-3">
							控制 MCP 客户端的默认返回规模、批量操作和执行时间。提高限制会增加响应、内存与敏感邮件数据暴露。
						</div>
					</div>
					<div className="grid gap-4 @min-[520px]/settings-section:grid-cols-2">
						{advancedFields.map((field) => {
							const changed = advancedDraft[field.key] !== undefined && advancedDraft[field.key] !== String(state[field.key]);
							const invalid = changed && parsedAdvanced[field.key] === null;
							const id = `mcp-${field.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
							return (
								<div key={field.key} className="space-y-2">
									<label htmlFor={id} className="text-xs font-medium text-ink">{field.label}</label>
									<div className="flex items-center gap-2">
										<Input
											id={id}
											type="number"
											min={field.minimum}
											max={field.maximum}
											value={advancedValues[field.key]}
											onChange={(event) => setAdvancedDraft((current) => ({ ...current, [field.key]: event.target.value }))}
											aria-invalid={invalid}
											aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
										/>
										{field.unit ? <span className="shrink-0 text-xs text-ink-3">{field.unit}</span> : null}
									</div>
									<div id={`${id}-help`} className="text-xs leading-5 text-ink-3">{field.help} 推荐 {field.recommended.toLocaleString()}。</div>
									{invalid ? <div id={`${id}-error`} className="text-xs text-red">请输入 {field.minimum.toLocaleString()}–{field.maximum.toLocaleString()} 之间的整数。</div> : null}
								</div>
							);
						})}
					</div>
					{parsedAdvanced.defaultBodyCharacters !== null && parsedAdvanced.maxBodyCharacters !== null && parsedAdvanced.defaultBodyCharacters > parsedAdvanced.maxBodyCharacters ? <div className="text-xs text-red">默认正文长度不能高于正文长度上限。</div> : null}
					{parsedAdvanced.defaultPageSize !== null && parsedAdvanced.maxPageSize !== null && parsedAdvanced.defaultPageSize > parsedAdvanced.maxPageSize ? <div className="text-xs text-red">默认分页数量不能高于分页数量上限。</div> : null}
					<div className="rounded-md bg-paper-3 px-3 py-2 text-xs leading-5 text-ink-3">
						鉴权、本机回环监听、请求体大小、速率、并发和临时附件内存容量属于应用安全边界，不允许关闭。
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<Button
							size="sm"
							variant="ghost"
							disabled={configure.isPending || advancedFields.every((field) => advancedValues[field.key] === String(field.recommended))}
							onClick={() => setAdvancedDraft(recommendedSettings)}
						>
							恢复推荐值
						</Button>
						<Button
							size="sm"
							variant="secondary"
							loading={configure.isPending}
							disabled={!advancedSettingsChanged || !advancedSettingsValid}
							onClick={saveAdvancedSettings}
						>
							保存高级设置
						</Button>
					</div>
				</div>

				<div className="mt-4 space-y-2">
					<div className="text-xs font-semibold uppercase tracking-wider text-ink-3">
						连接地址
					</div>
					<div className="flex items-center gap-2 rounded-lg border border-edge bg-paper-3 px-3 py-2">
						<code className="min-w-0 flex-1 break-all text-xs text-ink">
							{state.endpoint}
						</code>
						<CopyButton
							variant="ghost"
							size="sm"
							iconOnly
							aria-label="复制 MCP 地址"
							text={state.endpoint}
							labels={{ idle: "复制 MCP 地址", copied: "已复制" }}
						/>
					</div>
				</div>

				<div className="mt-4 rounded-lg border border-edge bg-paper p-3">
					<div className="flex items-center justify-between gap-3">
						<div>
							<div className="text-xs font-medium text-ink">本机连接凭据</div>
							<div className="mt-0.5 text-xs text-ink-3">
								{state.token
									? `指纹 ${state.token.fingerprint} · ${new Date(state.token.createdAt).toLocaleString()}`
									: "尚未准备"}
							</div>
						</div>
						<Button
							size="sm"
							variant="ghost"
							disabled={resetCredential.isPending}
							onClick={() => setResetCredentialOpen(true)}
						>
							重置连接凭据
						</Button>
					</div>
					{state.legacyTokens.length > 0 ? (
						<div className="mt-3 flex gap-2 rounded-md bg-amber-bg px-3 py-2 text-xs text-amber">
							<WarningIcon size={14} className="shrink-0" weight="fill" />
							<span>
								仍有 {state.legacyTokens.length} 个旧版连接凭据有效；重置后会一并撤销。
							</span>
						</div>
					) : null}
				</div>

				<div className="mt-4 space-y-2">
					<div className="text-xs font-semibold uppercase tracking-wider text-ink-3">
						活动会话 · {state.sessions.length}
					</div>
					{state.sessions.length === 0 ? (
						<div className="rounded-lg border border-dashed border-edge px-4 py-4 text-center text-xs text-ink-3">
							暂无客户端会话
						</div>
					) : (
						<div className="divide-y divide-edge-3 rounded-lg border border-edge">
							{state.sessions.map((session) => (
								<div
									key={session.sessionHash}
									className="flex items-center gap-3 px-3 py-2.5"
								>
									<div className="min-w-0 flex-1">
										<code className="text-xs text-ink">
											{session.sessionHash}
										</code>
										<div className="text-xs text-ink-3">
											{session.protocolVersion} · 最近使用{" "}
											{new Date(session.lastUsedAt).toLocaleString()}
										</div>
									</div>
									<Button
										size="sm"
										variant="ghost"
										onClick={() =>
											terminateSession.mutate(session.sessionHash)
										}
									>
										终止
									</Button>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<div className="text-xs font-semibold uppercase tracking-wider text-ink-3">
							MCP 操作 · {state.pendingOperationCount} 个待处理
						</div>
					</div>
					{operations.length === 0 ? (
						<div className="rounded-lg border border-dashed border-edge px-4 py-4 text-center text-xs text-ink-3">
							暂无 MCP 操作
						</div>
					) : (
						<div className="divide-y divide-edge-3 rounded-lg border border-edge">
							{operations.map((operation) => (
								<div key={operation.id} className="px-3 py-2.5">
									<div className="flex items-center justify-between gap-3">
										<span className="text-xs font-medium text-ink">
											{operation.preview}
										</span>
										<span className="shrink-0 text-xs text-ink-3">
											{operationLabels[operation.state] ?? operation.state}
										</span>
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="space-y-3">
					<div className="text-xs font-semibold uppercase tracking-wider text-ink-3">
						公开工具 · {state.tools.length}
					</div>
					{toolGroups.map(([domain, tools]) => (
						<div key={domain} className="space-y-1.5">
							<div className="text-xs font-semibold uppercase tracking-widest text-ink-3">
								{domain}
							</div>
							<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
								{tools?.map((tool) => (
									<div
										key={tool.name}
										className={`rounded-md border border-edge px-3 py-2 ${
											tool.available ? "" : "opacity-55"
										}`}
										title={tool.description}
									>
										<code className="text-xs font-medium text-ink">
											{tool.name}
										</code>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			</details>
			<ConfirmActionDialog
				open={resetCredentialOpen}
				onOpenChange={setResetCredentialOpen}
				title="重置 MCP 连接凭据？"
				description="当前凭据会立即失效，已复制到 Codex、Claude 或其他客户端的 MCP 配置需要重新复制。"
				confirmLabel="重置凭据"
				pending={resetCredential.isPending}
				onConfirm={() =>
					resetCredential.mutate(undefined, {
						onSuccess: () => {
							setResetCredentialOpen(false);
							toast.success("连接凭据已重置，旧配置已失效");
						},
						onError: () => toast.error("重置连接凭据失败"),
					})
				}
			/>
		</div>
	);
}
