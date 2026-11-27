// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * upstream-style onboarding: Provider picker → Mailbox setup → AI
 * model setup. The workbench shell redirects unauthenticated
 * users here; on success we navigate back to "/".
 */

import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
	PROVIDER_PRESETS,
	type ProviderPreset,
	findPresetByEmail,
} from "../../shared/wemail/providers";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ModelPicker } from "~/components/llm/ModelPicker";
import { handleExternalLinkClick } from "~/lib/external-links";
import { getUserFacingError } from "~/lib/user-facing-error";
import { durationBucket, normalizeTelemetryErrorClass, trackTelemetry } from "~/lib/telemetry";
import api, { ApiError,
	type DiscoveredLlmModel,
	type MailAccountLoginInput,
} from "~/services/api";
import { useDiscoverLlmModels } from "~/queries/llmSettings";
import { useCurrentAccount } from "~/queries/currentAccount";

type OnboardingStep = "provider" | "credentials" | "ai";
type TransportSecurityMode = "tls" | "starttls";

function parseServerPort(value: string, label: string): number {
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(`${label}必须是 1 到 65535 之间的整数`);
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${label}必须是 1 到 65535 之间的整数`);
	}
	return port;
}

/**
 * Dev quick-boot: when `.env.local` defines a `VITE_DEV_EMAIL`, skip
 * the provider picker step and land directly on the
 * credentials form with the email pre-filled and the provider preset
 * resolved from the email domain.
 *
 * Optional knobs:
 *  - `VITE_DEV_PASSWORD` — pre-fills the IMAP/SMTP authorization-code
 *    field. DEV-only: read behind `import.meta.env.DEV` so production
 *    builds DCE the read entirely (the literal never reaches the
 *    bundle). See `.env.example` for the threat model.
 *  - `VITE_DEV_AUTOLOGIN=1` — when email + password are both present,
 *    the credentials step auto-submits on mount and lands the user in
 *    the workbench without a click.
 *
 * After the first successful login the backend persists the account;
 * subsequent boots skip onboarding entirely (existing gate behavior).
 */
// Dev-prefill reads are gated behind `import.meta.env.DEV`. The production
// Vite config also refuses to build when any dev-login setting is populated,
// so safety does not depend on dead-code elimination of credential literals.
const DEV_MODE = import.meta.env.DEV;
const DEV_EMAIL: string = DEV_MODE
	? (import.meta.env.VITE_DEV_EMAIL as string | undefined)?.trim() ?? ""
	: "";
const DEV_DISPLAY_NAME: string = DEV_MODE
	? (import.meta.env.VITE_DEV_DISPLAY_NAME as string | undefined)?.trim() ?? ""
	: "";
const DEV_PASSWORD: string = DEV_MODE
	? (import.meta.env.VITE_DEV_PASSWORD as string | undefined)?.trim() ?? ""
	: "";
const DEV_AUTOLOGIN: boolean =
	DEV_MODE && (import.meta.env.VITE_DEV_AUTOLOGIN as string | undefined) === "1";
const DEV_PRESET: ProviderPreset | null = DEV_EMAIL
	? findPresetByEmail(DEV_EMAIL) ?? null
	: null;

function getLocalPart(email: string) {
	const at = email.indexOf("@");
	return at >= 0 ? email.slice(0, at) : email;
}

function getPrimaryDomain(preset: ProviderPreset) {
	return preset.domains[0] ?? "";
}

function formatLoginError(error: unknown) {
	return getUserFacingError(error, "邮箱连接失败，请检查填写的信息后重试。");
}

export default function OnboardingRoute() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const chooseProvider = searchParams.get("chooseProvider") === "1";
	const currentAccount = useCurrentAccount();
	const initialAccountCheckRef = useRef(false);
	const setupStartedRef = useRef(false);
	// Edition info (extra presets / preferred preset) arrives from the local
	// API; the open edition returns defaults — picker-first, no extras.
	const { data: editionInfo } = useQuery({
		queryKey: ["system", "edition"],
		queryFn: () => api.getEditionInfo(),
		staleTime: Infinity,
		retry: 1,
	});
	const allPresets: ProviderPreset[] = [
		...PROVIDER_PRESETS,
		...(editionInfo?.providerPresets ?? []),
	];
	// No vendor is pre-selected: onboarding always lands on the provider
	// picker. A dev email + matching preset still shortcuts straight to
	// the credentials step for local development.
	const [step, setStep] = useState<OnboardingStep>(
		DEV_PRESET ? "credentials" : "provider",
	);
	const [provider, setProvider] = useState<ProviderPreset | null>(DEV_PRESET);

	// An edition may pin a preferred preset and boot straight to its
	// credentials screen (internal first-run flow). Only applies while the
	// user is still on the picker and hasn't interacted, at most once.
	const editionBootRef = useRef(false);
	useEffect(() => {
		if (editionBootRef.current || setupStartedRef.current || step !== "provider" || chooseProvider) return;
		if (!editionInfo?.bootToCredentials || !editionInfo.preferredPresetId) return;
		const preferred = allPresets.find((p) => p.id === editionInfo.preferredPresetId);
		if (!preferred) return;
		editionBootRef.current = true;
		setProvider(preferred);
		setStep("credentials");
	}, [editionInfo, step, chooseProvider, allPresets]);

	// A stale redirect or a renderer reload should never make an already
	// configured account look like a fresh setup. The check is only
	// performed once for the initial onboarding entry; after the user starts
	// configuring a mailbox, subsequent cache updates must not interrupt the
	// in-progress flow.
	useEffect(() => {
		if (
			chooseProvider ||
			setupStartedRef.current ||
			initialAccountCheckRef.current ||
			currentAccount.isLoading
		) {
			return;
		}
		initialAccountCheckRef.current = true;
		if (currentAccount.data?.account) {
			navigate("/", { replace: true });
		}
	}, [chooseProvider, currentAccount.data?.account, currentAccount.isLoading, navigate]);

	const completeOnboarding = async () => {
		// Confirm the persisted session before leaving onboarding. This closes
		// the race where the account mutation succeeded locally but the next
		// workbench render still observed the pre-login null response.
		const persisted = await qc.fetchQuery({
			queryKey: ["account", "current"],
			queryFn: () => api.getCurrentAccount(),
			staleTime: 0,
		});
		if (!persisted.account) {
			throw new Error("邮箱账号尚未保存，请返回上一步重新连接邮箱。");
		}
		qc.setQueryData(["account", "current"], persisted);
		navigate("/", { replace: true });
	};

	return (
		<div className="flex min-h-full w-full items-center justify-center bg-paper-3 px-4 py-8">
			<div className="w-full max-w-[520px]">
				<StepIndicator step={step} />
				{step === "provider" && (
					<ProviderPickerStep
						presets={allPresets}
						onPick={(p) => {
							// Any explicit user choice voids the edition
							// auto-boot: a late edition response must never
							// override an already-made selection.
							editionBootRef.current = true;
							setProvider(p);
							setStep("credentials");
						}}
					/>
				)}
				{step === "credentials" && provider && (
					<CredentialsStep
						preset={provider}
						onLoginStarted={() => {
							setupStartedRef.current = true;
						}}
						onReadyForAi={() => setStep("ai")}
						onBack={() => {
							// Returning to the picker is also an interaction —
							// keep the edition auto-boot voided afterwards.
							editionBootRef.current = true;
							setStep("provider");
						}}
					/>
				)}
				{step === "ai" && <AiModelStep onContinue={completeOnboarding} />}
			</div>
		</div>
	);
}
function StepIndicator({
	step,
}: {
	step: OnboardingStep;
}) {
	const order: OnboardingStep[] = ["credentials", "ai"];
	const labels: Record<OnboardingStep, string> = {
		provider: "选择邮箱",
		credentials: "配置邮箱",
		ai: "配置 AI",
	};
	// Provider selection is an entry choice, not a third setup phase. Keep
	// the primary progress model stable when users switch mailboxes.
	const activeStep = step === "provider" ? "credentials" : step;
	const i = order.indexOf(activeStep);
	return (
		<ol
			className="mb-6 grid gap-2"
			style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}
			aria-label="设置进度"
		>
			{order.map((s, idx) => (
				<li
					key={s}
					aria-current={idx === i ? "step" : undefined}
					className={`min-w-0 border-t-2 pt-2 text-center text-caption font-medium ${
						idx < i
							? "border-coral-2 text-ink-2"
							: idx === i
								? "border-coral-2 text-coral-2"
								: "border-edge-2 text-ink-3"
					}`}
				>
					<span className="sr-only">{idx < i ? "已完成：" : idx === i ? "当前步骤：" : "未完成："}</span>
					{labels[s]}
				</li>
			))}
		</ol>
	);
}
function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-xl border border-edge bg-paper-2 px-5 py-7 shadow-sm sm:px-8 sm:py-9">
			{children}
		</div>
	);
}

function ProviderPickerStep({
	presets,
	onPick,
}: {
	presets: ProviderPreset[];
	onPick: (p: ProviderPreset) => void;
}) {
	return (
		<Card>
			<h2 className="mb-1 text-lg font-semibold text-ink">选择邮箱服务商</h2>
			<p className="mb-6 text-sm text-ink-3">
				选择对应的邮箱类型以自动填充 IMAP / SMTP 服务器配置。
			</p>
			<div className="grid grid-cols-2 gap-3">
				{presets.map((p) => (
					<button
						key={p.id}
						type="button"
						onClick={() => onPick(p)}
						className="flex flex-col items-start gap-1 rounded-xl border border-edge bg-paper px-4 py-3 text-left transition-colors hover:border-coral hover:bg-paper-3"
					>
						<span className="text-sm font-medium text-ink">{p.label}</span>
						{p.domains.length > 0 && (
							<span className="text-xs text-ink-3">
								@{p.domains[0]}
							</span>
						)}
					</button>
				))}
			</div>
		</Card>
	);
}

function CredentialsStep({
	preset,
	onLoginStarted,
	onReadyForAi,
	onBack,
}: {
	preset: ProviderPreset;
	onLoginStarted?: () => void;
	onReadyForAi: () => void;
	onBack: () => void;
}) {
	const qc = useQueryClient();
	// Prefill from VITE_DEV_EMAIL / VITE_DEV_DISPLAY_NAME / VITE_DEV_PASSWORD
	// when set. The password read is DEV-only — production builds elide it
	// at module-eval time so the literal never reaches the bundle.
	const [email, setEmail] = useState(DEV_EMAIL || "");
	const [presetUsername, setPresetUsername] = useState(
		DEV_EMAIL && DEV_PRESET ? getLocalPart(DEV_EMAIL) : "",
	);
	const [displayName, setDisplayName] = useState(DEV_DISPLAY_NAME || "");
	const [password, setPassword] = useState(DEV_PASSWORD || "");
	const effective = preset;
	const [imapHost, setImapHost] = useState(preset.imap.host);
	const [imapPort, setImapPort] = useState(String(preset.imap.port));
	const [imapSecurity, setImapSecurity] = useState<TransportSecurityMode>(
		preset.imap.secure ? "tls" : "starttls",
	);
	const [smtpHost, setSmtpHost] = useState(preset.smtp.host);
	const [smtpPort, setSmtpPort] = useState(String(preset.smtp.port));
	const [smtpSecurity, setSmtpSecurity] = useState<TransportSecurityMode>(
		preset.smtp.secure ? "tls" : "starttls",
	);
	const [error, setError] = useState<string | null>(null);
	const [expiredDialogOpen, setExpiredDialogOpen] = useState(false);
	const primaryInputRef = useRef<HTMLInputElement | null>(null);
	const loginStartedAtRef = useRef(0);
	const isCustomProvider = effective.id === "imap";
	const presetDomain = getPrimaryDomain(effective);
	const presetEmailSuffix = presetDomain ? `@${presetDomain}` : "";

	const login = useMutation({
		mutationFn: (input: MailAccountLoginInput) => api.loginAccount(input),
		onSuccess: async (data) => {
			if (!data?.ok || !data.account) {
				trackTelemetry("wemail_account_login_failed", {
					provider_family: effective.id,
					duration_bucket: durationBucket(performance.now() - loginStartedAtRef.current),
					reason: "invalid_response",
				});
				setError("登录失败，请检查邮箱和授权码是否正确");
				return;
			}
			trackTelemetry("wemail_account_login_succeeded", {
				provider_family: effective.id,
				duration_bucket: durationBucket(performance.now() - loginStartedAtRef.current),
			});
			// Eagerly seed the cache so the workbench gate sees the account
			// without a refetch race. Cancel the initial unauthenticated lookup
			// first so its late null response cannot overwrite this login.
			await qc.cancelQueries({ queryKey: ["account", "current"] });
			qc.setQueryData(["account", "current"], { account: data.account });
			await qc.refetchQueries({ queryKey: ["account", "current"], type: "all" });
			onReadyForAi();
		},
		onError: (e: Error) => {
			trackTelemetry("wemail_account_login_failed", {
				provider_family: effective.id,
				duration_bucket: durationBucket(performance.now() - loginStartedAtRef.current),
				error_class: normalizeTelemetryErrorClass(e),
				reason:
					e instanceof ApiError && e.body?.code === "MAIL_PASSWORD_EXPIRED"
						? "password_expired"
						: "request_failed",
			});
			if (e instanceof ApiError && e.body?.code === "MAIL_PASSWORD_EXPIRED") {
				setError("邮箱密码已过期，请更新密码。");
				setExpiredDialogOpen(true);
				return;
			}
			setError(formatLoginError(e));
		},
	});

	function submit(e?: React.FormEvent) {
		e?.preventDefault();
		setError(null);
		const normalizedPresetUsername = presetUsername.trim();
		const resolvedEmail = !isCustomProvider
			? `${normalizedPresetUsername}${presetEmailSuffix}`
			: email.trim();
		const resolvedImapHost = isCustomProvider ? imapHost : effective.imap.host;
		const resolvedImapPort = isCustomProvider ? imapPort : String(effective.imap.port);
		const resolvedImapSecure = isCustomProvider ? imapSecurity === "tls" : effective.imap.secure;
		const resolvedSmtpHost = isCustomProvider ? smtpHost : effective.smtp.host;
		const resolvedSmtpPort = isCustomProvider ? smtpPort : String(effective.smtp.port);
		const resolvedSmtpSecure = isCustomProvider ? smtpSecurity === "tls" : effective.smtp.secure;
		if (
			(!isCustomProvider && !normalizedPresetUsername) ||
			!resolvedEmail ||
			!password ||
			!resolvedImapHost ||
			!resolvedSmtpHost
		) {
			setError(
				!isCustomProvider
					? "请填写用户名和密码"
					: "请填写完整的邮箱、密码和服务器信息",
			);
			return;
		}
		let parsedImapPort: number;
		let parsedSmtpPort: number;
		try {
			parsedImapPort = parseServerPort(resolvedImapPort, "IMAP 端口");
			parsedSmtpPort = parseServerPort(resolvedSmtpPort, "SMTP 端口");
		} catch (portError) {
			setError(portError instanceof Error ? portError.message : "请填写有效的服务器端口");
			return;
		}
		loginStartedAtRef.current = performance.now();
		onLoginStarted?.();
		trackTelemetry("wemail_account_login_attempted", {
			provider_family: effective.id,
		});
		login.mutate({
			config: {
				id: `acct-${Date.now()}`,
				emailAddress: resolvedEmail,
				displayName: displayName || resolvedEmail.split("@")[0],
				imap: {
					host: resolvedImapHost,
					port: parsedImapPort,
					secure: resolvedImapSecure,
					username: resolvedEmail,
				},
				smtp: {
					host: resolvedSmtpHost,
					port: parsedSmtpPort,
					secure: resolvedSmtpSecure,
					username: resolvedEmail,
				},
			},
			secrets: { imapPassword: password, smtpPassword: password },
		});
	}

	// VITE_DEV_AUTOLOGIN: when the env supplies a full email + password
	// pair, fire login once on mount. The autoFiredRef gate prevents a
	// HMR-induced double-submit during Vite Fast Refresh.
	const autoFiredRef = useRef(false);
	useEffect(() => {
		if (!DEV_AUTOLOGIN) return;
		if (autoFiredRef.current) return;
		if (!isCustomProvider && !presetUsername.trim()) return;
		if (isCustomProvider && !email) return;
		if (!password || !imapHost || !smtpHost) return;
		autoFiredRef.current = true;
		submit();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const id = requestAnimationFrame(() => {
			primaryInputRef.current?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [isCustomProvider, effective.id]);

	return (
		<Card>
			<div className="mb-5 flex items-start justify-between gap-4">
				<div>
				<h2 className="mb-1 text-lg font-semibold text-ink">
						{`配置 ${effective.label}`}
					</h2>
					<p className="text-xs text-ink-3">
						{!isCustomProvider
							? effective.helpHint ?? "使用邮箱账号和授权码连接 WeMail。"
							: "填写邮箱账号以及收发服务器信息。"}
						{effective.helpUrl && (
							<>
								{" · "}
								<a
									href={effective.helpUrl}
									rel="noreferrer"
									onClick={(event) =>
										handleExternalLinkClick(event.nativeEvent, effective.helpUrl)
									}
									className="text-coral hover:underline"
								>
									查看帮助
								</a>
							</>
						)}
					</p>
				</div>
				<button
					type="button"
					onClick={onBack}
					className="shrink-0 text-xs font-medium text-coral hover:text-coral-2"
				>
					切换其他邮箱
				</button>
			</div>
			<form onSubmit={submit} className="space-y-3" autoComplete="on">
				{!isCustomProvider ? (
					<>
						<Field label="邮箱用户名">
							<div className="flex h-10 overflow-hidden rounded-md border border-edge bg-paper-2 shadow-[var(--shadow-1)] focus-within:border-coral focus-within:ring-2 focus-within:ring-ring">
								<input
									ref={primaryInputRef}
									aria-label="邮箱用户名"
									name={`${effective.id}-local-part`}
									value={presetUsername}
									onChange={(e) => setPresetUsername(e.target.value)}
									placeholder="请输入用户名"
									autoFocus
									autoComplete="username"
									spellCheck={false}
									className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3"
								/>
								<span className="flex items-center border-l border-edge bg-paper-3 px-3 text-sm text-ink-3">
									{presetEmailSuffix}
								</span>
							</div>
						</Field>
						<Field label="显示名称（可选）">
							<Input
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="留空则使用邮箱前缀"
							/>
						</Field>
						<Field label="密码">
							<Input
								aria-label="密码"
								type="password"
								name="mail-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="邮箱密码"
								autoComplete="current-password"
							/>
						</Field>
						<p className="text-meta leading-5 text-ink-3">
							凭据仅用于连接邮箱，并由桌面应用的安全存储保存。WeMail 不会在界面或 Agent 对话中展示密码。
						</p>
					</>
				) : (
					<>
						<Field label="邮箱地址">
							<Input
								ref={primaryInputRef}
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="you@example.com"
								autoFocus
							/>
						</Field>
						<Field label="显示名称（可选）">
							<Input
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="留空则使用邮箱前缀"
							/>
						</Field>
						<Field label="授权码 / 密码">
							<Input
								type="password"
								autoComplete="current-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="IMAP/SMTP 授权码"
							/>
						</Field>
						<div className="grid grid-cols-2 gap-3">
							<Field label="IMAP 服务器">
								<Input
									value={imapHost}
									onChange={(e) => setImapHost(e.target.value)}
								/>
							</Field>
							<Field label="IMAP 端口">
								<Input
									type="number"
									min={1}
									max={65535}
									inputMode="numeric"
									value={imapPort}
									onChange={(e) => setImapPort(e.target.value)}
								/>
							</Field>
							<Field label="IMAP 加密方式">
								<select
									value={imapSecurity}
									onChange={(event) => setImapSecurity(event.target.value as TransportSecurityMode)}
									className="h-10 w-full rounded-md border border-edge bg-paper-2 px-3 text-sm text-ink shadow-[var(--shadow-1)] outline-none focus:border-coral focus:ring-2 focus:ring-ring"
								>
									<option value="tls">TLS / SSL</option>
									<option value="starttls">STARTTLS / 自动升级</option>
								</select>
							</Field>
							<Field label="SMTP 服务器">
								<Input
									value={smtpHost}
									onChange={(e) => setSmtpHost(e.target.value)}
								/>
							</Field>
							<Field label="SMTP 端口">
								<Input
									type="number"
									min={1}
									max={65535}
									inputMode="numeric"
									value={smtpPort}
									onChange={(e) => setSmtpPort(e.target.value)}
								/>
							</Field>
							<Field label="SMTP 加密方式">
								<select
									value={smtpSecurity}
									onChange={(event) => setSmtpSecurity(event.target.value as TransportSecurityMode)}
									className="h-10 w-full rounded-md border border-edge bg-paper-2 px-3 text-sm text-ink shadow-[var(--shadow-1)] outline-none focus:border-coral focus:ring-2 focus:ring-ring"
								>
									<option value="tls">TLS / SSL</option>
									<option value="starttls">STARTTLS / 自动升级</option>
								</select>
							</Field>
						</div>
					</>
				)}
				{error && (
					<div role="alert" className="flex items-start gap-2 rounded-md border border-red/30 bg-red-bg px-3 py-2 text-meta leading-5 text-red">
						<WarningCircleIcon size={14} weight="bold" />
						<span>{error}</span>
					</div>
				)}
				<div className="flex justify-end pt-2">
					<Button type="submit" disabled={login.isPending}>
						{login.isPending ? "连接中…" : "连接邮箱"}
					</Button>
				</div>
			</form>
			<Dialog open={expiredDialogOpen} onOpenChange={setExpiredDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>密码已过期</DialogTitle>
						<DialogDescription>
							密码过期，请更新密码后重新验证。
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="新密码"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="输入新密码"
						autoComplete="current-password"
					/>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setExpiredDialogOpen(false)}>
							稍后再说
						</Button>
						<Button
							loading={login.isPending}
							disabled={!password}
							onClick={() => {
								setExpiredDialogOpen(false);
								void submit();
							}}
						>
							使用新密码重试
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-medium text-ink-3">{label}</span>
			{children}
		</label>
	);
}

function AiModelStep({ onContinue }: { onContinue: () => void | Promise<void> }) {
	const qc = useQueryClient();
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [defaultModel, setDefaultModel] = useState("");
	const [models, setModels] = useState<DiscoveredLlmModel[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [localDetected, setLocalDetected] = useState(false);
	const [localRequiresAuth, setLocalRequiresAuth] = useState(false);
	const probedRef = useRef(false);
	const discover = useDiscoverLlmModels();
	const runDiscovery = discover.mutate;
	const discoverModels = useCallback(() => {
		if (!apiKey.trim()) return;
		runDiscovery(
			{
				baseUrl: baseUrl.trim() || undefined,
				apiKey: apiKey.trim(),
			},
			{
				onSuccess: (result) => {
					setModels(result.models);
					if (result.models.length === 1) {
						setDefaultModel((current) => current || result.models[0]!.id);
					}
				},
				onError: () => setModels([]),
			},
		);
	}, [apiKey, baseUrl, runDiscovery]);

	// One-shot background probe of the local sub2agent gateway (127.0.0.1:8989).
	// Prefill ONLY when the gateway is reachable AND a real model discovery
	// with the fixed "sub2agent" API key succeeds — i.e. 8989 + sub2agent
	// actually returns models. If either step fails, nothing is prefilled
	// so the user is never handed a broken configuration.
	useEffect(() => {
		if (probedRef.current) return;
		probedRef.current = true;
		let cancelled = false;
		void api
			.detectLocalLlmGateway()
			.then(async (result) => {
				if (cancelled || !result.reachable) return;
				const gatewayBaseUrl = result.baseUrl || "";
				// Verify the gateway actually serves models with the fixed key.
				try {
					const discovery = await api.discoverLlmModels({
						baseUrl: gatewayBaseUrl || undefined,
						apiKey: "sub2agent",
					});
					if (cancelled || !discovery.models?.length) return;
					setBaseUrl((current) => current || gatewayBaseUrl);
					setApiKey((current) => current || "sub2agent");
					setModels((current) =>
						current.length ? current : discovery.models,
					);
					if (discovery.models.length === 1) {
						setDefaultModel(
							(current) => current || discovery.models[0]!.id,
						);
					}
					setLocalDetected(true);
					setLocalRequiresAuth(result.requiresAuth === true);
				} catch {
					// Model discovery with sub2agent failed — do not prefill.
				}
			})
			.catch(() => {
				// Probing must never block or disturb onboarding.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!apiKey.trim()) {
			// Keep models prefilled by the local-gateway probe instead of
			// clearing them the moment the user edits the base URL.
			if (!localDetected) setModels([]);
			return;
		}
		const timer = window.setTimeout(discoverModels, 600);
		return () => window.clearTimeout(timer);
	}, [apiKey, baseUrl, discoverModels, localDetected]);
	const save = useMutation({
		mutationFn: () =>
			api.saveLlmSettings({
				baseUrl: baseUrl.trim() || undefined,
				apiKey: apiKey.trim(),
				defaultModel: defaultModel.trim(),
			}),
		onSuccess: async (result) => {
			await qc.invalidateQueries({ queryKey: ["settings"] });
			try {
				await onContinue();
				if (result.runtimeReloaded === false) {
					toast.error("AI 模型设置已保存，但运行时重载未完成。请重启应用。");
				} else if (!result.probe.ok) {
					toast.warning("AI 模型设置已保存，但连接验证失败。请在设置中检查端点、密钥和网络。");
				} else {
					toast.success("AI 模型已配置");
				}
			} catch (err) {
				setError(getUserFacingError(err, "邮箱配置尚未完成，请返回上一步确认邮箱状态。"));
			}
		},
		onError: (err: Error) => {
			setError(getUserFacingError(err, "AI 模型配置失败，请检查填写的信息后重试。"));
		},
	});
	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		if (!defaultModel.trim()) {
			setError("请填写默认模型");
			return;
		}
		if (!apiKey.trim()) {
			setError("请填写 API Key，或先跳过稍后在设置中配置");
			return;
		}
		save.mutate();
	};

	return (
		<Card>
			<div className="mb-5">
				<h2 className="mb-1 text-lg font-semibold text-ink">配置 AI 模型</h2>
				<p className="text-xs text-ink-3">
					请先完成 AI 模型配置，然后再正式进入邮箱。也可以先跳过，稍后在设置中配置。
				</p>
				{localDetected ? (
					<p className="mt-2 text-xs leading-5 text-ink-3">
						检测到本地 AI 网关（127.0.0.1:8989），已验证可用并自动填入配置。
					</p>
				) : null}
			</div>
			<form onSubmit={submit} className="space-y-3">
				<Field label="Base URL（可选）">
					<Input
						value={baseUrl}
						onChange={(event) => {
							setModels([]);
							discover.reset();
							setBaseUrl(event.target.value);
						}}
						placeholder="https://api.openai.com/v1"
						autoComplete="off"
					/>
				</Field>
				<Field label="API Key">
					<Input
						type="password"
						value={apiKey}
						onChange={(event) => {
							setModels([]);
							discover.reset();
							setApiKey(event.target.value);
						}}
						placeholder="sk-..."
						autoComplete="off"
					/>
				</Field>
				<div>
					<div className="mb-1 flex items-center justify-between gap-3">
						<label
							htmlFor="onboarding-default-model"
							className="text-xs font-medium text-ink-3"
						>
							默认模型
						</label>
						<button
							type="button"
							onClick={discoverModels}
							disabled={!apiKey.trim() || discover.isPending}
							className="min-h-8 text-meta font-medium text-coral hover:text-coral-2 disabled:text-ink-4"
						>
							{discover.isPending ? "正在获取…" : "重新获取模型"}
						</button>
					</div>
					<ModelPicker
						id="onboarding-default-model"
						value={defaultModel}
						onChange={setDefaultModel}
						models={models}
						status={discover.isPending
							? "loading"
							: discover.isError
								? "error"
								: discover.isSuccess
									? "success"
									: "idle"}
						showStatus
						placeholder="自动发现，也可手动输入模型 ID"
					/>
				</div>
				{error ? (
					<div role="alert" className="flex items-start gap-2 rounded-md border border-red/30 bg-red-bg px-3 py-2 text-meta leading-5 text-red">
						<WarningCircleIcon size={14} weight="bold" />
						<span>{error}</span>
					</div>
				) : null}
				<div className="flex items-center justify-between pt-2">
					<button
						type="button"
						className="text-xs text-ink-3 hover:text-ink"
						onClick={() => {
							setError(null);
							void Promise.resolve(onContinue()).catch((err) => {
								setError(getUserFacingError(err, "邮箱配置尚未完成，请返回上一步确认邮箱状态。"));
							});
						}}
					>
						暂时跳过
					</button>
					<Button type="submit" disabled={save.isPending}>
						{save.isPending ? "保存中…" : "保存并进入"}
					</Button>
				</div>
			</form>
		</Card>
	);
}
