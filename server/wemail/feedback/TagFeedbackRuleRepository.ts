import { randomUUID } from "node:crypto";
import type { TagResult } from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { MailDatabase } from "../database/Database.js";
import type { WorkspaceFeedbackSink } from "../workspace/WorkspaceFeedbackSink.js";

/**
 * Subject-prefix length used for `reject` rule matching. Handoff / design
 * doc explicitly calls this out as a scoping knob; 32 is the phase-one
 * default. We fold case + collapse whitespace before the cut so
 * `Daily build #12 ` and `daily build #12` match the same rule.
 */
export const SUBJECT_PREFIX_LENGTH = 32;

/**
 * Rule action. Phase one only uses `reject`. `promote` is reserved and
 * accepted by storage for forward-compat but not emitted by the UI.
 */
export type RuleAction = "reject" | "promote";

export interface TagFeedbackRule {
  id: string;
  accountId: string;
  tag: string;
  senderPattern?: string;
  subjectPattern?: string;
  action: RuleAction;
  reason?: string;
  createdAt: string;
}

export interface AddRejectionInput {
  accountId: string;
  tagName: string;
  senderPattern?: string;
  subjectPattern?: string;
  reason?: string;
}

interface Row {
  id: string;
  account_id: string;
  tag: string;
  sender_pattern: string | null;
  subject_pattern: string | null;
  action: string;
  reason: string | null;
  created_at: string;
}

const RULE_SELECT = `SELECT rules.public_id AS id,
  accounts.public_id AS account_id, tags.name AS tag,
  rules.sender_pattern_norm AS sender_pattern,
  rules.subject_prefix_norm AS subject_pattern,
  rules.action, rules.reason,
  datetime(rules.created_at_ms / 1000, 'unixepoch') AS created_at
  FROM mail_tag_feedback_rules rules
  JOIN mail_accounts accounts ON accounts.id = rules.account_id
  JOIN mail_user_tags tags ON tags.id = rules.tag_id`;

