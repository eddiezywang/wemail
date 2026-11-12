// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email, Folder, Mailbox } from "~/types";
import { waitForMailRefresh } from "~/lib/mailRefresh";
import type { EmailIntelligenceState } from "~/types/wemail";
import type {
	InvoiceMailState,
	InvoiceMailStatusSummary,
} from "../../shared/wemail/invoice";
import type {
	WemailDeliveryResult,
	MailDraftRecord,
	MailMessage as CanonicalMailMessage,
	WemailDraftInput,
	WemailDraftSaveInput,
} from "../../shared/wemail/mail";
import { hasDownloadableAttachments } from "../../shared/wemail/mail";
import type {
	AutomationAction,
	AutomationConditionMode,
	AutomationConditionRule,
	AutomationConditions,
	AutomationRule,
	AutomationRuleV2,
	AutomationTrigger,
	AutomationProcessing,
	AutomationRulePreviewResult,
} from "../../shared/wemail/automation";
import type {
	AutomationDetail,
	AutomationDraftPatch,
	AutomationListItem,
	AutomationRunDetail,
	AutomationTemplateDefinition,
	AutomationTemplateSummary,
	AutomationTemplateUpgrade,
	UnifiedAutomationListResponse,
} from "../../shared/wemail/automationCenter";
import type { ApplicationMessage, ApplicationMessageListResult } from "../../shared/wemail/applicationMessages";
import type {
  InsightReportSummary,
  InsightReportVersionSummary,
} from "../../shared/wemail/designArtifacts";
import type { AiProfileSettings, WritingStyle } from "../../shared/wemail/settings";
import type {
	ExecutionPipelineDraft,
	SkillContentResponse,
	SkillDraft,
	SkillPackageVersion,
	SkillSummary,
	SkillUsageReference,
} from "../../shared/wemail/skillCenter";
import type {
	AgentChatInput,
	AgentSuggestion,
	AgentSuggestionAction,
} from "../../shared/wemail/agent";
import type { ConversationState } from "../../shared/wemail/conversationState";
import {
	isWemailAgentEvent,
	type AgentJsonValue,
	type PersistedAgentPreference,
	type PersistedAgentFollowup,
	type WemailAgentEvent,
} from "../../shared/wemail/agentProtocol";

type AgentEvent = WemailAgentEvent;
import type {
	GenerateMailDigestRequest,
	MailDigestKind,
	MailDigestRecord,
	MailDigestScope,
	MailDigestSettings,
	MailDigestStatus,
} from "../../shared/wemail/digests";
import type { PublicEditionInfo } from "../../shared/wemail/edition";
import type {
  DirectoryContactQueryOptions,
  DirectoryContactSearchResult,
	DirectoryDepartment,
	DirectorySyncStatus,
	RecipientResolution,
	RecipientValidation,
} from "../../shared/wemail/directory";
import type {
	ConfigurationOutcome,
	ConfigurationTaskSnapshot,
} from "../../shared/wemail/configuration";
import type {
	ActionCenterPayload,
	AgentActionRiskLevel,
	AgentPendingAction,
	ComposeMailResult,
	InboxCategory,
	IntelligenceAttributeKind,
	IntelligenceJobType,
	LearningSummary,
	MailQaResult,
	SemanticSearchResult,
	SummaryHealthStatus,
	SummaryRetryAllResult,
	SummaryRetryMode,
	SmartTagPromotionCreateRequest,
	SmartTagPromotionCreateResponse,
	SmartTagPromotionPreviewRequest,
	SmartTagPromotionPreviewResponse,
	TaskAgentStatus,
	TodoItem,
	UsageBucketStats,
} from "../../shared/wemail/intelligence";
import type {
	UsagePeriod,
	EmailUsageRow,
	UsageTimeseriesGranularity,
	UsageTimeseriesResult,
} from "../../shared/wemail/usage";
import type { TelemetryArgs, TelemetryEventName } from "../../shared/wemail/telemetry";
import { createRafBatcher } from "~/lib/streamThrottle";
import { countBucket, trackPromise, trackTelemetry } from "~/lib/telemetry";
import type {
	WemailMcpConfigurationCopyResult,
	WemailMcpConfigurationTarget,
	WemailMcpManagementState,
	WemailMcpOneTimeTokenResult,
	WemailMcpSettingsInput,
} from "../../shared/wemail/mcp";
import type { NotificationTarget } from "../../shared/wemail/notifications";
import type {
  CoreHealthResult,
  MailCoreCategoryResult,
	MailCoreFolderResult,
	MailCoreListParams,
	MailCoreListResult,
  MailCoreMessageSummary,
  MailEnsureBodyResult,
  MailFocusResult,
  MailRefreshResult,
  MailSnapshotResult,
  MailCoreMutationParams,
  MailCoreMutationResult,
} from "../../shared/wemail/mailCoreProtocol";
import type {
	MailDatabaseChangeEvent,
	MailDatabaseHealthResult,
	MailDatabaseDeleteDraftParams,
	MailDatabaseGetDraftParams,
	MailDatabaseListDraftsParams,
	MailDatabaseMutationResult,
	MailDatabaseSearchParams,
	MailDatabaseEnqueueSendParams,
	MailDatabaseEnqueueSendResult,
	MailDatabaseSaveDraftParams,
	MailDatabaseSaveDraftResult,
	MailDatabaseScheduledSendRecord,
	MailDatabaseScheduledSendPage,
	MailDatabaseSetSnoozeParams,
	MailDatabaseWriteResult,
} from "../../shared/wemail/mailDatabaseProtocol";
import type { DesktopUpdateBridge } from "../../shared/wemail/update";
import type {
	ChannelBinding,
	ChannelBotProfile,
	ChannelBotSetup,
	ChannelDiagnostics,
	ChannelDestination,
	BotChannelConfiguration,
	IntegrationConnectionSnapshot,
	IntegrationConnectionId,
} from "../../shared/wemail/channels";
import {
	type WecliCatalogResponse,
	type WecliSetupResult,
	type WecliUpdateCheckResult,
	type WecliUpdateResult,
} from "../../shared/wemail/wecliTypes";

const REQUEST_TIMEOUT_MS = 30_000;

declare global {
	interface Window {
		wemailDesktop?: {
			agentDrafts?: {
				get: (accountId: string, conversationId: string) => Promise<{ text: string }>;
				save: (accountId: string, conversationId: string, text: string) => Promise<{ ok: boolean }>;
				delete: (accountId: string, conversationId: string) => Promise<{ ok: boolean }>;
				clearAccount: (accountId: string) => Promise<{ ok: boolean }>;
			};
			mailCore?: {
				isConnected: () => boolean;
				health: () => Promise<CoreHealthResult>;
				ensureMailBody: (accountId: string, id: string, traceId?: string) => Promise<MailEnsureBodyResult>;
				retryMailBody: (accountId: string, id: string, traceId?: string, onDemand?: boolean) => Promise<MailEnsureBodyResult>;
				focusMail: (accountId: string, id: string, traceId?: string) => Promise<MailFocusResult>;
				blurMail: (accountId: string, id: string, traceId?: string) => Promise<MailFocusResult>;
				refreshMail: (accountId: string, traceId?: string) => Promise<MailRefreshResult>;
			};
			mailDatabase?: {
				isConnected: () => boolean;
				health: () => Promise<MailDatabaseHealthResult>;
				getMailSnapshot: (id: string, traceId?: string, requestId?: string) => Promise<MailSnapshotResult>;
				cancelRequest: (requestId: string) => void;
				getIntelligenceState: (id: string) => Promise<EmailIntelligenceState>;
				requestIntelligence: (params: {
					emailId: string;
					kinds: Array<"summary" | "tags" | "replyDecision">;
					revive?: boolean;
				}) => Promise<MailDatabaseWriteResult<{ jobIds: number[] }>>;
				listMail: (params: MailCoreListParams) => Promise<MailCoreListResult>;
				listFolders: (accountId: string) => Promise<MailCoreFolderResult[]>;
				listCategories: (accountId: string) => Promise<MailCoreCategoryResult>;
				search: (params: MailDatabaseSearchParams) => Promise<MailCoreListResult>;
				mutateMail: (
					params: MailCoreMutationParams,
					idempotencyKey: string,
				) => Promise<MailDatabaseMutationResult>;
				saveDraft: (params: MailDatabaseSaveDraftParams) => Promise<MailDatabaseSaveDraftResult>;
				getDraft: (params: MailDatabaseGetDraftParams) => Promise<MailDraftRecord | null>;
				listDrafts: (params: MailDatabaseListDraftsParams) => Promise<MailDraftRecord[]>;
				listSnoozed: (accountId: string) => Promise<CanonicalMailMessage[]>;
				deleteDraft: (params: MailDatabaseDeleteDraftParams) => Promise<MailDatabaseWriteResult<boolean>>;
				setSnooze: (params: MailDatabaseSetSnoozeParams) => Promise<MailDatabaseWriteResult<CanonicalMailMessage | null>>;
				enqueueSend: (
					params: MailDatabaseEnqueueSendParams,
				) => Promise<MailDatabaseWriteResult<MailDatabaseEnqueueSendResult>>;
				listScheduled: (accountId: string) => Promise<MailDatabaseScheduledSendRecord[]>;
				listScheduledPage: (accountId: string, page?: number, limit?: number) => Promise<MailDatabaseScheduledSendPage>;
				cancelScheduled: (accountId: string, id: string) => Promise<MailDatabaseWriteResult<boolean>>;
				deleteScheduled: (accountId: string, id: string) => Promise<MailDatabaseWriteResult<boolean>>;
				onChanged: (listener: (event: MailDatabaseChangeEvent) => void) => () => void;
			};
			apiBaseUrl?: string;
			platform?: string;
			storage?: {
				getDataDirectory: () => Promise<{
					currentPath: string;
					defaultPath: string;
					custom: boolean;
					managedByEnvironment: boolean;
					lastMigration?: {
						status: "success" | "failed";
						from: string;
						to: string;
						message?: string;
					};
				} | undefined>;
				chooseDataDirectory: () => Promise<{ canceled: boolean; path?: string }>;
				migrateDataDirectory: (target: string) => Promise<
					| { ok: true; restarting: true }
					| { ok: false; error: string }
				>;
			};
			versions?: Record<string, string>;
			getPathForFile?: (file: File) => string;
			getAppInfo?: () => Promise<DesktopAppInfo>;
			update?: DesktopUpdateBridge;
			telemetry?: {
				track: (event: TelemetryEventName, args?: TelemetryArgs) => void;
				getEnabled: () => Promise<boolean>;
				setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
			};
			openExternal?: (url: string) => Promise<{
				ok: boolean;
				reason?: "invalid-url" | "open-failed";
			}>;
			openWindowsNotificationSettings?: () => Promise<{
				ok: boolean;
				supported: boolean;
			}>;
			saveDiagnosticsPackage?: (fileName: string) => Promise<{
				ok: boolean;
				canceled?: boolean;
				filePath?: string;
				error?: string;
			}>;
			getApiBaseUrl?: () => Promise<string | undefined>;
			onApiEndpointChanged?: (
				callback: (state: {
					state: "recovering" | "ready";
					baseUrl?: string;
					generation: number;
				}) => void,
			) => () => void;
			copyMcpConfiguration?: (
				target: WemailMcpConfigurationTarget,
			) => Promise<WemailMcpConfigurationCopyResult>;
			searchDirectoryContacts?: (
				query: string,
				options?: DirectoryContactQueryOptions,
			) => Promise<{ ok: true } & DirectoryContactSearchResult>;
			onSyncNow?: (callback: () => void) => () => void;
			onMailChanged?: (
				callback: (payload: {
					accountId: string;
					origin: "live-idle" | "live-poll" | "manual";
					insertedCount: number;
					insertedIds: string[];
				}) => void,
			) => () => void;
			onMailAuthRequired?: (
				callback: (payload: {
					accountId: string;
					code: "MAIL_CREDENTIAL_INVALID";
					stage: "imap.login";
				}) => void,
			) => () => void;
			onNotificationNavigate?: (
				callback: (target: NotificationTarget) => void,
			) => () => void;
			notifyAgentConfirmation?: (input: {
				accountId: string;
				actionId: string;
				description: string;
			}) => void;
			notifyAgentRun?: (input: {
				accountId: string;
				conversationId: string;
				runId: string;
				state: "failed" | "paused";
			}) => void;
			window?: {
				minimize: () => Promise<void>;
				toggleMaximize: () => Promise<{ maximized: boolean }>;
				close: () => Promise<void>;
				quit?: () => Promise<void>;
				getCloseBehavior: () => Promise<"tray" | "exit">;
				setCloseBehavior: (value: "tray" | "exit") => Promise<{ ok: boolean; value: "tray" | "exit" }>;
				onCloseBehaviorChange: (callback: (value: "tray" | "exit") => void) => () => void;
				isMaximized: () => Promise<boolean>;
				onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
			};
		};
	}
}

export interface DesktopAppInfo {
	name: string;
	version: string;
	platform: string;
	arch: string;
	electronVersion: string;
	chromeVersion: string;
	nodeVersion: string;
}

export interface WecliComponentStatus {
	state: "missing" | "ready" | "error";
	installed: boolean;
	connected: boolean;
	version?: string;
	checkedAt: string;
	doctor: {
		ok: boolean;
		durationMs?: number;
		timedOut: boolean;
	};
}

export interface WecliInstallResult {
	succeeded: boolean;
	durationMs: number;
	timedOut: boolean;
}

// Cache for the IPC-resolved API base URL. Some Electron releases drop
// `additionalArguments` from the renderer's process.argv, so the sync
// `wemailDesktop.apiBaseUrl` can be missing — we fall back to an IPC
// round-trip on first use and memoize the result.
let cachedApiBaseUrl: string | undefined;
let cachedApiBaseUrlPromise: Promise<string | undefined> | null = null;
let apiEndpointGeneration = 0;
const endpointRequestControllers = new Set<AbortController>();
const endpointReadyWaiters = new Set<{
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}>();
const API_ENDPOINT_CHANGED = "wemail-api-endpoint-changed";
let disposeApiEndpointSubscription: (() => void) | null = null;
export type ApiEndpointRuntimeState = "ready" | "recovering";
let apiEndpointRuntimeState: ApiEndpointRuntimeState = "ready";
const apiEndpointStateListeners = new Set<() => void>();

