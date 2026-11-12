import { createHash } from "node:crypto";
import type {
  ReplyDecisionResult,
  SummaryResult,
  TagResult,
  IntelligenceResult,
} from "../../../shared/wemail/intelligence.js";
import type { MailCoreMessageSummary } from "../../../shared/wemail/mailCoreProtocol.js";
import type {
  AgentSuggestion,
  AgentSuggestionResponse,
} from "../../../shared/wemail/usage.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import { stripStructuredJsonFence } from "../ai/StructuredJsonText.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import {
  NO_OP_OFFICE_SCENES,
  type OfficeScenePort,
} from "../intelligence/officeScenePort.js";

export const AGENT_HOME_MAX_CANDIDATES = 12;
export const AGENT_HOME_MAX_SUGGESTIONS = 3;
export const AGENT_HOME_REFRESH_DEBOUNCE_MS = 10_000;
export const AGENT_HOME_FAILURE_COOLDOWN_MS = 5 * 60_000;
const PROMPT_VERSION = "agent-home-suggestions-v1";

export type AgentHomeScoreReason =
  | "unread"
  | "action-required"
  | "pending-todo"
  | "deadline-24h"
  | "deadline-3d"
  | "important"
  | "repeated"
  | "recent"
  | "answered"
  | "todos-completed"
  | "marketing"
  | "notification";

export interface AgentHomeCandidate {
  emailId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  score: number;
  reasons: AgentHomeScoreReason[];
  summary?: string;
  actions: string[];
  deadline?: string;
  unread: boolean;
  answered: boolean;
  pendingTodoTitles: string[];
  category?: string;
  kind: "reply" | "todo" | "deadline" | "notification" | "review";
}

interface CacheEntry {
  fingerprint: string;
  suggestions: AgentSuggestion[];
}

export interface AgentHomeSuggestionServiceOptions {
  mailDatabase: MailDatabaseClient;
  llmRuntime?: LlmRuntime;
  now?: () => Date;
  logger?: {
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
  refreshDebounceMs?: number;
  /**
   * Edition-registered office-scene detector (P2 module seam). Absent = the
   * NO_OP port, which detects nothing, so no deterministic office
   * suggestions are emitted and the LLM/rule suggestion flow is unchanged.
   */
  officeSceneProvider?: OfficeScenePort;
}

export interface AgentHomeSuggestionRequest {
  accountId: string;
  timezone: string;
}

function safeTimezone(timezone: string): string {
  const candidate = timezone.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "UTC";
  }
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
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = zonedParts(date, timezone);
  const represented = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return represented - date.getTime();
}

function zonedLocalTimeToUtc(
  local: { year: number; month: number; day: number; hour?: number },
  timezone: string,
): Date {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    0,
    0,
  );
  const first = new Date(guess - timezoneOffsetMs(new Date(guess), timezone));
  return new Date(guess - timezoneOffsetMs(first, timezone));
}

export function localDayBounds(now: Date, requestedTimezone: string): {
  timezone: string;
  start: Date;
  end: Date;
  dateKey: string;
} {
  const timezone = safeTimezone(requestedTimezone);
  const local = zonedParts(now, timezone);
  const start = zonedLocalTimeToUtc(
    { year: local.year, month: local.month, day: local.day },
    timezone,
  );
  const nextLocal = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const end = zonedLocalTimeToUtc(
    {
      year: nextLocal.getUTCFullYear(),
      month: nextLocal.getUTCMonth() + 1,
      day: nextLocal.getUTCDate(),
    },
    timezone,
  );
  return {
    timezone,
    start,
    end,
    dateKey: `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`,
  };
}

function isInboxLike(message: MailCoreMessageSummary): boolean {
  const folder = message.folder.trim().toLowerCase();
  return !/(^|[\\/])(sent|drafts?|trash|deleted|spam|junk|archive)([\\/]|$)/i.test(folder);
}

