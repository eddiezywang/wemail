import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export type TopicCandidateState = "collecting" | "pending" | "created" | "deferred" | "suppressed" | "failed";

export interface TopicCandidate {
  id: string;
  accountId: string;
  normalizedKey: string;
  displayName: string;
  aliases: string[];
  state: TopicCandidateState;
  mailCount: number;
  threadCount: number;
  senderCount: number;
  positiveCount: number;
  negativeCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSuggestedAt?: string;
  deferredAt?: string;
  suppressedAt?: string;
  userTagId?: string;
  applicationMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicEvidence {
  topicId: string;
  accountId: string;
  emailId: string;
  threadId?: string;
  senderKey?: string;
  confidence: number;
  polarity: "positive" | "negative";
  createdAt: string;
  updatedAt: string;
}

export interface TopicWindowCounts { mailCount: number; threadCount: number; senderCount: number }

interface CandidateRow {
  id: string; account_id: string; normalized_key: string; display_name: string;
  aliases_json: string; state: TopicCandidateState; mail_count: number;
  thread_count: number; sender_count: number; positive_count: number;
  negative_count: number; first_seen_at_ms: number; last_seen_at_ms: number;
  last_suggested_at_ms: number | null; deferred_at_ms: number | null;
  suppressed_at_ms: number | null; user_tag_id: string | null;
  application_message_id: string | null; created_at_ms: number; updated_at_ms: number;
}

interface EvidenceRow {
  topic_id: string; account_id: string; email_id: string; thread_id: string | null;
  sender_key: string | null; confidence: number; polarity: "positive" | "negative";
  created_at_ms: number; updated_at_ms: number;
}

const TOPIC_SELECT = `SELECT topics.public_id AS id,
  accounts.public_id AS account_id, topics.normalized_key, topics.display_name,
  topics.aliases_json, topics.state, topics.mail_count, topics.thread_count,
  topics.sender_count, topics.positive_count, topics.negative_count,
  topics.first_seen_at_ms, topics.last_seen_at_ms, topics.last_suggested_at_ms,
  topics.deferred_at_ms, topics.suppressed_at_ms, tags.public_id AS user_tag_id,
  topics.application_message_public_id AS application_message_id,
  topics.created_at_ms, topics.updated_at_ms
  FROM mail_smart_topics topics
  JOIN mail_accounts accounts ON accounts.id = topics.account_id
  LEFT JOIN mail_user_tags tags ON tags.id = topics.user_tag_id`;

const EVIDENCE_SELECT = `SELECT topics.public_id AS topic_id,
  accounts.public_id AS account_id, messages.public_id AS email_id,
  threads.public_id AS thread_id, evidence.sender_key, evidence.confidence,
  evidence.polarity, evidence.created_at_ms, evidence.updated_at_ms
  FROM mail_smart_topic_evidence evidence
  JOIN mail_smart_topics topics ON topics.id = evidence.topic_id
  JOIN mail_accounts accounts ON accounts.id = topics.account_id
  JOIN mail_messages messages ON messages.id = evidence.message_id
  LEFT JOIN mail_threads threads ON threads.id = evidence.thread_id`;

export class TopicCandidateRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  recordEvidence(input: {
    accountId: string; normalizedKey: string; displayName: string; emailId: string;
    threadId?: string; senderKey?: string; confidence: number;
    polarity?: "positive" | "negative";
  }): TopicCandidate {
    return this.db.transaction(() => {
      const nowMs = parseTime(this.now());
      const id = `topic-${randomUUID()}`;
      const existing = this.getByKey(input.accountId, input.normalizedKey);
      const priorEvidence = existing
        ? this.db.prepare(`SELECT 1 FROM mail_smart_topic_evidence evidence
            JOIN mail_smart_topics topics ON topics.id = evidence.topic_id
            JOIN mail_messages messages ON messages.id = evidence.message_id
            WHERE topics.public_id = ? AND messages.public_id = ?`).get(existing.id, input.emailId)
        : undefined;
      this.db.prepare(`INSERT INTO mail_smart_topics (
        public_id, account_id, normalized_key, display_name, aliases_json, state,
        first_seen_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms
      ) SELECT @id, accounts.id, @normalizedKey, @displayName, '[]', 'collecting',
        @nowMs, @nowMs, @nowMs, @nowMs
        FROM mail_accounts accounts WHERE accounts.public_id = @accountId
        ON CONFLICT(account_id, normalized_key) DO UPDATE SET
          display_name = CASE WHEN length(excluded.display_name) < length(display_name)
            THEN excluded.display_name ELSE display_name END,
          last_seen_at_ms = CASE WHEN @isNew = 1 THEN excluded.last_seen_at_ms ELSE last_seen_at_ms END,
          updated_at_ms = excluded.updated_at_ms`).run({
        id,
        ...input,
        nowMs,
        isNew: priorEvidence ? 0 : 1,
      });
      const topic = this.getByKey(input.accountId, input.normalizedKey);
      if (!topic) throw new Error("topic-upsert-missing");
      this.db.prepare(`INSERT INTO mail_smart_topic_evidence (
        topic_id, message_id, thread_id, sender_key, confidence, polarity,
        created_at_ms, updated_at_ms
      ) SELECT topics.id, messages.id, threads.id, @senderKey, @confidence,
        @polarity, @nowMs, @nowMs
        FROM mail_smart_topics topics
        JOIN mail_messages messages ON messages.public_id = @emailId
        LEFT JOIN mail_threads threads ON threads.public_id = @threadId
        WHERE topics.public_id = @topicId
        ON CONFLICT(topic_id, message_id) DO UPDATE SET
          thread_id = excluded.thread_id, sender_key = excluded.sender_key,
          confidence = excluded.confidence, polarity = excluded.polarity,
          updated_at_ms = excluded.updated_at_ms`).run({
        topicId: topic.id,
        ...input,
        threadId: input.threadId ?? null,
        senderKey: input.senderKey ?? null,
        polarity: input.polarity ?? "positive",
        nowMs,
      });
      this.refreshCounts(topic.id, nowMs);
      if (!priorEvidence && topic.state === "deferred") {
        this.db.prepare(`UPDATE mail_smart_topics SET state = 'collecting', updated_at_ms = ?
          WHERE public_id = ?`).run(nowMs, topic.id);
      }
      return this.getById(topic.id)!;
    })();
  }