export function getApiEndpointRuntimeState(): ApiEndpointRuntimeState {
	return apiEndpointRuntimeState;
}

export function subscribeApiEndpointRuntimeState(listener: () => void): () => void {
	apiEndpointStateListeners.add(listener);
	return () => apiEndpointStateListeners.delete(listener);
}

function publishApiEndpointRuntimeState(state: ApiEndpointRuntimeState): void {
	if (apiEndpointRuntimeState === state) return;
	apiEndpointRuntimeState = state;
	for (const listener of apiEndpointStateListeners) listener();
}

function applyApiEndpointState(state: {
	state: "recovering" | "ready";
	baseUrl?: string;
	generation: number;
}) {
	publishApiEndpointRuntimeState(state.state);
	apiEndpointGeneration = Math.max(apiEndpointGeneration + 1, state.generation);
	cachedApiBaseUrl = state.state === "ready" ? state.baseUrl : undefined;
	cachedApiBaseUrlPromise = null;
	for (const controller of endpointRequestControllers) {
		controller.abort(API_ENDPOINT_CHANGED);
	}
	endpointRequestControllers.clear();
	if (!cachedApiBaseUrl) return;
	for (const waiter of [...endpointReadyWaiters]) {
		clearTimeout(waiter.timer);
		endpointReadyWaiters.delete(waiter);
		waiter.resolve();
	}
}

function waitForApiEndpoint(timeoutMs = 60_000): Promise<void> {
	if (cachedApiBaseUrl) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const waiter = {
			resolve,
			reject,
			timer: setTimeout(() => {
				endpointReadyWaiters.delete(waiter);
				reject(new Error("邮件服务恢复超时，请重试"));
			}, timeoutMs),
		};
		endpointReadyWaiters.add(waiter);
	});
}

export function initializeDesktopApiEndpointBridge() {
	if (typeof window === "undefined") return;
	const initial = window.wemailDesktop?.apiBaseUrl;
	if (initial) {
		cachedApiBaseUrl = initial;
		publishApiEndpointRuntimeState("ready");
	} else if (window.wemailDesktop?.onApiEndpointChanged) {
		publishApiEndpointRuntimeState("recovering");
	}
	if (!disposeApiEndpointSubscription) {
		disposeApiEndpointSubscription =
			window.wemailDesktop?.onApiEndpointChanged?.(applyApiEndpointState) ?? null;
	}
}

export function resetApiEndpointRuntimeForTests() {
	disposeApiEndpointSubscription?.();
	disposeApiEndpointSubscription = null;
	cachedApiBaseUrl = undefined;
	cachedApiBaseUrlPromise = null;
	apiEndpointGeneration = 0;
	apiEndpointRuntimeState = "ready";
	for (const controller of endpointRequestControllers) controller.abort();
	endpointRequestControllers.clear();
	for (const waiter of endpointReadyWaiters) {
		clearTimeout(waiter.timer);
		waiter.reject(new Error("API endpoint runtime reset"));
	}
	endpointReadyWaiters.clear();
}

initializeDesktopApiEndpointBridge();

async function ensureApiBaseUrl(): Promise<string | undefined> {
	if (cachedApiBaseUrl) return cachedApiBaseUrl;
	const sync = window.wemailDesktop?.apiBaseUrl;
	if (sync) {
		cachedApiBaseUrl = sync;
		publishApiEndpointRuntimeState("ready");
		return sync;
	}
	if (!window.wemailDesktop?.getApiBaseUrl) return undefined;
	if (!cachedApiBaseUrlPromise) {
		const lookupGeneration = apiEndpointGeneration;
		cachedApiBaseUrlPromise = window.wemailDesktop.getApiBaseUrl().then((v) => {
			if (v && lookupGeneration === apiEndpointGeneration) {
				cachedApiBaseUrl = v;
				publishApiEndpointRuntimeState("ready");
			}
			return v;
		});
	}
	return cachedApiBaseUrlPromise;
}

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super(formatApiErrorMessage(status, body));
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

function formatApiErrorMessage(status: number, body: Record<string, unknown>) {
	const base =
		typeof body.error === "string" && body.error.length > 0
			? body.error
			: `Request failed: ${status}`;
	const details: string[] = [];
	if (typeof body.stage === "string" && body.stage.length > 0) {
		details.push(`stage: ${body.stage}`);
	}
	if (typeof body.detail === "string" && body.detail.length > 0 && body.detail !== base) {
		details.push(`detail: ${body.detail}`);
	}
	if (
		typeof body.errorId === "string" &&
		body.errorId.length > 0 &&
		!base.includes(body.errorId)
	) {
		details.push(`errorId: ${body.errorId}`);
	}
	return details.length > 0 ? `${base} (${details.join(", ")})` : base;
}

async function request<T>(
	url: string,
	options: RequestInit = {},
	requestOptions: { timeoutMs?: number } = {},
	endpointRetry = 0,
): Promise<T> {
	const timeoutController = new AbortController();
	const endpointController = new AbortController();
	const timeoutMs = requestOptions.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const timeout = setTimeout(() => {
		timeoutController.abort(new Error("请求超时，请稍后重试"));
	}, timeoutMs);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		timeoutController.signal,
		endpointController.signal,
	]);

	// Resolve base URL lazily; the IPC fallback handles cases where the
	// preload's sync `apiBaseUrl` did not propagate via process.argv.
	if (typeof window !== "undefined" && !cachedApiBaseUrl) {
		await ensureApiBaseUrl();
	}
	const requestGeneration = apiEndpointGeneration;
	endpointRequestControllers.add(endpointController);

	try {
		const res = await fetch(resolveApiUrl(url), {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} catch (error) {
		if (
			endpointController.signal.aborted &&
			endpointController.signal.reason === API_ENDPOINT_CHANGED
		) {
			if (endpointRetry >= 1) {
				throw new Error("邮件服务刚刚恢复，请重试");
			}
			await waitForApiEndpoint();
			return request<T>(url, options, requestOptions, endpointRetry + 1);
		}
		if (timeoutController.signal.aborted) {
			throw new Error("请求超时，请稍后重试");
		}
		if (requestGeneration !== apiEndpointGeneration && endpointRetry < 1) {
			await waitForApiEndpoint();
			return request<T>(url, options, requestOptions, endpointRetry + 1);
		}
		throw error;
	} finally {
		endpointRequestControllers.delete(endpointController);
		clearTimeout(timeout);
	}
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function getDesktopApiBaseUrl(): string | undefined {
	if (typeof window === "undefined") return undefined;
	return cachedApiBaseUrl ?? window.wemailDesktop?.apiBaseUrl;
}

export function resolveApiUrl(url: string): string {
	if (/^https?:\/\//i.test(url)) return url;
	const baseUrl = getDesktopApiBaseUrl();
	if (baseUrl) return `${baseUrl}${url}`;
	if (typeof window !== "undefined" && window.location?.origin) {
		return `${window.location.origin}${url}`;
	}
	return url;
}

export interface AgentActionExecutionItem {
	filename?: string;
	ok: boolean;
	command?: string;
	binary?: string;
	resolvedBinary?: string;
	args?: string[];
	errorCode?: string;
	exitCode?: number;
	auditId?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
}

export interface AgentActionExecutionResult {
	ok: boolean;
	summary: string;
	successCount?: number;
	failureCount?: number;
	items?: AgentActionExecutionItem[];
}

export interface ResolvePendingActionResult {
	ok: boolean;
	execution?: AgentActionExecutionResult;
  accepted?: boolean;
  task?: import("../../shared/wemail/actionExecution").ActionExecutionSnapshot;
}

export function buildActionExecutionEventsUrl(): string {
  return resolveApiUrl("/api/agent/action-execution-events");
}

export function buildMailEventsUrl(accountId: string): string {
	return resolveApiUrl(
		`/api/mail/events?accountId=${encodeURIComponent(accountId)}`,
	);
}

export function buildIntegrationEventsUrl(): string {
	return resolveApiUrl("/api/channels/events");
}

function isDesktopApi() {
	if (typeof window === "undefined") return false;
	return !!(cachedApiBaseUrl || window.wemailDesktop);
}

async function mutateDesktopMail(
	params: MailCoreMutationParams,
): Promise<MailCoreMutationResult> {
	const database = window.wemailDesktop?.mailDatabase;
	const idempotencyKey = crypto.randomUUID();
	if (!database?.isConnected()) {
		throw new ApiError(503, { error: "mail database is not connected" });
	}
	return (await database.mutateMail(params, idempotencyKey)).value;
}

function get<T>(
	url: string,
	opts?: {
		params?: Record<string, string>;
		responseType?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
	},
) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	}, { timeoutMs: opts?.timeoutMs });
}

function post<T>(
	url: string,
	body?: unknown,
	opts?: { signal?: AbortSignal; timeoutMs?: number },
) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	}, { timeoutMs: opts?.timeoutMs });
}

type CompleteTodoResponse = { ok: boolean; todo?: unknown };
const todoCompletionRequests = new Map<string, Promise<CompleteTodoResponse>>();

function completeTodoDebounced(todoId: string): Promise<CompleteTodoResponse> {
	const pending = todoCompletionRequests.get(todoId);
	if (pending) return pending;
	const request = post<CompleteTodoResponse>(
		`/api/todos/${encodeURIComponent(todoId)}/complete`,
	);
	todoCompletionRequests.set(todoId, request);
	const release = () => globalThis.setTimeout(() => {
		if (todoCompletionRequests.get(todoId) === request) {
			todoCompletionRequests.delete(todoId);
		}
	}, 300);
	void request.then(release, release);
	return request;
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function patch<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PATCH",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "DELETE",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function parseSseEvents(chunk: string): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const block of chunk.split(/\r?\n\r?\n/)) {
		const dataLines = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart());
		if (dataLines.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(dataLines.join("\n"));
			if (!isWemailAgentEvent(parsed)) {
				throw new Error("Invalid versioned agent event");
			}
			events.push(parsed);
		} catch {
			throw new Error("Invalid agent event stream.");
		}
	}
	return events;
}

