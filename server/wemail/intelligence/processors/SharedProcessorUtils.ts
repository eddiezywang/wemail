/**
 * Shared utilities for intelligence processors and prompts.
 * Extracted from SummaryProcessor, TagProcessor, ReplyDraftProcessor
 * to reduce duplication and ensure consistent behavior.
 */

import type { WemailAddress } from "../../../../shared/wemail/mail.js";
import { stripStructuredJsonFence } from "../../ai/StructuredJsonText.js";
import {
  htmlToAiMarkdown,
  resolveAiBodyText,
} from "../../ai/context/ContextBuilder.js";

/**
 * Check whether the LLM response is wrapped in code fences.
 * Structured endpoints should return pure JSON — fenced output indicates the
 * adapter ignored response_format / forced-tool-use and needs normalization.
 */
export function looksFenced(text: string): boolean {
  return text.trim().startsWith("```");
}

/**
 * Remove one outer Markdown JSON fence when a structured-output provider
 * returns `json` inside a code block. Keep non-matching text unchanged so
 * callers still reject prose, partial fences, or other malformed payloads
 * through their normal JSON/schema validation path.
 */
export function stripJsonFence(text: string): string {
  return stripStructuredJsonFence(text);
}

/** Convert HTML-only mail into bounded-prompt-friendly Markdown. */
export function stripHtml(html: string): string {
  return htmlToAiMarkdown(html);
}

/**
 * Format a WemailAddress or raw string for display in prompts.
 */
export function formatFrom(from: WemailAddress | string | undefined): string {
  if (!from) return "(unknown sender)";
  if (typeof from === "string") return from;
  return from.name ? `${from.name} <${from.email}>` : from.email;
}

/**
 * Truncate text to a character budget with a truncation marker.
 */
export function truncateBody(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n[... truncated ...]`;
}

/**
 * Resolve the best available body text from mail fields.
 * Prefers bodyText → falls back to Markdown from bodyHtml → falls back to snippet.
 */
export function resolveBodyText(options: {
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
}): string {
  return resolveAiBodyText(options).text || options.snippet || "";
}