function rowToRule(row: Row): TagFeedbackRule {
  return {
    id: row.id,
    accountId: row.account_id,
    tag: row.tag,
    senderPattern: row.sender_pattern || undefined,
    subjectPattern: row.subject_pattern || undefined,
    action: row.action === "promote" ? "promote" : "reject",
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Normalize a subject for prefix comparison. We lowercase, collapse
 * whitespace, and trim so small editorial differences don't defeat the
 * match. We intentionally do NOT remove punctuation — "Re: foo" vs "foo"
 * is a meaningful distinction in phase one.
 */
export function normalizeSubject(subject: string | undefined): string {
  return (subject ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function deriveSubjectPattern(subject: string | undefined): string {
  return normalizeSubject(subject).slice(0, SUBJECT_PREFIX_LENGTH);
}

/**
 * Phase-one sender pattern is the exact email (canonical-cased). We
 * deliberately avoid domain-only matching — tagging rules are scoped to
 * a single sender so one noisy correspondent cannot suppress a tag
 * across their whole domain. This is called out in the subagent brief
 * under "scoped to avoid over-eager cross-mail generalization".
 */
export function deriveSenderPattern(
  from: MailMessage["from"] | undefined,
): string | undefined {
  if (!from) return undefined;
  const email = typeof from === "string" ? from : from.email;
  if (!email) return undefined;
  return email.trim().toLowerCase();
}

export class TagFeedbackRuleRepository {
  /**
   * Optional workspace feedback sink. When present, addRejection /
   * removeRejection emit a JSONL event so the Curator runtime can
   * learn from the user's tag preferences. Wired by AppComposition
   * in a later Route C batch; today repos run with sink === undefined.
   */
  private readonly feedbackSink?: WorkspaceFeedbackSink;

  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
    feedbackSink?: WorkspaceFeedbackSink,
  ) {
    this.feedbackSink = feedbackSink;
  }

  /**
   * Idempotent. Callers may re-reject the same tag on the same sender +
   * subject prefix — the UNIQUE index absorbs duplicates.
   */
  addRejection(input: AddRejectionInput): TagFeedbackRule {
    const { id, now, row } = this.addRule(input, "reject");
    if (!row) {
      // Fallback — shouldn't happen, but keeps return type honest.
      this.emitFeedback("tag-reject", {
        accountId: input.accountId,
        tagName: input.tagName,
        senderPattern: input.senderPattern,
        subjectPattern: input.subjectPattern,
      });
      return {
        id,
        accountId: input.accountId,
        tag: input.tagName,
        senderPattern: input.senderPattern,
        subjectPattern: input.subjectPattern,
        action: "reject",
        reason: input.reason,
        createdAt: now,
      };
    }
    this.emitFeedback("tag-reject", {
      accountId: input.accountId,
      tagName: input.tagName,
      senderPattern: input.senderPattern,
      subjectPattern: input.subjectPattern,
    });
    return rowToRule(row);
  }

  /**
   * Persist a positive (promote) feedback rule for a tag scoped to a
   * sender + subject prefix. Idempotent. Used by the per-email Smart
   * Tag Picker so future similar mail is biased toward this tag in the
   * AI's candidate set.
   */
  addPromotion(input: AddRejectionInput): TagFeedbackRule {
    const { id, now, row } = this.addRule(input, "promote");
    if (!row) {
      return {
        id,
        accountId: input.accountId,
        tag: input.tagName,
        senderPattern: input.senderPattern,
        subjectPattern: input.subjectPattern,
        action: "promote",
        reason: input.reason,
        createdAt: now,
      };
    }
    return rowToRule(row);
  }

  /** Inverse of {@link addPromotion}. */
  removePromotion(input: {
    accountId: string;
    tagName: string;
    senderPattern?: string;
    subjectPattern?: string;
  }): number {
    const info = this.db
      .prepare(
        `DELETE FROM mail_tag_feedback_rules
         WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
           AND tag_id = (SELECT id FROM mail_user_tags WHERE account_id =
             (SELECT id FROM mail_accounts WHERE public_id = @accountId) AND name_norm = @tagNorm)
           AND sender_pattern_norm = @senderPattern
           AND subject_prefix_norm = @subjectPattern AND action = 'promote'`,
      )
      .run({
        accountId: input.accountId,
        tagNorm: normalizeTag(input.tagName),
        senderPattern: input.senderPattern ?? "",
        subjectPattern: input.subjectPattern ?? "",
      });
    return info.changes;
  }

  /**
   * Inverse of {@link addRejection}. Called when the user accepts a tag
   * that had a prior reject rule — we nuke the exact match so future
   * similar mail sees the tag again.
   */
  removeRejection(input: {
    accountId: string;
    tagName: string;
    senderPattern?: string;
    subjectPattern?: string;
  }): number {
    const info = this.db
      .prepare(
        `DELETE FROM mail_tag_feedback_rules
         WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
           AND tag_id = (SELECT id FROM mail_user_tags WHERE account_id =
             (SELECT id FROM mail_accounts WHERE public_id = @accountId) AND name_norm = @tagNorm)
           AND sender_pattern_norm = @senderPattern
           AND subject_prefix_norm = @subjectPattern AND action = 'reject'`,
      )
      .run({
        accountId: input.accountId,
        tagNorm: normalizeTag(input.tagName),
        senderPattern: input.senderPattern ?? "",
        subjectPattern: input.subjectPattern ?? "",
      });
    if (info.changes > 0) {
      this.emitFeedback("tag-accept", {
        accountId: input.accountId,
        tagName: input.tagName,
        senderPattern: input.senderPattern,
        subjectPattern: input.subjectPattern,
      });
    }
    return info.changes;
  }

  /**
   * Fire-and-forget feedback emission. Errors are swallowed so that a
   * failed JSONL append never blocks the user's tag accept/reject —
   * the SQL row is the source of truth; the JSONL is best-effort
   * Curator fuel.
   */
  private emitFeedback(
    eventType: "tag-reject" | "tag-accept",
    event: Record<string, unknown>,
  ): void {
    if (!this.feedbackSink) return;
    void this.feedbackSink.append(eventType, event).catch(() => {
      /* swallow — JSONL is best-effort */
    });
  }

  listRules(accountId?: string): TagFeedbackRule[] {
    const rows = accountId
      ? (this.db
          .prepare(
            `${RULE_SELECT} WHERE accounts.public_id = ? ORDER BY rules.created_at_ms DESC`,
          )
          .all(accountId) as Row[])
      : (this.db
          .prepare(
            `${RULE_SELECT} ORDER BY rules.created_at_ms DESC`,
          )
          .all() as Row[]);
    return rows.map(rowToRule);
  }

  /**
   * Return every rule whose sender + subject pattern matches the
   * supplied mail. Matching semantics:
   *  - `sender_pattern` is NULL or equals the mail's canonical sender.
   *  - `subject_pattern` is NULL or is a prefix (case-insensitive,
   *    whitespace-collapsed) of the mail's normalized subject.
   *
   * Returning NULL patterns matches *any* sender/subject — this is the
   * forward-compatible shape but we never *create* such wildcard rules
   * in phase one.
   */
  findRulesForMail(mail: Pick<MailMessage, "accountId" | "from" | "subject">): TagFeedbackRule[] {
    const sender = deriveSenderPattern(mail.from);
    const normalizedSubject = normalizeSubject(mail.subject);
    const rows = this.db
      .prepare(
        `${RULE_SELECT}
         WHERE accounts.public_id = @accountId
           AND (rules.sender_pattern_norm = '' OR rules.sender_pattern_norm = @sender)`,
      )
      .all({
        accountId: mail.accountId,
        sender: sender ?? "",
      }) as Row[];
    return rows
      .filter((row) => {
        if (!row.subject_pattern) return true;
        return normalizedSubject.startsWith(row.subject_pattern);
      })
      .map(rowToRule);
  }

  /**
   * Apply matched rules to an LLM tag result. Phase-one behavior:
   *  - `reject` rule whose tag name matches a suggestion → drop it.
   *  - `promote` is reserved — we currently leave the suggestion as-is
   *    but stamp source='rule'. Kept out of Package F scope per brief.
   *
   * Dynamic tags are preserved for category tabs. We still report how many
   * non-built-in tags survived so callers can monitor taxonomy drift.
   */
  applyRules(
    tags: TagResult,
    mail: Pick<MailMessage, "accountId" | "from" | "subject">,
    builtinVocabulary: readonly string[],
  ): {
    result: TagResult;
    droppedByRules: number;
    dynamicTags: number;
    droppedOffVocab: number;
  } {
    const rules = this.findRulesForMail(mail);
    const rejectNames = new Set(
      rules.filter((r) => r.action === "reject").map((r) => r.tag),
    );
    const vocab = new Set(builtinVocabulary);

    let droppedByRules = 0;
    let dynamicTags = 0;
    const filtered = tags.tags.filter((t) => {
      if (!vocab.has(t.name)) {
        dynamicTags++;
      }
      if (rejectNames.has(t.name)) {
        droppedByRules++;
        return false;
      }
      return true;
    });

    return {
      result: { type: "tags", tags: filtered },
      droppedByRules,
      dynamicTags,
      droppedOffVocab: 0,
    };
  }

  private addRule(input: AddRejectionInput, action: RuleAction): { id: string; now: string; row?: Row } {
    const id = `tfr-${randomUUID()}`;
    const now = this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("invalid-tag-feedback-time");
    const tagNorm = normalizeTag(input.tagName);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO mail_user_tags (
        public_id, account_id, name, name_norm, creation_source, created_at_ms, updated_at_ms
      ) SELECT @tagPublicId, accounts.id, @tagName, @tagNorm, 'manual', @nowMs, @nowMs
        FROM mail_accounts accounts WHERE accounts.public_id = @accountId
        ON CONFLICT(account_id, name_norm) DO NOTHING`).run({
        tagPublicId: `tag-${randomUUID()}`,
        accountId: input.accountId,
        tagName: input.tagName,
        tagNorm,
        nowMs,
      });
      this.db.prepare(`INSERT INTO mail_tag_feedback_rules (
        public_id, account_id, tag_id, sender_pattern_norm, subject_prefix_norm,
        action, reason, created_at_ms, updated_at_ms, row_version
      ) SELECT @id, accounts.id, tags.id, @senderPattern, @subjectPattern,
        @action, @reason, @nowMs, @nowMs, 1
        FROM mail_accounts accounts
        JOIN mail_user_tags tags ON tags.account_id = accounts.id AND tags.name_norm = @tagNorm
        WHERE accounts.public_id = @accountId
        ON CONFLICT(account_id, tag_id, sender_pattern_norm, subject_prefix_norm, action) DO NOTHING`).run({
        id,
        accountId: input.accountId,
        tagNorm,
        senderPattern: input.senderPattern ?? "",
        subjectPattern: input.subjectPattern ?? "",
        action,
        reason: input.reason ?? null,
        nowMs,
      });
    })();
    const row = this.db.prepare(`${RULE_SELECT}
      WHERE accounts.public_id = @accountId AND tags.name_norm = @tagNorm
        AND rules.sender_pattern_norm = @senderPattern
        AND rules.subject_prefix_norm = @subjectPattern AND rules.action = @action
      LIMIT 1`).get({
      accountId: input.accountId,
      tagNorm,
      senderPattern: input.senderPattern ?? "",
      subjectPattern: input.subjectPattern ?? "",
      action,
    }) as Row | undefined;
    return { id, now, row };
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}