async function streamAgentChat(
	input: AgentChatInput,
	handlers: AgentChatStreamHandlers,
	opts?: { signal?: AbortSignal },
): Promise<void> {
	if (typeof window !== "undefined" && !cachedApiBaseUrl) {
		await ensureApiBaseUrl();
	}

	const res = await fetch(resolveApiUrl("/api/agent/chat"), {
		method: "POST",
		headers: {
			Accept: "text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input),
		signal: opts?.signal,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new ApiError(res.status, body as Record<string, unknown>);
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream") || !res.body) {
		const body = (await res.json()) as { events?: AgentEvent[] };
		for (const event of body.events ?? []) handlers.onEvent(event);
		return;
	}

	// Throttle React-facing dispatch to one batch per animation frame so a
	// burst of per-token SSE events doesn't trigger 100s of setState calls
	// per second. Events are drained in arrival order so tool-call lifecycle
	// (tool_call → tool_result) and surrounding text deltas stay ordered.
	const batcher = createRafBatcher<AgentEvent>((batch) => {
		for (const event of batch) handlers.onEvent(event);
	});

	try {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			const boundary = Math.max(
				pending.lastIndexOf("\n\n"),
				pending.lastIndexOf("\r\n\r\n"),
			);
			if (boundary < 0) continue;
			const complete = pending.slice(0, boundary + 2);
			pending = pending.slice(boundary + 2);
			for (const event of parseSseEvents(complete)) batcher.push(event);
		}
		pending += decoder.decode();
		for (const event of parseSseEvents(pending)) batcher.push(event);
		// Synchronously deliver any tail events buffered between the last
		// frame and stream completion before this promise resolves.
		batcher.flush();
	} catch (err) {
		// On abort / network error, drop anything still buffered. The caller
		// observes the rejection and won't expect further events.
		batcher.dispose();
		throw err;
	}
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
	unreadCount: number;
	hasMore: boolean;
	nextCursor?: string;
}

export interface AccountCurrentResponse {
	account: {
		id: string;
		emailAddress: string;
		displayName?: string;
		imap: { host: string; port: number; secure: boolean; username: string };
		smtp: { host: string; port: number; secure: boolean; username: string };
	} | null;
}

export type { AgentChatInput, AgentEvent };
export type { AgentActionRiskLevel, AgentPendingAction, ActionCenterPayload };

export interface AgentChatStreamHandlers {
	onEvent: (event: AgentEvent) => void;
}

export interface WorkspaceFileEntry {
	path: string;
	size: number;
	mtime: string;
	type: "file";
	kind: "writing-style" | "sender-preference" | "category-rule" | "learning-note";
}

export interface MailAccountLoginInput {
	config: {
		id: string;
		emailAddress: string;
		displayName?: string;
		imap: { host: string; port: number; secure: boolean; username: string };
		smtp: { host: string; port: number; secure: boolean; username: string };
	};
	secrets: {
		imapPassword: string;
		smtpPassword: string;
	};
}

export interface LlmSettings {
	provider: "openai" | "anthropic";
	baseUrl?: string;
	defaultModel: string;
	summaryModel?: string;
	draftModel?: string;
	agentModel?: string;
	reasoningEffort?: import("../../shared/wemail/settings").LlmReasoningEffort;
	hasApiKey: boolean;
	/** true = 当前生效的是免费额度（AI 调用走免费配置）。 */
	freeTrial?: boolean;
	/** 免费额度展示信息（不含密钥）。 */
	freeTrialModel?: string;
	freeTrialExpiresAt?: string;
	updatedAt?: string;
}

export interface LlmStatusError {
	code: string;
	status?: number;
	message: string;
	occurredAt: string;
}

export interface LlmStatus {
	configured: boolean;
	provider?: string;
	model?: string;
	health?: {
		availability: "unknown" | "available" | "unreachable";
		lastError: LlmStatusError | null;
		lastSuccessAt: string | null;
	};
}

export interface SaveLlmSettingsInput {
	provider?: "openai" | "anthropic";
	baseUrl?: string;
	apiKey?: string;
	defaultModel: string;
	summaryModel?: string;
	draftModel?: string;
	agentModel?: string;
	reasoningEffort?: import("../../shared/wemail/settings").LlmReasoningEffort;
}

export interface DiscoveredLlmModel {
	id: string;
	ownedBy?: string;
}

export interface DiscoverLlmModelsInput {
	provider?: "openai" | "anthropic";
	baseUrl?: string;
	apiKey?: string;
}

export interface DiscoverLlmModelsResponse {
	ok: true;
	provider: "openai" | "anthropic";
	models: DiscoveredLlmModel[];
}

export interface DetectLocalGatewayResult {
	ok: true;
	reachable: boolean;
	baseUrl?: string;
	requiresAuth?: boolean;
	models?: DiscoveredLlmModel[];
	provider?: "openai" | "anthropic";
}

export interface FreeTrialResourceInfo {
	enabled: boolean;
	model: string;
	groupId: number;
	expiresInDays: number;
	baseUrl: string;
	allowedDomains: string[];
}

export interface ActivateFreeTrialResult {
	ok: boolean;
	llm: LlmSettings;
	expiresAt?: string;
	resource?: FreeTrialResourceInfo;
}

export interface WemailAddress {
	email: string;
	name?: string;
	directoryName?: string;
}

export interface LoggingDiagnostics {
	ok: boolean;
	debugEnabled: boolean;
	expiresAt: string | null;
	remainingSeconds: number;
	retentionDays: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

async function requestCanonicalIntelligence(
	emailId: string,
	kinds: Array<"summary" | "tags" | "replyDecision">,
	revive = false,
): Promise<{ ok: boolean }> {
	const database = window.wemailDesktop?.mailDatabase;
	if (!database?.isConnected()) {
		throw new ApiError(503, { error: "mail database is not connected" });
	}
	await database.requestIntelligence({ emailId, kinds, revive });
	return { ok: true };
}

export interface AgentAttentionRun {
	id: string;
	conversationId: string;
	state: "queued" | "running" | "retrying" | "stopping" | "settled" | "failed" | "stopped" | "interrupted";
	startedAt?: string;
	settledAt?: string;
	interruptedAt?: string;
	errorCode?: string;
}

export interface AgentAttention {
	active: AgentAttentionRun[];
	failed: AgentAttentionRun[];
	pausedConversationIds: string[];
}

export interface DiagnosticPackageExport {
	ok: boolean;
	package: {
		fileName: string;
		expiresAt: string;
	};
	uploaded: false;
}

export interface WemailMessageSummary {
	id: string;
	accountId: string;
	folder: string;
	threadId?: string;
	messageId: string;
	from: WemailAddress;
	to: WemailAddress[];
	subject: string;
	snippet: string;
	receivedAt: string;
	sentAt?: string;
	hasAttachments: boolean;
	invoiceDetected?: boolean;
	invoiceStatusTag?: string | null;
	invoiceStatusState?: InvoiceMailState | null;
}

export interface WemailMessage extends WemailMessageSummary {
	parentMessageId?: string;
	cc?: WemailAddress[];
	bcc?: WemailAddress[];
	delivery?: WemailDeliveryResult;
	bodyText?: string;
	bodyHtml?: string;
	attachments?: WemailAttachment[];
	flags?: {
		seen?: boolean;
		flagged?: boolean;
		answered?: boolean;
		draft?: boolean;
	};
}

interface WemailAttachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	contentId?: string | null;
	content_id?: string | null;
	disposition?: string | null;
}

interface WemailMessagesResponse {
	messages: WemailMessageSummary[];
	totalCount?: number;
	unreadCount?: number;
	nextCursor?: string;
}

interface WemailMessageResponse {
	message: WemailMessage;
	bodyState?: "ready" | "missing" | "fetching" | "failed";
	bodyErrorCode?: string;
	bodyAttempts?: number;
	bodyNextRetryAt?: string;
	bodyRetryable?: boolean;
	invoiceDetected?: boolean;
	invoiceStatus?: InvoiceMailStatusSummary | null;
}

interface WemailSyncResponse {
	queued: boolean;
	synced?: boolean;
	inserted?: number;
	updated?: number;
	error?: string;
	code?: string;
}

export interface WemailRefreshResponse {
	ok: true;
	accountId: string;
	runId: string;
	disposition: "accepted" | "joined";
	status: "queued" | "completed";
	changed: boolean;
	completedAt?: string;
}

export interface MailSyncStatusResponse {
	metadataSyncedAt: string | null;
	bodySyncedAt: string | null;
	pendingBodyCount: number;
	bodyWorkerState: "idle" | "running" | "backoff" | "credential-required" | "stopped";
	lastBodyErrorCode: string | null;
	watcher: {
		mode: "starting" | "watching" | "reconnecting" | "stopped";
		nativeIdle: boolean | null;
		reconnectAttempts: number;
		lastConnectedAt: string | null;
		lastMailboxEventAt: string | null;
		lastSyncSucceededAt: string | null;
		lastNewMailAt: string | null;
		lastError: string | null;
	};
	startup: import("../../shared/wemail/startup").StartupSyncStatus | null;
}

const SYSTEM_FOLDERS: Folder[] = [
	{ id: "inbox", name: "收件箱", unreadCount: 0, totalCount: 0 },
	{ id: "sent", name: "已发送", unreadCount: 0, totalCount: 0 },
	{ id: "draft", name: "草稿", unreadCount: 0, totalCount: 0 },
	{ id: "archive", name: "归档", unreadCount: 0, totalCount: 0 },
	{ id: "trash", name: "回收站", unreadCount: 0, totalCount: 0 },
];

function formatAddress(addr?: WemailAddress): string {
	if (!addr) return "";
	const displayName = addr.directoryName || addr.name;
	return displayName ? `${displayName} <${addr.email}>` : addr.email;
}

function mapFolderForServer(folder?: string): string | undefined {
	if (!folder) return undefined;
	const trimmed = folder.trim();
	const systemFolders: Record<string, string> = {
		inbox: "INBOX",
		sent: "Sent",
		draft: "Drafts",
		drafts: "Drafts",
		archive: "Archive",
		trash: "Trash",
		spam: "Spam",
	};
	return systemFolders[trimmed.toLowerCase()] ?? trimmed;
}

function mapWemailAttachments(message: WemailMessageSummary | WemailMessage | MailCoreMessageSummary) {
	if (!("attachments" in message) || !Array.isArray(message.attachments)) {
		return [];
	}
	return message.attachments.map((attachment) => {
		const contentId = attachment.contentId ?? attachment.content_id ?? undefined;
		return {
			id: attachment.id,
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			size: attachment.size,
			...(contentId ? { contentId, content_id: contentId } : {}),
			...(attachment.disposition ? { disposition: attachment.disposition } : {}),
		};
	});
}

function mapWemailMessage(
	message: WemailMessageSummary | WemailMessage | MailCoreMessageSummary,
	invoiceStatus?: InvoiceMailStatusSummary | null,
	bodyState?: "ready" | "missing" | "fetching" | "failed",
	bodyErrorCode?: string,
	bodyAttempts?: number,
	bodyNextRetryAt?: string,
	bodyRetryable?: boolean,
): Email {
	const flags = "flags" in message ? message.flags : undefined;
	const bodyHtml = "bodyHtml" in message ? message.bodyHtml : undefined;
	const bodyText = "bodyText" in message ? message.bodyText : undefined;
	const attachments = mapWemailAttachments(message);
	return {
		id: message.id,
		thread_id: message.threadId ?? message.id,
		folder_id: message.folder.toLowerCase(),
		subject: message.subject || "(no subject)",
		sender: formatAddress(message.from),
		recipient: message.to.map(formatAddress).join(", "),
		cc: "cc" in message ? message.cc?.map(formatAddress).join(", ") : undefined,
		bcc: "bcc" in message ? message.bcc?.map(formatAddress).join(", ") : undefined,
		toAddresses: message.to,
		ccAddresses: "cc" in message ? message.cc : undefined,
		bccAddresses: "bcc" in message ? message.bcc : undefined,
		...("delivery" in message && message.delivery
			? { delivery: message.delivery }
			: {}),
		date: message.receivedAt,
		read: flags?.seen ?? false,
		starred: flags?.flagged ?? false,
		body: bodyHtml || bodyText || null,
		bodyHtml: bodyHtml || null,
		bodyText: bodyText || null,
		bodyPending:
			bodyState === "missing" ||
			bodyState === "fetching" ||
			bodyState === "failed",
		bodyState,
		...(bodyErrorCode ? { bodyErrorCode } : {}),
		...(typeof bodyAttempts === "number" ? { bodyAttempts } : {}),
		...(bodyNextRetryAt ? { bodyNextRetryAt } : {}),
		...(typeof bodyRetryable === "boolean" ? { bodyRetryable } : {}),
		message_id: message.messageId,
		in_reply_to:
			"parentMessageId" in message ? message.parentMessageId ?? null : null,
		snippet: message.snippet,
		invoiceStatusTag: invoiceStatus?.tag ?? message.invoiceStatusTag ?? null,
		invoiceStatusState: invoiceStatus?.state ?? message.invoiceStatusState ?? null,
		invoiceStatus: invoiceStatus ?? null,
		invoiceDetected: message.invoiceDetected === true,
		hasAttachments:
			message.hasAttachments || hasDownloadableAttachments(attachments),
		attachments,
	};
}

async function getCurrentMailboxAccount(): Promise<Mailbox | null> {
	const { account } = await get<AccountCurrentResponse>("/api/account/current");
	if (!account) return null;
	return {
		id: account.id,
		email: account.emailAddress,
		name: account.displayName || account.emailAddress.split("@")[0] || account.emailAddress,
	};
}

async function listDesktopMailboxes(): Promise<Mailbox[]> {
	const mailbox = await getCurrentMailboxAccount();
	return mailbox ? [mailbox] : [];
}

async function getDesktopMailbox(mailboxId: string): Promise<Mailbox> {
	const mailbox = await getCurrentMailboxAccount();
	if (!mailbox || (mailbox.id !== mailboxId && mailbox.email !== mailboxId)) {
		throw new ApiError(404, { error: "mailbox not found" });
	}
	return mailbox;
}

async function listDesktopEmails(
	mailboxId: string,
	params: Record<string, string>,
	opts?: { signal?: AbortSignal },
): Promise<EmailListResponse> {
	opts?.signal?.throwIfAborted();
	const folder = mapFolderForServer(params.folder);
	const query: Record<string, string> = {};
	if (folder) query.folder = folder;
	for (const key of [
		"limit",
		"before",
		"cursor",
		"allMail",
		"scope",
		"category",
		"tag",
		"smartTagId",
		"unread",
		"toMe",
		"ccMe",
		"hasAttachment",
		"olderThan",
	]) {
		if (params[key]) query[key] = params[key];
	}
	const mailDatabase = window.wemailDesktop?.mailDatabase;
	const listParams: MailCoreListParams = {
				accountId: mailboxId,
				...(folder ? { folder } : {}),
				...(query.limit ? { limit: Number(query.limit) } : {}),
				...(query.before ? { before: query.before } : {}),
				...(query.cursor ? { cursor: query.cursor } : {}),
				...(query.allMail === "1" ? { allMail: true } : {}),
				...(query.scope === "all" || query.scope === "starred" || query.scope === "snoozed" || query.scope === "newsletter" || query.scope === "todos"
					? { scope: query.scope }
					: {}),
				...(query.category ? { category: query.category } : {}),
				...(query.smartTagId || query.tag
					? { smartTagId: query.smartTagId ?? query.tag }
					: {}),
				...(query.unread === "1" ? { unread: true } : {}),
				...(query.toMe === "1" ? { toMe: true } : {}),
				...(query.ccMe === "1" ? { ccMe: true } : {}),
				...(query.hasAttachment === "1" ? { hasAttachment: true } : {}),
				...(query.olderThan === "7d" || query.olderThan === "30d" || query.olderThan === "180d"
					? { olderThan: query.olderThan }
					: {}),
			};
	if (!mailDatabase?.isConnected()) {
		throw new ApiError(503, { error: "mail database is not connected" });
	}
	const data = await mailDatabase.listMail(listParams);
	opts?.signal?.throwIfAborted();
	const emails = data.messages.map((message) => mapWemailMessage(message));
	if (import.meta.env.DEV) {
		console.debug(
			"[mail-events] listDesktopEmails result",
			JSON.stringify({
				folder: folder ?? null,
				category: query.category ?? null,
				tag: query.tag ?? null,
				count: emails.length,
				latestId: emails[0]?.id ?? null,
				latestSubject: emails[0]?.subject ?? null,
			}),
		);
	}
	return {
		emails,
		totalCount: data.totalCount ?? emails.length,
		unreadCount: data.unreadCount ?? emails.filter((email) => !email.read).length,
		hasMore: data.hasMore ?? Boolean(data.nextCursor),
		nextCursor: data.nextCursor,
	};
}

async function searchDesktopEmails(
	mailboxId: string,
	params: Record<string, string>,
	opts?: { signal?: AbortSignal },
): Promise<EmailListResponse> {
	opts?.signal?.throwIfAborted();
	const query: Record<string, string> = {};
	const folder = mapFolderForServer(params.folder);
	if (folder) query.folder = folder;
	if (params.query) query.q = params.query;
	if (params.from) query.from = params.from;
	if (params.to) query.to = params.to;
	if (params.subject) query.subject = params.subject;
	if (params.scope) query.scope = params.scope;
	if (params.mailScope) query.mailScope = params.mailScope;
	if (params.category) query.category = params.category;
	if (params.smartTagId) query.smartTagId = params.smartTagId;
	if (params.date_start) query.dateFrom = params.date_start;
	if (params.date_end) query.dateTo = params.date_end;
	if (params.is_read) query.read = params.is_read;
	if (params.is_starred) query.starred = params.is_starred;
	if (params.has_attachment) query.hasAttachment = params.has_attachment;
	if (params.unread) query.unread = params.unread;
	if (params.toMe) query.toMe = params.toMe;
	if (params.ccMe) query.ccMe = params.ccMe;
	if (params.olderThan) query.olderThan = params.olderThan;
	if (params.hasAttachment) query.hasAttachment = params.hasAttachment;
	if (params.limit) query.limit = params.limit;
	if (params.page) query.page = params.page;

	const mailDatabase = window.wemailDesktop?.mailDatabase;
	if (!mailDatabase?.isConnected()) {
		throw new ApiError(503, { error: "mail database is not connected" });
	}
	const data: MailCoreListResult = await mailDatabase.search({
			accountId: mailboxId,
			...(query.q ? { query: query.q } : {}),
			...(query.folder ? { folder: query.folder } : {}),
			...(query.from ? { from: query.from } : {}),
			...(query.to ? { to: query.to } : {}),
			...(query.subject ? { subject: query.subject } : {}),
			...(query.scope === "subject" || query.scope === "body" || query.scope === "address"
				? { scope: query.scope }
				: {}),
			...(query.mailScope === "all" || query.mailScope === "starred" || query.mailScope === "snoozed" || query.mailScope === "newsletter" || query.mailScope === "todos"
				? { mailScope: query.mailScope }
				: {}),
			...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
			...(query.category ? { category: query.category } : {}),
			...(query.smartTagId ? { smartTagId: query.smartTagId } : {}),
			...(query.dateTo ? { dateTo: query.dateTo } : {}),
			...(query.read ? { read: query.read === "true" || query.read === "1" } : {}),
			...(query.starred ? { starred: query.starred === "true" || query.starred === "1" } : {}),
			...(query.hasAttachment
				? { hasAttachment: query.hasAttachment === "true" || query.hasAttachment === "1" }
				: {}),
			...(query.unread ? { unread: query.unread === "true" || query.unread === "1" } : {}),
			...(query.toMe ? { toMe: query.toMe === "true" || query.toMe === "1" } : {}),
			...(query.ccMe ? { ccMe: query.ccMe === "true" || query.ccMe === "1" } : {}),
			...(query.olderThan === "7d" || query.olderThan === "30d" || query.olderThan === "180d"
				? { olderThan: query.olderThan }
				: {}),
			limit: query.limit ? Number(query.limit) : undefined,
			page: query.page ? Number(query.page) : undefined,
	});
	opts?.signal?.throwIfAborted();
	const emails = data.messages.map((message) => mapWemailMessage(message));
	return {
		emails,
		totalCount: data.totalCount ?? emails.length,
		unreadCount: emails.filter((email) => !email.read).length,
		hasMore: data.hasMore ?? Boolean(data.nextCursor),
		nextCursor: data.nextCursor,
	};
}

// ---------- Workspace (Route C / WP J.7) ----------

export async function listWorkspaceFiles(opts?: {
	signal?: AbortSignal;
}): Promise<WorkspaceFileEntry[]> {
	const res = await get<{ ok: boolean; files: WorkspaceFileEntry[] }>(
		`/api/workspace/files`,
		{ signal: opts?.signal },
	);
	return res.files ?? [];
}

export async function getWorkspaceFile(
	pathArg: string,
	opts?: { signal?: AbortSignal },
): Promise<{ path: string; content: string } | null> {
	try {
		const res = await get<{
			ok: boolean;
			path: string;
			kind: WorkspaceFileEntry["kind"];
			content: string;
		}>(
			`/api/workspace/files/${pathArg.split("/").map(encodeURIComponent).join("/")}`,
			{ signal: opts?.signal },
		);
		return { path: res.path, content: res.content };
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) return null;
		throw err;
	}
}

