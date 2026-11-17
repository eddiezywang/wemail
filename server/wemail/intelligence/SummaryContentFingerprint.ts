import { createHash } from "node:crypto";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { stripHtml } from "../ai/context/ContextBuilder.js";

function normalizedBody(message: Pick<MailMessage, "bodyText" | "bodyHtml">): string {
  const text = message.bodyText?.trim();
  if (text) return text.replace(/\s+/g, " ");
  return stripHtml(message.bodyHtml ?? "").replace(/\s+/g, " ").trim();
}

export function hasSummarizableBody(
  message: Pick<MailMessage, "bodyText" | "bodyHtml">,
): boolean {
  return normalizedBody(message).length > 0;
}

/** A body containing only inline images has nothing the text model can read. */
export function isImageOnlyBody(
  message: Pick<MailMessage, "bodyText" | "bodyHtml">,
): boolean {
  if (normalizedBody(message).length > 0) return false;
  return /<(?:img|svg)\b/i.test(message.bodyHtml ?? "");
}

export function summaryContentFingerprint(
  message: Pick<MailMessage, "subject" | "from" | "bodyText" | "bodyHtml">,
): string {
  const source = [
    message.subject.trim(),
    message.from.email.trim().toLowerCase(),
    message.from.name?.trim() ?? "",
    normalizedBody(message),
  ].join("\n");
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function hasMonitoringDataCandidate(
  message: Pick<MailMessage, "subject" | "bodyText" | "bodyHtml">,
): boolean {
  const rawBody = message.bodyText?.trim() || stripHtml(message.bodyHtml ?? "");
  const body = rawBody.trim();
  if (body.length < 40) return false;
  const scope = `${message.subject}\n${body}`;
  const monitoringLanguage =
    /监控|告警|调用量|失败量|成功率|延迟|耗时|状态|指标|报表|report|monitor|alert|failure|success rate|latency|metric/i
      .test(scope);
  const htmlTable = /<table[\s>]/i.test(message.bodyHtml ?? "");
  const numericTokens = body.match(/(?:^|[^\p{L}\p{N}])[-+]?\d+(?:[.,]\d+)*(?:%|ms|s|次|个|条)?/gu) ?? [];
  const rowLikeStructure = (message.bodyHtml?.match(/<tr[\s>]/gi)?.length ?? 0) >= 2 ||
    rawBody.split(/\r?\n/).filter((line) => /\d/.test(line)).length >= 2;
  return monitoringLanguage && numericTokens.length >= 2 && (htmlTable || rowLikeStructure);
}

export function summaryClaimsEmptyBody(summary: {
  headline?: string;
  bullets?: string[];
  details?: string[];
}): boolean {
  const text = [
    summary.headline ?? "",
    ...(summary.bullets ?? []),
    ...(summary.details ?? []),
  ].join(" ");
  return /正文(?:内容)?为空|未提供正文|没有正文|empty body|body is empty/i.test(text);
}