  private refreshCounts(topicId: string, nowMs: number): void {
    this.db.prepare(`UPDATE mail_smart_topics SET
      mail_count = (SELECT COUNT(*) FROM mail_smart_topic_evidence WHERE topic_id = mail_smart_topics.id AND polarity = 'positive'),
      thread_count = (SELECT COUNT(DISTINCT thread_id) FROM mail_smart_topic_evidence WHERE topic_id = mail_smart_topics.id AND polarity = 'positive' AND thread_id IS NOT NULL),
      sender_count = (SELECT COUNT(DISTINCT sender_key) FROM mail_smart_topic_evidence WHERE topic_id = mail_smart_topics.id AND polarity = 'positive' AND sender_key IS NOT NULL),
      positive_count = (SELECT COUNT(*) FROM mail_smart_topic_evidence WHERE topic_id = mail_smart_topics.id AND polarity = 'positive'),
      negative_count = (SELECT COUNT(*) FROM mail_smart_topic_evidence WHERE topic_id = mail_smart_topics.id AND polarity = 'negative'),
      updated_at_ms = @nowMs WHERE public_id = @topicId`).run({ topicId, nowMs });
  }

  getById(id: string, accountId?: string): TopicCandidate | null {
    const row = this.db.prepare(`${TOPIC_SELECT} WHERE topics.public_id = @id
      AND (@accountId IS NULL OR accounts.public_id = @accountId)`).get({ id, accountId: accountId ?? null }) as CandidateRow | undefined;
    return row ? candidateFromRow(row) : null;
  }

  /** Cached smart-tag description generated for this topic, or null when absent. */
  getPromotionDescription(topicId: string): string | null {
    const row = this.db.prepare(
      `SELECT promotion_description FROM mail_smart_topics WHERE public_id = ?`,
    ).get(topicId) as { promotion_description: string | null } | undefined;
    return row?.promotion_description ?? null;
  }

  setPromotionDescription(topicId: string, description: string): void {
    this.db.prepare(`UPDATE mail_smart_topics
      SET promotion_description = ?, updated_at_ms = ? WHERE public_id = ?`)
      .run(description, parseTime(this.now()), topicId);
  }

  getByKey(accountId: string, normalizedKey: string): TopicCandidate | null {
    const row = this.db.prepare(`${TOPIC_SELECT}
      WHERE accounts.public_id = ? AND topics.normalized_key = ?`).get(accountId, normalizedKey) as CandidateRow | undefined;
    return row ? candidateFromRow(row) : null;
  }

  listEligible(accountId: string, since: string, minMailCount = 5): TopicCandidate[] {
    const rows = this.db.prepare(`${TOPIC_SELECT}
      WHERE accounts.public_id = @accountId
        AND topics.state IN ('collecting', 'deferred', 'failed')
        AND topics.user_tag_id IS NULL AND topics.suppressed_at_ms IS NULL
        AND topics.mail_count >= @minMailCount
        AND (topics.thread_count >= 2 OR topics.sender_count >= 2)
        AND topics.last_seen_at_ms >= @sinceMs
        AND (topics.deferred_at_ms IS NULL OR topics.last_seen_at_ms > topics.deferred_at_ms)
      ORDER BY topics.mail_count DESC, topics.last_seen_at_ms DESC`).all({
      accountId,
      sinceMs: parseTime(since),
      minMailCount,
    }) as CandidateRow[];
    return rows.map(candidateFromRow);
  }

