/**
 * State-aware suggestion builder for the PI agent (ai-agent-task-assistant).
 *
 * Derives contextual suggestions from the current intelligence state of
 * a focused email. Suggestions are ordered by priority so the most
 * important next step appears first.
 *
 * Rules:
 *   - Edition-contributed business workflows (for example the allowance
 *     invoice upload, injected via the allowance module's
 *     `buildUploadSuggestion`) win first
 *   - Focused-mail action analysis stays separate from summary and link extraction
 *   - Fallback AI capabilities fill only when no stronger action exists
 *   - Account context without email -> no suggestions; home actions come from
 *     AgentHomeActionService
 */

import type {
  AgentSuggestionItem,
  EmailIntelligenceState,
} from "../../../shared/wemail/intelligence.js";
import {
  resolveAllowanceModules,
  type EditionAllowanceModules,
} from "./allowancePort.js";
export interface SuggestionContext {
  /** Current intelligence state for the focused email, if any. */
  intelligenceState?: EmailIntelligenceState;
  /** Mail envelope and attachment metadata for the focused email, if available. */
  envelope?: SuggestionEnvelope | null;
  /** Whether the account has a focused email. */
  hasEmailContext: boolean;
  /** The email id for email-scoped suggestions. */
  emailId?: string;
  /** The account id for account-scoped suggestions. */
  accountId?: string;
  /**
   * P2.6 test/edition override for the assembled allowance module. Omitting
   * it resolves the build-time registration (open default: absent, so no
   * edition-contributed suggestion ever fires).
   */
  allowanceModules?: EditionAllowanceModules | null;
}

export interface SuggestionEnvelope {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  folder: string;
  language?: string;
  attachments?: Array<{
    id?: string;
    filename?: string;
    mimetype?: string;
  }>;
}

interface SuggestionCandidate extends AgentSuggestionItem {
  confidence: number;
  source: "built-in" | "fallback";
}

const MAX_SUGGESTIONS = 3;
const DEFAULT_FALLBACK_LIMIT = 3;

/**
 * Detect whether an email appears to be in a foreign language
 * based on the intelligence state. A mail is "foreign-language"
 * if it has no translation result but translation status is
 * not "not-needed" (i.e. translation was either skipped or not
 * attempted, and the language might differ from user's profile).
 *
 * For simplicity, we treat any email without a translation as
 * potentially foreign-language if the summary exists (so we know
 * the mail was processed) but no translation was generated.
 */
function isForeignLanguageWithoutTranslation(
  state: EmailIntelligenceState,
): boolean {
  if (!state.translation) return false;
  // If translation has no result and it wasn't explicitly skipped
  if (
    state.translation.status !== "succeeded" &&
    state.translation.status !== "skipped" &&
    !state.translation.result
  ) {
    // Only suggest if the mail was actually processed (has at least a summary)
    return state.summary.status === "succeeded";
  }
  return false;
}

function hasTodos(state: EmailIntelligenceState): boolean {
  return (
    state.todoExtraction?.status === "succeeded" &&
    !!state.todoExtraction.result &&
    state.todoExtraction.result.todos.length > 0
  );
}

function needsReplyDraft(state: EmailIntelligenceState): boolean {
  const replyRequired =
    state.replyDecision.result?.replyRequired === true ||
    state.replyDecision.result?.shouldReply === true;
  const hasNoDraft =
    state.replyDraft.status !== "succeeded" || !state.replyDraft.result;
  return replyRequired && hasNoDraft;
}

