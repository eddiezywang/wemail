import type {
  AiResultMetadata,
  IntelligenceJob,
  TodoExtractionResult,
} from "../../../../shared/wemail/intelligence.js";
import { LlmClientError, type LlmClient } from "../../ai/LlmClient.js";
import { resolveAiBodyText } from "../../ai/context/ContextBuilder.js";
import { applyCustomInstructions } from "../../personalization/applyCustomInstructions.js";
import type { AiUsageRecorder } from "../../../../shared/wemail/usage.js";
import type { TodoRepository } from "../../todos/TodoRepository.js";
import { persistSuggestedTodos, type SuggestedTodos } from "../../todos/persistSuggestedTodos.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "../MailIntelligenceProcessor.js";
import { DEFAULT_TODO_MANAGEMENT_PROMPT } from "../../../../shared/wemail/settings.js";

export const TODO_EXTRACTION_LLM_TIMEOUT_MS = 25_000;

/**
 * Processor version for AiResultMetadata. Incremented on breaking changes
 * to the output schema or processing logic. Bumped to 2 in Route C / WP G
 * when per-todo evidence + extractionReason fields were added to the
 * model output and persisted to the repository. Bumped to 3 when todo
 * management moved to its own editable prompt and standalone job. Bumped to
 * 4 when Simplified Chinese became part of the todo output contract. Bumped
 * to 5 when hypothetical instructions and same-outcome duplicates were
 * explicitly excluded from todo extraction.
 */
export const TODO_EXTRACTION_PROCESSOR_VERSION = 5;

function buildTodoSystemPrompt(managementPrompt: string): string {
  return `${managementPrompt}\n\n## WeMail Output Contract\n\n` + [
    "Evaluate only the email supplied in the user message.",
    "Return todos that should be created or kept for future action; return an empty array when the email should be skipped.",
    "Do not turn hypothetical instructions into todos unless the condition is already true; phrases such as 'if your details change', 'if you want to change your selection', or 'if you later withdraw' are reference information.",
    "Create at most one todo per outcome; merge alternate channels, prerequisites, exceptions, and steps for the same outcome.",
    "Do not invent dates, owners, or tasks.",
    "Write todo titles and descriptions in Simplified Chinese; preserve product names, platform names, ticket IDs, and other identifiers verbatim.",
    "Use `dueDate` for end_time/deadlines and `startTime` for start_time.",
    "For each todo, include up to 3 short quotes or direct paraphrases in `evidence` and one sentence in `extractionReason`.",
    "Keep each evidence string under 200 characters.",
    "Respond only with JSON matching the provided schema.",
  ].join(" ");
}

export const TODO_EXTRACTION_SYSTEM_PROMPT = Object.freeze(
  buildTodoSystemPrompt(DEFAULT_TODO_MANAGEMENT_PROMPT),
) as string;

export const TODO_EXTRACTION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["todos"],
  properties: {
    todos: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "dueDate",
          "startTime",
          "confidence",
          "evidence",
          "extractionReason",
        ],
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          dueDate: { type: ["string", "null"] },
          startTime: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: ["array", "null"],
            maxItems: 3,
            items: { type: "string", maxLength: 200 },
          },
          extractionReason: { type: ["string", "null"], maxLength: 240 },
        },
      },
    },
  },
}) as Record<string, unknown>;

/**
 * Phrases that are ambiguous or vague and should NOT be used as due dates.
 * The AI is instructed to avoid these, but we also strip them as a safety net.
 */
const AMBIGUOUS_DUE_DATE_PATTERNS: readonly RegExp[] = [
  /^soon$/i,
  /^asap$/i,
  /^as\s+soon\s+as\s+possible$/i,
  /^when\s+possible$/i,
  /^when\s+you\s+can$/i,
  /^when\s+you\s+get\s+a\s+chance$/i,
  /^at\s+some\s+point$/i,
  /^sometime$/i,
  /^eventually$/i,
  /^in\s+a\s+while$/i,
  /^later$/i,
  /^at\s+your\s+earliest\s+convenience$/i,
  /^whenever$/i,
  /^anytime$/i,
  /^no\s+rush$/i,
  /^not\s+urgent$/i,
  /^when\s+convenient$/i,
];