// ---------- Action Center (Route C / WP 3H) ----------

/**
 * Fetch the aggregated Action Center payload (pending agent actions,
 * open todos, latest Curator-authored learnings file). Returns the
 * payload directly with the API envelope's `ok` flag stripped.
 */
export async function getActionCenter(opts?: {
	signal?: AbortSignal;
}): Promise<ActionCenterPayload> {
	const res = await get<{ ok: boolean } & ActionCenterPayload>(
		`/api/action-center`,
		{ signal: opts?.signal },
	);
	const { ok: _ok, ...payload } = res;
	return payload;
}

// ---------- API client ----------

/**
 * 当前 LLM 配置是否来自"限时免费资源"的模块级缓存。
 * 用于埋点区分免费/自有模型；在 settings 读写响应时更新。
 */
let llmFreeTrialCache: boolean | undefined;

export function setLlmFreeTrialCache(value: boolean | undefined): void {
	llmFreeTrialCache = value;
}

export function isFreeTrialLlm(): boolean {
	return llmFreeTrialCache === true;
}

function trackAiFeature<T>(feature: string, operation: () => Promise<T>): Promise<T> {
	return trackPromise(operation, {
		attempted: "wemail_ai_feature_started",
		succeeded: "wemail_ai_feature_succeeded",
		failed: "wemail_ai_feature_failed",
		args: {
			feature,
			initiator: "manual",
			// 区分免费资源模型与用户自有模型（用于运营统计）
			resource: isFreeTrialLlm() ? "free" : "personal",
		},
	});
}

