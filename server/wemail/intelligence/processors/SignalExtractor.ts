/**
 * Signal extraction for the priority-aware reply decision processor.
 *
 * Signals are deterministic, rule-derived values computed from stored mail
 * inputs BEFORE the LLM call. They provide explainability and ensure
 * deterministic output for identical inputs + prompt version.
 *
 * Signal weights are fixed constants — not learned — so the same input
 * always produces the same signals.
 */

import type { WemailAddress } from "../../../../shared/wemail/mail.js";
import type { SystemCategoryId } from "../../../../shared/wemail/intelligence.js";

/* ---------------------------------------------------------------- *
 * Types                                                            *
 * ---------------------------------------------------------------- */

export interface PrioritySignal {
  name: string;
  value: string;
  /** Weight in [0, 1] indicating influence on priority. */
  weight: number;
}

export interface SignalExtractionInput {
  subject?: string;
  from?: WemailAddress | string;
  to?: WemailAddress[];
  cc?: WemailAddress[];
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** Tags already computed by the TagProcessor, if available. */
  tags?: string[];
  /**
   * System classification category from the TagProcessor's
   * ClassificationResult, if available. Takes precedence over
   * tag-based category detection.
   */
  classificationCategoryId?: SystemCategoryId;
  /** Whether the sender has been replied to before (heuristic). */
  hasRepliedBefore?: boolean;
  /** User's email address, used to determine direct addressing. */
  userEmail?: string;
}

/* ---------------------------------------------------------------- *
 * Constants                                                        *
 * ---------------------------------------------------------------- */

/**
 * System categories that strongly suggest bulk/newsletter/marketing.
 * Mail in these categories defaults to low priority unless strong
 * contrary evidence exists.
 */
const BULK_CATEGORY_SIGNALS = [
  "通知",        // notification
  "发布",        // announcement / broadcast
  "日报",        // daily digest
] as const;

/**
 * Regex patterns for detecting questions in the message body.
 * Covers English and Chinese question markers.
 * No /g flag: creates fresh regex per call to avoid stateful lastIndex.
 */
const QUESTION_PATTERNS = [
  /\?/,
  /？/,
  /\b(please|can you|could you|would you|will you|do you|are you|is there|how|what|when|where|who|why)\b/i,
  /(请问|帮忙|能否|可以|是否|什么时候|怎么|如何|为什么)/,
] as const;

/**
 * Regex patterns for deadline/time expressions.
 * Captures both explicit dates and relative time expressions.
 * No /g flag: creates fresh regex per call to avoid stateful lastIndex.
 */
const DEADLINE_PATTERNS = [
  /\b(by|before|no later than|due|deadline|until)\s+(?:the\s+)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:end of |this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|quarter|year)|(?:today|tomorrow|tonight|eod|cob|5pm|5:00pm|close of business|end of day))/i,
  /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/,
  /(之前|之前|截止|截止日期|期限|到期|以前)/,
  /(今天|明天|本周|下周|本月底|下月底|本季度末|下季度末)/,
] as const;

/**
 * Sender patterns that indicate automated / noreply senders.
 */
const NOREPLY_PATTERNS = [
  /^(noreply|no-reply|notification|donotreply|donot-reply|mailer-daemon|postmaster|notifications|alert|automated|system|admin|info)@/i,
] as const;

/**
 * Known newsletter / marketing sender domains.
 */
const NEWSLETTER_DOMAINS = new Set([
  "mailchimp.com",
  "sendgrid.net",
  "mailchimpapp.net",
  "mcsv.net",
  "hubspot.com",
  "hubspotemail.net",
  "convertkit-mail.com",
  "convertkit.com",
  "substack.com",
  "beehiiv.com",
  "buttondown.email",
  "aweber.com",
  "getresponse.com",
  "campaign-archive.com",
  "medium.com",
  "linkedin.com",
  "mailer.linkedin.com",
]);

/* ---------------------------------------------------------------- *
 * Signal extractors (pure functions)                               *
 * ---------------------------------------------------------------- */

/**
 * Extract sender signal: automated/noreply vs personal.
 * Weight: high (0.3) because sender identity is the strongest single signal.
 */
function extractSenderSignal(input: SignalExtractionInput): PrioritySignal {
  const from = input.from;
  const emailStr = typeof from === "string"
    ? from
    : from?.email ?? "";

  for (const pattern of NOREPLY_PATTERNS) {
    if (pattern.test(emailStr)) {
      return { name: "sender", value: "automated", weight: 0.3 };
    }
  }

  const domain = emailStr.split("@")[1]?.toLowerCase() ?? "";
  if (NEWSLETTER_DOMAINS.has(domain)) {
    return { name: "sender", value: "newsletter", weight: 0.3 };
  }

  return { name: "sender", value: "personal", weight: 0.3 };
}

/**
 * Extract question signal: whether the message contains questions.
 * Weight: medium (0.2) because questions strongly suggest reply needed.
 */
