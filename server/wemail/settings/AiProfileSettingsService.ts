import { randomUUID } from "node:crypto";
import {
  AI_WORKER_CONCURRENCY_DEFAULT,
  AI_WORKER_CONCURRENCY_MAX,
  AI_WORKER_CONCURRENCY_MIN,
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  TODO_PROMPT_MAX_LENGTH,
  type AiProfileSettings,
  type WritingStyle,
} from "../../../shared/wemail/settings.js";
import type { MailDatabase } from "../database/Database.js";

interface AiProfileRow {
  user_display_name: string | null;
  assistant_preference: string | null;
  summary_language: string | null;
  todo_language: string | null;
  compose_language: string | null;
  translation_language: string | null;
  important_contacts_json: string | null;
  default_summary_language: string | null;
  default_reply_tone: string | null;
  signature_preference: string | null;
  custom_instructions: string | null;
  todo_prompt: string | null;
  worker_concurrency: number | null;
  updated_at: string;
}

export class AiProfileValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "AiProfileValidationError";
    this.field = field;
  }
}

interface WritingStyleRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  created_at: string;
  updated_at: string;
}

const PROFILE_ID = "default";

export class AiProfileSettingsService {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getProfile(): AiProfileSettings | null {
    const row = this.db
      .prepare("SELECT * FROM ai_profile_settings WHERE id = ?")
      .get(PROFILE_ID) as AiProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  /**
   * Resolve the effective AI worker concurrency.
   *
   * Precedence: a persisted user preference → the WEMAIL_AI_WORKER_CONCURRENCY
   * env var → AI_WORKER_CONCURRENCY_DEFAULT. The DB column is nullable: NULL
   * means "no user preference", so the env var can still tune a fresh install
   * without the first boot writing a row. Once the user sets a value via the
   * UI it persists and the env var is ignored on subsequent boots. The result
   * is always clamped to [MIN, MAX].
   */
  getWorkerConcurrency(): number {
    const raw = this.getProfile()?.workerConcurrency;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return clampWorkerConcurrency(Math.trunc(raw));
    }
    const env = Number(process.env.WEMAIL_AI_WORKER_CONCURRENCY ?? AI_WORKER_CONCURRENCY_DEFAULT);
    return clampWorkerConcurrency(
      Number.isFinite(env) ? Math.trunc(env) : AI_WORKER_CONCURRENCY_DEFAULT,
    );
  }