/**
 * Check if a due date string is ambiguous/vague and should be stripped.
 * Returns true if the date phrase is ambiguous, false if it appears to be
 * an explicit or strongly implied date.
 */
export function isAmbiguousDueDate(dueDate: string): boolean {
  const trimmed = dueDate.trim();
  if (!trimmed) return false;

  // ISO date pattern (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS) is always explicit
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;

  // Named days of week are explicit enough
  if (/^(this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(trimmed)) return false;
  if (/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(trimmed)) return false;

  // "tomorrow", "today" are explicit enough
  if (/^(tomorrow|today)$/i.test(trimmed)) return false;

  // "by end of week", "by Friday", "by X" patterns are explicit
  if (/^by\s+/i.test(trimmed)) return false;

  // "end of week/month" patterns are explicit enough
  if (/^end\s+of\s+(the\s+)?(week|month|quarter|year)/i.test(trimmed)) return false;

  // Check against ambiguous patterns
  for (const pattern of AMBIGUOUS_DUE_DATE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * Normalize a todo title for deduplication purposes.
 * Collapses whitespace, trims, and lowercases.
 */
export function normalizeTodoTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface TodoExtractionProcessorDeps {
  llmClient: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  todos?: TodoRepository;
  persistTodos?: (accountId: string, emailId: string, todos: SuggestedTodos) => SuggestedTodos | Promise<SuggestedTodos>;
  logger?: (event: string, fields: Record<string, string | number>) => void;
  usage?: AiUsageRecorder;
  now?: () => number;
  timeoutMs?: number;
  /** upstream-parity F4: per-call lookup of user's free-form custom instructions. */
  getCustomInstructions?: () => string | undefined;
  /** Editable instructions scoped to todo management only. */
  getTodoPrompt?: () => string | undefined | Promise<string | undefined>;
}

export class TodoExtractionProcessorError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "TodoExtractionProcessorError";
    this.retryable = retryable;
  }
}

function buildUserMessage(input: {
  subject: string;
  from: string;
  bodyText?: string;
  bodyHtml?: string;
}): string {
  const body = resolveAiBodyText(input).text.trim();
  return [
    "Extract todos from this email.",
    "",
    `Subject: ${input.subject || "(no subject)"}`,
    `From: ${input.from || "(unknown sender)"}`,
    "",
    "Body:",
    body.slice(0, 6000) || "(empty body)",
  ].join("\n");
}

/**
 * Coerce an LLM-supplied `evidence` array into a clean `string[]`.
 * - Drops non-string entries and empty strings.
 * - Caps each string at 200 chars (matches the schema `maxLength`).
 * - Caps the array at 3 items.
 * Returns `undefined` when the field is absent or yields no usable items.
 */
function coerceEvidence(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    cleaned.push(trimmed.slice(0, 200));
    if (cleaned.length >= 3) break;
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

function validate(parsed: unknown): Omit<TodoExtractionResult, "type"> {
  if (typeof parsed !== "object" || parsed === null) {
    throw new TodoExtractionProcessorError("response-not-object", false);
  }
  const todos = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    throw new TodoExtractionProcessorError("todos-not-array", false);
  }
  return {
    todos: todos
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => {
        // Normalize title: trim and collapse whitespace
        const rawTitle = typeof item.title === "string" ? item.title.trim().replace(/\s+/g, " ") : "";
        const rawDueDate = typeof item.dueDate === "string" && item.dueDate.trim()
          ? item.dueDate.trim()
          : undefined;
        const rawReason =
          typeof item.extractionReason === "string" && item.extractionReason.trim()
            ? item.extractionReason.trim().slice(0, 240)
            : undefined;
        const confidence =
          typeof item.confidence === "number" && Number.isFinite(item.confidence)
            ? Math.max(0, Math.min(1, item.confidence))
            : 0;

        return {
          title: rawTitle,
          description:
            typeof item.description === "string" && item.description.trim()
              ? item.description.trim()
              : undefined,
          // Conservative due dates: strip ambiguous phrases
          dueDate: rawDueDate && !isAmbiguousDueDate(rawDueDate) ? rawDueDate : undefined,
          startTime:
            typeof item.startTime === "string" && item.startTime.trim()
              ? item.startTime.trim()
              : undefined,
          confidence,
          // Route C / WP G: model confidence doubles as the extraction
          // confidence persisted alongside the rationale + evidence.
          extractionConfidence: confidence,
          evidence: coerceEvidence(item.evidence),
          extractionReason: rawReason,
          // AI todos are ALWAYS suggested, never auto-confirmed
          status: "suggested" as const,
        };
      })
      .filter((todo) => todo.title.length > 0),
  };
}

