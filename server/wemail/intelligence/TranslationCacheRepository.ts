import { createHash } from "node:crypto";
import type { TranslationParagraph, TranslationResult } from "../../../shared/wemail/intelligence.js";
import type { MailDatabase } from "../database/Database.js";

export interface TranslationCacheEntry {
  accountId: string;
  emailId: string;
  targetLanguage: string;
  processorVersion: number;
  sourceContentHash: string;
  translatedText: string;
  paragraphs: TranslationParagraph[];
  model: string | null;
  createdAt: string;
}

interface TranslationCacheRow {
  account_public_id: string;
  message_public_id: string;
  target_language: string;
  processor_version: number;
  source_content_hash: string;
  translated_text: string;
  paragraphs_json: string | null;
  model: string | null;
  created_at_ms: number;
}

/**
 * Compute a SHA-256 hash of the source content for cache keying.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function rowToEntry(row: TranslationCacheRow): TranslationCacheEntry {
  return {
    accountId: row.account_public_id,
    emailId: row.message_public_id,
    targetLanguage: row.target_language,
    processorVersion: row.processor_version,
    sourceContentHash: row.source_content_hash,
    translatedText: row.translated_text,
    paragraphs: row.paragraphs_json ? JSON.parse(row.paragraphs_json) : [],
    model: row.model,
    createdAt: new Date(row.created_at_ms).toISOString(),
  };
}

/**
 * Repository for canonical message translations. Provides lookup and
 * upsert keyed by (accountId, emailId, targetLanguage, processorVersion).
 * A source content hash enables cache invalidation when the source changes.
 */
export class TranslationCacheRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Look up a cached translation. Returns null when no match exists
   * or when the source content hash has changed (stale cache).
   */
  find(input: {
    accountId: string;
    emailId: string;
    targetLanguage: string;
    processorVersion: number;
    sourceContentHash: string;
  }): TranslationCacheEntry | null {
    const row = this.db
      .prepare(
        `SELECT accounts.public_id AS account_public_id,
                messages.public_id AS message_public_id,
                translations.target_language,
                CAST(translations.processor_version AS INTEGER) AS processor_version,
                translations.source_content_sha256 AS source_content_hash,
                translations.translated_text, translations.paragraphs_json,
                translations.model_id AS model, translations.created_at_ms
         FROM mail_translations translations
         JOIN mail_accounts accounts ON accounts.id = translations.account_id
         JOIN mail_messages messages ON messages.id = translations.message_id
         WHERE accounts.public_id = @accountId
           AND messages.public_id = @emailId
           AND translations.target_language = @targetLanguage
           AND translations.processor_version = @processorVersion
           AND translations.source_content_sha256 = @sourceContentHash`,
      )
      .get({ ...input, processorVersion: String(input.processorVersion) }) as TranslationCacheRow | undefined;

    if (!row) return null;

    // If source content hash changed, the cache is stale
    if (row.source_content_hash !== input.sourceContentHash) return null;

    return rowToEntry(row);
  }

  /**
   * Upsert a cache entry. If a row with the same composite key exists,
   * it is replaced (source content changed and we re-translated).
   */
  save(entry: TranslationCacheEntry): void {
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new Error("invalid-translation-time");
    this.db
      .prepare(
        `INSERT INTO mail_translations (
           account_id, message_id, target_language, processor_version,
           source_content_sha256, translated_text, paragraphs_json, model_id, created_at_ms
         ) SELECT accounts.id, messages.id, @targetLanguage, @processorVersion,
           @sourceContentHash, @translatedText, @paragraphsJson, @model, @nowMs
         FROM mail_accounts accounts
         JOIN mail_messages messages ON messages.account_id = accounts.id
         WHERE accounts.public_id = @accountId AND messages.public_id = @emailId
         ON CONFLICT(message_id, target_language, processor_version, source_content_sha256) DO UPDATE SET
           translated_text = excluded.translated_text,
           paragraphs_json = excluded.paragraphs_json,
           model_id = excluded.model_id,
           created_at_ms = excluded.created_at_ms`,
      )
      .run({
        ...entry,
        processorVersion: String(entry.processorVersion),
        paragraphsJson: entry.paragraphs.length > 0
          ? JSON.stringify(entry.paragraphs)
          : null,
        nowMs,
      });
  }

  /**
   * Convert a cache entry to a TranslationResult (with cached=true).
   */
  toResult(entry: TranslationCacheEntry): TranslationResult {
    return {
      type: "translation",
      targetLanguage: entry.targetLanguage,
      translatedText: entry.translatedText,
      cached: true,
      paragraphs: entry.paragraphs.length > 0 ? entry.paragraphs : undefined,
    };
  }
}
