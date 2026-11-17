import type { MailDatabase } from "../database/Database.js";

export interface MailSemanticAttribute {
  emailId: string;
  attachmentId: string;
  fieldPath: string;
  valueType: "date" | "datetime";
  value?: string;
  status: "pending" | "ready" | "unavailable";
  source?: "pdf-text";
  confidence?: number;
  extractorVersion: number;
  reasonCode?: string;
  extractedAt?: string;
}

interface SemanticAttributeRow {
  email_id: string;
  attachment_id: string;
  field_path: string;
  value_type: MailSemanticAttribute["valueType"];
  value_text: string | null;
  status: MailSemanticAttribute["status"];
  source: MailSemanticAttribute["source"] | null;
  confidence: number | null;
  extractor_version: string;
  reason_code: string | null;
  extracted_at_ms: number | null;
}

interface SemanticAttributeKey {
  emailId: string;
  attachmentId: string;
  fieldPath: string;
  valueType: MailSemanticAttribute["valueType"];
  extractorVersion: number;
}

export interface MailSemanticAttributeRepositoryOptions {
  db: MailDatabase;
  now?: () => string;
}

export class MailSemanticAttributeRepository {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(options: MailSemanticAttributeRepositoryOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  upsertPending(input: SemanticAttributeKey): void {
    this.upsert(input, { status: "pending" });
  }

  upsertReady(input: SemanticAttributeKey & {
    value: string;
    source: "pdf-text";
    confidence: number;
  }): void {
    this.upsert(input, {
      status: "ready",
      value: input.value,
      source: input.source,
      confidence: input.confidence,
    });
  }

  markUnavailable(input: SemanticAttributeKey & { reasonCode: string }): void {
    this.upsert(input, { status: "unavailable", reasonCode: input.reasonCode });
  }

  list(emailId: string, fieldPath: string): MailSemanticAttribute[] {
    const rows = this.db.prepare(`SELECT messages.public_id AS email_id,
      attachments.public_id AS attachment_id, attributes.field_path,
      attributes.value_type, attributes.value_text,
      attributes.state AS status, attributes.source, attributes.confidence,
      attributes.extractor_version, attributes.reason_code,
      attributes.extracted_at_ms
      FROM mail_attachment_semantic_attributes attributes
      JOIN mail_attachments attachments ON attachments.id = attributes.attachment_id
      JOIN mail_messages messages ON messages.id = attachments.message_id
      WHERE messages.public_id = ? AND attributes.field_path = ?
      ORDER BY attachments.public_id`).all(emailId, fieldPath) as SemanticAttributeRow[];
    return rows.map(toAttribute);
  }

  private upsert(
    input: SemanticAttributeKey,
    state: {
      status: MailSemanticAttribute["status"];
      value?: string;
      source?: "pdf-text";
      confidence?: number;
      reasonCode?: string;
    },
  ): void {
    const nowMs = parseTime(this.now());
    const extractedAtMs = state.status === "pending" ? null : nowMs;
    this.db.prepare(`INSERT INTO mail_attachment_semantic_attributes (
      attachment_id, field_path, value_type, value_text, value_json,
      state, source, confidence, extractor_version, source_content_sha256,
      reason_code, extracted_at_ms, created_at_ms, updated_at_ms
    ) SELECT attachments.id, @fieldPath, @valueType, @value, NULL,
      @status, @source, @confidence, @extractorVersion,
      attachments.content_sha256, @reasonCode, @extractedAtMs, @nowMs, @nowMs
      FROM mail_attachments attachments
      JOIN mail_messages messages ON messages.id = attachments.message_id
      WHERE attachments.public_id = @attachmentId AND messages.public_id = @emailId
      ON CONFLICT(attachment_id, field_path) DO UPDATE SET
        value_type = excluded.value_type, value_text = excluded.value_text,
        value_json = NULL, state = excluded.state, source = excluded.source,
        confidence = excluded.confidence,
        extractor_version = excluded.extractor_version,
        source_content_sha256 = excluded.source_content_sha256,
        reason_code = excluded.reason_code,
        extracted_at_ms = excluded.extracted_at_ms,
        updated_at_ms = excluded.updated_at_ms`).run({
      ...input,
      status: state.status,
      value: state.value ?? null,
      source: state.source ?? null,
      confidence: state.confidence ?? null,
      extractorVersion: String(input.extractorVersion),
      reasonCode: state.reasonCode ?? null,
      extractedAtMs,
      nowMs,
    });
  }
}

function toAttribute(row: SemanticAttributeRow): MailSemanticAttribute {
  return {
    emailId: row.email_id,
    attachmentId: row.attachment_id,
    fieldPath: row.field_path,
    valueType: row.value_type,
    ...(row.value_text === null ? {} : { value: row.value_text }),
    status: row.status,
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    extractorVersion: Number(row.extractor_version),
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    ...(row.extracted_at_ms === null
      ? {}
      : { extractedAt: new Date(row.extracted_at_ms).toISOString() }),
  };
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-semantic-attribute-time");
  return parsed;
}
