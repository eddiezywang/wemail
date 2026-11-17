import { createHash, randomUUID } from "node:crypto";
import type {
  AiResultMetadata,
  WritingDraftState,
} from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "../database/Database.js";
import type { WorkspaceFeedbackSink } from "../workspace/WorkspaceFeedbackSink.js";

interface DraftVersionRow {
  id: string;
  email_id: string;
  version: number;
  state: string;
  draft_markdown: string;
  language: string;
  style_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

const DRAFT_VERSION_SELECT = `SELECT versions.public_id AS id,
  messages.public_id AS email_id, versions.version, versions.state,
  versions.draft_markdown, versions.language,
  versions.style_public_id AS style_id, versions.model_id AS model,
  datetime(versions.created_at_ms / 1000, 'unixepoch') AS created_at,
  datetime(versions.updated_at_ms / 1000, 'unixepoch') AS updated_at
  FROM mail_draft_versions versions
  JOIN mail_messages messages ON messages.id = versions.source_message_id`;

export interface DraftVersion {
  id: string;
  emailId: string;
  version: number;
  state: WritingDraftState;
  draftMarkdown: string;
  language: string;
  styleId?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToDraftVersion(row: DraftVersionRow): DraftVersion {
  return {
    id: row.id,
    emailId: row.email_id,
    version: row.version,
    state: row.state as WritingDraftState,
    draftMarkdown: row.draft_markdown,
    language: row.language,
    styleId: row.style_id ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DraftVersionRepositoryDeps {
  db: MailDatabase;
  now?: () => string;
  /**
   * Optional workspace feedback sink. When present, updateState emits
   * a JSONL event for accept / delete / edit transitions. Wired by
   * AppComposition in a later Route C batch.
   */
  feedbackSink?: WorkspaceFeedbackSink;
}

/**
 * Repository for persisting and querying draft versions.
 *
 * Each draft version records a lifecycle state (initial, regenerated,
 * accepted, deleted, edited_and_sent) alongside the draft content,
 * language, style, and model. No draft ever auto-sends — state
 * transitions are explicitly user-initiated.
 */
export class DraftVersionRepository {
  private readonly db: MailDatabase;
  private readonly now: () => string;
  private readonly feedbackSink?: WorkspaceFeedbackSink;

  constructor(deps: DraftVersionRepositoryDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.feedbackSink = deps.feedbackSink;
  }

  /**
   * Fire-and-forget feedback emission for draft state transitions.
   */
  private emitFeedback(
    eventType: "draft-accept" | "draft-delete" | "draft-edit",
    event: Record<string, unknown>,
  ): void {
    if (!this.feedbackSink) return;
    void this.feedbackSink.append(eventType, event).catch(() => {
      /* swallow — JSONL is best-effort */
    });
  }

  /**
   * Save a new draft version. Returns the saved version.
   * If no version number is provided, it auto-increments from the
   * latest version for the email.
   */
  save(input: {
    emailId: string;
    state: WritingDraftState;
    draftMarkdown: string;
    language?: string;
    styleId?: string;
    model?: string;
    version?: number;
  }): DraftVersion {
    const id = `dv-${randomUUID()}`;
    const now = this.now();
    const nowMs = parseTime(now);
    const version =
      input.version ?? this.nextVersion(input.emailId);

    this.db
      .prepare(`
        INSERT INTO mail_draft_versions (
          public_id, source_message_id, version, state, draft_markdown,
          language, style_public_id, model_id, content_sha256,
          created_at_ms, updated_at_ms
        ) SELECT @id, messages.id, @version, @state, @draftMarkdown,
          @language, @styleId, @model, @contentHash, @nowMs, @nowMs
        FROM mail_messages messages WHERE messages.public_id = @emailId
      `)
      .run({
        id,
        emailId: input.emailId,
        version,
        state: input.state,
        draftMarkdown: input.draftMarkdown,
        language: input.language ?? "en",
        styleId: input.styleId ?? null,
        model: input.model ?? null,
        contentHash: createHash("sha256").update(input.draftMarkdown).digest("hex"),
        nowMs,
      });

    return this.getById(id)!;
  }

  /**
   * Update the state of a draft version.
   */
  updateState(id: string, state: WritingDraftState): DraftVersion | null {
    const now = this.now();
    const nowMs = parseTime(now);
    this.db
      .prepare(`
        UPDATE mail_draft_versions SET state = @state, updated_at_ms = @nowMs
        WHERE public_id = @id
      `)
      .run({ id, state, nowMs });
    const updated = this.getById(id);
    if (updated) {
      // Map lifecycle states to coarse feedback event types. Internal
      // states like "initial" / "regenerated" are not user-feedback
      // transitions and are not emitted.
      const eventType =
        state === "accepted"
          ? ("draft-accept" as const)
          : state === "deleted"
            ? ("draft-delete" as const)
            : state === "edited_and_sent"
              ? ("draft-edit" as const)
              : null;
      if (eventType) {
        this.emitFeedback(eventType, {
          draftVersionId: updated.id,
          emailId: updated.emailId,
          version: updated.version,
          draftLength: updated.draftMarkdown.length,
          language: updated.language,
          styleId: updated.styleId,
          model: updated.model,
        });
      }
    }
    return updated;
  }

  /**
   * Get a draft version by id.
   */
  getById(id: string): DraftVersion | null {
    const row = this.db
      .prepare(`${DRAFT_VERSION_SELECT} WHERE versions.public_id = ?`)
      .get(id) as DraftVersionRow | undefined;
    return row ? rowToDraftVersion(row) : null;
  }

  /**
   * List all draft versions for an email, ordered by version descending.
   */
  findByEmailId(emailId: string): DraftVersion[] {
    const rows = this.db
      .prepare(
        `${DRAFT_VERSION_SELECT} WHERE messages.public_id = ? ORDER BY versions.version DESC`,
      )
      .all(emailId) as DraftVersionRow[];
    return rows.map(rowToDraftVersion);
  }

  /**
   * Get the latest (highest version) draft for an email.
   */
  getLatest(emailId: string): DraftVersion | null {
    const rows = this.db
      .prepare(
        `${DRAFT_VERSION_SELECT} WHERE messages.public_id = ? ORDER BY versions.version DESC LIMIT 1`,
      )
      .all(emailId) as DraftVersionRow[];
    return rows.length > 0 ? rowToDraftVersion(rows[0]) : null;
  }

  /**
   * Get the current active draft for an email (latest non-deleted version).
   */
  getActive(emailId: string): DraftVersion | null {
    const rows = this.db
      .prepare(
        `${DRAFT_VERSION_SELECT}
         WHERE messages.public_id = ? AND versions.state NOT IN ('deleted', 'edited_and_sent')
         ORDER BY versions.version DESC LIMIT 1`,
      )
      .all(emailId) as DraftVersionRow[];
    return rows.length > 0 ? rowToDraftVersion(rows[0]) : null;
  }

  /**
   * Compute the next version number for an email's drafts.
   */
  private nextVersion(emailId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(versions.version) as max_ver FROM mail_draft_versions versions
         JOIN mail_messages messages ON messages.id = versions.source_message_id
         WHERE messages.public_id = ?`,
      )
      .get(emailId) as { max_ver: number | null } | undefined;
    return (row?.max_ver ?? 0) + 1;
  }
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-draft-version-time");
  return parsed;
}
