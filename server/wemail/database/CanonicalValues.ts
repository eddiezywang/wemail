import { createHash } from "node:crypto";

export function parseTimestampMs(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeAddress(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeSubject(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stablePublicId(prefix: string, value: string): string {
  return `${prefix}-${sha256Text(value).slice(0, 26)}`;
}

export function normalizeRfcMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function mapFolderRole(folder: string): string {
  // Strip IMAP namespace prefixes (e.g. "[Gmail]/All Mail" -> "all mail")
  // so providers' special folders resolve by role instead of exact path.
  const normalized = folder.trim().toLowerCase().replace(/^\[[^\]]+\]\//, "");
  switch (normalized) {
    case "inbox":
    case "收件箱":
    case "受信トレイ":
    case "входящие":
      return "inbox";
    case "sent":
    case "sent items":
    case "sent mail":
    case "sent messages":
    case "已发送":
    case "已寄出":
    case "送信済み":
    case "送信済みメール":
    case "отправленные":
      return "sent";
    case "draft":
    case "drafts":
    case "草稿":
    case "下書き":
    case "черновики":
      return "drafts";
    case "trash":
    case "deleted":
    case "deleted items":
    case "已删除":
    case "已刪除":
    case "ゴミ箱":
    case "корзина":
      return "trash";
    case "junk":
    case "spam":
    case "垃圾邮件":
    case "垃圾郵件":
      return "junk";
    case "archive":
    case "archives":
    case "archived":
    case "归档":
    case "封存":
    case "アーカイブ":
    case "архив":
      return "archive";
    case "all":
    case "all mail":
      return "all";
    default:
      return "custom";
  }
}

export function encodeFlagsBits(input: {
  isSeen: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  isDraft: boolean;
}): number {
  return (
    (input.isSeen ? 1 : 0) |
    (input.isFlagged ? 2 : 0) |
    (input.isAnswered ? 4 : 0) |
    (input.isDraft ? 8 : 0)
  );
}