function collectBuiltInCandidates(ctx: SuggestionContext): SuggestionCandidate[] {
  if (!ctx.emailId) return [];
  // P2.6 round 8: the invoice-upload suggestion (its invoice-text
  // heuristics and its copy) is contributed by the edition module. The
  // open edition registers no contributor and proposes nothing
  // invoice-specific; the fallback AI suggestions below still fill.
  const modules = ctx.allowanceModules ?? resolveAllowanceModules();
  const summary = ctx.intelligenceState?.summary.result;
  const contribution = modules?.buildUploadSuggestion?.({
    emailId: ctx.emailId,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    summary: summary
      ? {
          intent: summary.intent,
          headline: summary.headline,
          bullets: summary.bullets,
        }
      : null,
    envelope: ctx.envelope
      ? {
          subject: ctx.envelope.subject,
          snippet: ctx.envelope.snippet,
          from: ctx.envelope.from,
          attachments: ctx.envelope.attachments,
        }
      : null,
  });
  if (!contribution) return [];
  return [{ ...contribution, source: "built-in" }];
}


function collectFallbackCandidates(ctx: SuggestionContext): SuggestionCandidate[] {
  const state = ctx.intelligenceState;
  if (!state || !ctx.emailId) return [];
  const suggestions: SuggestionCandidate[] = [{
    id: "analyze-next-step",
    label: "给出下一步建议",
    prompt:
      "分析当前邮件内容，从帮助我推进工作的角度给出最值得执行的下一步。" +
      "不要把邮件链接的标题直接当作行动建议；链接只作为执行入口引用。",
    reason: "analyze-next-step",
    priority: 4,
    confidence: 0.8,
    source: "fallback",
  }];

  if (needsReplyDraft(state)) {
    suggestions.push({
      id: "suggest-draft",
      label: "起草回复",
      prompt: "基于当前邮件帮我起草一封简洁回复，等待我确认后再发送。",
      reason: "reply-needed-no-draft",
      priority: 3,
      confidence: 0.75,
      source: "fallback",
    });
  }

  if (!hasTodos(state)) {
    suggestions.push({
      id: "suggest-todos",
      label: "提取待办",
      prompt: "从当前邮件中提取需要跟进的待办事项。",
      reason: "no-todos",
      priority: 2,
      confidence: 0.72,
      source: "fallback",
    });
  }

  if (isForeignLanguageWithoutTranslation(state)) {
    suggestions.push({
      id: "suggest-translation",
      label: "翻译",
      prompt: "把当前邮件翻译成我的首选语言。",
      reason: "foreign-language-no-translation",
      priority: 1,
      confidence: 0.68,
      source: "fallback",
    });
  }

  if (state.summary.status !== "succeeded" || !state.summary.result) {
    suggestions.push({
      id: "suggest-summary",
      label: "总结",
      prompt: "总结这封邮件，列出重点和风险。",
      reason: "no-summary",
      priority: 1,
      confidence: 0.65,
      source: "fallback",
    });
  } else {
    suggestions.push({
      id: "fallback-summary",
      label: "总结",
      prompt: "总结这封邮件，列出重点和风险。",
      reason: "fallback-summary",
      priority: 0,
      confidence: 0.55,
      source: "fallback",
    });
  }

  return suggestions;
}

function uniqueCandidates(candidates: SuggestionCandidate[]): SuggestionCandidate[] {
  const seen = new Set<string>();
  const result: SuggestionCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function ranked(candidates: SuggestionCandidate[]): SuggestionCandidate[] {
  return uniqueCandidates(candidates).sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.confidence - a.confidence;
  });
}

/**
 * Build state-aware suggestions based on current intelligence context.
 * Returns suggestions ordered by descending priority.
 */
export function buildSuggestions(ctx: SuggestionContext): AgentSuggestionItem[] {
  // Home actions are discovered separately from unread inbox mail.
  if (!ctx.hasEmailContext) {
    return [];
  }

  const state = ctx.intelligenceState;
  if (!state || !ctx.emailId) {
    return [];
  }

  const candidates = ranked([
    ...collectBuiltInCandidates(ctx),
    ...collectFallbackCandidates(ctx),
  ]);
  return candidates.slice(
    0,
    candidates.some((candidate) => candidate.source !== "fallback")
      ? MAX_SUGGESTIONS
      : DEFAULT_FALLBACK_LIMIT,
  );
}
