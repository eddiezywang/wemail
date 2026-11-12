/**
 * Phase-one tool inventory for the PI agent (Handoff §5.J).
 *
 * Standard mail read tools expose envelope + snippet fields only. The
 * explicit source-read tools may return stored body content for one
 * targeted message or a bounded selected batch with truncation. Sending
 * remains unavailable as a direct tool: `WemailAgentTools.propose_send_mail`
 * creates a pending action and the confirmed executor performs the send.
 *
 * wecli tools split auto-approved vs requires-confirmation:
 *   - `wecli_query` executes iff the classifier returns `auto-approved`;
 *     otherwise returns `{ requires_confirmation: true, ... }` without
 *     running.
 *   - `wecli_action_preview` returns classification + planned args
 *     with `executed: false`; it NEVER spawns a process.
 *
 * ai-agent-task-assistant additions:
 *   - `get_suggestions` returns focused-email suggestions based on
 *     current intelligence state. Home actions are provided separately.
 *   - `propose_action` returns a pendingAction for high-risk operations
 *     instead of executing them. The agent MUST use this for send,
 *     delete, move, archive, mark_spam, unsubscribe, and run_automation.
 */

import {
  AgentTerminalToolError,
  type AgentTool,
  type AgentToolContext,
} from "./AgentRuntime.js";
import type { ToolInput } from "./AgentTypes.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { IntelligenceService } from "../intelligence/IntelligenceService.js";
import type { WecliRunOptions } from "../../../shared/wemail/wecliTypes.js";
import {
  WECLI_ERROR_CODES,
  isWecliErrorCode,
  wecliSpawnFailure,
  type WecliClassifierPort,
  type WecliInstallRequest,
  type WecliRuntimePort,
  type WecliTokenizerPort,
} from "../skills/wecliPort.js";
import type { CuratorScheduler } from "./CuratorScheduler.js";
import type { AllowanceInvoicePort } from "./allowancePort.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { MailCoreMessageSummary } from "../../../shared/wemail/mailCoreProtocol.js";
import type {
  AgentPendingAction,
  CallerContext,
  HighRiskActionType,
  IntelligenceJobType,
} from "../../../shared/wemail/intelligence.js";
import { buildSuggestions } from "./SuggestionBuilder.js";
import { isConfirmationRequiredAction } from "./AgentOperationPolicy.js";
import {
  createPendingActionAuthorization,
  deriveRiskLevel,
  rowToAction,
  type AgentPendingActionRepository,
} from "./AgentPendingActionRepository.js";
import { resolveAiBodyText } from "../ai/context/ContextBuilder.js";

export interface MailAgentToolDeps {
  mailDatabase: MailDatabaseClient;
  intelligenceService: IntelligenceService;
  wecli: WecliRuntimePort;
  classify: WecliClassifierPort;
  /** Edition-supplied tokenizer; the open default is quote-aware and neutral. */
  tokenize: WecliTokenizerPort;
  /** Edition-supplied install request descriptor; absent in the open edition. */
  wecliInstallRequest?: WecliInstallRequest;
  /** Register the wecli_* tools only when the feature and module are both on. */
  wecliToolsEnabled?: boolean;
  pendingActionRepo?: AgentPendingActionRepository;
  /**
   * Mail Curator scheduler (Route C / WP J.8). When provided, the
   * `run_curator` chat tool is registered so the agent can refresh the
   * workspace on demand. Omitted in deployments without curator wiring
   * (the tool is then absent from `listTools()`).
   */
  curator?: CuratorScheduler;
  /** Resolves to the active account id for {@link curator} triggers. */
  getActiveAccountId?: () => string | undefined;
  /** Edition allowance service; absent in the open edition. */
  allowance?: Pick<AllowanceInvoicePort, "findInvoiceAttachments">;
  /**
   * Register the three allowance/invoice tools only when the feature flag
   * AND the edition module are both on (P2.6, mirrors `wecliToolsEnabled`).
   */
  allowanceToolsEnabled?: boolean;
  now?: () => Date;
}

const WECLI_MISSING_USER_MESSAGE =
  "未检测到 WeCLI，因此本次企业命令未执行。WeMail 的其他功能仍可正常使用；你可以在确认弹窗中选择安装 WeCLI（仅限企业内网环境），也可以取消并配置 WEMAIL_WECLI_BINARY 后重试。";

function toWecliInstallPendingAction(
  row: ReturnType<AgentPendingActionRepository["getPending"]>[number],
): AgentPendingAction {
  return {
    ...rowToAction(row),
    toolName: "install_wecli",
  };
}

function createWecliInstallPendingAction(
  repo: AgentPendingActionRepository | undefined,
  ctx: AgentToolContext | undefined,
  request: WecliInstallRequest | undefined,
): AgentPendingAction | undefined {
  // The install command / registry are edition-supplied. The open edition
  // has no module, so it never offers an installer pending action.
  if (!repo || !ctx?.sessionId || !request) return undefined;
  const existing = repo
    .getPending(ctx.sessionId)
    .find((action) => action.action_type === "install_wecli");
  if (existing) return toWecliInstallPendingAction(existing);

  const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parameters = {
    command: request.command,
    package: request.packageName,
    registry: request.registry,
    networkRequirement: request.networkRequirement,
  };
  const pendingAction: AgentPendingAction = {
    id,
    conversationId: ctx.sessionId,
    actionType: "install_wecli",
    description: "安装可选组件 WeCLI",
    toolName: "install_wecli",
    inputJson: JSON.stringify(parameters),
    riskReason:
      "该操作会通过企业内网源全局安装 npm 包。仅应在企业内网环境中执行；取消不会影响 WeMail 的其他功能。",
    riskLevel: deriveRiskLevel("install_wecli"),
    ...createPendingActionAuthorization(id, parameters),
  };
  repo.insert({
    id: pendingAction.id,
    conversationId: pendingAction.conversationId,
    actionType: pendingAction.actionType,
    description: pendingAction.description,
    inputJson: pendingAction.inputJson,
    riskReason: pendingAction.riskReason,
    riskLevel: pendingAction.riskLevel,
    parameters: pendingAction.parameters,
    idempotencyKey: pendingAction.idempotencyKey,
    expiresAt: pendingAction.expiresAt,
  });
  return pendingAction;
}

