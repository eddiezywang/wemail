import type { LlmClient } from "../ai/LlmClient.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import type { AgentConversationRepository } from "./AgentConversationRepository.js";

const TITLE_MAX_LEN = 32;
const TITLE_FALLBACK_LEN = 28;
const TITLE_PROMPT =
  "Summarize this conversation in 4-10 words, no quotes, no trailing punctuation. Reply with the title only.";

export interface AgentTitleGeneratorOptions {
  conversations: AgentConversationRepository;
  llm?: LlmClient;
  /** Runtime is preferred so each title starts with the current model snapshot. */
  llmRuntime?: LlmRuntime;
  /** Model to use; if omitted, the LLM client's adapter default applies. */
  model?: string;
  /** Optional logger (Pino-shaped). */
  logger?: { warn?: (msg: string, ctx?: Record<string, unknown>) => void };
}

/**
 * Generate and persist a 4-10 word title for a fresh conversation.
 *
 * Trigger contract: callers fire-and-forget after the *first* assistant
 * message has been persisted. The generator no-ops when:
 *   - the conversation already has a non-empty title; OR
 *   - no LLM client is configured (a heuristic fallback derived from the
 *     first user message is written instead).
 *
 * Failures are non-fatal: the LLM error is logged and the conversation
 * keeps its existing (possibly NULL) title.
 */
export class AgentTitleGenerator {
  constructor(private readonly options: AgentTitleGeneratorOptions) {}

  async maybeGenerate(conversationId: string): Promise<string | null> {
    const { conversations, logger } = this.options;
    const snapshot = this.options.llmRuntime?.snapshot();
    const llm = snapshot?.client ?? this.options.llm;
    const model = snapshot?.modelFor("agent") ?? this.options.model;
    const convo = conversations.get(conversationId);
    if (!convo) return null;
    // Skip if a non-default title is already present. The previous turn
    // wrote a "first 80 chars of the user message" placeholder via
    // ensureConversation — treat any title >= TITLE_MAX_LEN or with a
    // trailing ellipsis as a placeholder we should overwrite.
    const existing = convo.title?.trim();
    if (existing && !looksLikePlaceholder(existing)) {
      return existing;
    }

    const messages = conversations.listMessages(conversationId);
    if (messages.length === 0) return null;

    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (!firstUser) return null;

    const userText = extractText(firstUser.body);
    const assistantText = firstAssistant ? extractText(firstAssistant.body) : "";

    let title: string | null = null;
    if (llm) {
      try {
        const response = await llm.generate({
          model: model ?? "default",
          system: TITLE_PROMPT,
          messages: [
            {
              role: "user",
              content: buildPromptBody(userText, assistantText),
            },
          ],
          temperature: 0.2,
          maxTokens: 32,
          timeoutMs: 15_000,
        });
        title = sanitize(response.text);
      } catch (err) {
        logger?.warn?.("agent.title.generate-failed", {
          conversationId,
          error: (err as Error).message,
        });
        title = null;
      }
    }

    if (!title) {
      title = heuristicTitle(userText);
    }
    if (!title) return null;
    conversations.setTitle(conversationId, title);
    return title;
  }
}

function buildPromptBody(userText: string, assistantText: string): string {
  const segments = [`User: ${userText.slice(0, 600)}`];
  if (assistantText) {
    segments.push(`Assistant: ${assistantText.slice(0, 600)}`);
  }
  return segments.join("\n");
}

function extractText(body: Record<string, unknown>): string {
  const text = body["text"];
  if (typeof text === "string") return text;
  return "";
}

/**
 * Strip whitespace, surrounding quotes, and trailing punctuation; cap
 * at TITLE_MAX_LEN. Returns null when nothing useful remains.
 */
function sanitize(raw: string): string | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  // Take only the first non-empty line — some models pad with prefaces.
  const firstLine = cleaned.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!firstLine) return null;
  cleaned = firstLine;
  // Strip wrapping quotes (' " “ ” ' '). Repeat to peel layered quotes.
  for (let i = 0; i < 3; i += 1) {
    const before = cleaned;
    cleaned = cleaned.replace(/^["'“”‘’`]+/, "").replace(/["'“”‘’`]+$/, "");
    if (cleaned === before) break;
  }
  // Drop common preface patterns ("Title:", "Subject -", etc.).
  cleaned = cleaned.replace(/^(title|subject|topic|summary)\s*[:\-—]\s*/i, "");
  // Trim trailing punctuation.
  cleaned = cleaned.replace(/[.!?,;:\-—\s]+$/u, "");
  cleaned = cleaned.trim();
  if (!cleaned) return null;
  if (cleaned.length > TITLE_MAX_LEN) {
    cleaned = cleaned.slice(0, TITLE_MAX_LEN).trim();
  }
  return cleaned;
}

function looksLikePlaceholder(title: string): boolean {
  // The current ensureConversation uses `userText.slice(0, 80)` as a
  // placeholder. Anything longer than our cap is by definition a
  // pre-AI placeholder we should replace.
  if (title.length > TITLE_MAX_LEN) return true;
  if (/[…]$|\.\.\.$/.test(title)) return true;
  return false;
}

function heuristicTitle(userText: string): string | null {
  const trimmed = userText.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length <= TITLE_FALLBACK_LEN) return trimmed;
  // Prefer cutting at the next word boundary.
  const slice = trimmed.slice(0, TITLE_FALLBACK_LEN);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > 8 ? slice.slice(0, lastSpace) : slice;
}
