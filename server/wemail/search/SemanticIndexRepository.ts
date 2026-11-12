import { createHash } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export interface SemanticIndexRow {
  accountId: string;
  emailId: string;
  chunkId: string;
  chunkText: string;
  embeddingJson: string | null;
  lexicalTerms: string;
  processorVersion: number;
  indexedAt: string;
}

interface StoredRow {
  account_id: string;
  email_id: string;
  chunk_id: string;
  chunk_text: string;
  embedding_model: string;
  embedding_f32: Buffer;
  lexical_terms: string;
  processor_version: string;
  indexed_at_ms: number;
  score?: number;
}

const CHUNK_SELECT = `SELECT accounts.public_id AS account_id,
  messages.public_id AS email_id, chunks.chunk_key AS chunk_id,
  chunks.chunk_text, chunks.embedding_model, chunks.embedding_f32,
  chunks.lexical_terms, chunks.embedding_version AS processor_version,
  chunks.indexed_at_ms
  FROM mail_semantic_chunks chunks
  JOIN mail_accounts accounts ON accounts.id = chunks.account_id
  JOIN mail_messages messages ON messages.id = chunks.message_id`;

export interface SemanticIndexRepositoryOptions {
  db: MailDatabase;
  now?: () => string;
}

export class SemanticIndexRepository {
  private readonly db: MailDatabase;
  private readonly now: () => string;

  constructor(options: SemanticIndexRepositoryOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  upsertChunk(chunk: {
    accountId: string;
    emailId: string;
    chunkId: string;
    chunkText: string;
    embeddingJson?: string | null;
    lexicalTerms: string;
    processorVersion: number;
  }): void {
    const vector = parseEmbedding(chunk.embeddingJson);
    const embedding = Buffer.from(new Float32Array(vector).buffer);
    const sourceHash = sha256(chunk.chunkText);
    const embeddingHash = sha256(embedding);
    const indexedAtMs = parseTime(this.now());
    this.db.prepare(`INSERT INTO mail_semantic_chunks (
      account_id, message_id, chunk_key, chunk_ordinal,
      source_content_sha256, source_content_version, chunk_text, lexical_terms,
      embedding_model, embedding_version, embedding_dimensions,
      embedding_f32, embedding_sha256, indexed_at_ms, row_version
    ) SELECT accounts.id, messages.id, @chunkId, @chunkOrdinal,
      @sourceHash, messages.content_version, @chunkText, @lexicalTerms,
      @embeddingModel, @processorVersion, @dimensions,
      @embedding, @embeddingHash, @indexedAtMs, 1
      FROM mail_accounts accounts
      JOIN mail_messages messages ON messages.account_id = accounts.id
      WHERE accounts.public_id = @accountId AND messages.public_id = @emailId
      ON CONFLICT(message_id, chunk_key, embedding_model, embedding_version) DO UPDATE SET
        source_content_sha256 = excluded.source_content_sha256,
        source_content_version = excluded.source_content_version,
        chunk_text = excluded.chunk_text, lexical_terms = excluded.lexical_terms,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_f32 = excluded.embedding_f32,
        embedding_sha256 = excluded.embedding_sha256,
        indexed_at_ms = excluded.indexed_at_ms,
        row_version = mail_semantic_chunks.row_version + 1`).run({
      ...chunk,
      chunkOrdinal: chunkOrdinal(chunk.chunkId),
      sourceHash,
      embeddingModel: chunk.embeddingJson ? "legacy-json" : "lexical-only",
      processorVersion: String(chunk.processorVersion),
      dimensions: vector.length,
      embedding,
      embeddingHash,
      indexedAtMs,
    });
  }

  deleteChunksByEmail(emailId: string): number {
    return this.db.prepare(`DELETE FROM mail_semantic_chunks WHERE message_id =
      (SELECT id FROM mail_messages WHERE public_id = ?)`).run(emailId).changes;
  }

  getIndexedChunkCount(emailId: string, processorVersion: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM mail_semantic_chunks chunks
      JOIN mail_messages messages ON messages.id = chunks.message_id
      WHERE messages.public_id = ? AND chunks.embedding_version = ?`).get(
      emailId,
      String(processorVersion),
    ) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  lexicalSearch(input: {
    accountId: string;
    queryTerms: string[];
    limit?: number;
    offset?: number;
  }): Array<{ row: SemanticIndexRow; score: number }> {
    const terms = input.queryTerms.map((term) => term.trim()).filter(Boolean).slice(0, 16);
    if (terms.length === 0) return [];
    const params: Record<string, unknown> = {
      accountId: input.accountId,
      limit: Math.max(1, Math.floor(input.limit ?? 10)),
      offset: Math.max(0, input.offset ?? 0),
    };
    const matches = terms.map((term, index) => {
      params[`term${index}`] = `%${escapeLike(term)}%`;
      return `chunks.lexical_terms LIKE @term${index} ESCAPE '\\'`;
    });
    const score = matches.map((match) => `CASE WHEN ${match} THEN 1 ELSE 0 END`).join(" + ");
    const rows = this.db.prepare(`SELECT accounts.public_id AS account_id,
      messages.public_id AS email_id, chunks.chunk_key AS chunk_id,
      chunks.chunk_text, chunks.embedding_model, chunks.embedding_f32,
      chunks.lexical_terms, chunks.embedding_version AS processor_version,
      chunks.indexed_at_ms, (${score}) AS score
      FROM mail_semantic_chunks chunks
      JOIN mail_accounts accounts ON accounts.id = chunks.account_id
      JOIN mail_messages messages ON messages.id = chunks.message_id
      WHERE accounts.public_id = @accountId AND (${matches.join(" OR ")})
      ORDER BY score DESC, chunks.indexed_at_ms DESC, chunks.id DESC
      LIMIT @limit OFFSET @offset`).all(params) as StoredRow[];
    return rows.map((row) => ({ row: toPublicRow(row), score: (row.score ?? 0) / terms.length }));
  }

  vectorSearch(input: {
    accountId: string;
    queryEmbedding: number[];
    limit?: number;
    offset?: number;
  }): Array<{ row: SemanticIndexRow; score: number }> {
    const limit = Math.max(1, Math.floor(input.limit ?? 10));
    const offset = Math.max(0, input.offset ?? 0);
    const candidateLimit = Math.min(2_000, Math.max(200, (offset + limit) * 20));
    const rows = this.db.prepare(`${CHUNK_SELECT}
      WHERE accounts.public_id = ? AND chunks.embedding_model <> 'lexical-only'
      ORDER BY chunks.indexed_at_ms DESC, chunks.id DESC LIMIT ?`).all(
      input.accountId,
      candidateLimit,
    ) as StoredRow[];
    return rows.map((stored) => {
      const row = toPublicRow(stored);
      return { row, score: cosineSimilarity(input.queryEmbedding, JSON.parse(row.embeddingJson!) as number[]) };
    }).sort((a, b) => b.score - a.score).slice(offset, offset + limit);
  }

  getChunksByEmailIds(input: { accountId: string; emailIds: string[] }): SemanticIndexRow[] {
    const ids = [...new Set(input.emailIds.filter(Boolean))].slice(0, 500);
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, index) => `@email${index}`).join(", ");
    const params: Record<string, unknown> = { accountId: input.accountId };
    ids.forEach((id, index) => { params[`email${index}`] = id; });
    const rows = this.db.prepare(`${CHUNK_SELECT}
      WHERE accounts.public_id = @accountId AND messages.public_id IN (${placeholders})
      ORDER BY messages.public_id, chunks.chunk_ordinal, chunks.id`).all(params) as StoredRow[];
    return rows.map(toPublicRow);
  }

  countByAccount(accountId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM mail_semantic_chunks chunks
      JOIN mail_accounts accounts ON accounts.id = chunks.account_id
      WHERE accounts.public_id = ?`).get(accountId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}

function toPublicRow(row: StoredRow): SemanticIndexRow {
  const embeddingJson = row.embedding_model === "lexical-only"
    ? null
    : JSON.stringify(Array.from(
        { length: row.embedding_f32.byteLength / Float32Array.BYTES_PER_ELEMENT },
        (_, index) => row.embedding_f32.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT),
      ));
  return {
    accountId: row.account_id,
    emailId: row.email_id,
    chunkId: row.chunk_id,
    chunkText: row.chunk_text,
    embeddingJson,
    lexicalTerms: row.lexical_terms,
    processorVersion: Number(row.processor_version),
    indexedAt: new Date(row.indexed_at_ms).toISOString(),
  };
}

function parseEmbedding(json: string | null | undefined): number[] {
  if (!json) return [0];
  try {
    const value = JSON.parse(json) as unknown;
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return value;
    }
  } catch {
    // A malformed optional embedding becomes a lexical-only row.
  }
  return [0];
}

function chunkOrdinal(chunkId: string): number {
  const match = chunkId.match(/(\d+)$/u);
  return match ? Number(match[1]) : 0;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-semantic-index-time");
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dotProduct += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
