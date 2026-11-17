import type {
  AiResultMetadata,
  IntelligenceJob,
  TranslationParagraph,
  TranslationResult,
} from "../../../../shared/wemail/intelligence.js";
import { LlmClientError, type LlmClient } from "../../ai/LlmClient.js";
import { resolveAiBodyText } from "../../ai/context/ContextBuilder.js";
import { applyCustomInstructions } from "../../personalization/applyCustomInstructions.js";
import type { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import { TranslationCacheRepository, hashContent } from "../TranslationCacheRepository.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "../MailIntelligenceProcessor.js";

export const TRANSLATION_LLM_TIMEOUT_MS = 30_000;

/**
 * Processor version for AiResultMetadata and cache keying.
 * Incremented on breaking changes to the output schema or processing logic.
 */
export const TRANSLATION_PROCESSOR_VERSION = 2;

/**
 * Maximum characters per segment for segmented translation.
 * Keeps each LLM call well within token limits.
 */
export const SEGMENT_CHAR_LIMIT = 6000;

export const TRANSLATION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["translatedText"],
  properties: {
    translatedText: { type: "string" },
  },
}) as Record<string, unknown>;

export interface TranslationProcessorDeps {
  llmClient: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  logger?: (event: string, fields: Record<string, string | number>) => void;
  usage?: AiUsageRepository;
  now?: () => number;
  timeoutMs?: number;
  /** Cache repository for avoiding duplicate LLM calls. */
  cache?: TranslationCacheRepository;
  /** Default target language from user profile. Used when job omits targetLanguage. */
  defaultTargetLanguage?: string;
  /** upstream-parity F4: per-call lookup of user's free-form custom instructions. */
  getCustomInstructions?: () => string | undefined;
}

export class TranslationProcessorError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "TranslationProcessorError";
    this.retryable = retryable;
  }
}

/* ---------------------------------------------------------------- *
 * Protected-token masking / restoration                            *
 *                                                                  *
 * Before sending text to the LLM, mask URLs, email addresses,     *
 * code blocks, and tracking IDs with stable placeholders. After    *
 * the LLM responds, restore the originals so they remain unchanged.*
 * ---------------------------------------------------------------- */