async function runWecliForAgent(
  runtime: WecliRuntimePort,
  command: string,
  options?: WecliRunOptions,
  recovery?: {
    pendingActionRepo?: AgentPendingActionRepository;
    ctx?: AgentToolContext;
    installRequest?: WecliInstallRequest;
  },
) {
  try {
    const result = await runtime.run(command, { ...options, signal: recovery?.ctx?.signal });
    if (result.exitCode !== 0) {
      throw new AgentTerminalToolError({
        code: "wecli_command_failed",
        userMessage: `平台命令执行失败（退出码 ${result.exitCode}），未取得可用结果。请检查平台连接和登录状态后再试。`,
      });
    }
    return result;
  } catch (err) {
    if (isWecliErrorCode(err, WECLI_ERROR_CODES.timeout)) {
      throw new AgentTerminalToolError({
        code: "wecli_timeout",
        userMessage: "平台命令未在截止时间内返回结果，已停止等待。请检查平台连接和登录状态后再试。",
        cause: err,
      });
    }
    const spawnFailure = wecliSpawnFailure(err);
    const binaryMissing =
      isWecliErrorCode(err, WECLI_ERROR_CODES.binaryMissing) ||
      (isWecliErrorCode(err, WECLI_ERROR_CODES.spawn) &&
        spawnFailure.errorCode === "ENOENT");
    if (binaryMissing) {
      const pendingAction = createWecliInstallPendingAction(
        recovery?.pendingActionRepo,
        recovery?.ctx,
        recovery?.installRequest,
      );
      throw new AgentTerminalToolError({
        code: "wecli_binary_missing",
        userMessage: WECLI_MISSING_USER_MESSAGE,
        pendingAction,
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Envelope-only summary safe for agent traces. Explicitly omits
 * bodyText / bodyHtml — see `no-body-in-logs` constraint (Handoff §2).
 */
export interface MailEnvelopeSummary {
  id: string;
  folder: string;
  subject: string;
  snippet: string;
  from: MailMessage["from"];
  to: MailMessage["to"];
  receivedAt: string;
  hasAttachments: boolean;
  flags: MailMessage["flags"];
}

function toEnvelope(m: MailMessage | MailCoreMessageSummary): MailEnvelopeSummary {
  return {
    id: m.id,
    folder: m.folder,
    subject: m.subject,
    snippet: m.snippet,
    from: m.from,
    to: m.to,
    receivedAt: m.receivedAt,
    hasAttachments: m.hasAttachments,
    flags: m.flags,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function messageIdFrom(input: ToolInput, ctx: AgentToolContext): string | undefined {
  return asString(input.id) ?? asString(ctx.runContext?.emailId);
}
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}
function truncate(value: string | undefined, maxChars: number): { value: string; truncated: boolean } {
  const raw = value ?? "";
  if (raw.length <= maxChars) return { value: raw, truncated: false };
  return { value: raw.slice(0, maxChars), truncated: true };
}
function normalizeFolder(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase() === "inbox" ? "INBOX" : value;
}
function isSafeWecliToken(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
function isPdfFilename(value: string | undefined): boolean {
  return typeof value === "string" && /\.pdf$/i.test(value.trim());
}

const ALLOWANCE_LS_MODE_ALIASES = new Map<string, string>([
  ["可用", "available"],
  ["卡包", "available"],
  ["已上传未使用", "available"],
  ["待确认", "pending"],
  ["核验失败", "failed"],
  ["月份已关联", "month"],
  ["账期已关联", "month"],
  ["月份可用", "eligible"],
  ["账期可用", "eligible"],
]);

function stripLeadingWecli(tokens: string[]): string[] {
  const normalized = [...tokens];
  if (normalized.length > 0) {
    const head = normalized[0]!.toLowerCase();
    if (head === "wecli" || head === "wecli.exe") normalized.shift();
  }
  return normalized;
}

function normalizeWecliCommand(command: string, tokenize: WecliTokenizerPort): string {
  const tokens = stripLeadingWecli(tokenize(command.trim()));
  if (
    tokens[0]?.toLowerCase() === "allowance" &&
    tokens[1]?.toLowerCase() === "ls" &&
    tokens[2]
  ) {
    const alias = ALLOWANCE_LS_MODE_ALIASES.get(tokens[2]);
    if (alias) tokens[2] = alias;
  }
  return tokens.join(" ");
}

function commandFamily(command: string, tokenize: WecliTokenizerPort): string | undefined {
  const tokens = stripLeadingWecli(tokenize(normalizeWecliCommand(command, tokenize)));
  if (tokens.length === 0) return undefined;
  const first = tokens[0]!.toLowerCase();
  const second = tokens[1]?.toLowerCase();
  if (first === "allowance" && second) {
    return `wecli:allowance:${second}`;
  }
  return `wecli:${first}`;
}

function inDateRange(receivedAt: string, fromDate?: string, toDate?: string): boolean {
  const value = Date.parse(receivedAt);
  if (!Number.isFinite(value)) return false;
  if (fromDate) {
    const from = Date.parse(fromDate);
    if (Number.isFinite(from) && value < from) return false;
  }
  if (toDate) {
    const to = Date.parse(toDate);
    if (Number.isFinite(to) && value > to) return false;
  }
  return true;
}

type DateRangePreset =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "this_week"
  | "last_week"
  | "last_30_days";

function nowFromContext(ctx?: AgentToolContext, fallback?: () => Date): Date {
  const raw = asString(ctx?.runContext?.now) ?? asString(ctx?.runContext?.requestedAt);
  const parsed = raw ? new Date(raw) : fallback?.();
  if (parsed && Number.isFinite(parsed.getTime())) return parsed;
  return new Date();
}

function iso(date: Date): string {
  return date.toISOString();
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    hour: Number(byType.get("hour")),
    minute: Number(byType.get("minute")),
    second: Number(byType.get("second")),
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = zonedParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedLocalTimeToUtc(
  local: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timezone: string,
): Date {
  const utcGuess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
  );
  const first = new Date(utcGuess - timezoneOffsetMs(new Date(utcGuess), timezone));
  return new Date(utcGuess - timezoneOffsetMs(first, timezone));
}

function shiftLocalDate(
  local: { year: number; month: number; day: number },
  days: number,
) {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function startOfLocalDay(date: Date, timezone: string): Date {
  const parts = zonedParts(date, timezone);
  return zonedLocalTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day },
    timezone,
  );
}

function startOfLocalWeek(date: Date, timezone: string): Date {
  const parts = zonedParts(date, timezone);
  const localWeekday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const isoWeekday = localWeekday === 0 ? 7 : localWeekday;
  const monday = shiftLocalDate(parts, 1 - isoWeekday);
  return zonedLocalTimeToUtc(monday, timezone);
}

function buildTimeSnapshot(now: Date, timezone?: string) {
  const resolvedTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const todayStart = startOfLocalDay(now, resolvedTimezone);
  const thisWeekStart = startOfLocalWeek(now, resolvedTimezone);
  return {
    nowIso: iso(now),
    epochMs: now.getTime(),
    timezone: resolvedTimezone,
    ranges: {
      today: { from: iso(todayStart), to: iso(now) },
      yesterday: { from: iso(addDays(todayStart, -1)), to: iso(todayStart) },
      last_7_days: { from: iso(addDays(now, -7)), to: iso(now) },
      this_week: { from: iso(thisWeekStart), to: iso(now) },
      last_week: { from: iso(addDays(thisWeekStart, -7)), to: iso(thisWeekStart) },
      last_30_days: { from: iso(addDays(now, -30)), to: iso(now) },
    },
  };
}

function resolveDateRange(input: ToolInput, ctx: AgentToolContext, fallbackNow?: () => Date) {
  const dateRange = asRecord(input.dateRange);
  const preset = asString(dateRange?.preset) as DateRangePreset | undefined;
  const explicitFrom = asString(input.fromDate) ?? asString(dateRange?.from);
  const explicitTo = asString(input.toDate) ?? asString(dateRange?.to);
  if (explicitFrom || explicitTo) {
    return { from: explicitFrom, to: explicitTo };
  }
  if (!preset) return {};
  const timezone = asString(ctx.runContext?.timezone);
  const snapshot = buildTimeSnapshot(nowFromContext(ctx, fallbackNow), timezone);
  const range = snapshot.ranges[preset];
  return range ? { from: range.from, to: range.to } : {};
}

export function createMailAgentTools(deps: MailAgentToolDeps): AgentTool[] {
  const getCurrentTime: AgentTool = {
    name: "get_current_time",
    description:
      "Return the local current time and canonical date ranges. Use this before answering relative date questions like today, last week, or last 7 days.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler(_input: ToolInput, ctx: AgentToolContext) {
      return buildTimeSnapshot(
        nowFromContext(ctx, deps.now),
        asString(ctx.runContext?.timezone),
      );
    },
    observe: (output) =>
      `Current time ${(output as { nowIso?: string }).nowIso ?? "unknown"}`,
  };

  const listMail: AgentTool = {
    name: "list_mail",
    description:
      "List envelope summaries of mail messages. Supports unreadOnly and received date range filtering. Returns subject/from/snippet/receivedAt/flags but never body text.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200 },
        unreadOnly: { type: "boolean" },
        category: { type: "string" },
        subjectTerms: {
          type: "array",
          items: { type: "string" },
          maxItems: 12,
        },
        dateRange: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              enum: ["today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days"],
            },
            from: { type: "string" },
            to: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const folder = normalizeFolder(asString(input.folder));
      const limit = asNumber(input.limit) ?? 50;
      const unreadOnly = asBoolean(input.unreadOnly) ?? false;
      const category = asString(input.category);
      const subjectTerms = Array.isArray(input.subjectTerms)
        ? input.subjectTerms
            .filter((term): term is string => typeof term === "string")
            .map((term) => term.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 12)
        : [];
      const range = resolveDateRange(input, ctx, deps.now);
      const scanLimit =
        unreadOnly || category || subjectTerms.length > 0 || range.from || range.to
          ? 200
          : limit;
      const accountId = asString(ctx.runContext?.accountId) ?? deps.getActiveAccountId?.();
      if (!accountId) return { messages: [], count: 0, error: "account-required" };
      const listed = await deps.mailDatabase.listMail({
          accountId,
          folder,
          unread: unreadOnly || undefined,
          category,
          limit: scanLimit,
        });
      const rows = listed.messages
        .filter((message) => !unreadOnly || !message.flags.seen)
        .filter((message) => inDateRange(message.receivedAt, range.from, range.to))
        .filter(
          (message) =>
            subjectTerms.length === 0 ||
            subjectTerms.some((term) => message.subject.toLowerCase().includes(term)),
        )
        .slice(0, limit);
      return { messages: rows.map(toEnvelope), count: rows.length };
    },
    observe: (output) => `Listed ${(output as { count?: number }).count ?? 0} messages`,
  };

  const readMail: AgentTool = {
    name: "read_mail",
    description:
      "Fetch an envelope summary by message id (subject, from, snippet, flags). Does not return mail body.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = messageIdFrom(input, ctx);
      if (!id) return { ok: false, error: "id is required" };
      const msg = (await deps.mailDatabase.getMailSnapshot(id)).message;
      if (!msg) return { ok: false, error: "not_found" };
      return {
        ok: true,
        message: {
          ...toEnvelope(msg),
          flags: msg.flags,
          cc: msg.cc,
          bcc: msg.bcc,
          // attachments metadata (no bytes) is fine — size/filename only
          attachments: msg.attachments,
        },
      };
    },
    observe: (output) =>
      (output as { ok?: boolean }).ok ? "Loaded mail envelope" : "Mail not found",
  };

  const readMailSource: AgentTool = {
    name: "read_mail_source",
    description:
      "Fetch stored source content for one targeted mail message. Returns bodyText, optional bodyHtml, selected headers, and envelope metadata for debugging AI failures.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeHtml: { type: "boolean" },
        maxChars: { type: "number", minimum: 1, maximum: 20000 },
      },
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = messageIdFrom(input, ctx);
      if (!id) return { ok: false, error: "id is required" };
      const msg = (await deps.mailDatabase.getMailSnapshot(id)).message;
      if (!msg) return { ok: false, error: "not_found" };
      const maxChars = clampInt(asNumber(input.maxChars), 6000, 1, 20000);
      const bodyText = truncate(resolveAiBodyText(msg).text, maxChars);
      const bodyHtml = truncate(msg.bodyHtml, maxChars);
      const includeHtml = asBoolean(input.includeHtml) ?? false;
      return {
        ok: true,
        message: {
          ...toEnvelope(msg),
          cc: msg.cc,
          bcc: msg.bcc,
          attachments: msg.attachments,
          headers: msg.headers ?? {},
          bodyText: bodyText.value,
          ...(includeHtml ? { bodyHtml: bodyHtml.value } : {}),
          source: "stored-message",
          truncated: {
            bodyText: bodyText.truncated,
            bodyHtml: includeHtml ? bodyHtml.truncated : false,
          },
        },
      };
    },
    observe: (output) =>
      (output as { ok?: boolean }).ok ? "Loaded stored mail source" : "Mail source not found",
  };

  const batchReadMailSource: AgentTool = {
    name: "batch_read_mail_source",
    description:
      "Read bounded stored body text for 1-20 explicitly selected mail ids after list_mail or search_mail. Use this instead of repeated read_mail_source calls for multi-mail analysis. Returns text only, enforces active-account ownership, and limits both each body and the whole batch.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
        maxCharsPerMessage: {
          type: "number",
          minimum: 1,
          maximum: 20000,
        },
        maxTotalChars: {
          type: "number",
          minimum: 1,
          maximum: 80000,
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const rawIds = Array.isArray(input.ids)
        ? input.ids.filter((id): id is string => typeof id === "string")
        : [];
      if (rawIds.length === 0) {
        return { ok: false, error: "ids are required" };
      }
      if (rawIds.length > 20) {
        return { ok: false, error: "at most 20 ids are allowed" };
      }
      const accountId =
        asString(ctx.runContext?.accountId) ?? deps.getActiveAccountId?.();
      if (!accountId) {
        return { ok: false, error: "active account is required" };
      }

      const ids = Array.from(new Set(rawIds));
      const maxCharsPerMessage = clampInt(
        asNumber(input.maxCharsPerMessage),
        4000,
        1,
        20000,
      );
      const maxTotalChars = clampInt(
        asNumber(input.maxTotalChars),
        80000,
        1,
        80000,
      );
      let remainingChars = maxTotalChars;
      let returnedCount = 0;
      let unavailableCount = 0;
      let truncatedCount = 0;
      const entries: Array<Record<string, unknown>> = [];

      for (const id of ids) {
        if (ctx.signal?.aborted) {
          return { ok: false, error: "cancelled" };
        }
        const message = (await deps.mailDatabase.getMailSnapshot(id)).message;
        if (!message || message.accountId !== accountId) {
          unavailableCount += 1;
          entries.push({ id, status: "unavailable" });
          continue;
        }

        const allowedChars = Math.min(maxCharsPerMessage, remainingChars);
        const aiBodyText = resolveAiBodyText(message).text;
        const body = truncate(aiBodyText, allowedChars);
        const bodyWasTruncated =
          body.truncated || aiBodyText.length > allowedChars;
        remainingChars -= body.value.length;
        returnedCount += 1;
        if (bodyWasTruncated) truncatedCount += 1;
        entries.push({
          id,
          status: "ready",
          message: {
            ...toEnvelope(message),
            attachments: message.attachments,
            bodyText: body.value,
          },
          truncated: { bodyText: bodyWasTruncated },
        });
      }

      return {
        ok: true,
        entries,
        requestedCount: ids.length,
        returnedCount,
        unavailableCount,
        truncatedCount,
        totalChars: maxTotalChars - remainingChars,
        maxTotalChars,
        aggregateTruncated: truncatedCount > 0 && remainingChars === 0,
      };
    },
    observe: (output) => {
      const result = output as {
        requestedCount?: number;
        returnedCount?: number;
        unavailableCount?: number;
        truncatedCount?: number;
      };
      return `Batch mail source read: requested ${result.requestedCount ?? 0}, returned ${result.returnedCount ?? 0}, unavailable ${result.unavailableCount ?? 0}, truncated ${result.truncatedCount ?? 0}`;
    },
  };

  const searchMail: AgentTool = {
    name: "search_mail",
    description:
      "Case-insensitive substring match over subject and from. Supports folder, unread, and received date-range filters. Returns envelope summaries.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        folder: { type: "string" },
        fromDate: { type: "string" },
        toDate: { type: "string" },
        dateRange: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              enum: ["today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days"],
            },
            from: { type: "string" },
            to: { type: "string" },
          },
          additionalProperties: false,
        },
        unreadOnly: { type: "boolean" },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const q = (asString(input.q) ?? "").trim().toLowerCase();
      const folder = normalizeFolder(asString(input.folder));
      const range = resolveDateRange(input, ctx, deps.now);
      const fromDate = range.from;
      const toDate = range.to;
      const unreadOnly = asBoolean(input.unreadOnly) ?? false;
      const limit = asNumber(input.limit) ?? 25;
      if (!q && !folder && !fromDate && !toDate && !unreadOnly) {
        return { messages: [], count: 0 };
      }
      const accountId = asString(ctx.runContext?.accountId) ?? deps.getActiveAccountId?.();
      if (!accountId) return { messages: [], count: 0, error: "account-required" };
      const searched = await deps.mailDatabase.search({
        accountId,
        query: q || undefined,
        folder,
        unread: unreadOnly ? true : undefined,
        dateFrom: fromDate,
        dateTo: toDate,
        limit: 200,
      });
      const pool = searched.messages;
      const matches = pool.filter((m) => {
        if (unreadOnly && m.flags.seen) return false;
        if (!inDateRange(m.receivedAt, fromDate, toDate)) return false;
        if (q.length === 0) return true;
        const subj = (m.subject ?? "").toLowerCase();
        const fromName = (m.from?.name ?? "").toLowerCase();
        const fromEmail = (m.from?.email ?? "").toLowerCase();
        return (
          subj.includes(q) || fromName.includes(q) || fromEmail.includes(q)
        );
      });
      const sliced = matches.slice(0, limit).map(toEnvelope);
      return { messages: sliced, count: sliced.length };
    },
    observe: (output) => `Found ${(output as { count?: number }).count ?? 0} messages`,
  };

  const batchGetMailIntelligence: AgentTool = {
    name: "batch_get_mail_intelligence",
    description:
      "Load envelope summaries plus stored intelligence state for several message ids. Never returns full mail body.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const ids = Array.isArray(input.ids)
        ? input.ids.filter((id): id is string => typeof id === "string")
        : [];
      const uniqueIds = Array.from(new Set(ids)).slice(0, 50);
      const messages = [];
      for (const id of uniqueIds) {
        const msg = (await deps.mailDatabase.getMailSnapshot(id)).message;
        if (!msg) continue;
        const state = await deps.mailDatabase.getIntelligenceState(id);
        messages.push({
          ...toEnvelope(msg),
          summary: state.summary.result,
          tags: state.tags.result,
          replyDecision: state.replyDecision.result,
          replyDraftStatus: state.replyDraft.status,
        });
      }
      return { ok: true, messages, count: messages.length };
    },
    observe: (output) =>
      `Loaded intelligence for ${(output as { count?: number }).count ?? 0} messages`,
  };

  const summarizeMail: AgentTool = {
    name: "summarize_mail",
    description:
      "Return the AI summary for a message. If no summary exists yet, returns ready=false with status info. Call trigger_summary to generate one.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const state = await deps.mailDatabase.getIntelligenceState(id);
      if (!state.summary.result) {
        return { ok: true, ready: false, status: state.summary.status };
      }
      return { ok: true, ready: true, summary: state.summary.result };
    },
  };

  const getSummary: AgentTool = {
    name: "get_summary",
    description:
      "Compatibility alias for summarize_mail. Prefer summarize_mail in new agent plans.",
    inputSchema: summarizeMail.inputSchema,
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const state = await deps.mailDatabase.getIntelligenceState(id);
      if (!state.summary.result) {
        return { ok: true, ready: false, status: state.summary.status };
      }
      return { ok: true, ready: true, summary: state.summary.result };
    },
  };

  const getTags: AgentTool = {
    name: "get_tags",
    description: "Return AI-generated tags for a message. Includes confidence and tier (auto/suggested).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const tags = (await deps.mailDatabase.getIntelligenceState(id)).tags.result;
      if (!tags) return { ok: true, ready: false };
      return { ok: true, ready: true, tags };
    },
  };

  const getReplyDecision: AgentTool = {
    name: "get_reply_decision",
    description: "Return the reply decision for a message — whether it needs a reply and why.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const decision = (await deps.mailDatabase.getIntelligenceState(id)).replyDecision.result;
      if (!decision) return { ok: true, ready: false };
      return { ok: true, ready: true, replyDecision: decision };
    },
  };

  const getReplyDraft: AgentTool = {
    name: "get_reply_draft",
    description:
      "Return the stored reply draft for a message. If no draft exists, returns ready=false with status. If reply is not needed, returns notNeeded=true.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const state = await deps.mailDatabase.getIntelligenceState(id);
      if (state.replyDraft.status === "not-needed") {
        return { ok: true, ready: false, notNeeded: true, reason: state.replyDecision.result?.reason };
      }
      if (!state.replyDraft.result) {
        return { ok: true, ready: false, status: state.replyDraft.status };
      }
      return { ok: true, ready: true, replyDraft: state.replyDraft.result };
    },
  };

  const getIntelligenceState: AgentTool = {
    name: "get_intelligence_state",
    description: "Return the full intelligence state for a message — summary, tags, reply decision, and draft status.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const state = await deps.mailDatabase.getIntelligenceState(id);
      return { ok: true, state };
    },
  };

  const triggerSummary: AgentTool = {
    name: "trigger_summary",
    description: "Trigger AI summary generation for a message. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      void caller;
      const result = await deps.mailDatabase.requestIntelligence({ emailId: id, kinds: ["summary"] });
      return { ok: true, jobId: result.value.jobIds[0] };
    },
  };

  const triggerTags: AgentTool = {
    name: "trigger_tags",
    description: "Trigger AI tag generation for a message. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      void caller;
      const result = await deps.mailDatabase.requestIntelligence({ emailId: id, kinds: ["tags"] });
      return { ok: true, jobId: result.value.jobIds[0] };
    },
  };

  const triggerReplyDecision: AgentTool = {
    name: "trigger_reply_decision",
    description: "Trigger reply decision analysis for a message. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      void caller;
      const result = await deps.mailDatabase.requestIntelligence({ emailId: id, kinds: ["replyDecision"] });
      return { ok: true, jobId: result.value.jobIds[0] };
    },
  };

  const triggerReplyDraft: AgentTool = {
    name: "trigger_reply_draft",
    description: "Trigger reply draft generation for a message. Only works if reply decision says shouldReply=true. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const jobId = await deps.intelligenceService.triggerReplyDraft(id, caller);
      return { ok: true, jobId };
    },
  };

  const retryIntelligence: AgentTool = {
    name: "retry_intelligence",
    description: "Retry a failed intelligence job for a message. Specify the capability type.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: {
          type: "string",
          enum: [
            "summary",
            "tags",
            "replyDecision",
            "replyDraft",
            "todoExtraction",
            "linkExtraction",
            "translation",
            "composeMail",
          ],
        },
      },
      required: ["id", "type"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      const type = asString(input.type) as IntelligenceJobType;
      if (!id || !type) return { ok: false, error: "id and type are required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const jobId = await deps.intelligenceService.retry(id, type, caller);
      return { ok: true, jobId };
    },
  };

  const triggerTodoExtraction: AgentTool = {
    name: "trigger_todo_extraction",
    description: "Trigger AI todo extraction for a message. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const requestId = await deps.intelligenceService.triggerTodoExtraction(id, caller);
      return { ok: true, status: "queued", jobId: requestId };
    },
  };

  const getTodos: AgentTool = {
    name: "get_todos",
    description: "List suggested and completed todos for a message.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const todos = await deps.intelligenceService.getTodos(id);
      return { ok: true, todos, count: todos.length };
    },
    observe: (output) => `Loaded ${(output as { count?: number }).count ?? 0} todos`,
  };

  const completeTodo: AgentTool = {
    name: "complete_todo",
    description: "Mark a todo complete through IntelligenceService audit path.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const todo = await deps.intelligenceService.completeTodo(id, caller);
      return todo ? { ok: true, todo } : { ok: false, error: "todo-not-found" };
    },
  };

  const getSmartLinks: AgentTool = {
    name: "get_smart_links",
    description: "Read extracted smart links for a message without exposing body HTML.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const id = asString(input.id);
      if (!id) return { ok: false, error: "id is required" };
      const links = await deps.intelligenceService.getSmartLinks(id);
      return { ok: true, ready: !!links, links };
    },
  };

  const triggerLinkExtraction: AgentTool = {
    name: "trigger_link_extraction",
    description: "Trigger smart link extraction for a message. Returns the job ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = messageIdFrom(input, ctx);
      if (!id) return { ok: false, error: "id is required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const jobId = await deps.intelligenceService.triggerLinkExtraction(id, caller);
      return { ok: true, status: "queued", jobId };
    },
  };

  const getTranslation: AgentTool = {
    name: "get_translation",
    description: "Read a stored translation result for a message.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = messageIdFrom(input, ctx);
      if (!id) return { ok: false, error: "id is required" };
      const translation = await deps.intelligenceService.getTranslation(id);
      return { ok: true, ready: !!translation, translation };
    },
  };

  const triggerTranslation: AgentTool = {
    name: "trigger_translation",
    description: "Trigger cached translation for a message and target language.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        targetLanguage: { type: "string" },
      },
      required: ["id", "targetLanguage"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      const targetLanguage = asString(input.targetLanguage);
      if (!id || !targetLanguage) {
        return { ok: false, error: "id and targetLanguage are required" };
      }
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const requestId = await deps.intelligenceService.triggerTranslation(
        id,
        targetLanguage,
        caller,
      );
      return { ok: true, status: "queued", jobId: requestId };
    },
  };

  const composeMail: AgentTool = {
    name: "compose_mail",
    description:
      "Create a waiting_confirmed draft payload for NEW or REPLY. This never sends mail.",
    inputSchema: {
      type: "object",
      properties: {
        operationType: { type: "string", enum: ["NEW", "REPLY"] },
        intent: { type: "string" },
        emailId: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        targetLanguage: { type: "string" },
        styleId: { type: "string" },
      },
      required: ["operationType", "intent"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const operationType = asString(input.operationType);
      const intent = asString(input.intent);
      if ((operationType !== "NEW" && operationType !== "REPLY") || !intent) {
        return { ok: false, error: "operationType and intent are required" };
      }
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      const draft = await deps.intelligenceService.composeMail(
        {
          operationType,
          intent,
          emailId: asString(input.emailId),
          to: Array.isArray(input.to)
            ? input.to.filter((item): item is string => typeof item === "string")
            : undefined,
          targetLanguage: asString(input.targetLanguage),
          styleId: asString(input.styleId),
        },
        caller,
      );
      return { ok: true, draft };
    },
    observe: () => "Created draft for user confirmation",
  };

  const confirmTag: AgentTool = {
    name: "confirm_tag",
    description: "Confirm a suggested AI tag, promoting it to auto-applied for this email.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, tag: { type: "string" } },
      required: ["id", "tag"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      const tag = asString(input.tag);
      if (!id || !tag) return { ok: false, error: "id and tag are required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      await deps.intelligenceService.confirmTag(id, tag, caller);
      return { ok: true };
    },
  };

  const rejectTag: AgentTool = {
    name: "reject_tag",
    description: "Reject an AI tag and create a feedback rule to suppress it on similar emails.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, tag: { type: "string" } },
      required: ["id", "tag"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const id = asString(input.id);
      const tag = asString(input.tag);
      if (!id || !tag) return { ok: false, error: "id and tag are required" };
      const caller: CallerContext = { source: "agent", sessionId: ctx.sessionId };
      await deps.intelligenceService.rejectTag(id, tag, caller);
      return { ok: true };
    },
  };

  const findInvoiceAttachments: AgentTool = {
    name: "find_invoice_attachments",
    description:
      "Find invoice mails and attachment candidates. Subjects containing 发票 are always included, even without attachments. Defaults to the mailbox; pass emailId or scope=current ONLY when the user asks for the current mail. Returns messages separately from uploadable attachments. Follow nextPage while hasMore is true before claiming a complete result. Never downloads or uploads.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        emailId: { type: "string" },
        scope: { type: "string", enum: ["current", "mailbox"] },
        page: { type: "number", minimum: 1 },
        fromDate: { type: "string" },
        toDate: { type: "string" },
        dateRange: {
          type: "object",
          properties: {
            preset: {
              type: "string",
              enum: ["today", "yesterday", "last_7_days", "this_week", "last_week", "last_30_days"],
            },
            from: { type: "string" },
            to: { type: "string" },
          },
          additionalProperties: false,
        },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      if (!deps.allowance) {
        return { ok: false, error: "allowance service not wired" };
      }
      const range = resolveDateRange(input, ctx, deps.now);
      return deps.allowance.findInvoiceAttachments({
        accountId: asString(ctx.runContext?.accountId),
        emailId: asString(input.emailId) ?? (input.scope === "current" ? asString(ctx.runContext?.emailId) : undefined),
        q: asString(input.q),
        fromDate: range.from,
        toDate: range.to,
        limit: asNumber(input.limit),
        page: asNumber(input.page),
      });
    },
    observe: (output) =>
      `Found ${(output as { mailCount?: number }).mailCount ?? 0} invoice mails and ${(output as { count?: number }).count ?? 0} attachment candidates${(output as { hasMore?: boolean }).hasMore ? "; more pages remain" : ""}`,
  };

  const proposeAllowanceInvoiceUpload: AgentTool = {
    name: "propose_allowance_invoice_upload",
    description:
      "Create a pending confirmation action for allowance upload. After confirmation, WeMail automatically downloads the selected PDF mail attachments into an internal temporary directory, then passes each staged local path to wecli allowance. The download needs no separate permission, and this tool never executes the upload before confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              emailId: { type: "string" },
              attachmentId: { type: "string" },
              filename: { type: "string" },
            },
            required: ["emailId", "attachmentId"],
            additionalProperties: false,
          },
        },
        includeNonPdf: {
          type: "boolean",
          description:
            "Set true only when the user explicitly asks to upload ZIP, non-PDF, or all attachments. Default behavior uploads PDF invoice attachments only when PDFs are present.",
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const rawItems = Array.isArray(input.items) ? input.items : [];
      const items = rawItems
        .map((item) =>
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : undefined,
        )
        .filter(
          (item): item is { emailId: string; attachmentId: string; filename?: string } =>
            typeof item?.emailId === "string" &&
            typeof item.attachmentId === "string",
        )
        .slice(0, 20);
      if (items.length === 0) {
        return { ok: false, error: "items are required" };
      }
      const includeNonPdf = asBoolean(input.includeNonPdf) === true;
      const pdfItems = items.filter((item) => isPdfFilename(item.filename));
      const allItemsHaveKnownFilename = items.every(
        (item) =>
          typeof item.filename === "string" && item.filename.trim().length > 0,
      );
      if (!includeNonPdf && allItemsHaveKnownFilename && pdfItems.length === 0) {
        return {
          ok: false,
          error: "No PDF invoice attachments found in the selected items.",
          requires_clarification: true,
          message:
            "默认只上传 PDF 发票附件。当前所选附件里没有 PDF；如需继续上传 ZIP、OFD、图片或其他非 PDF 附件，请明确确认并设置 includeNonPdf=true。",
        };
      }
      const defaultedToPdf = !includeNonPdf && pdfItems.length > 0;
      let selectedItems = defaultedToPdf ? pdfItems : items;
      let retryUnverified = false;
      let excluded: Array<{ emailId: string; attachmentId: string; filename?: string; reason: string; message: string }> = [];
      if (deps.mailDatabase.actionExecution) {
        const accountId = asString(ctx.runContext?.accountId) ?? deps.getActiveAccountId?.();
        if (!accountId) return { ok: false, error: "accountId-required", executed: false };
        const preflight = await deps.mailDatabase.actionExecution({ op: "preflight", accountId,
          items: selectedItems.map(({ emailId, attachmentId }) => ({ emailId, attachmentId })) });
        if (!preflight || typeof preflight !== "object" || !("eligibility" in preflight)) throw new Error("invalid-upload-preflight");
        retryUnverified = preflight.eligibility.some((item) => item.reason === "pending_verification");
        const blocked = new Map(preflight.eligibility.filter((item) => item.reason && item.reason !== "pending_verification").map((item) => [`${item.emailId}\0${item.attachmentId}`, item.reason!]));
        const labels = { already_processed: "此前已上传，本次无需上传", already_associated: "已关联账单，本次无需上传",
          in_progress: "正在处理中，本次无需重复提交", pending_verification: "历史提交结果待核实，本次未重复上传" };
        excluded = selectedItems.flatMap((item) => {
          const reason = blocked.get(`${item.emailId}\0${item.attachmentId}`);
          return reason ? [{ ...item, reason, message: labels[reason] }] : [];
        });
        selectedItems = selectedItems.filter((item) => !blocked.has(`${item.emailId}\0${item.attachmentId}`));
        if (!selectedItems.length) return { ok: true, executed: false, noUploadNeeded: true, excluded,
          message: "本次未上传。请按每项 message 展示已上传、已关联或正在处理的实际结果，不要自行尝试绕过防护的命令。" };
      }
      const description = retryUnverified ? `重新尝试上传 ${selectedItems.length} 个发票附件（历史结果未确认）` : defaultedToPdf
        ? `上传 ${selectedItems.length} 个 PDF 发票附件到发票平台`
        : `上传 ${selectedItems.length} 个邮件附件到发票平台`;
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parameters = {
        items: selectedItems,
        includeNonPdf,
        ...(retryUnverified ? { retryUnverified: true } : {}),
        commandFamily: "wecli:allowance:upload",
        continuation: {
          scenario: "allowance_monthly_invoice",
          nextGoal: "upload_done_then_query_wallet_and_plan",
        },
      };
      const pendingAction: AgentPendingAction = {
        id,
        actionType: "upload_allowance_invoices",
        description,
        toolName: "propose_allowance_invoice_upload",
        inputJson: JSON.stringify(parameters),
        riskReason: retryUnverified
          ? "历史上传曾超时或未收到明确回执，尚不能确认是否入库。确认将授权再次提交本卡所列附件，存在重复提交风险；已有明确成功或正在处理的附件不会重传。"
          : "确认发票上传后，WeMail 会先将选中的 PDF 邮件附件下载到内部临时目录，再把本地临时路径交给 wecli allowance；下载不需要单独权限。确认授权当前对话中的这组上传命令。",
        riskLevel: deriveRiskLevel("upload_allowance_invoices"),
        ...createPendingActionAuthorization(id, parameters),
      };
      if (deps.pendingActionRepo) {
        deps.pendingActionRepo.insert({
          id: pendingAction.id,
          conversationId: ctx.sessionId,
          actionType: pendingAction.actionType,
          description: pendingAction.description,
          inputJson: pendingAction.inputJson,
          riskReason: pendingAction.riskReason,
          emailId: selectedItems[0]?.emailId,
          riskLevel: pendingAction.riskLevel,
          parameters: pendingAction.parameters,
          idempotencyKey: pendingAction.idempotencyKey,
          expiresAt: pendingAction.expiresAt,
        });
      }
      return { ok: true, pendingAction, excluded, executed: false };
    },
    observe: (output) => {
      const pending = (output as { pendingAction?: AgentPendingAction }).pendingAction;
      return pending
        ? `Proposed allowance upload: ${pending.description}`
        : (output as { noUploadNeeded?: boolean }).noUploadNeeded ? "No eligible attachments to upload; excluded items need status explanation"
          : "Allowance upload proposal failed";
    },
  };

  const proposeAllowanceInvoiceDelete: AgentTool = {
    name: "propose_allowance_invoice_delete",
    description:
      "Create a pending confirmation action to delete allowance invoice associations from the monthly invoice platform by invoice id. This never executes until the user confirms.",
    inputSchema: {
      type: "object",
      properties: {
        invoiceIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ["invoiceIds"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const rawInvoiceIds = Array.isArray(input.invoiceIds)
        ? input.invoiceIds
        : [];
      const invoiceIds = rawInvoiceIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0);
      if (invoiceIds.length === 0) {
        return { ok: false, error: "invoiceIds are required" };
      }
      if (!invoiceIds.every((id) => isSafeWecliToken(id))) {
        return { ok: false, error: "invalid invoiceId" };
      }
      const command = `allowance delete ${invoiceIds.join(" ")}`;
      const description = `从发票平台删除 ${invoiceIds.length} 个发票关联`;
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parameters = { invoiceIds, command, commandFamily: "wecli:allowance:delete" };
      const pendingAction: AgentPendingAction = {
        id,
        actionType: "delete_allowance_invoices",
        description,
        toolName: "propose_allowance_invoice_delete",
        inputJson: JSON.stringify(parameters),
        riskReason:
          "This runs a confirmed wecli allowance delete command and removes invoice-platform associations for the selected invoice ids.",
        riskLevel: deriveRiskLevel("delete_allowance_invoices"),
        ...createPendingActionAuthorization(id, parameters),
      };
      if (deps.pendingActionRepo) {
        deps.pendingActionRepo.insert({
          id: pendingAction.id,
          conversationId: ctx.sessionId,
          actionType: pendingAction.actionType,
          description: pendingAction.description,
          inputJson: pendingAction.inputJson,
          riskReason: pendingAction.riskReason,
          riskLevel: pendingAction.riskLevel,
          parameters: pendingAction.parameters,
          idempotencyKey: pendingAction.idempotencyKey,
          expiresAt: pendingAction.expiresAt,
        });
      }
      return { ok: true, pendingAction, executed: false };
    },
    observe: (output) => {
      const pending = (output as { pendingAction?: AgentPendingAction }).pendingAction;
      return pending
        ? `Proposed allowance delete: ${pending.description}`
        : "Allowance delete proposal failed";
    },
  };

  const wecliQuery: AgentTool = {
    name: "wecli_query",
    description:
      "Run an auto-approved (ls/list) wecli command. Returns { requires_confirmation: true } for mutations without running them.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const command = asString(input.command);
      if (!command) return { ok: false, error: "command is required" };
      const normalizedCommand = normalizeWecliCommand(command, deps.tokenize);
      const classification = deps.classify(normalizedCommand);
      if (classification.kind !== "auto-approved") {
        return {
          ok: true,
          requires_confirmation: true,
          classification,
          message:
            "this command mutates; call wecli_action_preview instead — the agent cannot approve mutations",
        };
      }
      // Auto-approved path: execute without approvedBy (runtime allows auto-kind).
      const result = await runWecliForAgent(
        deps.wecli,
        normalizedCommand,
        undefined,
        { pendingActionRepo: deps.pendingActionRepo, ctx, installRequest: deps.wecliInstallRequest },
      );
      return {
        ok: true,
        requires_confirmation: false,
        classification: result.classification,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        parsed: result.parsed,
      };
    },
  };

  const wecliActionPreview: AgentTool = {
    name: "wecli_action_preview",
    description:
      "Preview a wecli mutation: returns classification + planned args WITHOUT spawning anything. Never executes.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    async handler(input: ToolInput) {
      const command = asString(input.command);
      if (!command) return { ok: false, error: "command is required" };
      const normalizedCommand = normalizeWecliCommand(command, deps.tokenize);
      const classification = deps.classify(normalizedCommand);
      // Derive the planned argv the same way the runtime would, minus
      // the optional leading `wecli` token. We intentionally do NOT
      // append `-f json` — this is a preview, not an exec plan.
      const tokens = stripLeadingWecli(deps.tokenize(normalizedCommand));
      return {
        ok: true,
        executed: false,
        classification,
        plannedArgs: tokens,
        riskDescription:
          classification.kind === "auto-approved"
            ? "read-only; safe to run via wecli_query"
            : `mutation (${classification.subcommand}); needs user confirmation via the UI`,
      };
    },
  };

  const wecliHelp: AgentTool = {
    name: "wecli_help",
    description:
      "Run a restricted wecli help discovery command: wecli <site> [command] [mode] --help. Use before site-specific wecli tasks such as allowance. This is read-only discovery.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        command: { type: "string" },
        mode: { type: "string" },
      },
      required: ["site"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const site = asString(input.site);
      const command = asString(input.command);
      const mode = asString(input.mode);
      if (!isSafeWecliToken(site)) return { ok: false, error: "invalid site" };
      if (command !== undefined && !isSafeWecliToken(command)) {
        return { ok: false, error: "invalid command" };
      }
      if (mode !== undefined && !isSafeWecliToken(mode)) {
        return { ok: false, error: "invalid mode" };
      }
      const parts = [site, command, mode].filter(Boolean);
      const result = await runWecliForAgent(
        deps.wecli,
        `${parts.join(" ")} --help`,
        {
          approvedBy: "agent:help",
        },
        { pendingActionRepo: deps.pendingActionRepo, ctx, installRequest: deps.wecliInstallRequest },
      );
      return {
        ok: true,
        classification: result.classification,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        parsed: result.parsed,
        auditId: result.auditId,
      };
    },
    observe: (output) =>
      (output as { ok?: boolean }).ok ? "Loaded wecli help" : "wecli help failed",
  };

  const wecliRun: AgentTool = {
    name: "wecli_run",
    description:
      "Run a wecli command only when the shared classifier auto-approves it. For commands that are not auto-approved, this returns requires_confirmation=true without running; use propose_wecli_command next.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const rawCommand = asString(input.command)?.trim();
      const command = rawCommand ? normalizeWecliCommand(rawCommand, deps.tokenize) : undefined;
      if (!command) return { ok: false, error: "command is required" };
      const classification = deps.classify(command);
      if (classification.kind !== "auto-approved") {
        return {
          ok: true,
          requires_confirmation: true,
          classification,
          message:
            "this wecli command is not classified as read-only; call propose_wecli_command to request user confirmation",
        };
      }
      const result = await runWecliForAgent(deps.wecli, command, {
        approvedBy: "agent:readonly",
      }, { pendingActionRepo: deps.pendingActionRepo, ctx, installRequest: deps.wecliInstallRequest });
      return {
        ok: true,
        requires_confirmation: false,
        classification: result.classification,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        parsed: result.parsed,
        auditId: result.auditId,
      };
    },
  };

  const proposeWecliCommand: AgentTool = {
    name: "propose_wecli_command",
    description:
      "Create a pending confirmation action for any non-read-only wecli command across enterprise sites. This never executes until the user confirms the pending action card.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const rawCommand = asString(input.command)?.trim();
      const command = rawCommand ? normalizeWecliCommand(rawCommand, deps.tokenize) : undefined;
      if (!command) return { ok: false, error: "command is required" };
      if (command.length > 4000 || command.includes("\0")) {
        return { ok: false, error: "invalid command" };
      }
      const classification = deps.classify(command);
      if (classification.kind === "auto-approved") {
        const result = await runWecliForAgent(deps.wecli, command, {
          approvedBy: "agent:readonly",
        }, { pendingActionRepo: deps.pendingActionRepo, ctx, installRequest: deps.wecliInstallRequest });
        return {
          ok: true,
          executed: true,
          reusedAuthorization: false,
          requires_confirmation: false,
          classification: result.classification,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          parsed: result.parsed,
          auditId: result.auditId,
        };
      }
      const family = commandFamily(command, deps.tokenize);
      const description =
        asString(input.description)?.trim() || `执行 wecli 命令：${command}`;
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parameters = { command, description, commandFamily: family };
      const pendingAction: AgentPendingAction = {
        id,
        actionType: "run_wecli_command",
        description,
        toolName: "propose_wecli_command",
        inputJson: JSON.stringify(parameters),
        riskReason:
          "This executes a user-confirmed wecli command that may change enterprise systems. Confirming authorizes this command family for the current conversation.",
        riskLevel: deriveRiskLevel("run_wecli_command"),
        ...createPendingActionAuthorization(id, parameters),
      };
      if (deps.pendingActionRepo) {
        deps.pendingActionRepo.insert({
          id: pendingAction.id,
          conversationId: ctx.sessionId,
          actionType: pendingAction.actionType,
          description: pendingAction.description,
          inputJson: pendingAction.inputJson,
          riskReason: pendingAction.riskReason,
          riskLevel: pendingAction.riskLevel,
          parameters: pendingAction.parameters,
          idempotencyKey: pendingAction.idempotencyKey,
          expiresAt: pendingAction.expiresAt,
        });
      }
      return { ok: true, pendingAction, executed: false };
    },
    observe: (output) => {
      const pending = (output as { pendingAction?: AgentPendingAction }).pendingAction;
      return pending ? `Proposed wecli command: ${pending.description}` : "Wecli command proposal failed";
    },
  };

  // ── ai-agent-task-assistant tools ─────────────────────────────

  const getSuggestions: AgentTool = {
    name: "get_suggestions",
    description:
      "Return state-aware suggestions for the current focused email. Returns no suggestions without an emailId because home actions are discovered separately from unread inbox mail.",
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        accountId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const emailId = asString(input.emailId) ?? asString(ctx.runContext?.emailId);
      const accountId = asString(input.accountId) ?? asString(ctx.runContext?.accountId);
      const hasEmailContext = !!emailId;

      let intelligenceState;
      if (emailId) {
        intelligenceState = await deps.mailDatabase.getIntelligenceState(emailId);
      }

      const suggestions = buildSuggestions({
        intelligenceState,
        hasEmailContext,
        emailId: emailId ?? undefined,
        accountId: accountId ?? undefined,
      });

      return { ok: true, suggestions, count: suggestions.length };
    },
    observe: (output) =>
      `Generated ${(output as { count?: number }).count ?? 0} suggestions`,
  };

  const proposeAction: AgentTool = {
    name: "propose_action",
    description:
      "Propose a high-risk action (send, delete, move, archive, mark_spam, unsubscribe, run_automation) as a pendingAction for user confirmation. This tool NEVER executes the action — it returns a pendingAction that the UI must present for confirmation. Use this whenever the user asks to perform a high-risk operation.",
    inputSchema: {
      type: "object",
      properties: {
        actionType: {
          type: "string",
          enum: [
            "send",
            "delete",
            "move",
            "archive",
            "mark_spam",
            "unsubscribe",
            "run_automation",
          ],
        },
        description: { type: "string" },
        emailId: { type: "string" },
        details: { type: "object" },
      },
      required: ["actionType", "description"],
      additionalProperties: false,
    },
    async handler(input: ToolInput, ctx: AgentToolContext) {
      const actionType = asString(input.actionType) as HighRiskActionType;
      const description = asString(input.description);
      if (!actionType || !description) {
        return { ok: false, error: "actionType and description are required" };
      }
      if (!isConfirmationRequiredAction(actionType)) {
        return {
          ok: false,
          error: `Unknown or directly executable action type: ${actionType}`,
        };
      }
      const emailId = asString(input.emailId) ?? asString(ctx.runContext?.emailId);
      const riskLevel = deriveRiskLevel(actionType);
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parameters = { actionType, description, emailId, details: input.details };
      const pendingAction: AgentPendingAction = {
        id,
        actionType,
        description,
        toolName: "propose_action",
        inputJson: JSON.stringify(parameters),
        riskReason: `${actionType} is a high-risk action that requires explicit user confirmation`,
        riskLevel,
        ...createPendingActionAuthorization(id, parameters),
      };
      // Persist the pending action for audit and user confirmation
      if (deps.pendingActionRepo) {
        deps.pendingActionRepo.insert({
          id: pendingAction.id,
          conversationId: ctx.sessionId,
          actionType,
          description,
          inputJson: pendingAction.inputJson,
          riskReason: pendingAction.riskReason,
          emailId: emailId ?? undefined,
          riskLevel,
          parameters: pendingAction.parameters,
          idempotencyKey: pendingAction.idempotencyKey,
          expiresAt: pendingAction.expiresAt,
        });
      }
      return { ok: true, pendingAction, executed: false };
    },
    observe: (output) => {
      const pending = (output as { pendingAction?: AgentPendingAction }).pendingAction;
      return pending
        ? `Proposed ${pending.actionType}: ${pending.description}`
        : "Action proposal failed";
    },
  };

  // ── Mail Curator manual trigger (Route C / WP J.8) ───────────────

  const runCurator: AgentTool | undefined =
    deps.curator && deps.getActiveAccountId
      ? {
          name: "run_curator",
          description:
            "Trigger an immediate Mail Curator run for the active account. Use this when the user asks to refresh their writing-style notes, rebuild sender summaries, or 'remember' something based on recent activity.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async handler() {
            const accountId = deps.getActiveAccountId?.();
            if (!accountId) {
              return { ok: false, error: "no active account" };
            }
            try {
              const result = await deps.curator!.triggerManual(accountId);
              if (!result) {
                return {
                  ok: true,
                  accountId,
                  ran: false,
                  note: "no curator runtime available for account",
                };
              }
              return {
                ok: true,
                accountId: result.accountId,
                reason: result.reason,
                summary: result.summary,
                ran: true,
              };
            } catch (err) {
              return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
          observe: (output) =>
            (output as { ran?: boolean }).ran
              ? "Curator run completed"
              : "Curator run skipped",
        }
      : undefined;

  const tools: AgentTool[] = [
    getCurrentTime,
    listMail,
    readMail,
    readMailSource,
    batchReadMailSource,
    searchMail,
    batchGetMailIntelligence,
    summarizeMail,
    getSummary,
    getTags,
    getReplyDecision,
    getIntelligenceState,
    triggerSummary,
    triggerTags,
    triggerReplyDecision,
    // P2.6: the allowance/invoice tools are edition-gated. The open edition
    // registers none of them, so "upload my invoices" requests have no tool
    // path at all and the agent answers from its generic prompt.
    ...(deps.allowanceToolsEnabled === true && deps.allowance
      ? [findInvoiceAttachments, proposeAllowanceInvoiceUpload, proposeAllowanceInvoiceDelete]
      : []),
    // P2.5: wecli_* tools are edition-gated. The open edition registers
    // none of them, so a "run an enterprise command" request has no tool
    // path at all and the agent answers from its (short) generic prompt.
    ...(deps.wecliToolsEnabled === true
      ? [wecliQuery, wecliHelp, wecliRun, proposeWecliCommand, wecliActionPreview]
      : []),
    getSuggestions,
    proposeAction,
  ];
  if (runCurator) tools.push(runCurator);
  return tools;
}