function extractQuestionSignal(input: SignalExtractionInput): PrioritySignal {
  const body = [input.bodyText ?? "", input.snippet ?? ""].join(" ");
  const subject = input.subject ?? "";
  const combined = `${subject} ${body}`;

  let questionCount = 0;
  // Use test() with non-global regex — fresh each call, no state leakage
  for (const pattern of QUESTION_PATTERNS) {
    // Clone pattern to avoid lastIndex issues
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(combined)) questionCount++;
  }

  if (questionCount >= 3) {
    return { name: "questions", value: "many", weight: 0.2 };
  }
  if (questionCount >= 1) {
    return { name: "questions", value: "present", weight: 0.2 };
  }
  return { name: "questions", value: "none", weight: 0.2 };
}

/**
 * Extract deadline signal: whether the message mentions a deadline or time pressure.
 * Weight: high (0.25) because deadlines directly drive priority.
 */
function extractDeadlineSignal(input: SignalExtractionInput): PrioritySignal {
  const body = [input.bodyText ?? "", input.snippet ?? ""].join(" ");
  const subject = input.subject ?? "";
  const combined = `${subject} ${body}`;

  for (const pattern of DEADLINE_PATTERNS) {
    // Clone pattern to avoid stateful lastIndex issues
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(combined)) {
      return { name: "deadline", value: "present", weight: 0.25 };
    }
  }

  return { name: "deadline", value: "none", weight: 0.25 };
}

/**
 * Extract directness signal: is the user directly addressed (To) vs CC'd.
 * Weight: medium (0.15) because direct addressing implies higher obligation.
 */
function extractDirectnessSignal(input: SignalExtractionInput): PrioritySignal {
  const userEmail = input.userEmail;
  const toList = input.to ?? [];
  const ccList = input.cc ?? [];

  if (!userEmail) {
    // Without user email, use recipient count as proxy
    const totalRecipients = toList.length + ccList.length;
    if (totalRecipients <= 2) {
      return { name: "direct", value: "direct", weight: 0.15 };
    }
    if (totalRecipients <= 5) {
      return { name: "direct", value: "small-group", weight: 0.15 };
    }
    return { name: "direct", value: "broadcast", weight: 0.15 };
  }

  const isInTo = toList.some(
    (addr) => (typeof addr === "string" ? addr : addr.email)?.toLowerCase() === userEmail.toLowerCase(),
  );
  const isInCc = ccList.some(
    (addr) => (typeof addr === "string" ? addr : addr.email)?.toLowerCase() === userEmail.toLowerCase(),
  );

  if (isInTo) {
    return { name: "direct", value: "direct", weight: 0.15 };
  }
  if (isInCc) {
    return { name: "direct", value: "cc", weight: 0.15 };
  }
  return { name: "direct", value: "bcc-or-list", weight: 0.15 };
}

/**
 * Extract reply-history signal: whether the user has replied to this sender before.
 * Weight: low (0.05) because past behavior is a weak predictor of current need.
 */
function extractReplyHistorySignal(input: SignalExtractionInput): PrioritySignal {
  if (input.hasRepliedBefore) {
    return { name: "reply-history", value: "has-replied", weight: 0.05 };
  }
  return { name: "reply-history", value: "no-history", weight: 0.05 };
}

/**
 * Extract system-category signal from tags already computed by TagProcessor,
 * or from the classification category if available.
 * Weight: medium (0.15) because tag categories strongly indicate mail type.
 */
function extractSystemCategorySignal(input: SignalExtractionInput): PrioritySignal {
  // Prefer the explicit classification category when available
  if (input.classificationCategoryId) {
    return { name: "system-category", value: input.classificationCategoryId, weight: 0.15 };
  }

  const tags = input.tags ?? [];

  for (const bulkTag of BULK_CATEGORY_SIGNALS) {
    if (tags.includes(bulkTag)) {
      return { name: "system-category", value: bulkTag, weight: 0.15 };
    }
  }

  // Check for tags that imply action needed
  const actionTags = ["待回复", "审批", "需求"];
  for (const actionTag of actionTags) {
    if (tags.includes(actionTag)) {
      return { name: "system-category", value: actionTag, weight: 0.15 };
    }
  }

  if (tags.length > 0) {
    return { name: "system-category", value: "other", weight: 0.15 };
  }

  return { name: "system-category", value: "untagged", weight: 0.15 };
}

/* ---------------------------------------------------------------- *
 * Public API                                                       *
 * ---------------------------------------------------------------- */

/**
 * Extract all priority signals from the given mail input.
 *
 * Signals are computed deterministically from stored inputs — no LLM
 * involved. Same inputs + same code version = same signals.
 *
 * @returns Array of signals with name, value, and weight.
 */
export function extractSignals(input: SignalExtractionInput): PrioritySignal[] {
  return [
    extractSenderSignal(input),
    extractQuestionSignal(input),
    extractDeadlineSignal(input),
    extractDirectnessSignal(input),
    extractReplyHistorySignal(input),
    extractSystemCategorySignal(input),
  ];
}

/**
 * Compute a deterministic priority score from extracted signals.
 *
 * The scoring formula is:
 *   base = 0.5 (neutral)
 *   For each signal, adjust the score by its weighted contribution.
 *   Clamp to [0, 1].
 *
 * Key rules:
 *   - Automated/noreply/newsletter senders strongly push score down.
 *   - Bulk category tags push score down.
 *   - Direct addressing + questions + deadlines push score up.
 *   - CC-only addressing pushes score down.
 */
