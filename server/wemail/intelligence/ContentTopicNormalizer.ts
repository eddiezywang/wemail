import { PROHIBITED_CONTENT_TOPIC_NAMES } from "../ai/prompts/tagPrompt.js";

const PROHIBITED = new Set<string>(PROHIBITED_CONTENT_TOPIC_NAMES);

export interface NormalizedContentTopic {
  displayName: string;
  normalizedKey: string;
}

export function normalizeContentTopic(input: string): NormalizedContentTopic | null {
  const displayName = input
    .trim()
    .replace(/[\[【(（]?\b(?:20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\d{1,2}[-/.]\d{1,2})\b[\]】)）]?/giu, " ")
    .replace(/\b[A-Z][A-Z0-9_-]{1,12}-\d+\b/gu, " ")
    .replace(/\bv?\d+(?:\.\d+){1,3}(?:[-_][a-z0-9]+)?\b/giu, " ")
    .replace(/[“”"'`]/gu, "")
    .replace(/[\s_-]+/gu, " ")
    .replace(/^[\s:：,，.。/\\|]+|[\s:：,，.。/\\|]+$/gu, "")
    .trim();
  if (displayName.length < 2 || displayName.length > 24 || PROHIBITED.has(displayName)) {
    return null;
  }
  const normalizedKey = displayName
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·•:：,，.。/\\|()[\]【】（）]/gu, "");
  if (normalizedKey.length < 2) return null;
  return { displayName, normalizedKey };
}

