import type { ApplicationMessageContentBlock } from "../../../shared/wemail/applicationMessages.js";

const MAX_TEXT = 20_000;

export function normalizeApplicationMessageContent(input: unknown): ApplicationMessageContentBlock[] {
  if (typeof input === "string") return markdownToBlocks(input);
  if (!Array.isArray(input)) throw new Error("invalid-application-message-content");
  return input.map(normalizeBlock);
}

function normalizeBlock(value: unknown): ApplicationMessageContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("invalid-application-message-content");
  const text = (field: string) => cleanText(value[field]);
  if (value.type === "heading") {
    const level = value.level === 2 || value.level === 3 ? value.level : 1;
    return { type: "heading", level, text: text("text") };
  }
  if (value.type === "paragraph") return { type: "paragraph", text: text("text") };
  if (value.type === "list") {
    if (!Array.isArray(value.items)) throw new Error("invalid-application-message-content");
    return { type: "list", ordered: value.ordered === true, items: value.items.slice(0, 200).map(cleanText) };
  }
  if (value.type === "table") {
    if (!Array.isArray(value.headers) || !Array.isArray(value.rows)) throw new Error("invalid-application-message-content");
    return {
      type: "table",
      headers: value.headers.slice(0, 20).map(cleanText),
      rows: value.rows.slice(0, 200).map((row) => {
        if (!Array.isArray(row)) throw new Error("invalid-application-message-content");
        return row.slice(0, 20).map(cleanText);
      }),
    };
  }
  if (value.type === "callout") {
    const tone = normalizeTone(value.tone);
    return { type: "callout", tone, title: value.title === undefined ? undefined : cleanText(value.title), text: text("text") };
  }
  if (value.type === "status") {
    return { type: "status", label: text("label"), value: text("value"), tone: value.tone === undefined ? undefined : normalizeTone(value.tone) };
  }
  throw new Error("invalid-application-message-content");
}

function markdownToBlocks(markdown: string): ApplicationMessageContentBlock[] {
  const safe = cleanText(markdown);
  const blocks: ApplicationMessageContentBlock[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push({ type: "list", ordered: false, items: list.splice(0) }); };
  for (const raw of safe.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! }); continue; }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) { list.push(item[1]!); continue; }
    flush();
    blocks.push({ type: "paragraph", text: line });
  }
  flush();
  return blocks.slice(0, 500);
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid-application-message-content");
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[[^\]]*\]\((?:javascript:|data:|https?:)[^)]+\)/gi, "[已移除不安全链接]")
    .slice(0, MAX_TEXT);
}

function normalizeTone(value: unknown): "info" | "success" | "warning" | "error" {
  return value === "success" || value === "warning" || value === "error" ? value : "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