export function computePriorityScore(signals: PrioritySignal[]): number {
  let score = 0.5; // neutral baseline

  for (const signal of signals) {
    switch (signal.name) {
      case "sender": {
        if (signal.value === "automated" || signal.value === "newsletter") {
          score -= signal.weight * 1.5; // strong negative
        } else if (signal.value === "personal") {
          score += signal.weight * 0.5;
        }
        break;
      }
      case "questions": {
        if (signal.value === "many") {
          score += signal.weight * 1.0;
        } else if (signal.value === "present") {
          score += signal.weight * 0.6;
        }
        break;
      }
      case "deadline": {
        if (signal.value === "present") {
          score += signal.weight * 1.2; // strong positive
        }
        break;
      }
      case "direct": {
        if (signal.value === "direct") {
          score += signal.weight * 0.8;
        } else if (signal.value === "cc") {
          score -= signal.weight * 0.7;
        } else if (signal.value === "broadcast") {
          score -= signal.weight * 0.8;
        }
        break;
      }
      case "reply-history": {
        if (signal.value === "has-replied") {
          score += signal.weight * 0.5;
        }
        break;
      }
      case "system-category": {
        // Bulk/newsletter/marketing categories push score down strongly
        if (BULK_CATEGORY_SIGNALS.includes(signal.value as any)) {
          score -= signal.weight * 1.0; // strong negative for bulk
        } else if (["newsletter", "marketing", "receipt", "notification"].includes(signal.value)) {
          score -= signal.weight * 1.0; // strong negative for SystemCategoryId bulk types
        } else if (signal.value === "待回复" || signal.value === "审批" || signal.value === "需求") {
          score += signal.weight * 0.8;
        } else if (signal.value === "action_required" || signal.value === "important") {
          score += signal.weight * 1.0; // strong positive for action/important
        } else if (signal.value === "personal") {
          score += signal.weight * 0.3; // mild positive
        }
        break;
      }
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Derive the priority level from the numeric score.
 *
 *   low    = score < 0.35
 *   normal = 0.35 <= score < 0.7
 *   high   = score >= 0.7
 */
export function deriveLevel(score: number): "low" | "normal" | "high" {
  if (score < 0.35) return "low";
  if (score < 0.7) return "normal";
  return "high";
}

/**
 * Attempt to extract a deadline date string from the message body.
 * Returns an ISO-8601 date string if a clear deadline is found,
 * or undefined if no deadline is detected.
 */
export function extractDeadlineDate(input: SignalExtractionInput): string | undefined {
  const body = [input.bodyText ?? "", input.snippet ?? ""].join(" ");
  const subject = input.subject ?? "";
  const combined = `${subject} ${body}`;

  // Look for explicit date patterns like YYYY-MM-DD or YYYY/MM/DD
  const isoPattern = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/g;
  let match: RegExpExecArray | null;
  while ((match = isoPattern.exec(combined)) !== null) {
    const year = parseInt(match[1]!, 10);
    const month = parseInt(match[2]!, 10);
    const day = parseInt(match[3]!, 10);
    if (year >= 2020 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      // Check context: is this near a deadline keyword?
      const contextStart = Math.max(0, match.index - 50);
      const contextEnd = Math.min(combined.length, match.index + match[0].length + 50);
      const context = combined.slice(contextStart, contextEnd).toLowerCase();
      if (/\b(by|before|due|deadline|until|no later|之前|截止|期限)\b/.test(context)) {
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        return dateStr;
      }
    }
  }

  // Check for relative time expressions with deadline keywords
  if (/\b(by|before|due|deadline)\s+(today|tomorrow|tonight|eod|cob)\b/i.test(combined)) {
    // Return a sentinel that the caller can resolve relative to now
    return undefined; // relative dates need runtime resolution; not stored deterministically
  }

  return undefined;
}

/**
 * Determine whether a reply is required based on signals and the LLM's
 * shouldReply decision.
 *
 * Rules:
 *   - If shouldReply=false, replyRequired is always false.
 *   - If shouldReply=true and level=low, replyRequired=false (low priority
 *     means "nice to reply" but not required).
 *   - If shouldReply=true and level>=normal, replyRequired=true.
 *   - Direct requests with deadlines always set replyRequired=true.
 */
export function deriveReplyRequired(
  shouldReply: boolean,
  level: "low" | "normal" | "high",
  signals: PrioritySignal[],
): boolean {
  if (!shouldReply) return false;

  // Even if shouldReply=true, low priority means reply is not required
  if (level === "low") return false;

  // Direct request with deadline is always required
  const hasDeadline = signals.some((s) => s.name === "deadline" && s.value === "present");
  const isDirect = signals.some((s) => s.name === "direct" && s.value === "direct");
  if (hasDeadline && isDirect) return true;

  return true;
}

/**
 * Re-export constants for testing.
 */
export { BULK_CATEGORY_SIGNALS, NOREPLY_PATTERNS, NEWSLETTER_DOMAINS };