function asSummary(value: unknown): SummaryResult | undefined {
  return value && typeof value === "object" && (value as { type?: string }).type === "summary"
    ? (value as SummaryResult)
    : undefined;
}

function asReplyDecision(value: unknown): ReplyDecisionResult | undefined {
  return value && typeof value === "object" && (value as { type?: string }).type === "replyDecision"
    ? (value as ReplyDecisionResult)
    : undefined;
}

function asTags(value: unknown): TagResult | undefined {
  return value && typeof value === "object" && (value as { type?: string }).type === "tags"
    ? (value as TagResult)
    : undefined;
}

function senderLabel(message: MailCoreMessageSummary): string {
  return message.from.name?.trim() || message.from.email.split("@")[0] || "邮件";
}

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/i, "")
    .replace(/[\s\[\]【】()（）_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function topicLabel(candidate: AgentHomeCandidate): string {
  const subject = candidate.subject
    .replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/i, "")
    .replace(/[【】\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = subject || candidate.sender;
  return label.length > 16 ? `${label.slice(0, 16)}…` : label;
}

interface HomeTodo {
  title: string;
  dueDate?: string;
  done: boolean;
}

interface HomeIntelligenceResults {
  summary?: IntelligenceResult;
  tags?: IntelligenceResult;
  replyDecision?: IntelligenceResult;
}

function deadlineFrom(
  decision: ReplyDecisionResult | undefined,
  todos: HomeTodo[],
): string | undefined {
  const values = [decision?.deadline, ...todos.map((todo) => todo.dueDate)]
    .filter((value): value is string => !!value)
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort();
  return values[0];
}

function summaryActions(summary: SummaryResult | undefined): string[] {
  return [...(summary?.actions ?? []), ...(summary?.actionItems ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function candidateKind(input: {
  pendingTodos: HomeTodo[];
  actionRequired: boolean;
  deadline?: string;
  category?: string;
}): AgentHomeCandidate["kind"] {
  if (input.deadline) return "deadline";
  if (input.pendingTodos.length > 0) return "todo";
  if (input.actionRequired) return "reply";
  if (["notification", "newsletter", "marketing"].includes(input.category ?? "")) {
    return "notification";
  }
  return "review";
}

export function scoreAgentHomeCandidates(input: {
  messages: MailCoreMessageSummary[];
  intelligenceByEmail: Map<string, HomeIntelligenceResults>;
  todosByEmail: Map<string, HomeTodo[]>;
  now: Date;
  dayStart: Date;
  dayEnd: Date;
}): AgentHomeCandidate[] {
  const repeatedSubjects = new Map<string, number>();
  for (const message of input.messages) {
    const key = normalizeSubject(message.subject);
    if (key) repeatedSubjects.set(key, (repeatedSubjects.get(key) ?? 0) + 1);
  }
  const daySpan = Math.max(1, input.dayEnd.getTime() - input.dayStart.getTime());

  return input.messages.map((message) => {
    const stored = input.intelligenceByEmail.get(message.id) ?? {};
    const summary = asSummary(stored.summary);
    const decision = asReplyDecision(stored.replyDecision);
    const tags = asTags(stored.tags);
    const todos = input.todosByEmail.get(message.id) ?? [];
    const pendingTodos = todos.filter((todo) => !todo.done);
    const category = tags?.classification?.categoryId;
    const actions = summaryActions(summary);
    const actionRequired =
      decision?.shouldReply === true ||
      decision?.replyRequired === true ||
      category === "action_required" ||
      actions.length > 0;
    const deadline = deadlineFrom(decision, pendingTodos);
    const reasons: AgentHomeScoreReason[] = [];
    let score = 0;
    if (!message.flags.seen) {
      score += 40;
      reasons.push("unread");
    }
    if (actionRequired) {
      score += 35;
      reasons.push("action-required");
    }
    if (pendingTodos.length > 0) {
      score += 30;
      reasons.push("pending-todo");
    }
    if (deadline) {
      const remaining = new Date(deadline).getTime() - input.now.getTime();
      if (remaining <= 24 * 60 * 60 * 1000) {
        score += 25;
        reasons.push("deadline-24h");
      } else if (remaining <= 3 * 24 * 60 * 60 * 1000) {
        score += 15;
        reasons.push("deadline-3d");
      }
    }
    if (message.flags.flagged || category === "important") {
      score += 10;
      reasons.push("important");
    }
    const normalizedSubject = normalizeSubject(message.subject);
    if (normalizedSubject && (repeatedSubjects.get(normalizedSubject) ?? 0) > 1) {
      score += 10;
      reasons.push("repeated");
    }
    const received = new Date(message.receivedAt).getTime();
    const recency = Math.max(
      0,
      Math.min(10, Math.round(((received - input.dayStart.getTime()) / daySpan) * 10)),
    );
    if (recency > 0) {
      score += recency;
      reasons.push("recent");
    }
    if (message.flags.answered) {
      score -= 35;
      reasons.push("answered");
    }
    if (todos.length > 0 && pendingTodos.length === 0) {
      score -= 40;
      reasons.push("todos-completed");
    }
    if (category === "marketing" || category === "newsletter") {
      score -= 25;
      reasons.push("marketing");
    } else if (category === "notification") {
      score -= 15;
      reasons.push("notification");
    }

    return {
      emailId: message.id,
      subject: message.subject,
      sender: senderLabel(message),
      receivedAt: message.receivedAt,
      score,
      reasons,
      ...(summary?.headline ? { summary: summary.headline } : {}),
      actions,
      ...(deadline ? { deadline } : {}),
      unread: !message.flags.seen,
      answered: message.flags.answered,
      pendingTodoTitles: pendingTodos.map((todo) => todo.title).slice(0, 5),
      ...(category ? { category } : {}),
      kind: candidateKind({ pendingTodos, actionRequired, deadline, category }),
    };
  }).sort((a, b) => b.score - a.score || b.receivedAt.localeCompare(a.receivedAt));
}

function suggestionForGroup(
  kind: AgentHomeCandidate["kind"],
  candidates: AgentHomeCandidate[],
  index: number,
): AgentSuggestion {
  const topics = [...new Set(candidates.map(topicLabel))].slice(0, 2);
  const topicText = topics.join(" 与 ");
  const label = kind === "deadline"
    ? `处理 ${topicText} 的临期事项`
    : kind === "todo"
      ? `跟进 ${topicText} 中的未完成待办`
      : kind === "reply"
        ? `处理今天尚未回复的 ${topicText}`
        : kind === "notification"
          ? `整理今天收到的 ${topicText}`
          : `查看今天需要优先处理的 ${topicText}`;
  const emailIds = candidates.map((candidate) => candidate.emailId);
  return {
    id: `home-${kind}-${index + 1}`,
    label,
    prompt: `${label}。请只处理推荐范围内的邮件，先汇总重点、待办和需要我确认的动作。`,
    emailIds,
    action: {
      type: "agent_prompt",
      prompt: `${label}。请只处理推荐范围内的邮件，先汇总重点、待办和需要我确认的动作。`,
    },
  };
}

/**
 * Deterministic office-scene suggestions, e.g. overdue alerts / release
 * finalize reminders / todo reminders / surveys / meetings (scene set is
 * owned by the registered {@link OfficeScenePort}). Zero LLM cost; emitted
 * as semantic `extracted` actions so they pass the home-panel filter and
 * hand off to the agent with the scene's confirmation-gated prompt.
 */
function buildOfficeHomeSuggestions(
  candidates: AgentHomeCandidate[],
  scenes: OfficeScenePort,
): AgentSuggestion[] {
  const suggestions: AgentSuggestion[] = [];
  for (const scene of scenes.actionableScenes()) {
    const group = candidates.filter(
      (candidate) => scenes.detect(candidate.subject, candidate.sender) === scene,
    );
    if (group.length === 0) continue;
    const meta = scenes.actionMeta(scene);
    if (!meta) continue;
    const emailIds = group.map((candidate) => candidate.emailId);
    const count = emailIds.length;
    suggestions.push({
      id: `office-${scene}`,
      label: count > 1 ? `处理 ${count} 个${meta.label}` : `处理${meta.label}`,
      prompt: meta.prompt,
      emailIds,
      kind: "extracted",
      discovery: { emailIds, primaryWindow: "24h", mailState: "unread" },
      executionScope: { mode: "fixed", emailIds },
    });
    if (suggestions.length >= AGENT_HOME_MAX_SUGGESTIONS) break;
  }
  return suggestions;
}

/** Office actions first (deterministic, always fresh), then the rest. */
function mergeOfficeFirst(
  office: AgentSuggestion[],
  rest: AgentSuggestion[],
): AgentSuggestion[] {
  const seen = new Set(office.map((suggestion) => suggestion.id));
  return [...office, ...rest.filter((suggestion) => !seen.has(suggestion.id))].slice(
    0,
    AGENT_HOME_MAX_SUGGESTIONS,
  );
}

export function buildRuleHomeSuggestions(
  candidates: AgentHomeCandidate[],
): AgentSuggestion[] {
  const positive = candidates.filter((candidate) => candidate.score > 0);
  const groups = new Map<AgentHomeCandidate["kind"], AgentHomeCandidate[]>();
  for (const candidate of positive) {
    const existing = groups.get(candidate.kind) ?? [];
    existing.push(candidate);
    groups.set(candidate.kind, existing);
  }
  return [...groups.entries()]
    .sort(([, left], [, right]) => right[0].score - left[0].score)
    .slice(0, AGENT_HOME_MAX_SUGGESTIONS)
    .map(([kind, group], index) => suggestionForGroup(kind, group.slice(0, 6), index));
}

export function agentHomeCandidateFingerprint(input: {
  accountId: string;
  dateKey: string;
  candidates: AgentHomeCandidate[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: PROMPT_VERSION,
      accountId: input.accountId,
      dateKey: input.dateKey,
      candidates: input.candidates.map((candidate) => ({
        id: candidate.emailId,
        score: candidate.score,
        reasons: candidate.reasons,
        subject: candidate.subject,
        summary: candidate.summary,
        actions: candidate.actions,
        deadline: candidate.deadline,
        pendingTodos: candidate.pendingTodoTitles,
      })),
    }))
    .digest("hex");
}

function fallbackSuggestions(accountId: string): AgentSuggestion[] {
  return [
    {
      id: "review-unread",
      label: "查看未读邮件",
      prompt: `查看账户 ${accountId} 的未读邮件并按重要程度排序。`,
    },
    {
      id: "show-todos",
      label: "查看未完成的邮件待办",
      prompt: `显示账户 ${accountId} 当前未完成的邮件待办。`,
    },
    {
      id: "search-important",
      label: "搜索最近的重要邮件",
      prompt: `搜索账户 ${accountId} 最近的重要邮件。`,
    },
  ];
}

function parseAiSuggestions(
  raw: string,
  allowedIds: Set<string>,
): AgentSuggestion[] {
  const cleaned = stripStructuredJsonFence(raw).trim();
  const parsed = JSON.parse(cleaned) as { suggestions?: unknown };
  if (!Array.isArray(parsed.suggestions)) return [];
  const seen = new Set<string>();
  const result: AgentSuggestion[] = [];
  for (const [index, value] of parsed.suggestions.entries()) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    const emailIds = Array.isArray(item.emailIds)
      ? [...new Set(item.emailIds.filter((id): id is string => typeof id === "string" && allowedIds.has(id)))]
      : [];
    const key = label.toLowerCase();
    if (!label || !prompt || emailIds.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `home-ai-${index + 1}`,
      label: label.slice(0, 48),
      prompt,
      emailIds,
      action: { type: "agent_prompt", prompt },
    });
    if (result.length >= AGENT_HOME_MAX_SUGGESTIONS) break;
  }
  return result;
}

export class AgentHomeSuggestionService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly lastRefreshAt = new Map<string, number>();
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  private readonly failedAt = new Map<string, number>();
  private readonly officeScenes: OfficeScenePort;

  constructor(private readonly options: AgentHomeSuggestionServiceOptions) {
    this.officeScenes = options.officeSceneProvider ?? NO_OP_OFFICE_SCENES;
  }

  async getSuggestions(request: AgentHomeSuggestionRequest): Promise<AgentSuggestionResponse> {
    const now = this.options.now?.() ?? new Date();
    const bounds = localDayBounds(now, request.timezone);
    const page = await this.options.mailDatabase.search({
      accountId: request.accountId,
      dateFrom: bounds.start.toISOString(),
      dateTo: new Date(bounds.end.getTime() - 1).toISOString(),
      limit: 100,
    });
    const messages = page.messages.filter(isInboxLike);
    const emailIds = messages.map((message) => message.id);
    const states = await Promise.all(
      emailIds.map((emailId) =>
        this.options.mailDatabase.getIntelligenceState(emailId),
      ),
    );
    const intelligenceByEmail = new Map<string, HomeIntelligenceResults>();
    const todosByEmail = new Map<string, HomeTodo[]>();
    for (const state of states) {
      intelligenceByEmail.set(state.emailId, {
        ...(state.summary.result ? { summary: state.summary.result } : {}),
        ...(state.tags.result ? { tags: state.tags.result } : {}),
        ...(state.replyDecision.result
          ? { replyDecision: state.replyDecision.result }
          : {}),
      });
      todosByEmail.set(
        state.emailId,
        (state.todoExtraction?.result?.todos ?? []).map((todo) => ({
          title: todo.title,
          ...(todo.dueDate ? { dueDate: todo.dueDate } : {}),
          done: false,
        })),
      );
    }
    const scoredCandidates = scoreAgentHomeCandidates({
      messages,
      intelligenceByEmail,
      todosByEmail,
      now,
      dayStart: bounds.start,
      dayEnd: bounds.end,
    });
    const eligibleCount = scoredCandidates.filter((candidate) => candidate.score > 0).length;
    const candidates = scoredCandidates
      .filter((candidate) => candidate.score > 0)
      .slice(0, AGENT_HOME_MAX_CANDIDATES);
    // Office actions are high-value and deterministic; detect them on the
    // full scored set (not just score>0) so notification-docked system mail
    // still surfaces without waiting for the LLM refresh. Without a
    // registered scene port this is always empty.
    const officeSuggestions = buildOfficeHomeSuggestions(
      scoredCandidates,
      this.officeScenes,
    );
    const fingerprint = agentHomeCandidateFingerprint({
      accountId: request.accountId,
      dateKey: bounds.dateKey,
      candidates,
    });
    const cached = this.cache.get(request.accountId);
    const contextLine = messages.length === 0
      ? "今天还没有收到新邮件。"
      : `今天有 ${messages.length} 封新邮件，其中 ${eligibleCount} 封建议优先处理。`;
    if (cached?.fingerprint === fingerprint) {
      return {
        suggestions: mergeOfficeFirst(officeSuggestions, cached.suggestions),
        contextLine,
        source: "cached-ai",
        candidateFingerprint: fingerprint,
        refreshPending: false,
      };
    }
    const rules = buildRuleHomeSuggestions(candidates);
    const baseSuggestions = rules.length > 0 ? rules : fallbackSuggestions(request.accountId);
    const suggestions = mergeOfficeFirst(officeSuggestions, baseSuggestions);
    const failedRecently = Date.now() - (this.failedAt.get(fingerprint) ?? 0) < AGENT_HOME_FAILURE_COOLDOWN_MS;
    const refreshPending =
      candidates.length > 0 &&
      !!this.options.llmRuntime?.snapshot().client &&
      !failedRecently;
    if (refreshPending) {
      this.scheduleRefresh(request.accountId, fingerprint, candidates);
    }
    return {
      suggestions,
      contextLine,
      source: "rules",
      candidateFingerprint: fingerprint,
      refreshPending,
    };
  }

  private scheduleRefresh(
    accountId: string,
    fingerprint: string,
    candidates: AgentHomeCandidate[],
  ): void {
    if (this.inflight.has(fingerprint) || this.scheduled.has(fingerprint)) return;
    const debounceMs = this.options.refreshDebounceMs ?? AGENT_HOME_REFRESH_DEBOUNCE_MS;
    const elapsed = Date.now() - (this.lastRefreshAt.get(accountId) ?? 0);
    const delay = Math.max(0, debounceMs - elapsed);
    if (delay === 0) {
      this.startRefresh(accountId, fingerprint, candidates);
      return;
    }
    const timer = setTimeout(() => {
      this.scheduled.delete(fingerprint);
      this.startRefresh(accountId, fingerprint, candidates);
    }, delay);
    timer.unref?.();
    this.scheduled.set(fingerprint, timer);
  }

  private startRefresh(
    accountId: string,
    fingerprint: string,
    candidates: AgentHomeCandidate[],
  ): void {
    if (this.inflight.has(fingerprint)) return;
    this.lastRefreshAt.set(accountId, Date.now());
    const task = this.generateAiSuggestions(candidates)
      .then((suggestions) => {
        if (suggestions.length > 0) {
          this.failedAt.delete(fingerprint);
          this.cache.set(accountId, { fingerprint, suggestions });
        } else {
          this.failedAt.set(fingerprint, Date.now());
        }
      })
      .catch((error) => {
        this.failedAt.set(fingerprint, Date.now());
        this.options.logger?.warn?.("agent.home-suggestions.generate-failed", {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.inflight.delete(fingerprint));
    this.inflight.set(fingerprint, task);
  }

  private async generateAiSuggestions(
    candidates: AgentHomeCandidate[],
  ): Promise<AgentSuggestion[]> {
    const snapshot = this.options.llmRuntime?.snapshot();
    const llm = snapshot?.client;
    if (!llm) return [];
    const bounded = candidates.slice(0, AGENT_HOME_MAX_CANDIDATES);
    const response = await llm.generate({
      model: snapshot?.modelFor("agent") ?? "default",
      system: [
        "You generate concise Chinese suggested prompts for an email assistant home screen.",
        "Group related messages into at most three executable user intents.",
        "Prioritize higher scores and unfinished work. Keep labels natural and specific, not feature names.",
        "Every emailIds value must come from the provided candidates. Return JSON only.",
      ].join(" "),
      messages: [{
        role: "user",
        content: JSON.stringify({
          candidates: bounded.map((candidate) => ({
            emailId: candidate.emailId,
            subject: candidate.subject,
            sender: candidate.sender,
            summary: candidate.summary,
            actions: candidate.actions,
            deadline: candidate.deadline,
            unread: candidate.unread,
            answered: candidate.answered,
            pendingTodos: candidate.pendingTodoTitles,
            score: candidate.score,
            reasons: candidate.reasons,
            category: candidate.category,
          })),
        }),
      }],
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 8_000,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["suggestions"],
        properties: {
          suggestions: {
            type: "array",
            maxItems: AGENT_HOME_MAX_SUGGESTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "prompt", "emailIds"],
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                prompt: { type: "string" },
                emailIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    });
    return parseAiSuggestions(
      response.text,
      new Set(bounded.map((candidate) => candidate.emailId)),
    );
  }
}