export class TodoExtractionProcessor implements MailIntelligenceProcessor {
  readonly type = "todoExtraction" as const;
  private readonly llmClient: LlmClient;
  private readonly model: string;
  private readonly provider?: string;
  private readonly persistTodos: NonNullable<TodoExtractionProcessorDeps["persistTodos"]>;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRecorder;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly getCustomInstructions?: () => string | undefined;
  private readonly getTodoPrompt?: TodoExtractionProcessorDeps["getTodoPrompt"];

  constructor(deps: TodoExtractionProcessorDeps) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    if (!deps.persistTodos && !deps.todos) throw new Error("todo-persistence-required");
    this.persistTodos = deps.persistTodos ?? ((accountId, emailId, todos) =>
      persistSuggestedTodos(deps.todos!, accountId, emailId, todos));
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? TODO_EXTRACTION_LLM_TIMEOUT_MS;
    this.getCustomInstructions = deps.getCustomInstructions;
    this.getTodoPrompt = deps.getTodoPrompt;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<TodoExtractionResult> {
    const started = this.now();
    const mail = ctx.getMessage(job.emailId);
    if (!mail) throw new TodoExtractionProcessorError("mail-missing", false);

    let response;
    try {
      response = await this.llmClient.generate({
        model: this.model,
        system: applyCustomInstructions(
          buildTodoSystemPrompt(
            (await this.getTodoPrompt?.())?.trim() || DEFAULT_TODO_MANAGEMENT_PROMPT,
          ),
          this.getCustomInstructions?.(),
        ),
        messages: [
          {
            role: "user",
            content: buildUserMessage({
              subject: mail.subject,
              from: mail.from.name ? `${mail.from.name} <${mail.from.email}>` : mail.from.email,
              bodyText: mail.bodyText,
              bodyHtml: mail.bodyHtml,
            }),
          },
        ],
        jsonSchema: TODO_EXTRACTION_JSON_SCHEMA,
        temperature: 0.1,
        maxTokens: 4096,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const code =
        error instanceof LlmClientError
          ? (error.code ?? `http-${error.status ?? 0}`)
          : "unknown";
      this.logger("todoExtraction-llm-error", {
        emailId: job.emailId,
        type: "todoExtraction",
        durationMs: this.now() - started,
        model: this.model,
        code,
      });
      throw error;
    }

    if (response.finishReason === "length") {
      throw new TodoExtractionProcessorError("truncated", false);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new TodoExtractionProcessorError("response-not-json", false);
    }

    const validated = validate(parsed);

    const persisted = await this.persistTodos(mail.accountId, job.emailId, validated.todos);

    const duration = this.now() - started;
    this.logger("todoExtraction-ok", {
      emailId: job.emailId,
      type: "todoExtraction",
      count: persisted.length,
      durationMs: duration,
      model: this.model,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    });
    await this.usage?.record({
      accountId: mail.accountId,
      category: "todo",
      processor: "todoExtraction",
      emailId: job.emailId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      model: this.model,
      provider: this.provider,
      durationMs: duration,
    });

    const metadata: AiResultMetadata = {
      processor: "todoExtraction",
      version: TODO_EXTRACTION_PROCESSOR_VERSION,
      model: this.model,
      contextRefs: [`email:${job.emailId}`],
      createdAt: new Date(started).toISOString(),
      durationMs: duration,
      tokenUsage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };

    return { type: "todoExtraction", todos: persisted, _metadata: metadata };
  }
}