interface MaskEntry {
  placeholder: string;
  original: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const TRACKING_ID_RE = /\b[A-Z]{2,5}-\d{4,10}\b/g;

/**
 * Mask protected tokens in source text, returning the masked text
 * and an ordered list of mask entries for restoration.
 */
export function maskProtectedTokens(text: string): {
  masked: string;
  entries: MaskEntry[];
} {
  const entries: MaskEntry[] = [];
  let counter = 0;

  function addEntry(original: string): string {
    const placeholder = `__PROT${counter}__`;
    entries.push({ placeholder, original });
    counter++;
    return placeholder;
  }

  // Order matters: code blocks first (they may contain URLs/emails)
  let masked = text;

  masked = masked.replace(CODE_BLOCK_RE, (match) => addEntry(match));
  masked = masked.replace(INLINE_CODE_RE, (match) => addEntry(match));
  masked = masked.replace(URL_RE, (match) => addEntry(match));
  masked = masked.replace(EMAIL_RE, (match) => addEntry(match));
  masked = masked.replace(TRACKING_ID_RE, (match) => addEntry(match));

  return { masked, entries };
}

/**
 * Restore masked tokens in translated text using the mask entries.
 */
export function restoreProtectedTokens(
  translated: string,
  entries: MaskEntry[],
): string {
  let result = translated;
  for (const { placeholder, original } of entries) {
    // Case-insensitive replacement — LLM may change placeholder casing
    result = result.replace(
      new RegExp(escapeRegExp(placeholder), "gi"),
      original,
    );
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a single long paragraph into sub-segments that each fit within
 * charLimit. Tries sentence boundaries first; falls back to hard-split
 * at charLimit boundaries when a single "sentence" still exceeds the limit.
 */
export function splitLongParagraph(text: string, charLimit: number): string[] {
  const segments: string[] = [];
  // Try splitting on sentence boundaries first
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n/);
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > charLimit) {
      if (current) segments.push(current);
      // If single sentence exceeds limit, hard-split it
      if (sentence.length > charLimit) {
        for (let i = 0; i < sentence.length; i += charLimit) {
          segments.push(sentence.slice(i, i + charLimit));
        }
        current = "";
      } else {
        current = sentence;
      }
    } else {
      current = current ? current + " " + sentence : sentence;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/* ---------------------------------------------------------------- *
 * Segmentation                                                      *
 *                                                                  *
 * Split long mail into segments at paragraph boundaries to avoid   *
 * token-limit failures. Each segment is translated separately and   *
 * results are recombined in order.                                  *
 * ---------------------------------------------------------------- */

/**
 * Split text into segments at paragraph boundaries, respecting the
 * character limit. Each segment is a non-empty string.
 * Returns an object with segments and a flag indicating whether any
 * oversized paragraph was split.
 */
export function segmentText(text: string, charLimit: number = SEGMENT_CHAR_LIMIT): { segments: string[]; hadOversizedSplit: boolean } {
  if (!text.trim()) return { segments: [], hadOversizedSplit: false };

  const paragraphs = text.split(/\n\s*\n/);
  const segments: string[] = [];
  let current = "";
  let hadOversizedSplit = false;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // If adding this paragraph exceeds the limit and we already have content,
    // flush the current segment and start a new one.
    if (current && (current.length + 2 + trimmed.length) > charLimit) {
      segments.push(current);
      current = trimmed;
    } else if (current) {
      current += "\n\n" + trimmed;
    } else {
      current = trimmed;
    }

    // If a single paragraph exceeds the limit, split it further by sentences
    if (current.length > charLimit && current === trimmed) {
      const subSegments = splitLongParagraph(current, charLimit);
      segments.push(...subSegments);
      hadOversizedSplit = true;
      current = "";
    }
  }

  if (current) {
    segments.push(current);
  }

  return { segments, hadOversizedSplit };
}

/**
 * Build paragraph mappings from source and translated text.
 * Splits both by paragraph breaks and pairs them by index.
 */
export function buildParagraphMappings(
  source: string,
  translated: string,
): TranslationParagraph[] {
  const sourceParas = source.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const translatedParas = translated.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const count = Math.max(sourceParas.length, translatedParas.length);
  const paragraphs: TranslationParagraph[] = [];

  for (let i = 0; i < count; i++) {
    paragraphs.push({
      index: i,
      source: sourceParas[i] ?? "",
      translated: translatedParas[i] ?? "",
    });
  }

  return paragraphs;
}

/* ---------------------------------------------------------------- *
 * Target language resolution                                        *
 * ---------------------------------------------------------------- */

function targetLanguageFor(job: IntelligenceJob, defaultLanguage?: string): string {
  const value = job.payload?.targetLanguage;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (defaultLanguage && defaultLanguage.trim()) return defaultLanguage.trim();
  throw new TranslationProcessorError("targetLanguage-missing", false);
}

/* ---------------------------------------------------------------- *
 * TranslationProcessor                                              *
 * ---------------------------------------------------------------- */

export class TranslationProcessor implements MailIntelligenceProcessor {
  readonly type = "translation" as const;
  private readonly llmClient: LlmClient;
  private readonly model: string;
  private readonly provider?: string;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRepository;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache?: TranslationCacheRepository;
  private readonly defaultTargetLanguage?: string;
  private readonly getCustomInstructions?: () => string | undefined;

  constructor(deps: TranslationProcessorDeps) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? TRANSLATION_LLM_TIMEOUT_MS;
    this.cache = deps.cache;
    this.defaultTargetLanguage = deps.defaultTargetLanguage;
    this.getCustomInstructions = deps.getCustomInstructions;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<TranslationResult> {
    const started = this.now();
    const targetLanguage = targetLanguageFor(job, this.defaultTargetLanguage);
    const mail = ctx.getMessage(job.emailId);
    if (!mail) throw new TranslationProcessorError("mail-missing", false);
    const body = resolveAiBodyText(mail).text.trim();

    // ── Cache lookup ─────────────────────────────────────────────
    if (this.cache) {
      const sourceContentHash = hashContent(body);
      const cached = this.cache.find({
        accountId: mail.accountId,
        emailId: job.emailId,
        targetLanguage,
        processorVersion: TRANSLATION_PROCESSOR_VERSION,
        sourceContentHash,
      });
      if (cached) {
        this.logger("translation-cache-hit", {
          emailId: job.emailId,
          type: "translation",
          durationMs: this.now() - started,
        });
        return this.cache.toResult(cached);
      }
    }

    // ── Mask protected tokens ────────────────────────────────────
    const { masked, entries } = maskProtectedTokens(body);

    // ── Segment and translate ────────────────────────────────────
    const { segments, hadOversizedSplit } = segmentText(masked);
    let translatedFull: string;

    if (segments.length <= 1) {
      // Single segment (most common case) or empty body
      translatedFull = await this.translateSegment(
        segments[0] || "(empty body)",
        targetLanguage,
        job.emailId,
        started,
      );
    } else {
      // Multi-segment translation
      const translatedSegments: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const segmentResult = await this.translateSegment(
          segments[i],
          targetLanguage,
          job.emailId,
          started,
          i,
        );
        translatedSegments.push(segmentResult);
      }
      translatedFull = translatedSegments.join("\n\n");
    }

    // ── Restore protected tokens ─────────────────────────────────
    translatedFull = restoreProtectedTokens(translatedFull, entries);

    // ── Build paragraph mappings ─────────────────────────────────
    const paragraphs = buildParagraphMappings(body, translatedFull);

    // ── Build result ─────────────────────────────────────────────
    const duration = this.now() - started;

    const metadata: AiResultMetadata = {
      processor: "translation",
      version: TRANSLATION_PROCESSOR_VERSION,
      model: this.model,
      contextRefs: ["body-text"],
      createdAt: new Date(started).toISOString(),
      durationMs: duration,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    };

    const result: TranslationResult = {
      type: "translation",
      targetLanguage,
      translatedText: translatedFull,
      cached: false,
      paragraphs: paragraphs.length > 0 ? paragraphs : undefined,
      _metadata: {
        ...metadata,
        ...(hadOversizedSplit ? { truncated: true } : {}),
      },
    };

    // ── Save to cache ────────────────────────────────────────────
    if (this.cache) {
      const sourceContentHash = hashContent(body);
      this.cache.save({
        accountId: mail.accountId,
        emailId: job.emailId,
        targetLanguage,
        processorVersion: TRANSLATION_PROCESSOR_VERSION,
        sourceContentHash,
        translatedText: translatedFull,
        paragraphs: paragraphs,
        model: this.model,
        createdAt: new Date().toISOString(),
      });
    }

    this.logger("translation-ok", {
      emailId: job.emailId,
      type: "translation",
      durationMs: duration,
      model: this.model,
    });
    this.usage?.record({
      accountId: mail.accountId,
      category: "translation",
      processor: "translation",
      emailId: job.emailId,
      inputTokens: 0,
      outputTokens: 0,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });

    return result;
  }

  /**
   * Translate a single text segment via the LLM.
   */
  private async translateSegment(
    text: string,
    targetLanguage: string,
    emailId: string,
    startedAt: number,
    segmentIndex?: number,
  ): Promise<string> {
    // Pre-check: reject segments that exceed the hard limit instead of silently truncating
    const MAX_SEGMENT_CHARS = 12000;
    if (text.length > MAX_SEGMENT_CHARS) {
      throw new TranslationProcessorError(
        `Segment too long (${text.length} chars, max ${MAX_SEGMENT_CHARS})`,
        false, // non-retryable
      );
    }

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: applyCustomInstructions(
          [
            "You are WeMail's email translation assistant.",
            `Translate the email body to ${targetLanguage}.`,
            "Preserve meaning and paragraph breaks.",
            "Do NOT translate placeholders that look like __PROT0__, __PROT1__, etc. — leave them exactly as they are.",
            "Respond only with JSON matching the schema.",
          ].join(" "),
          this.getCustomInstructions?.(),
        ),
        messages: [
          {
            role: "user",
            content: text || "(empty body)",
          },
        ],
        jsonSchema: TRANSLATION_JSON_SCHEMA,
        temperature: 0.1,
        maxTokens: 4096,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const code =
        error instanceof LlmClientError
          ? (error.code ?? `http-${error.status ?? 0}`)
          : "unknown";
      this.logger("translation-llm-error", {
        emailId,
        type: "translation",
        durationMs: this.now() - startedAt,
        model: this.model,
        code,
        segment: segmentIndex ?? 0,
      });
      throw error;
    }

    if (response.finishReason === "length") {
      throw new TranslationProcessorError("truncated", false);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new TranslationProcessorError("response-not-json", false);
    }
    const translatedText =
      typeof (parsed as { translatedText?: unknown }).translatedText === "string"
        ? (parsed as { translatedText: string }).translatedText
        : "";
    if (!translatedText.trim()) {
      throw new TranslationProcessorError("translatedText-missing", false);
    }

    return translatedText;
  }
}