  listEvidence(topicId: string, limit = 20): TopicEvidence[] {
    const rows = this.db.prepare(`${EVIDENCE_SELECT}
      WHERE topics.public_id = ? ORDER BY evidence.created_at_ms DESC LIMIT ?`).all(
      topicId,
      Math.max(1, Math.min(200, limit)),
    ) as EvidenceRow[];
    return rows.map(evidenceFromRow);
  }

  countEvidenceSince(topicId: string, since: string): TopicWindowCounts {
    const row = this.db.prepare(`SELECT COUNT(*) AS mail_count,
      COUNT(DISTINCT CASE WHEN evidence.thread_id IS NOT NULL THEN evidence.thread_id END) AS thread_count,
      COUNT(DISTINCT CASE WHEN evidence.sender_key IS NOT NULL THEN evidence.sender_key END) AS sender_count
      FROM mail_smart_topic_evidence evidence
      JOIN mail_smart_topics topics ON topics.id = evidence.topic_id
      WHERE topics.public_id = ? AND evidence.polarity = 'positive'
        AND evidence.created_at_ms >= ?`).get(topicId, parseTime(since)) as {
      mail_count: number; thread_count: number; sender_count: number;
    };
    return { mailCount: Number(row.mail_count), threadCount: Number(row.thread_count), senderCount: Number(row.sender_count) };
  }

  markPending(id: string, applicationMessageId: string): TopicCandidate | null {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_smart_topics SET state = 'pending',
      application_message_public_id = ?, last_suggested_at_ms = ?, updated_at_ms = ?
      WHERE public_id = ? AND state IN ('collecting','deferred','failed')`).run(applicationMessageId, nowMs, nowMs, id);
    return this.getById(id);
  }

  defer(id: string, accountId: string): TopicCandidate | null {
    return this.updateState(id, accountId, "deferred", "deferred_at_ms");
  }

  suppress(id: string, accountId: string): TopicCandidate | null {
    return this.updateState(id, accountId, "suppressed", "suppressed_at_ms");
  }

  markCreated(id: string, accountId: string, userTagId: string): TopicCandidate | null {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_smart_topics SET state = 'created',
      user_tag_id = (SELECT id FROM mail_user_tags WHERE public_id = @userTagId),
      updated_at_ms = @nowMs WHERE public_id = @id AND account_id =
        (SELECT id FROM mail_accounts WHERE public_id = @accountId)`).run({ id, accountId, userTagId, nowMs });
    return this.getById(id, accountId);
  }

  private updateState(id: string, accountId: string, state: "deferred" | "suppressed", timeColumn: "deferred_at_ms" | "suppressed_at_ms"): TopicCandidate | null {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_smart_topics SET state = @state,
      ${timeColumn} = @nowMs, updated_at_ms = @nowMs
      WHERE public_id = @id AND account_id =
        (SELECT id FROM mail_accounts WHERE public_id = @accountId)`).run({ id, accountId, state, nowMs });
    return this.getById(id, accountId);
  }
}

function candidateFromRow(row: CandidateRow): TopicCandidate {
  return {
    id: row.id, accountId: row.account_id, normalizedKey: row.normalized_key,
    displayName: row.display_name, aliases: parseAliases(row.aliases_json),
    state: row.state, mailCount: Number(row.mail_count), threadCount: Number(row.thread_count),
    senderCount: Number(row.sender_count), positiveCount: Number(row.positive_count),
    negativeCount: Number(row.negative_count), firstSeenAt: iso(row.first_seen_at_ms)!,
    lastSeenAt: iso(row.last_seen_at_ms)!, lastSuggestedAt: iso(row.last_suggested_at_ms),
    deferredAt: iso(row.deferred_at_ms), suppressedAt: iso(row.suppressed_at_ms),
    userTagId: row.user_tag_id ?? undefined,
    applicationMessageId: row.application_message_id ?? undefined,
    createdAt: iso(row.created_at_ms)!, updatedAt: iso(row.updated_at_ms)!,
  };
}

function evidenceFromRow(row: EvidenceRow): TopicEvidence {
  return {
    topicId: row.topic_id, accountId: row.account_id, emailId: row.email_id,
    threadId: row.thread_id ?? undefined, senderKey: row.sender_key ?? undefined,
    confidence: row.confidence, polarity: row.polarity,
    createdAt: iso(row.created_at_ms)!, updatedAt: iso(row.updated_at_ms)!,
  };
}

function parseAliases(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch { return []; }
}

function iso(value: number | bigint | null): string | undefined {
  return value == null ? undefined : new Date(Number(value)).toISOString();
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-smart-topic-time");
  return parsed;
}