const api = {
	getActionCenter,
	listSkills: () =>
		get<{ skills: SkillSummary[] }>("/api/skill-center"),
	inspectSkill: (skillId: string, version?: string) =>
		get<SkillPackageVersion>(
			`/api/skill-center/${encodeURIComponent(skillId)}${version ? `?version=${encodeURIComponent(version)}` : ""}`,
		),
	getSkillContent: (skillId: string, version?: string) =>
		get<SkillContentResponse>(
			`/api/skill-center/${encodeURIComponent(skillId)}/content${version ? `?version=${encodeURIComponent(version)}` : ""}`,
		),
	importSkill: (path: string) =>
		post<SkillPackageVersion>("/api/skill-center/import", { path }),
	previewSkillImport: (path: string) =>
		post<{
			valid: boolean;
			displayName?: string;
			description?: string;
			contentHash?: string;
			issues: string[];
			warnings: string[];
		}>("/api/skill-center/import/preview", { path }),
	confirmSkillImport: (path: string, contentHash: string) =>
		post<SkillPackageVersion>("/api/skill-center/import/confirm", {
			path,
			contentHash,
		}),
	exportSkill: (
		skillId: string,
		version: string,
		destinationDirectory: string,
	) =>
		post<{ path: string }>(
			`/api/skill-center/${encodeURIComponent(skillId)}/export`,
			{ version, destinationDirectory },
		),
	setSkillEnabled: (skillId: string, enabled: boolean) =>
		post<SkillSummary>(
			`/api/skill-center/${encodeURIComponent(skillId)}/enabled`,
			{ enabled },
		),
	activateSkillVersion: (skillId: string, version: string) =>
		post<SkillSummary>(
			`/api/skill-center/${encodeURIComponent(skillId)}/activate`,
			{ version },
		),
	listSkillUsage: (skillId: string, version?: string) =>
		get<{ references: SkillUsageReference[] }>(
			`/api/skill-center/${encodeURIComponent(skillId)}/usage${version ? `?version=${encodeURIComponent(version)}` : ""}`,
		),
	deleteSkillVersion: (skillId: string, version: string) =>
		del<{ deleted: boolean }>(
			`/api/skill-center/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version)}`,
		),
	createSkillDraft: (input: {
		skillId: string;
		version: string;
		displayName: string;
		description: string;
		skillMarkdown: string;
	}) => post<SkillDraft>("/api/skill-center/drafts", input),
	createSkillDraftFromPipeline: (input: {
		accountId: string;
		pipelineDraftId: string;
		skillId: string;
		version: string;
		displayName: string;
		description: string;
	}) => post<SkillDraft>("/api/skill-center/drafts/from-pipeline", input),
	validateSkillDraft: (draftId: string) =>
		post<SkillDraft>(
			`/api/skill-center/drafts/${encodeURIComponent(draftId)}/validate`,
			{},
		),
	installSkillDraft: (draftId: string, contentHash: string) =>
		post<SkillPackageVersion>(
			`/api/skill-center/drafts/${encodeURIComponent(draftId)}/install`,
			{ contentHash },
		),
	getCurrentAccount: () =>
		get<AccountCurrentResponse>("/api/account/current"),
	getIntegrationStatus: () =>
		get<IntegrationConnectionSnapshot>("/api/channels/status"),
	refreshIntegrationStatus: (id?: IntegrationConnectionId) =>
		post<IntegrationConnectionSnapshot>(
			`/api/channels/status/detect${id ? `?id=${encodeURIComponent(id)}` : ""}`,
		),
	listChannelProfiles: () =>
		get<{ profiles: ChannelBotProfile[] }>("/api/channels/profiles"),
	listBotChannelConfigurations: () =>
		get<{ configurations: BotChannelConfiguration[] }>(
			"/api/channels/platform-configurations",
		),
	saveBotChannelConfiguration: (
		platform: "feishu" | "wecom",
		input:
			| {
					appId: string;
					appSecret: string;
			  }
			| {
					botId: string;
					botSecret: string;
			  },
	) =>
		put<{ configuration: BotChannelConfiguration }>(
			`/api/channels/platform-configurations/${platform}`,
			input,
		),
	disableBotChannelConfiguration: (platform: "feishu" | "wecom") =>
		post<{ configuration: BotChannelConfiguration }>(
			`/api/channels/platform-configurations/${platform}/disable`,
		),
	startChannelBotSetup: (platform: "feishu" | "wecom") =>
		post<{ setup: ChannelBotSetup }>(
			`/api/channels/platform-configurations/${platform}/setup`,
		),
	getChannelBotSetup: (setupId: string) =>
		get<{ setup: ChannelBotSetup }>(
			`/api/channels/platform-configurations/setup/${encodeURIComponent(setupId)}`,
		),
	cancelChannelBotSetup: (setupId: string) =>
		del<{ cancelled: boolean }>(
			`/api/channels/platform-configurations/setup/${encodeURIComponent(setupId)}`,
		),
	createOwnerPairing: (profileId: string) =>
		post<{
			pairing: {
				profileId: string;
				code: string;
				command: string;
				expiresAt: string;
			};
		}>(`/api/channels/profiles/${encodeURIComponent(profileId)}/pairing`),
	cancelOwnerPairing: (profileId: string) =>
		post<{ profile: ChannelBotProfile }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/pairing/cancel`,
		),
	detectChannelProfile: (profileId: string) =>
		post<{ diagnostics: ChannelDiagnostics }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/detect`,
		),
	sendChannelTestMessage: (profileId: string) =>
		post<{ delivery: { id: string; state: string } }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/test-message`,
		),
	retryChannelInitialization: (profileId: string) =>
		post<{ delivery: { id: string; state: string } }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/initialization/retry`,
		),
	disconnectChannelProfile: (profileId: string) =>
		post<{ profile: ChannelBotProfile }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/disconnect`,
		),
	resetChannelProfile: (profileId: string) =>
		post<{ profile: ChannelBotProfile }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/reset`,
		),
	listChannelBindings: (profileId: string) =>
		get<{ bindings: ChannelBinding[] }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/bindings`,
		),
	listChannelDestinations: (profileId: string) =>
		get<{ destinations: ChannelDestination[] }>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/destinations`,
		),
	listChannelDependentRules: (profileId: string) =>
		get<{
			rules: Array<{
				id: string;
				name: string;
				enabled: boolean;
				ownerBindingVersion: number;
				needsReauthorization: boolean;
			}>;
		}>(
			`/api/channels/profiles/${encodeURIComponent(profileId)}/dependent-rules`,
		),
	updateAccountDisplayName: (displayName: string) =>
		patch<{ ok: boolean; account: NonNullable<AccountCurrentResponse["account"]> }>(
			"/api/account/current",
			{ displayName },
		),
	loginAccount: (input: MailAccountLoginInput) =>
		post<{ ok: boolean; account: AccountCurrentResponse["account"] }>(
			"/api/account/login",
			input,
		),
	logoutAccount: () =>
		trackPromise(() => post<{ ok: boolean }>("/api/account/logout"), {
			succeeded: "wemail_account_logout",
			failed: "wemail_account_logout_failed",
			args: { source: "renderer" },
		}),
	getEditionInfo: () =>
		get<PublicEditionInfo>("/api/system/edition"),
	getDirectoryStatus: () =>
		get<{ ok: boolean; status: DirectorySyncStatus }>("/api/directory/status"),
	refreshDirectory: () =>
		post<{ ok: boolean; status: DirectorySyncStatus }>("/api/directory/refresh"),
	listDirectoryDepartments: (parentId?: string) => {
		const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
		return get<{ ok: boolean; departments: DirectoryDepartment[] }>(
			`/api/directory/departments${query}`,
		);
	},
	searchDirectoryContacts: (query: string, options?: DirectoryContactQueryOptions & { signal?: AbortSignal }) => {
		const desktopSearch =
			typeof window !== "undefined"
				? window.wemailDesktop?.searchDirectoryContacts
				: undefined;
		if (desktopSearch) {
			return withAbortSignal(
				desktopSearch(query, {
					departmentId: options?.departmentId,
					includeDescendants: options?.includeDescendants,
					limit: options?.limit,
					offset: options?.offset,
				}),
				options?.signal,
			);
		}
		const params = new URLSearchParams({ q: query });
		if (options?.departmentId) params.set("departmentId", options.departmentId);
		if (options?.includeDescendants) params.set("includeDescendants", "true");
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.offset) params.set("offset", String(options.offset));
		return get<{ ok: boolean } & DirectoryContactSearchResult>(
			`/api/directory/contacts?${params.toString()}`,
			{ signal: options?.signal },
		);
	},
	resolveDirectoryRecipients: (inputs: string[]) =>
		post<{ ok: boolean; resolutions: RecipientResolution[] }>(
			"/api/directory/recipients/resolve",
			{ inputs },
		),
	validateDirectoryRecipients: (emails: string[]) =>
		post<{ ok: boolean; validations: RecipientValidation[] }>(
			"/api/directory/recipients/validate",
			{ emails },
		),
	getLlmSettings: () =>
		get<{ llm: LlmSettings | null }>("/api/settings/llm").then((res) => {
			setLlmFreeTrialCache(res.llm?.freeTrial);
			return res;
		}),
	saveLlmSettings: (input: SaveLlmSettingsInput) =>
		put<{ ok: boolean; llm: LlmSettings }>("/api/settings/llm", input).then((res) => {
			setLlmFreeTrialCache(res.llm?.freeTrial);
			return res;
		}),
	discoverLlmModels: (input: DiscoverLlmModelsInput) =>
		post<DiscoverLlmModelsResponse>("/api/settings/llm/discover-models", input),
	detectLocalLlmGateway: () =>
		post<DetectLocalGatewayResult>("/api/settings/llm/detect-local"),
	activateFreeTrial: (username: string, email?: string) =>
		post<ActivateFreeTrialResult>("/api/settings/llm/activate-free-trial", { username, ...(email ? { email } : {}) }).then(
			(res) => {
				setLlmFreeTrialCache(res.llm?.freeTrial);
				return res;
			},
		),
	getFreeTrialResource: () =>
		get<{ ok: boolean; resource: FreeTrialResourceInfo }>("/api/settings/llm/free-trial"),
	getMcpState: () =>
		get<{ ok: true; state: WemailMcpManagementState }>("/api/mcp/state"),
	configureMcp: (input: WemailMcpSettingsInput) =>
		put<{ ok: true; state: WemailMcpManagementState }>("/api/mcp/settings", input),
	createMcpToken: () =>
		post<{ ok: true; result: WemailMcpOneTimeTokenResult }>("/api/mcp/tokens"),
	rotateMcpToken: () =>
		post<{ ok: true; result: WemailMcpOneTimeTokenResult }>("/api/mcp/tokens/rotate"),
	revokeMcpToken: () =>
		del<{ ok: true; revoked: boolean }>("/api/mcp/tokens/current"),
	resetMcpCredential: () =>
		post<{ ok: true; state: WemailMcpManagementState }>("/api/mcp/credentials/reset"),
	terminateMcpSession: (sessionHash: string) =>
		del<{ ok: true; terminated: boolean }>(`/api/mcp/sessions/${encodeURIComponent(sessionHash)}`),

	// Mailboxes — desktop mail access is provided only by the canonical DB bridge.
	// listing and fetching the current mailbox are supported, both routed
	// through `/api/account/current` adapters above. Create / update /
	// delete are not exposed: the active mailbox is configured during
	// IMAP/SMTP onboarding and changing it requires a re-login.
	listMailboxes: () =>
		listDesktopMailboxes(),
	getMailbox: (mailboxId: string) =>
		getDesktopMailbox(mailboxId),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		listDesktopEmails(mailboxId, params, opts),
	syncMail: (_input: { days?: number; mode?: "incremental" | "window"; deep?: boolean } = {}) =>
		trackPromise(
			async () => {
				const mailCore = window.wemailDesktop?.mailCore;
				if (!mailCore?.isConnected()) {
					throw new ApiError(503, { error: "mail core is not connected" });
				}
				const { account } = await get<AccountCurrentResponse>("/api/account/current");
				if (!account?.id) throw new ApiError(503, { error: "no active mail account" });
				const result = await mailCore.refreshMail(account.id);
				if (result.status === "account-unavailable" || !result.jobId) {
					throw new ApiError(503, { error: "active account is unavailable in mail core" });
				}
				return { queued: true, inserted: 0, updated: 0 } satisfies WemailSyncResponse;
			},
			{
				attempted: "wemail_mail_sync_started",
				succeeded: "wemail_mail_sync_succeeded",
				failed: "wemail_mail_sync_failed",
				args: { origin: "manual", source: "renderer" },
				successArgs: (value) => ({
					inserted_count_bucket: countBucket(value.inserted ?? 0),
					updated_count_bucket: countBucket(value.updated ?? 0),
				}),
			},
		),
	refreshMail: () =>
		trackPromise(
			async () => {
				const mailCore = window.wemailDesktop?.mailCore;
				if (!mailCore?.isConnected()) {
					throw new ApiError(503, { error: "mail core is not connected" });
				}
				const { account } = await get<AccountCurrentResponse>("/api/account/current");
				if (!account?.id) throw new ApiError(503, { error: "no active mail account" });
				const result = await mailCore.refreshMail(account.id);
				if (result.status === "account-unavailable" || !result.jobId) {
					throw new ApiError(503, { error: "active account is unavailable in mail core" });
				}
				const completed = await waitForMailRefresh(account.id, result, () => mailCore.health());
				return {
					ok: true,
					accountId: result.accountId ?? account.id,
					runId: String(result.jobId),
					disposition: "accepted",
					status: completed ? "completed" : "queued",
					changed: false,
				} satisfies WemailRefreshResponse;
			},
			{
				attempted: "wemail_mail_refresh_started",
				succeeded: "wemail_mail_refresh_succeeded",
				failed: "wemail_mail_refresh_failed",
				args: { origin: "manual", source: "renderer" },
				successArgs: (value) => ({
					disposition: value.disposition,
					status: value.status,
					changed: value.changed,
				}),
			},
		),
	getEmail: async (mailboxId: string, id: string, opts?: { signal?: AbortSignal; traceId?: string }) => {
		opts?.signal?.throwIfAborted();
		const mailDatabase = window.wemailDesktop?.mailDatabase;
		if (!mailDatabase?.isConnected()) {
			throw new ApiError(503, { error: "mail database is not connected" });
		}
		const requestId = `renderer-detail-${crypto.randomUUID()}`;
		const onAbort = () => mailDatabase.cancelRequest(requestId);
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		let data: MailSnapshotResult;
		try {
			data = await mailDatabase.getMailSnapshot(id, opts?.traceId, requestId);
		} finally {
			opts?.signal?.removeEventListener("abort", onAbort);
		}
		opts?.signal?.throwIfAborted();
		if (!data.message) throw new ApiError(404, { error: `message ${id} was not found` });
		const email = mapWemailMessage(
			data.message,
			data.invoiceStatus,
			data.bodyState,
			data.bodyErrorCode,
			data.bodyAttempts,
			data.bodyNextRetryAt,
			data.bodyRetryable,
		);
		return data.invoiceDetected ? { ...email, invoiceDetected: true } : email;
	},
	ensureEmailBody: (accountId: string, id: string, traceId?: string) => {
		const mailCore = window.wemailDesktop?.mailCore;
		if (!mailCore?.isConnected()) throw new ApiError(503, { error: "mail core is not connected" });
		return mailCore.ensureMailBody(accountId, id, traceId);
	},
	retryEmailBody: (accountId: string, id: string, onDemand?: boolean) => {
		const mailCore = window.wemailDesktop?.mailCore;
		if (!mailCore?.isConnected()) throw new ApiError(503, { error: "mail core is not connected" });
		return mailCore.retryMailBody(accountId, id, undefined, onDemand);
	},
	focusEmail: (accountId: string, id: string, traceId?: string) => {
		const mailCore = window.wemailDesktop?.mailCore;
		if (!mailCore?.isConnected()) throw new ApiError(503, { error: "mail core is not connected" });
		return mailCore.focusMail(accountId, id, traceId);
	},
	blurEmail: (accountId: string, id: string, traceId?: string) => {
		const mailCore = window.wemailDesktop?.mailCore;
		if (!mailCore?.isConnected()) throw new ApiError(503, { error: "mail core is not connected" });
		return mailCore.blurMail(accountId, id, traceId);
	},
	refreshInvoiceStatus: (emailId: string) =>
		post<{
			ok: boolean;
			updated: number;
			invoiceStatus?: InvoiceMailStatusSummary | null;
			partialFailure: boolean;
			message?: string;
		}>(`/api/mail/messages/${encodeURIComponent(emailId)}/invoice-status/refresh`),
	// Mail mutations commit only through the canonical DB Service.
	updateEmail: (_mailboxId: string, id: string, data: unknown) => {
		const fields = data && typeof data === "object" ? data as Record<string, unknown> : {};
		const readValue = typeof fields.isRead === "boolean"
			? fields.isRead
			: typeof fields.read === "boolean"
				? fields.read
				: undefined;
		const action = readValue !== undefined
			? readValue ? "mark_read" : "mark_unread"
			: "starred" in fields
				? fields.starred ? "star" : "unstar"
				: "update";
		const mutation = readValue !== undefined
			? { type: "flags" as const, patch: { seen: readValue } }
			: "starred" in fields && typeof fields.starred === "boolean"
				? { type: "flags" as const, patch: { flagged: fields.starred } }
				: null;
		if (!mutation) throw new Error("unsupported-canonical-mail-update");
		const request = mutateDesktopMail({ accountId: _mailboxId, emailId: id, mutation })
			.then((value) => ({ ok: value.status === "applied" }));
		return request.then((value) => {
			trackTelemetry("wemail_mail_action_completed", { action, source: "renderer" });
			return value;
		});
	},
	deleteEmail: (_mailboxId: string, id: string) =>
		// Toolbar "移到回收站" semantics — soft-trash, not hard-delete.
		// Hard delete is reachable via DELETE /api/mail/messages/:id but
		// none of the current UI surfaces it.
		mutateDesktopMail({
			accountId: _mailboxId,
			emailId: id,
			mutation: { type: "trash" },
		}).then((value) => ({ ok: value.status === "applied" })).then((value) => {
			trackTelemetry("wemail_mail_action_completed", { action: "trash", source: "renderer" });
			return value;
		}),
	moveEmail: (_mailboxId: string, id: string, folder: string) =>
		mutateDesktopMail({
			accountId: _mailboxId,
			emailId: id,
			mutation: { type: "move", folder },
		}).then((value) => ({ ok: value.status === "applied" })).then((value) => {
			trackTelemetry("wemail_mail_action_completed", { action: "move", source: "renderer" });
			return value;
		}),
	getThread: (_mailboxId: string, _threadId: string, _opts?: { signal?: AbortSignal }) =>
		// Phase-one: thread aggregation is done client-side in the panel;
		// no `/threads/:id` endpoint exists on the desktop server.
		Promise.resolve([] as Email[]),
	getAttachment: (_mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(
			`/api/mail/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
			{ responseType: "blob" },
		),

	// Folders are read through the canonical DB Service. Folder mutation is
	// intentionally not exposed until Mail Core provides a typed command.
	listFolders: (mailboxId: string) =>
		window.wemailDesktop?.mailDatabase?.isConnected()
			? window.wemailDesktop.mailDatabase.listFolders(mailboxId)
			: Promise.reject(new ApiError(503, { error: "mail database is not connected" })),

	// Search
	searchEmails: (
		mailboxId: string,
		params: Record<string, string>,
		opts?: { signal?: AbortSignal },
	) =>
		trackPromise(
			() => searchDesktopEmails(mailboxId, params, opts),
			{
				succeeded: "wemail_search_executed",
				failed: "wemail_search_executed",
				args: {
					scope: "mail",
					filter_count_bucket: countBucket(Math.max(0, Object.keys(params).length - 3)),
				},
				successArgs: (value) => ({
					result_count_bucket: countBucket(
						Array.isArray(value) ? value.length : value.totalCount ?? value.emails?.length ?? 0,
					),
				}),
			},
		),

	// ---------- WeMail intelligence ----------
	listInboxCategories: (accountId: string) =>
		window.wemailDesktop?.mailDatabase?.isConnected()
			? window.wemailDesktop.mailDatabase.listCategories(accountId)
					.then((categories) => ({ ok: true, categories }))
			: Promise.reject(new ApiError(503, { error: "mail database is not connected" })),

	getIntelligence: (emailId: string, opts?: { signal?: AbortSignal }) => {
		const database = window.wemailDesktop?.mailDatabase;
		void opts;
		if (!database?.isConnected()) {
			return Promise.reject(new ApiError(503, { error: "mail database is not connected" }));
		}
		return database.getIntelligenceState(emailId);
	},

	// Trigger endpoints — start a capability for a single message
	triggerSummary: (emailId: string) =>
		trackAiFeature("summary", () => requestCanonicalIntelligence(emailId, ["summary"])),
	triggerTags: (emailId: string) =>
		trackAiFeature("tag", () => requestCanonicalIntelligence(emailId, ["tags"])),
	triggerReplyDecision: (emailId: string) =>
		trackAiFeature("reply_decision", () => requestCanonicalIntelligence(emailId, ["replyDecision"])),

	// Retry endpoint
	retrySummary: (emailId: string) =>
		requestCanonicalIntelligence(emailId, ["summary"], true),
	getSummaryHealth: (
		accountId: string,
		scope?: MailDigestScope,
		opts?: { signal?: AbortSignal; query?: string; state?: string; states?: string[]; limit?: number; offset?: number; pageOnly?: boolean },
	) => {
		void accountId;
		const params = new URLSearchParams();
		if (scope?.scopeKind === "folder") {
			params.set("folder", scope.scopeKey);
		}
		if (opts?.query?.trim()) {
			params.set("q", opts.query.trim());
		}
		for (const state of opts?.states ?? []) {
			if (state && state !== "all") {
				params.append("state", state);
			}
		}
		if (opts?.state && opts.state !== "all") {
			params.set("state", opts.state);
		}
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		if (opts?.offset != null) params.set("offset", String(opts.offset));
		if (opts?.pageOnly) params.set("pageOnly", "true");
		return get<{ ok: boolean; status: SummaryHealthStatus }>(
			`/api/digests/summary-health?${params.toString()}`,
			{ signal: opts?.signal },
		);
	},
	retryAllSummaries: (input: {
		accountId: string;
		scope?: MailDigestScope;
		mode?: SummaryRetryMode;
		emailIds?: string[];
		kinds?: IntelligenceAttributeKind[];
		limit?: number;
	}) =>
		post<{ ok: boolean; result: SummaryRetryAllResult }>(
			`/api/digests/summary-retry`,
			{
				folder: input.scope?.scopeKind === "folder" ? input.scope.scopeKey : undefined,
				mode: input.mode ?? "all",
				emailIds: input.emailIds,
				kinds: input.kinds,
				limit: input.limit,
			},
		),

	completeTodo: completeTodoDebounced,

	sendWemailDraft: (draft: WemailDraftInput) => {
		const args = {
			compose_mode: draft.originalEmailId ? "reply" : "new",
			has_attachment: (draft.attachments?.length ?? 0) > 0,
			recipient_count_bucket: countBucket(
				draft.to.length + (draft.cc?.length ?? 0) + (draft.bcc?.length ?? 0),
			),
		};
		return trackPromise(
			async () => {
				const database = window.wemailDesktop?.mailDatabase;
				if (!database?.isConnected()) {
					throw new Error("Canonical mail database is unavailable");
				}
				if ((draft.attachments?.length ?? 0) > 0) {
					throw new Error("Attachment blob staging is not available yet");
				}
				const committed = await database.enqueueSend({
					...draft,
					attachments: [],
					idempotencyKey: `send:${draft.accountId}:${crypto.randomUUID()}`,
				});
				return {
					ok: true,
					messageId: committed.value.messageIdHeader,
					outboxId: committed.value.outboxId,
				};
			},
			{
				attempted: "wemail_mail_send_attempted",
				succeeded: "wemail_mail_send_succeeded",
				failed: "wemail_mail_send_failed",
				args,
			},
		);
	},
	saveWemailDraft: async (draft: WemailDraftSaveInput) => {
		const database = window.wemailDesktop?.mailDatabase;
		if (!database?.isConnected()) {
			throw new Error("Canonical mail database is unavailable");
		}
		if ((draft.attachments?.length ?? 0) > 0) {
			throw new Error("Attachment blob staging is not available yet");
		}
		const committed = await database.saveDraft({ ...draft, attachments: [] });
		return { ok: true, draft: committed.value };
	},
	// ---------- AI compose-draft ----------
	composeDraft: (input: {
		operationType: "NEW" | "REPLY";
		intent: string;
		accountId?: string;
		emailId?: string;
		to?: string[];
		currentTo?: string[];
		currentCc?: string[];
		currentBcc?: string[];
		targetLanguage?: string;
		styleId?: string;
		/** Existing draft body — when set, the LLM treats `intent` as
		 *  edit instructions on this body (rewrite / shorten / extend). */
		currentBody?: string;
		currentSubject?: string;
		clientNow?: string;
		clientTimeZone?: string;
	}, opts?: { signal?: AbortSignal }) =>
		post<{ ok: boolean; draft: ComposeMailResult }>(
			`/api/compose/draft`,
			input,
			opts,
		),

	// ---------- todos (manual create from More menu) ----------
	createTodo: (input: {
		accountId: string;
		emailId: string;
		title: string;
		description?: string;
		dueDate?: string;
		startTime?: string;
		endTime?: string;
		timezone?: string;
		priority?: "high" | "medium" | "low";
		agentStatus?: TaskAgentStatus | null;
	}) =>
		post<{ ok: boolean; todo: unknown }>(`/api/todos`, input),
	listAccountTodos: (
		accountId: string,
		status?: "open" | "completed",
		options?: { page?: number; limit?: number },
	) => {
		void accountId;
		return get<{ ok: boolean; todos: TodoItem[]; totalCount?: number; hasMore?: boolean }>(
			`/api/todos?status=${encodeURIComponent(status ?? "")}&page=${options?.page ?? 1}&limit=${options?.limit ?? 50}`,
		);
	},
	restoreTodo: (todoId: string) =>
		post<{ ok: boolean; todo?: unknown }>(
			`/api/todos/${encodeURIComponent(todoId)}/restore`,
		),
	deleteTodo: (todoId: string) =>
		del<{ ok: boolean }>(
			`/api/todos/${encodeURIComponent(todoId)}`,
		),
	rejectTodo: (todoId: string) =>
		post<{ ok: boolean }>(
			`/api/todos/${encodeURIComponent(todoId)}/reject`,
		),
	updateTodo: (todoId: string, input: {
		title?: string;
		description?: string | null;
		dueDate?: string | null;
		startTime?: string | null;
		endTime?: string | null;
		timezone?: string | null;
		priority?: "high" | "medium" | "low";
	}) =>
		patch<{ ok: boolean; todo: TodoItem }>(
			`/api/todos/${encodeURIComponent(todoId)}`,
			input,
		),
	confirmTodo: (todoId: string) =>
		post<{ ok: boolean; todo?: unknown }>(
			`/api/todos/${encodeURIComponent(todoId)}/confirm`,
		),

	/**
	 * F3 — Task Agent state machine. Override the Task Agent status for
	 * a todo and lock it (default) so the auto-recompute loop leaves it
	 * alone. Pass `lock: false` to re-enable auto-updates.
	 */
	setTodoAgentStatus: (
		todoId: string,
		status: TaskAgentStatus | null,
		lock: boolean = true,
	) =>
		patch<{ ok: boolean; todo?: unknown; error?: string }>(
			`/api/todos/${encodeURIComponent(todoId)}/agent-status`,
			{ status, lock },
		),

	// ---------- AI profile + writing styles (settings) ----------
	getAiProfile: () =>
		get<{ profile: AiProfileSettings | null }>(`/api/settings/ai-profile`),
	saveAiProfile: (input: Partial<Omit<AiProfileSettings, "updatedAt">>) =>
		put<{ ok: boolean; profile: AiProfileSettings }>(
			`/api/settings/ai-profile`,
			input,
		),
	getAiWorkerConcurrency: () =>
		get<{ ok: boolean; concurrency: number }>(
			"/api/settings/ai-worker-concurrency",
		),
	saveAiWorkerConcurrency: (concurrency: number) =>
		put<{ ok: boolean; concurrency: number }>(
			"/api/settings/ai-worker-concurrency",
			{ concurrency },
		),
	getBusinessPreferences: () =>
		get<{ ok: boolean; stored: boolean; preferences: Record<string, unknown> }>(
			"/api/settings/business-preferences",
		),
	saveBusinessPreferences: (input: Record<string, unknown>) =>
		put<{ ok: boolean; preferences: Record<string, unknown> }>(
			"/api/settings/business-preferences",
			input,
		),
	listWritingStyles: () =>
		get<{ styles: WritingStyle[] }>(`/api/settings/writing-styles`),
	createWritingStyle: (input: {
		name: string;
		description?: string;
		instructions: string;
	}) =>
		post<{ ok: boolean; style: WritingStyle }>(
			`/api/settings/writing-styles`,
			input,
		),
	updateWritingStyle: (
		id: string,
		update: Partial<{ name: string; description: string; instructions: string }>,
	) =>
		patch<{ ok: boolean; style: WritingStyle }>(
			`/api/settings/writing-styles/${encodeURIComponent(id)}`,
			update,
		),
	deleteWritingStyle: (id: string) =>
		del<{ ok: boolean }>(
			`/api/settings/writing-styles/${encodeURIComponent(id)}`,
		),

	// ---------- AI learning summaries (settings) ----------
	getLearningSummaries: (accountId: string) =>
		get<{ ok: boolean; summaries: LearningSummary[] }>(
			`/api/settings/learning-summaries?accountId=${encodeURIComponent(accountId)}`,
		),
	resetLearned: (args: { accountId: string; feature?: IntelligenceJobType }) =>
		post<{ ok: boolean }>(`/api/settings/reset-learned`, args),

	// ---------- AI usage statistics (settings) ----------
	getUsageStats: (accountId: string, period: UsagePeriod = "30d") =>
		get<{ ok: boolean; period: string; stats: UsageBucketStats[] }>(
			`/api/settings/usage-stats?accountId=${encodeURIComponent(accountId)}&period=${encodeURIComponent(period)}`,
		),

	// ---------- per-email AI usage history ----------
	getEmailUsage: (emailId: string) =>
		get<{ ok: boolean; rows: EmailUsageRow[] }>(
			`/api/settings/usage-stats/email?emailId=${encodeURIComponent(emailId)}`,
		),

	// ---------- AI throughput monitoring timeseries ----------
	getUsageTimeseries: (
		accountId: string,
		granularity: UsageTimeseriesGranularity,
		window?: number,
	) =>
		get<{ ok: boolean; granularity: string; result: UsageTimeseriesResult }>(
			`/api/settings/usage-stats/timeseries?accountId=${encodeURIComponent(accountId)}&granularity=${granularity}${window ? `&window=${window}` : ""}`,
		),

	// ---------- automation rules ----------
	listAutomationRules: (accountId?: string) =>
		get<{ ok: boolean; rules: AutomationRule[] }>(
			accountId
				? `/api/automation/rules?accountId=${encodeURIComponent(accountId)}`
				: `/api/automation/rules`,
		),
	listAutomationRuns: (accountId: string, limit = 100) =>
		get<{
			ok: boolean;
			runs: Array<{
				id: string;
				ruleId: string;
				accountId: string;
				dryRun: boolean;
				matchedCount: number;
				appliedCount: number;
				triggerKind?: string;
				status?: "matched" | "applied" | "skipped" | "evaluation_failed" | "failed";
				actionResults: Array<Record<string, unknown>>;
				createdAt: string;
			}>;
		}>(
			`/api/automation/runs?accountId=${encodeURIComponent(accountId)}&limit=${limit}`,
		),
	createAutomationRule: (input: {
		accountId: string;
		name: string;
		enabled?: boolean;
		trigger?: AutomationTrigger;
		naturalLanguageCondition?: string;
		conditions: AutomationConditions;
		conditionMode?: AutomationConditionMode;
		conditionRules?: AutomationConditionRule[];
		processing?: AutomationProcessing;
		actions: AutomationAction[];
	}) =>
		post<{ ok: boolean; rule: AutomationRule }>(`/api/automation/rules`, input),
	updateAutomationRule: (
		id: string,
		update: Partial<{
			name: string;
			enabled: boolean;
			trigger: AutomationTrigger;
			naturalLanguageCondition: string;
			conditions: AutomationConditions;
			conditionMode: AutomationConditionMode;
			conditionRules: AutomationConditionRule[];
			processing: AutomationProcessing;
			actions: AutomationAction[];
		}>,
	) =>
		patch<{ ok: boolean; rule: AutomationRule }>(
			`/api/automation/rules/${encodeURIComponent(id)}`,
			update,
		),
	deleteAutomationRule: (id: string) =>
		del<{ ok: boolean }>(`/api/automation/rules/${encodeURIComponent(id)}`),
	dryRunAutomationRule: (id: string) =>
		post<{
			ok: boolean;
			matched: { id: string; subject: string }[];
		}>(`/api/automation/rules/${encodeURIComponent(id)}/dry-run`),
	runAutomationRule: (id: string, input?: { confirmDangerous?: boolean }) =>
		post<{ ok: boolean; matchedCount: number; appliedCount: number }>(
			`/api/automation/rules/${encodeURIComponent(id)}/run`,
			input,
		),
	getAutomationCapabilities: () => get<{ ok: boolean; capabilities: Record<string, unknown> }>("/api/automation/capabilities"),
	previewAutomationRule: (input: Omit<AutomationRule, "id" | "createdAt" | "updatedAt"> & { sourceRuleId?: string }) =>
		post<{ ok: boolean; preview: AutomationRulePreviewResult }>("/api/automation/rules/preview", input),
	commitAutomationRule: (input: { accountId: string; previewId: string; ruleHash: string }) =>
		post<{ ok: boolean; rule: AutomationRule }>("/api/automation/rules/commit", input),

	// ---------- Unified automation center ----------
	listUnifiedAutomations: (accountId: string, locale = "zh-CN") =>
		get<{ ok: boolean } & UnifiedAutomationListResponse>(
			`/api/automation/center?accountId=${encodeURIComponent(accountId)}&locale=${encodeURIComponent(locale)}`,
		),
	getUnifiedAutomation: (id: string, accountId: string) =>
		get<{ ok: boolean; automation: AutomationDetail }>(
			`/api/automation/center/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`,
		),
	setUnifiedAutomationEnabled: (id: string, accountId: string, enabled: boolean) =>
		patch<{ ok: boolean; automation: AutomationDetail }>(
			`/api/automation/center/${encodeURIComponent(id)}/state`,
			{ accountId, enabled },
		),
	runUnifiedAutomation: (
		id: string,
		accountId: string,
		confirmDangerous = false,
	) =>
		post<{ ok: boolean; result: Record<string, unknown> }>(
			`/api/automation/center/${encodeURIComponent(id)}/run`,
			{ accountId, confirmDangerous },
		),
	testUnifiedAutomation: (id: string, accountId: string) =>
		post<{ ok: boolean; preview: Record<string, unknown> }>(
			`/api/automation/center/${encodeURIComponent(id)}/test`,
			{ accountId },
		),
	archiveUnifiedAutomation: (id: string, accountId: string) =>
		post<{ ok: boolean; automation: AutomationListItem }>(
			`/api/automation/center/${encodeURIComponent(id)}/archive?accountId=${encodeURIComponent(accountId)}`,
			{},
		),
	deleteUnifiedAutomation: (id: string, accountId: string) =>
		del<{ ok: boolean }>(
			`/api/automation/center/${encodeURIComponent(id)}/permanent?accountId=${encodeURIComponent(accountId)}`,
		),
	getUnifiedAutomationRun: (id: string, runId: string, accountId: string) =>
		get<{ ok: boolean; run: AutomationRunDetail }>(
			`/api/automation/center/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}?accountId=${encodeURIComponent(accountId)}`,
		),
	getUnifiedAutomationRunProgress: (
		id: string,
		runId: string,
		accountId: string,
		afterRevision = 0,
	) =>
		get<{
			ok: boolean;
			changed: boolean;
			revision: number;
			detail?: AutomationRunDetail;
		}>(
			`/api/automation/center/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/progress?accountId=${encodeURIComponent(accountId)}&afterRevision=${afterRevision}`,
		),
	retryUnifiedAutomationStep: (
		id: string,
		runId: string,
		stepId: string,
		accountId: string,
		confirmDelivery = false,
	) =>
		post<{ ok: boolean; result: Record<string, unknown> }>(
			`/api/automation/center/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry?accountId=${encodeURIComponent(accountId)}`,
			{ confirmDelivery },
		),
	resumeUnifiedAutomationDraft: (id: string, accountId: string) =>
		post<{ ok: boolean; draft: ExecutionPipelineDraft }>(
			`/api/automation/center/${encodeURIComponent(id)}/edit-draft?accountId=${encodeURIComponent(accountId)}`,
			{},
		),
	getUnifiedAutomationDraft: (draftId: string, accountId: string) =>
		get<{ ok: boolean; draft: ExecutionPipelineDraft }>(
			`/api/automation/center/drafts/${encodeURIComponent(draftId)}?accountId=${encodeURIComponent(accountId)}`,
		),
	patchUnifiedAutomationDraft: (
		draftId: string,
		accountId: string,
		patchInput: AutomationDraftPatch,
	) =>
		patch<{
			ok: boolean;
			draft: ExecutionPipelineDraft;
			interaction?: {
				goalStatus?: string;
				stage?: string;
				message?: string;
				impact?: string;
				previewLinks?: Array<{ id: string; label: string; url: string }>;
			};
		}>(
			`/api/automation/center/drafts/${encodeURIComponent(draftId)}?accountId=${encodeURIComponent(accountId)}`,
			patchInput,
		),
	getUnifiedAutomationTemplateVersion: (id: string, accountId: string) =>
		get<{
			ok: boolean;
			upgrade: AutomationTemplateUpgrade;
			versions: Array<{
				version: number;
				templateVersion?: string;
				createdAt: string;
				current: boolean;
			}>;
		}>(
			`/api/automation/center/${encodeURIComponent(id)}/template-version?accountId=${encodeURIComponent(accountId)}`,
		),
	previewUnifiedAutomationTemplateUpgrade: (id: string, accountId: string) =>
		post<{
			ok: boolean;
			preview: {
				previewId: string;
				previewHash: string;
				draft: ExecutionPipelineDraft;
				expiresAt: string;
				upgrade: AutomationTemplateUpgrade;
			};
		}>(
			`/api/automation/center/${encodeURIComponent(id)}/template-upgrade/preview`,
			{ accountId },
		),
	confirmUnifiedAutomationTemplateUpgrade: (
		id: string,
		input: {
			accountId: string;
			previewId: string;
			previewHash: string;
			targetVersion: string;
			confirmation: string;
		},
	) =>
		post<{
			ok: boolean;
			draft: ExecutionPipelineDraft;
			next: { type: "review_and_confirm"; message: string };
		}>(
			`/api/automation/center/${encodeURIComponent(id)}/template-upgrade/confirm`,
			input,
		),
	rollbackUnifiedAutomationTemplate: (
		id: string,
		input: {
			accountId: string;
			targetVersion: number;
			expectedCurrentVersion: number;
			confirmation: string;
		},
	) =>
		post<{ ok: boolean; automation: unknown }>(
			`/api/automation/center/${encodeURIComponent(id)}/template-rollback`,
			input,
		),
	listAutomationTemplates: (accountId: string, locale = "zh-CN") =>
		get<{ ok: boolean; templates: AutomationTemplateSummary[] }>(
			`/api/automation/templates?accountId=${encodeURIComponent(accountId)}&locale=${encodeURIComponent(locale)}`,
		),
	getAutomationTemplate: (id: string, version?: string) =>
		get<{ ok: boolean; template: AutomationTemplateDefinition }>(
			`/api/automation/templates/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ""}`,
		),
	previewAutomationTemplate: (
		id: string,
		input: {
			accountId: string;
			version?: string;
			configuration: Record<string, unknown>;
		},
	) =>
		post<{
			ok: boolean;
			preview: {
				previewId: string;
				previewHash: string;
				draft: ExecutionPipelineDraft;
				expiresAt: string;
			};
		}>(`/api/automation/templates/${encodeURIComponent(id)}/preview`, input),
	confirmAutomationTemplate: (
		id: string,
		input: { accountId: string; previewId: string; previewHash: string },
	) =>
		post<{ ok: boolean; automation: AutomationRuleV2 }>(
			`/api/automation/templates/${encodeURIComponent(id)}/confirm`,
			input,
		),

	listApplicationMessages: (accountId: string, filters?: { unread?: boolean; archived?: boolean; type?: string; offset?: number; limit?: number }) => {
		const params = new URLSearchParams({ accountId });
		for (const [key, value] of Object.entries(filters ?? {})) if (value !== undefined) params.set(key, String(value));
		return get<{ ok: boolean } & ApplicationMessageListResult>(`/api/application-messages?${params}`);
	},
	markApplicationMessageRead: (id: string, accountId: string, value: boolean) =>
		patch<{ ok: boolean; message: ApplicationMessage }>(`/api/application-messages/${encodeURIComponent(id)}/read`, { accountId, value }),
	archiveApplicationMessage: (id: string, accountId: string, value: boolean) =>
		patch<{ ok: boolean; message: ApplicationMessage }>(`/api/application-messages/${encodeURIComponent(id)}/archive`, { accountId, value }),
	actOnSmartTagTopic: (topicId: string, input: { accountId: string; action: "create" | "defer" | "suppress"; name?: string; description?: string }) =>
		post<{ ok: boolean }>(`/api/application-messages/smart-tag-topics/${encodeURIComponent(topicId)}/actions`, input),
	getApplicationMessageArtifactUrl: (id: string, accountId: string) =>
		resolveApiUrl(`/api/application-messages/${encodeURIComponent(id)}/artifact?accountId=${encodeURIComponent(accountId)}`),
	getInsightReportForEmail: (accountId: string, emailId: string) =>
		get<{ ok: boolean; report: InsightReportSummary | null }>(
			`/api/insight-reports/by-email?accountId=${encodeURIComponent(accountId)}&emailId=${encodeURIComponent(emailId)}`,
		),
	getInsightReport: (accountId: string, reportId: string) =>
		get<{ ok: boolean; report: InsightReportSummary }>(
			`/api/insight-reports/${encodeURIComponent(reportId)}?accountId=${encodeURIComponent(accountId)}`,
		),
	listInsightReportVersions: (accountId: string, reportId: string) =>
		get<{ ok: boolean; report: InsightReportSummary; versions: InsightReportVersionSummary[] }>(
			`/api/insight-reports/${encodeURIComponent(reportId)}/versions?accountId=${encodeURIComponent(accountId)}`,
		),

	// ---------- agent suggestions ----------
	getAgentSuggestions: (accountId: string, emailId?: string) => {
		const params = new URLSearchParams({ accountId });
		if (emailId) params.set("emailId", emailId);
		return get<{
			ok: boolean;
			suggestions: AgentSuggestion[];
			contextLine?: string;
			source?: "rules" | "cached-ai";
			candidateFingerprint?: string;
			refreshPending?: boolean;
		}>(`/api/agent/suggestions?${params.toString()}`);
	},

	// ---------- agent conversation history ----------
	listAgentConversations: (opts?: {
		includeArchived?: boolean;
		search?: string;
		accountId?: string;
	}) => {
		const params = new URLSearchParams();
		if (opts?.includeArchived) params.set("includeArchived", "1");
		if (opts?.search) params.set("search", opts.search);
		if (opts?.accountId) params.set("accountId", opts.accountId);
		const qs = params.toString();
		return get<{
			ok: boolean;
			conversations: {
				id: string;
				accountId?: string;
				title?: string;
				createdAt: string;
				updatedAt: string;
				archivedAt?: string;
				pinnedAt?: string;
			}[];
		}>(`/api/agent/conversations${qs ? `?${qs}` : ""}`);
	},
	getAgentConversationState: (id: string) =>
		get<{ ok: boolean; state: ConversationState | null }>(
			`/api/agent/conversations/${encodeURIComponent(id)}/state`,
		),
	getAgentAttention: () =>
		get<{ ok: boolean } & AgentAttention>("/api/agent/attention"),
	enqueueAgentFollowup: (conversationId: string, text: string, accountId?: string) =>
		post<{ ok: boolean; followup: PersistedAgentFollowup }>(
			`/api/agent/conversations/${encodeURIComponent(conversationId)}/followups`,
			{ text, accountId },
		),
	updateAgentFollowup: (conversationId: string, id: string, text: string) =>
		patch<{ ok: boolean; followup: PersistedAgentFollowup }>(
			`/api/agent/conversations/${encodeURIComponent(conversationId)}/followups/${encodeURIComponent(id)}`,
			{ text },
		),
	moveAgentFollowup: (conversationId: string, id: string, position: number) =>
		patch<{ ok: boolean; followups: PersistedAgentFollowup[] }>(
			`/api/agent/conversations/${encodeURIComponent(conversationId)}/followups/${encodeURIComponent(id)}`,
			{ position },
		),
	removeAgentFollowup: (conversationId: string, id: string) =>
		del<{ ok: boolean }>(
			`/api/agent/conversations/${encodeURIComponent(conversationId)}/followups/${encodeURIComponent(id)}`,
		),
	resumeAgentFollowups: (conversationId: string) =>
		post<{ ok: boolean; resumed: number }>(
			`/api/agent/conversations/${encodeURIComponent(conversationId)}/followups/resume`,
		),
	renameAgentConversation: (id: string, title: string) =>
		patch<{
			ok: boolean;
			conversation?: {
				id: string;
				accountId?: string;
				title?: string;
				createdAt: string;
				updatedAt: string;
				archivedAt?: string;
			};
		}>(`/api/agent/conversations/${encodeURIComponent(id)}`, { title }),
	archiveAgentConversation: (id: string) =>
		post<{ ok: boolean }>(
			`/api/agent/conversations/${encodeURIComponent(id)}/archive`,
		),
	unarchiveAgentConversation: (id: string) =>
		post<{ ok: boolean }>(
			`/api/agent/conversations/${encodeURIComponent(id)}/unarchive`,
		),
	clearAgentConversations: () =>
		del<{ ok: boolean }>(`/api/agent/conversations`),
	streamAgentChat,

	// ---------- Agent pending actions (Route C / WP 3I) ----------
	// Backend route: GET /api/agent/pending-actions returns
	// `{ ok, actions: AgentPendingAction[] }` with camelCase fields and
	// an always-populated `riskLevel`. POST /pending-actions/:id/resolve
	// transitions the action to "confirmed" or "rejected".
	getPendingActions: (conversationId?: string) => {
		const qs = conversationId
			? `?conversationId=${encodeURIComponent(conversationId)}`
			: "";
		return get<{ ok: boolean; actions: AgentPendingAction[] }>(
			`/api/agent/pending-actions${qs}`,
		).then((res) => res.actions);
	},
	resolvePendingAction: (
		id: string,
		status: "confirmed" | "rejected",
		options?: {
			idempotencyKey?: string;
			parameters?: Record<string, unknown>;
			timeoutMs?: number;
		},
	) =>
		post<ResolvePendingActionResult>(
			`/api/agent/pending-actions/${encodeURIComponent(id)}/resolve`,
			{
				status,
				...(status === "confirmed"
					? {
							idempotencyKey: options?.idempotencyKey,
							parameters: options?.parameters,
						}
					: {}),
			},
			{ timeoutMs: options?.timeoutMs },
		),

	getActionExecution: (actionId: string) => get<{ ok: boolean; task: import("../../shared/wemail/actionExecution").ActionExecutionSnapshot }>(
		`/api/agent/action-executions/${encodeURIComponent(actionId)}`,
	),
	getAgentLearningPreferences: () =>
		get<{ ok: boolean; preferences: PersistedAgentPreference[] }>(
			"/api/agent/learning/preferences",
		).then((response) => response.preferences),
	correctAgentLearningPreference: (key: string, value: AgentJsonValue) =>
		patch<{ ok: boolean; preference: PersistedAgentPreference }>(
			`/api/agent/learning/preferences/${encodeURIComponent(key)}`,
			{ value },
		).then((response) => response.preference),
	deleteAgentLearningPreference: (key: string) =>
		del<{ ok: boolean; deleted: boolean }>(
			`/api/agent/learning/preferences/${encodeURIComponent(key)}`,
		),
	clearAgentLearning: () =>
		del<{ ok: boolean; cleared: { events: number; preferences: number } }>(
			"/api/agent/learning",
		),
	getConfigurationTask: (taskId: string) =>
		get<{ snapshot: ConfigurationTaskSnapshot; outcome: ConfigurationOutcome }>(
			`/api/configuration-tasks/${encodeURIComponent(taskId)}`,
		),
	cancelConfigurationTask: (taskId: string, expectedRevision: number) =>
		post<{ snapshot: ConfigurationTaskSnapshot; outcome: ConfigurationOutcome }>(
			`/api/configuration-tasks/${encodeURIComponent(taskId)}/cancel`,
			{ expectedRevision },
		),

	// ---------- semantic search + Mail QA ----------
	// Backend routes: POST /api/mail/semantic-search and POST /api/agent/mail-qa
	// (see server/api/routes/searchRoutes.ts). Both require accountId.
	// The thin shapes we surface here flatten the backend's
	// { ok, result: SemanticSearchResult | MailQaResult } into the
	// trimmed { ok, results | answer + citations } the UI needs. The raw
	// service responses are richer (claims, mode, totalChunks) — if a
	// caller needs them, prefer adding a second helper rather than
	// widening these signatures.
	semanticSearchMail: async (
		query: string,
		opts?: { topK?: number; accountId?: string },
	): Promise<{
		ok: boolean;
		results: Array<{ email: Email; score: number; snippet?: string }>;
	}> => {
		// accountId is required by the server. Resolve from the current
		// account if the caller didn't supply one. Throwing here keeps the
		// failure mode close to the call site instead of bubbling a 400.
		let accountId = opts?.accountId;
		if (!accountId) {
			const { account } = await get<AccountCurrentResponse>(
				"/api/account/current",
			);
			if (!account?.id) {
				throw new ApiError(400, { error: "no active account" });
			}
			accountId = account.id;
		}
		const body: Record<string, unknown> = { accountId, query };
		if (opts?.topK) body.limit = opts.topK;
		const res = await post<{
			ok: boolean;
			result?: SemanticSearchResult;
			error?: string;
		}>(`/api/mail/semantic-search`, body);
		const chunks = res.result?.chunks ?? [];
		// One logical email may have several indexed chunks or folder copies.
		// De-dupe by Message-ID and keep the highest-scoring real envelope.
		const byEmail = new Map<
			string,
			{ email: Email; score: number; snippet?: string }
		>();
		for (const c of chunks) {
			if (!c.subject || !c.receivedAt || !c.sender) continue;
			const logicalId = c.messageId ?? c.emailId;
			const existing = byEmail.get(logicalId);
			if (!existing || c.score > existing.score) {
				byEmail.set(logicalId, {
					email: {
						id: c.emailId,
						message_id: c.messageId ?? null,
						folder_id: c.folder?.toLowerCase() ?? null,
						subject: c.subject,
						sender: c.sender,
						recipient: c.recipient ?? "",
						date: c.receivedAt,
						read: c.read ?? true,
						starred: c.starred ?? false,
						hasAttachments: c.hasAttachments ?? false,
						snippet: c.snippet,
					},
					score: c.score,
					snippet: c.snippet,
				});
			}
		}
		return {
			ok: !!res.ok,
			results: Array.from(byEmail.values()).sort((a, b) => b.score - a.score),
		};
	},
	askMailbox: async (
		question: string,
		accountId: string,
	): Promise<{
		ok: boolean;
		answer: string;
		citations: Array<{ emailId: string; snippet: string }>;
	}> => {
		const res = await post<{
			ok: boolean;
			result?: MailQaResult;
			error?: string;
		}>(`/api/agent/mail-qa`, { accountId, question });
		const result = res.result;
		// Flatten claim citations into a single list. Each claim's
		// citations carry an emailId + optional `quote` snippet — treat
		// `quote` as the snippet text. De-dupe by emailId so the UI shows
		// one card per cited email.
		// TODO: the backend also exposes per-claim grouping
		// (`MailQaResult.claims`) which would let us highlight which
		// sentence cites which email. The current UI flattens citations.
		const seen = new Set<string>();
		const citations: Array<{ emailId: string; snippet: string }> = [];
		for (const claim of result?.claims ?? []) {
			for (const c of claim.citations) {
				if (seen.has(c.emailId)) continue;
				seen.add(c.emailId);
				citations.push({ emailId: c.emailId, snippet: c.quote ?? "" });
			}
		}
		return {
			ok: !!res.ok,
			answer: result?.answer ?? "",
			citations,
		};
	},

	// ---------- Feature F1: Snooze + Scheduled send ----------
	snoozeMessage: async (emailId: string, until: string) => {
		const database = window.wemailDesktop?.mailDatabase;
		if (!database?.isConnected()) throw new Error("Canonical mail database is unavailable");
		const snapshot = await database.getMailSnapshot(emailId);
		if (!snapshot.message) throw new Error(`Message not found: ${emailId}`);
		const result = await database.setSnooze({
			accountId: snapshot.message.accountId,
			emailId,
			until,
		});
		if (!result.value) throw new Error(`Message not found: ${emailId}`);
		return { ok: true, message: result.value };
	},
	unsnoozeMessage: async (emailId: string) => {
		const database = window.wemailDesktop?.mailDatabase;
		if (!database?.isConnected()) throw new Error("Canonical mail database is unavailable");
		const snapshot = await database.getMailSnapshot(emailId);
		if (!snapshot.message) throw new Error(`Message not found: ${emailId}`);
		const result = await database.setSnooze({
			accountId: snapshot.message.accountId,
			emailId,
		});
		if (!result.value) throw new Error(`Message not found: ${emailId}`);
		return { ok: true, message: result.value };
	},
	listSnoozed: async (accountId: string) => {
		const database = window.wemailDesktop?.mailDatabase;
		if (!database?.isConnected()) throw new Error("Canonical mail database is unavailable");
		return { messages: await database.listSnoozed(accountId) };
	},

	scheduleDraft: (
		draftId: string,
		input: { sendAt: string; payload?: WemailDraftInput },
	) => {
		const database = window.wemailDesktop?.mailDatabase;
		if (!database?.isConnected()) return Promise.reject(new Error("Canonical mail database is unavailable"));
		if (!input.payload) return Promise.reject(new Error("Scheduled send payload is required"));
		if ((input.payload.attachments?.length ?? 0) > 0) {
			return Promise.reject(new Error("Attachment blob staging is not available yet"));
		}
		return database.enqueueSend({
				...input.payload,
				attachments: [],
				draftId,
				scheduledAt: input.sendAt,
				idempotencyKey: `schedule:${input.payload.accountId}:${draftId}:${input.sendAt}`,
			}).then((committed) => ({
				ok: true,
				scheduled: {
					id: committed.value.outboxId,
					accountId: input.payload!.accountId,
					payload: input.payload!,
					sendAt: input.sendAt,
					status: "pending" as const,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			}));
	},
	cancelScheduledDraft: (id: string, accountId: string) =>
		window.wemailDesktop?.mailDatabase?.isConnected()
			? window.wemailDesktop.mailDatabase.cancelScheduled(accountId, id)
				.then((result) => ({ ok: result.value }))
			: Promise.reject(new ApiError(503, { error: "mail database is not connected" })),
	deleteScheduledDraft: (id: string, accountId: string) =>
		window.wemailDesktop?.mailDatabase?.isConnected()
			? window.wemailDesktop.mailDatabase.deleteScheduled(accountId, id)
				.then((result) => ({ ok: result.value }))
			: Promise.reject(new ApiError(503, { error: "mail database is not connected" })),
	listScheduled: (accountId: string) =>
		window.wemailDesktop?.mailDatabase?.isConnected()
			? window.wemailDesktop.mailDatabase.listScheduled(accountId)
				.then((scheduled) => ({ scheduled }))
			: Promise.reject(new ApiError(503, { error: "mail database is not connected" })),
	listScheduledPage: (accountId: string, page = 1, limit = 50) =>
		window.wemailDesktop?.mailDatabase?.isConnected()
			? window.wemailDesktop.mailDatabase.listScheduledPage(accountId, page, limit)
			: Promise.reject(new ApiError(503, { error: "mail database is not connected" })),

	// ---------- Mail digests ----------
	getDigestSettings: (opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; settings: MailDigestSettings }> =>
		get<{ ok: boolean; settings: MailDigestSettings }>(
			`/api/digests/settings`,
			{ signal: opts?.signal },
		),
	saveDigestSettings: (settings: MailDigestSettings) =>
		put<{ ok: boolean; settings: MailDigestSettings }>(
			`/api/digests/settings`,
			settings,
		),
	getDigestStatus: (
		accountId: string,
		scope?: MailDigestScope,
		opts?: { signal?: AbortSignal },
	) => {
		const params = new URLSearchParams({ accountId });
		if (scope) {
			params.set("scopeKind", scope.scopeKind);
			params.set("scopeKey", scope.scopeKey);
		}
		return get<{ ok: boolean; status: MailDigestStatus }>(
			`/api/digests/status?${params.toString()}`,
			{ signal: opts?.signal },
		);
	},
	getLatestDigest: (
		accountId: string,
		scope?: MailDigestScope,
		kind?: MailDigestKind,
		opts?: { signal?: AbortSignal },
	) => {
		const params = new URLSearchParams({ accountId });
		if (scope) {
			params.set("scopeKind", scope.scopeKind);
			params.set("scopeKey", scope.scopeKey);
		}
		if (kind) {
			params.set("kind", kind);
		}
		return get<{ ok: boolean; digest: MailDigestRecord | null }>(
			`/api/digests/latest?${params.toString()}`,
			{ signal: opts?.signal },
		);
	},
	listDigests: (
		accountId: string,
		scope?: MailDigestScope,
		kind?: MailDigestKind,
		limit?: number,
		opts?: { signal?: AbortSignal },
	) => {
		const params = new URLSearchParams({ accountId });
		if (scope) {
			params.set("scopeKind", scope.scopeKind);
			params.set("scopeKey", scope.scopeKey);
		}
		if (kind) {
			params.set("kind", kind);
		}
		if (limit !== undefined) {
			params.set("limit", String(limit));
		}
		return get<{ ok: boolean; digests: MailDigestRecord[] }>(
			`/api/digests/list?${params.toString()}`,
			{ signal: opts?.signal },
		);
	},
	generateDigest: (input: GenerateMailDigestRequest) =>
		post<{ ok: boolean; digest: MailDigestRecord }>(
			`/api/digests/generate`,
			input,
		),

	// System
	getLlmStatus: () =>
		get<LlmStatus>(
			`/api/system/llm-status`,
		),
	getWecliStatus: () =>
		get<{ ok: boolean; status: WecliComponentStatus }>(
			`/api/system/wecli/status`,
		).then((response) => response.status),
	installWecli: () =>
		post<{
			ok: boolean;
			message: string;
			result: WecliInstallResult;
		}>(
			`/api/system/wecli/install`,
			{ confirmed: true },
			{ timeoutMs: 135_000 },
		),
	getWecliCatalog: (opts?: { refresh?: boolean }) =>
		get<WecliCatalogResponse>(
			`/api/skills/wecli/catalog${opts?.refresh ? "?refresh=true" : ""}`,
		),
	setupWecli: () =>
		post<{ ok: boolean; result: WecliSetupResult }>(
			`/api/system/wecli/setup`,
			{},
			{ timeoutMs: 360_000 },
		).then((response) => response.result),
	checkWecliUpdate: () =>
		get<{ ok: boolean; result: WecliUpdateCheckResult }>(
			`/api/system/wecli/update/check`,
		).then((response) => response.result),
	performWecliUpdate: () =>
		post<{ ok: boolean; result: WecliUpdateResult }>(
			`/api/system/wecli/update`,
			{},
			{ timeoutMs: 150_000 },
		).then((response) => response.result),
	getLoggingDiagnostics: () =>
		get<LoggingDiagnostics>(`/api/diagnostics/logging`),
	setDebugLogging: (debugEnabled: boolean) =>
		put<LoggingDiagnostics>(`/api/diagnostics/logging`, { debugEnabled }),
	exportDiagnostics: () =>
		post<DiagnosticPackageExport>(`/api/diagnostics/export`),

	// ---------- agent conversation pinning ----------
	// Appended at end of file to minimise conflict surface with the
	// in-flight title-generator changes elsewhere in this module.
	pinAgentConversation: (id: string) =>
		post<{ ok: boolean }>(
			`/api/agent/conversations/${encodeURIComponent(id)}/pin`,
		),
	unpinAgentConversation: (id: string) =>
		post<{ ok: boolean }>(
			`/api/agent/conversations/${encodeURIComponent(id)}/unpin`,
		),

	// ---------- Workspace (Route C / WP J.7) ----------
	listWorkspaceFiles,
	getWorkspaceFile,

	// ---------- User-defined smart tags (Feature 4) ----------
	listUserTags: (accountId: string) =>
		get<{
			ok: boolean;
			tags: Array<{
				id: string;
				accountId: string;
				name: string;
				description: string;
				prompt: string;
				optimizedPrompt?: string;
				optimizedPromptVersion?: string;
				optimizedAt?: string;
				effectivePrompt: string;
				latestLearningRun?: {
					id: string;
					status: "generating" | "evaluating" | "activated" | "rejected" | "failed" | "stale";
					sampleCount: number;
					positiveCount: number;
					negativeCount: number;
					validationCount: number;
					currentCorrect: number;
					candidateCorrect: number;
					correctedCount: number;
					regressionCount: number;
					reason?: string;
					createdAt: string;
					completedAt?: string;
				};
				latestRetagRun?: {
					id: string;
					status: "running" | "completed" | "failed";
					queuedCount: number;
					processedCount: number;
					failedCount: number;
					retainedCount: number;
					removedCount: number;
				};
				feedbackSampleCount?: number;
				positiveFeedbackCount?: number;
				negativeFeedbackCount?: number;
				createdAt: string;
				updatedAt: string;
			}>;
		}>(`/api/smart-tags`),
	previewSmartTagPromotion: (input: SmartTagPromotionPreviewRequest) =>
		post<SmartTagPromotionPreviewResponse>(
			`/api/smart-tags/promotions/preview`,
			input,
			{ timeoutMs: 30_000 },
		),
	createSmartTagPromotion: (input: SmartTagPromotionCreateRequest) =>
		post<SmartTagPromotionCreateResponse>(
			`/api/smart-tags/promotions`,
			input,
		),
	createUserTag: (input: {
		accountId: string;
		name: string;
		description: string;
		prompt?: string;
	}) =>
		post<{
			ok: boolean;
			tag: {
				id: string;
				accountId: string;
				name: string;
				description: string;
				prompt: string;
				optimizedPrompt?: string;
				optimizedPromptVersion?: string;
				optimizedAt?: string;
				effectivePrompt: string;
				createdAt: string;
				updatedAt: string;
			};
		}>(`/api/smart-tags`, input),
	updateUserTag: (id: string, input: {
		name?: string;
		description?: string;
		prompt?: string;
	}) =>
		patch<{
			ok: boolean;
			tag: {
				id: string;
				accountId: string;
				name: string;
				description: string;
				prompt: string;
				optimizedPrompt?: string;
				optimizedPromptVersion?: string;
				optimizedAt?: string;
				effectivePrompt: string;
				createdAt: string;
				updatedAt: string;
			};
		}>(`/api/smart-tags/${encodeURIComponent(id)}`, input),
	deleteUserTag: (id: string) =>
		del<{ ok: boolean }>(
			`/api/smart-tags/${encodeURIComponent(id)}`,
		),
	restoreOriginalUserTag: (id: string) =>
		post<{
			ok: boolean;
			tag: {
				id: string;
				accountId: string;
				name: string;
				description: string;
				prompt: string;
				effectivePrompt: string;
				createdAt: string;
				updatedAt: string;
			};
		}>(`/api/smart-tags/${encodeURIComponent(id)}/restore-original`, {}),

	// ---------- Smart Tag Picker ----------
	applyMessageSmartTag: (emailId: string, tagId: string, reason?: string) =>
		put<{ ok: boolean }>(
			`/api/smart-tags/messages/${encodeURIComponent(emailId)}/${encodeURIComponent(tagId)}`,
			reason ? { reason } : {},
		),
	removeMessageSmartTag: (emailId: string, tagId: string, reason?: string) =>
		del<{ ok: boolean }>(
			`/api/smart-tags/messages/${encodeURIComponent(emailId)}/${encodeURIComponent(tagId)}`,
			reason ? { reason } : {},
		),
	listSmartTagBackfills: (accountId: string, limit = 5) =>
		get<{
			ok: boolean;
			runs: Array<{
				id: string;
				accountId: string;
				status: "running" | "completed" | "failed";
				scannedCount: number;
				queuedCount: number;
				processedCount: number;
				failedCount: number;
				createdAt: string;
				updatedAt: string;
				count: number;
				unreadCount: number;
			}>;
		}>(
			`/api/smart-tags/backfills?limit=${limit}`,
		),
};

export default api;