  saveProfile(input: Partial<Omit<AiProfileSettings, "updatedAt">>): AiProfileSettings {
    const now = this.now();
    const existing = this.getProfile();

    // Validate customInstructions length (cap at 2000 chars).
    if (input.customInstructions !== undefined && input.customInstructions !== null) {
      if (typeof input.customInstructions !== "string") {
        throw new AiProfileValidationError(
          "customInstructions",
          "customInstructions must be a string",
        );
      }
      if (input.customInstructions.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
        throw new AiProfileValidationError(
          "customInstructions",
          `customInstructions exceeds maximum length of ${CUSTOM_INSTRUCTIONS_MAX_LENGTH} characters`,
        );
      }
    }
    if (input.todoPrompt !== undefined && input.todoPrompt !== null) {
      if (typeof input.todoPrompt !== "string") {
        throw new AiProfileValidationError("todoPrompt", "todoPrompt must be a string");
      }
      if (input.todoPrompt.length > TODO_PROMPT_MAX_LENGTH) {
        throw new AiProfileValidationError(
          "todoPrompt",
          `todoPrompt exceeds maximum length of ${TODO_PROMPT_MAX_LENGTH} characters`,
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO ai_profile_settings (
           id, user_display_name, assistant_preference, summary_language,
           todo_language, compose_language, translation_language,
           important_contacts_json, default_summary_language, default_reply_tone,
           signature_preference, custom_instructions, todo_prompt,
           worker_concurrency, created_at, updated_at
         ) VALUES (
           @id, @userDisplayName, @assistantPreference, @summaryLanguage,
           @todoLanguage, @composeLanguage, @translationLanguage,
           @importantContactsJson, @defaultSummaryLanguage, @defaultReplyTone,
           @signaturePreference, @customInstructions, @todoPrompt,
           @workerConcurrency, @now, @now
         )
         ON CONFLICT(id) DO UPDATE SET
           user_display_name = excluded.user_display_name,
           assistant_preference = excluded.assistant_preference,
           summary_language = excluded.summary_language,
           todo_language = excluded.todo_language,
           compose_language = excluded.compose_language,
           translation_language = excluded.translation_language,
           important_contacts_json = excluded.important_contacts_json,
           default_summary_language = excluded.default_summary_language,
           default_reply_tone = excluded.default_reply_tone,
           signature_preference = excluded.signature_preference,
           custom_instructions = excluded.custom_instructions,
           todo_prompt = excluded.todo_prompt,
           worker_concurrency = excluded.worker_concurrency,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: PROFILE_ID,
        userDisplayName: input.userDisplayName ?? existing?.userDisplayName ?? null,
        assistantPreference: input.assistantPreference ?? existing?.assistantPreference ?? null,
        summaryLanguage: input.summaryLanguage ?? existing?.summaryLanguage ?? null,
        todoLanguage: input.todoLanguage ?? existing?.todoLanguage ?? null,
        composeLanguage: input.composeLanguage ?? existing?.composeLanguage ?? null,
        translationLanguage: input.translationLanguage ?? existing?.translationLanguage ?? null,
        importantContactsJson: input.importantContacts
          ? JSON.stringify(input.importantContacts)
          : (existing?.importantContacts ? JSON.stringify(existing.importantContacts) : null),
        defaultSummaryLanguage: input.defaultSummaryLanguage ?? existing?.defaultSummaryLanguage ?? null,
        defaultReplyTone: input.defaultReplyTone ?? existing?.defaultReplyTone ?? null,
        signaturePreference: input.signaturePreference ?? existing?.signaturePreference ?? null,
        customInstructions: input.customInstructions ?? existing?.customInstructions ?? null,
        todoPrompt: input.todoPrompt ?? existing?.todoPrompt ?? null,
        workerConcurrency: input.workerConcurrency ?? existing?.workerConcurrency ?? null,
        now,
      });
    return this.getProfile()!;
  }

  listStyles(): WritingStyle[] {
    const rows = this.db
      .prepare("SELECT * FROM writing_styles ORDER BY created_at ASC")
      .all() as WritingStyleRow[];
    return rows.map(rowToStyle);
  }

  createStyle(input: {
    name: string;
    description?: string;
    instructions: string;
  }): WritingStyle {
    const now = this.now();
    const id = `style-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO writing_styles (
           id, name, description, instructions, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.description ?? null, input.instructions, now, now);
    return this.getStyle(id)!;
  }

  getStyle(id: string): WritingStyle | null {
    const row = this.db
      .prepare("SELECT * FROM writing_styles WHERE id = ?")
      .get(id) as WritingStyleRow | undefined;
    return row ? rowToStyle(row) : null;
  }

  updateStyle(id: string, input: {
    name?: string;
    description?: string;
    instructions?: string;
  }): WritingStyle | null {
    const existing = this.getStyle(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE writing_styles SET
           name = @name,
           description = @description,
           instructions = @instructions,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        name: input.name ?? existing.name,
        description: input.description ?? existing.description ?? null,
        instructions: input.instructions ?? existing.instructions,
        updatedAt: this.now(),
      });
    return this.getStyle(id);
  }

  deleteStyle(id: string): boolean {
    const result = this.db.prepare("DELETE FROM writing_styles WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Reset the AI profile to default values. Clears all learned preferences
   * (importantContacts, defaultSummaryLanguage, defaultReplyTone, signaturePreference)
   * while preserving explicitly set fields that are not "learned".
   * If resetLearnedOnly is true, only the learned fields are cleared;
   * otherwise the entire profile is reset.
   */
  resetProfile(options?: { resetLearnedOnly?: boolean }): AiProfileSettings | null {
    const existing = this.getProfile();
    if (!existing) return null;

    if (options?.resetLearnedOnly) {
      // Reset only learned preference fields, keep explicit user settings
      return this.saveProfile({
        ...existing,
        importantContacts: undefined,
        defaultSummaryLanguage: undefined,
        defaultReplyTone: undefined,
        signaturePreference: undefined,
      });
    }

    // Full reset: delete the profile row
    this.db
      .prepare("DELETE FROM ai_profile_settings WHERE id = ?")
      .run(PROFILE_ID);
    return null;
  }
}

function rowToProfile(row: AiProfileRow): AiProfileSettings {
  return {
    userDisplayName: row.user_display_name ?? undefined,
    assistantPreference: row.assistant_preference ?? undefined,
    summaryLanguage: row.summary_language ?? undefined,
    todoLanguage: row.todo_language ?? undefined,
    composeLanguage: row.compose_language ?? undefined,
    translationLanguage: row.translation_language ?? undefined,
    importantContacts: row.important_contacts_json
      ? JSON.parse(row.important_contacts_json) as string[]
      : undefined,
    defaultSummaryLanguage: row.default_summary_language ?? undefined,
    defaultReplyTone: row.default_reply_tone ?? undefined,
    signaturePreference: row.signature_preference ?? undefined,
    customInstructions: row.custom_instructions ?? undefined,
    todoPrompt: row.todo_prompt ?? undefined,
    workerConcurrency: row.worker_concurrency ?? undefined,
    updatedAt: row.updated_at,
  };
}

function clampWorkerConcurrency(value: number): number {
  return Math.max(AI_WORKER_CONCURRENCY_MIN, Math.min(AI_WORKER_CONCURRENCY_MAX, value));
}

function rowToStyle(row: WritingStyleRow): WritingStyle {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
