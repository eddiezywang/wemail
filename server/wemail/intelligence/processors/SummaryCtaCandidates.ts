import type { SummaryCta } from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import { computeRiskSignals } from "./LinkExtractionProcessor.js";

const ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const IMAGE_ALT_PATTERN = /<img\b[^>]*\b(?:alt|title)\s*=\s*["']([^"']+)["'][^>]*>/i;
const BUTTON_TEXT_PATTERN = /^(?:activate|book|buy|shop|view|open|review|confirm|verify|approve|sign|join|download|pay|register|reserve|claim|discover|start|try|renew|manage|track|learn more|立即|查看|处理|确认|验证|审批|签署|加入|下载|支付|报名|预约|激活|预订|购买|领取|续费)(?:\b|\s|$)/i;
const NON_CONTENT_LABEL_PATTERN = /^(?:hotels?(?:\s*&\s*homes)?|homes?|flights?|deals?|activities|airport transfer|support|help|privacy|terms|preferences|settings|profile|view (?:in )?(?:browser|online)|web version|manage preferences|酒店|机票|优惠|活动|帮助|隐私|条款|网页查看|浏览器查看)$/i;
const NON_CONTENT_LINK_TYPES = new Set([
  "logo",
  "vip",
  "rthp",
  "flights",
  "deals",
  "activities",
  "airporttransfer",
]);
const NON_CONTENT_SUFFIXES = ["image", "title", "body"];
const MAX_CANDIDATES = 6;

export interface SummaryCtaCandidate {
  i: number;
  t: string;
  d?: string;
  b?: string;
  url: string;
  risk: boolean;
  riskReasons: SummaryCta["riskReasons"];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 10)));
}

function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedLinkType(url: URL): string {
  return (url.searchParams.get("linkType") ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isNonContentLink(label: string, linkType: string): boolean {
  if (NON_CONTENT_LINK_TYPES.has(linkType)) return true;
  if (NON_CONTENT_LABEL_PATTERN.test(label.trim())) return true;
  return /(?:unsubscribe|退订)/i.test(label);
}

function isButtonCandidate(label: string, linkType: string): boolean {
  if (linkType.endsWith("button")) return true;
  if (NON_CONTENT_SUFFIXES.some((suffix) => linkType.endsWith(suffix))) return false;
  return label.length > 0 && label.length <= 48 && BUTTON_TEXT_PATTERN.test(label);
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Extract a small set of real content buttons before the summary call. This is
 * deliberately conservative: image wrappers, brand chrome, membership badges,
 * global navigation, and descriptive title/body links never become candidates.
 */
export function extractSummaryCtaCandidates(
  mail: Pick<MailMessage, "bodyHtml">,
): SummaryCtaCandidate[] {
  const html = mail.bodyHtml ?? "";
  if (!html) return [];

  const candidates: SummaryCtaCandidate[] = [];
  const seenUrls = new Set<string>();
  let recentContent: string[] = [];

  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const rawUrl = decodeEntities(match[1] ?? "").trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;

    const anchorHtml = match[2] ?? "";
    const imageAlt = decodeEntities(anchorHtml.match(IMAGE_ALT_PATTERN)?.[1] ?? "").trim();
    const label = compactText(visibleText(anchorHtml) || imageAlt, 160);
    const linkType = normalizedLinkType(parsedUrl);

    if (isNonContentLink(label, linkType)) {
      recentContent = [];
      continue;
    }

    if (!isButtonCandidate(label, linkType)) {
      if (label && !linkType.endsWith("image")) {
        recentContent.push(label);
        recentContent = recentContent.slice(-2);
      }
      continue;
    }
    if (seenUrls.has(rawUrl)) continue;
    seenUrls.add(rawUrl);

    const title = compactText(recentContent[0] ?? label, 100);
    const description = recentContent[1] && recentContent[1] !== title
      ? compactText(recentContent[1], 140)
      : undefined;
    const risk = computeRiskSignals({ url: rawUrl, actionText: label });
    candidates.push({
      i: candidates.length,
      t: title,
      ...(description ? { d: description } : {}),
      ...(label && label !== title ? { b: compactText(label, 48) } : {}),
      url: rawUrl,
      risk: risk.risk,
      riskReasons: risk.riskReasons,
    });
    recentContent = [];
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

export function formatSummaryCtaCandidates(candidates: SummaryCtaCandidate[]): string {
  if (candidates.length === 0) return "";
  const compact = candidates.map(({ i, t, d, b }) => ({
    i,
    t,
    ...(d ? { d } : {}),
    ...(b ? { b } : {}),
  }));
  return `\n\nCTA candidates (local indexes; no URLs):\n${JSON.stringify({ ctas: compact })}`;
}

export function restoreSelectedCtas(
  value: unknown,
  candidates: SummaryCtaCandidate[],
): SummaryCta[] {
  if (!Array.isArray(value) || candidates.length === 0) return [];
  const byIndex = new Map(candidates.map((candidate) => [candidate.i, candidate]));
  const seen = new Set<number>();
  const restored: SummaryCta[] = [];

  for (const item of value.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (!Number.isInteger(row.i) || seen.has(row.i as number)) continue;
    const candidate = byIndex.get(row.i as number);
    const label = typeof row.l === "string" ? compactText(row.l, 48) : "";
    const confidence = row.c === "h" || row.c === "m" || row.c === "l" ? row.c : null;
    if (!candidate || !label || !confidence) continue;
    seen.add(candidate.i);
    restored.push({
      url: candidate.url,
      label,
      confidence,
      risk: candidate.risk,
      riskReasons: candidate.riskReasons,
      category: "action",
    });
  }
  return restored;
}
