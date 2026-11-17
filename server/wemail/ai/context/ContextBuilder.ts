import type {
  ContextBuildResult,
  ContextBuilderInput,
  ContextSection,
  IntelligenceJobType,
} from "../../../../shared/wemail/intelligence.js";
import {
  htmlToAiMarkdown,
  resolveAiBodyText,
} from "../../../../shared/wemail/aiMailText.js";

export { htmlToAiMarkdown, resolveAiBodyText };

/**
 * Default character budget for body text. Mirrors the existing
 * BODY_CHAR_BUDGET constants in summaryPrompt.ts and tagPrompt.ts.
 */
export const DEFAULT_BODY_CHAR_BUDGET = 8000;

/**
 * CJK-aware rough token estimation. Latin/digits ≈ 4 chars per token,
 * CJK/fullwidth/Hangul/Kana chars ≈ 1 token each (real tokenizers
 * split CJK per character or per bigram). Actual tokenization depends
 * on the model's tokenizer — this is only for pre-call truncation
 * budgets and log metadata; billing uses the LLM API `usage` values.
 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\u3040-\u30FF\uAC00-\uD7AF]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK_RE)?.length ?? 0;
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
}

/** @deprecated Use htmlToAiMarkdown for new AI context code. */
export const stripHtml = htmlToAiMarkdown;

export interface ContextBuilderOptions {
  /** The AI feature this context is being built for. */
  feature: IntelligenceJobType;
  /** Maximum characters for body content. Defaults to DEFAULT_BODY_CHAR_BUDGET. */
  bodyCharBudget?: number;
}

/**
 * ContextBuilder owns truncation, redaction, section ids, token
 * estimates, and contextRefs for AI feature context.
 *
 * The build result's metadata (sections, contextRefs, tokenEstimate)
 * is safe for logging. The promptText is NOT safe for logging — it
 * contains mail body content.
 */
export class ContextBuilder {
  private readonly feature: IntelligenceJobType;
  private readonly bodyCharBudget: number;

  constructor(options: ContextBuilderOptions) {
    this.feature = options.feature;
    this.bodyCharBudget = options.bodyCharBudget ?? DEFAULT_BODY_CHAR_BUDGET;
  }

  build(input: ContextBuilderInput): ContextBuildResult {
    const sections: ContextSection[] = [];
    const parts: string[] = [];
    let truncated = false;

    // Header section — always present
    const headerParts: string[] = [];
    const subject = (input.subject ?? "(no subject)").trim() || "(no subject)";
    headerParts.push(`Subject: ${subject}`);
    if (input.from) {
      headerParts.push(`From: ${input.from}`);
    }
    const headerText = headerParts.join("\n");
    sections.push({
      id: "header",
      tokenEstimate: estimateTokens(headerText),
    });
    parts.push(headerText);
    parts.push("");

    // Body section — feature-specific logic
    const bodySource = this.selectBodySource(input);
    if (bodySource.text) {
      const trimmedText = this.truncateBody(bodySource.text);
      if (trimmedText.truncated) {
        truncated = true;
      }
      sections.push({
        id: bodySource.sectionId,
        tokenEstimate: estimateTokens(trimmedText.text),
      });
      parts.push("Body:");
      parts.push(trimmedText.text || "(empty body)");
    } else {
      parts.push("Body:");
      parts.push("(empty body)");
    }

    // Snippet section for tag feature (when snippet is provided separately)
    if (this.feature === "tags" && input.snippet && bodySource.sectionId !== "snippet") {
      const snippetText = input.snippet.trim();
      if (snippetText) {
        sections.push({
          id: "snippet",
          tokenEstimate: estimateTokens(snippetText),
        });
        parts.push("");
        parts.push(`Snippet: ${snippetText}`);
      }
    }

    const promptText = parts.join("\n");
    const contextRefs = sections.map((s) => s.id);
    const totalTokenEstimate = sections.reduce(
      (sum, s) => sum + s.tokenEstimate,
      0,
    );

    return {
      promptText,
      sections,
      contextRefs,
      totalTokenEstimate,
      truncated,
    };
  }

  /**
   * Select the best body source based on feature and available data.
   */
  private selectBodySource(
    input: ContextBuilderInput,
  ): { text: string; sectionId: string } {
    const body = resolveAiBodyText(input);
    if (body.text) return body;
    // Fall back to snippet (especially for tags feature)
    if (input.snippet && input.snippet.trim().length > 0) {
      return { text: input.snippet, sectionId: "snippet" };
    }
    return body;
  }

  /**
   * Truncate body text to fit within the character budget.
   */
  private truncateBody(text: string): { text: string; truncated: boolean } {
    if (text.length <= this.bodyCharBudget) {
      return { text, truncated: false };
    }
    return {
      text: `${text.slice(0, this.bodyCharBudget)}\n[... truncated ...]`,
      truncated: true,
    };
  }
}
