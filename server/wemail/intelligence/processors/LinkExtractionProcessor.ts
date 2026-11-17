import type {
  AiResultMetadata,
  IntelligenceJob,
  LinkExtractionResult,
} from "../../../../shared/wemail/intelligence.js";
import type { LlmClient } from "../../ai/LlmClient.js";
import { stripStructuredJsonFence as stripJsonFence } from "../../ai/StructuredJsonText.js";
import type { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import {
  LINK_SELECTION_JSON_SCHEMA,
  LINK_SELECTION_SYSTEM_PROMPT,
  buildLinkSelectionUserMessage,
} from "../../ai/prompts/linkExtractionPrompt.js";
import type {
  MailIntelligenceProcessor,
  ProcessorContext,
} from "../MailIntelligenceProcessor.js";

/**
 * Processor version for AiResultMetadata. Bump on breaking changes to
 * the link-extraction output shape, the risk signal vocabulary, or the
 * selection prompt.
 */
export const LINK_EXTRACTION_PROCESSOR_VERSION = 6;

export class LinkExtractionProcessorError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "LinkExtractionProcessorError";
    this.retryable = retryable;
  }
}

// ── Risk signal constants ────────────────────────────────────────

/** Domains known to be used for phishing/impersonation. */
export const SUSPICIOUS_DOMAINS = new Set([
  "paypa1.com",
  "paypa1.me",
  "paypaI.com",
  "g00gle.com",
  "g00g1e.com",
  "faceb00k.com",
  "faceb0ok.com",
  "app1e.com",
  "app1e-id.com",
  "micr0soft.com",
  "micros0ft.com",
  "arnaz0n.com",
  "amaz0n.com",
  "netfl1x.com",
  "netf1ix.com",
  "dropbx.com",
  "chase-bank.com",
  "wellsfarg0.com",
  "bankofamer1ca.com",
]);

/** URL shortener domains that hide the true destination. */
export const URL_SHORTENER_DOMAINS = new Set([
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "is.gd",
  "v.gd",
  "ow.ly",
  "buff.ly",
  "j.mp",
  "goo.gl",
  "tiny.cc",
  "shorte.st",
  "clck.ru",
  "short.io",
  "rebrand.ly",
  "smarturl.it",
  "clicky.me",
  "bl.ink",
  "lc.chat",
  "soo.gd",
  "s2r.co",
  "click.fish",
  "hostname.io",
  "tr.im",
  "cli.gs",
  "lnkd.in",
  "db.tt",
  "qr.ae",
  "adf.ly",
  "bitly.com",
  "cutt.ly",
  "rb.gy",
]);

/** TLDs commonly used in phishing/spam. */
export const SUSPICIOUS_TLDS = new Set([
  "xyz",
  "top",
  "gq",
  "ml",
  "cf",
  "tk",
  "ga",
  "buzz",
  "icu",
  "work",
  "click",
  "link",
  "men",
  "loan",
  "date",
  "stream",
  "download",
  "racing",
  "win",
  "bid",
  "ren",
  "science",
  "party",
  "gdn",
  "accountant",
]);

/** Query parameter keys that may carry credentials or tokens. Stored in lowercase. */
export const CREDENTIAL_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "auth",
  "authorization",
  "password",
  "passwd",
  "pass",
  "secret",
  "apikey",
  "api_key",
  "session_id",
  "sessionid",
  "sid",
  "csrf",
  "csrf_token",
  "csrfmiddlewaretoken",
  "code",
  "credential",
  "private_key",
  "signature",
]);

// ── Internal types ───────────────────────────────────────────────

interface CandidateLink {
  url: string;
  actionText: string;
  fromListUnsubscribe?: boolean;
}

type LinkCategory = LinkExtractionResult["links"][number]["category"];

interface ScoredLinkCandidate {
  index: number;
  url: string;
  actionText: string;
  category: LinkCategory;
  risk: boolean;
  riskReasons: LinkExtractionResult["links"][number]["riskReasons"];
}

interface LinkExtractionProcessorDeps {
  llmClient?: LlmClient;
  model?: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  logger?: (event: string, fields: Record<string, string | number>) => void;
  /** Optional usage ledger; records the LLM-selection call when one happens. */
  usage?: AiUsageRepository;
  timeoutMs?: number;
}

export interface RiskSignals {
  risk: boolean;
  riskReasons: LinkExtractionResult["links"][number]["riskReasons"];
}

// ── Text helpers ─────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

// ── URL normalization ────────────────────────────────────────────

function isSupportedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string | null {
  const decoded = decodeEntities(url.trim());
  if (!isSupportedUrl(decoded)) return null;
  return decoded;
}

const STATIC_RESOURCE_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|css|m?js|map|woff2?|ttf|otf|eot)$/i;

function isStaticResourceUrl(url: string): boolean {
  try {
    return STATIC_RESOURCE_PATH_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isContactUrl(url: string): boolean {
  return /^mailto:/i.test(url);
}

/**
 * Extract the eTLD+1 (effective top-level domain plus one) from a hostname.
 * Returns the registered domain (e.g., "example.com" from "sub.example.com").
 * Falls back to the last two labels for unknown TLDs.
 */
function getRegisteredDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  // For known multi-part TLDs (co.uk, com.au, etc.), return last 3 parts
  const multiPartTlds = new Set(["co.uk", "com.au", "co.jp", "co.nz", "co.za", "com.br", "com.cn", "co.in", "com.sg", "com.hk", "org.uk", "net.au", "ac.uk"]);
  const lastTwo = parts.slice(-2).join(".");
  if (multiPartTlds.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/**
 * Try to extract a domain from a string that may or may not be a URL.
 * Returns null if the string does not look like it contains a domain.
 */
function extractDomainFromText(text: string): string | null {
  const trimmed = text.trim();
  // Try parsing as a full URL
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname) return getRegisteredDomain(parsed.hostname);
  } catch {
    // Not a full URL, try matching a domain pattern
  }
  // Try matching "domain.tld" pattern within the text
  const match = trimmed.match(/(?:https?:\/\/)?([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i);
  if (match?.[1]) {
    try {
      // Validate it looks like a real domain
      const domain = match[1].toLowerCase();
      const parts = domain.split(".");
      if (parts.length >= 2 && parts[parts.length - 1]!.length >= 2) {
        return getRegisteredDomain(domain);
      }
    } catch {
      // Not a valid domain
    }
  }
  return null;
}

// ── Extraction functions ─────────────────────────────────────────

function extractListUnsubscribe(headers: Record<string, string> | undefined): CandidateLink[] {
  const raw = headers?.["list-unsubscribe"] ?? headers?.["List-Unsubscribe"];
  if (!raw) return [];
  const out: CandidateLink[] = [];
  for (const match of raw.matchAll(/<([^>]+)>/g)) {
    const url = normalizeUrl(match[1]);
    if (url) {
      out.push({
        url,
        actionText: "Unsubscribe",
        fromListUnsubscribe: true,
      });
    }
  }
  return out;
}

function extractHtmlLinks(html: string | undefined): CandidateLink[] {
  if (!html) return [];
  const out: CandidateLink[] = [];
  const linkRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkRegex)) {
    const url = normalizeUrl(match[1]);
    if (!url) continue;
    const label = stripTags(match[2]) || url;
    out.push({
      url,
      actionText: (
        isBareUrlLabel(label)
          ? labelFromUrlContext(html, match.index ?? 0)
          : null
      ) ?? label.slice(0, 120),
    });
  }
  return out;
}

function extractTextLinks(text: string | undefined): CandidateLink[] {
  if (!text) return [];
  const out: CandidateLink[] = [];
  const markdownLinks = new Set<string>();
  for (const match of text.matchAll(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/gi)) {
    const url = normalizeUrl(match[2]);
    if (!url) continue;
    markdownLinks.add(url);
    out.push({ url, actionText: match[1].trim().slice(0, 120) || url });
  }
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
    const url = normalizeUrl(match[0]);
    if (url && !markdownLinks.has(url)) {
      out.push({
        url,
        actionText: labelFromUrlContext(text, match.index ?? 0) ?? url,
      });
    }
  }
  return out;
}

/** Use an explicitly named resource before a bare URL as the link label. */
function labelFromUrlContext(text: string, urlIndex: number): string | null {
  const context = stripTags(
    text.slice(Math.max(0, urlIndex - 80), urlIndex),
  )
    .replace(/\s+/g, " ")
    .trim();
  const match = context.match(
    /([\p{L}\p{N}_·（）() -]{2,32}(?:系统|平台|门户|官网|中心|页面|文档|工单|问卷|申请))(?:地址|入口|链接|网址)\s*[:：]?\s*$/u,
  );
  return match?.[1]?.trim() || null;
}

// ── Category classification ──────────────────────────────────────

/** Hostnames whose registered domain identifies a video meeting service. */
const MEETING_DOMAINS = new Set([
  "zoom.us",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "gotomeeting.com",
  "bluejeans.com",
  "whereby.com",
]);

/** Phrases that strongly imply a meeting join action. */
const MEETING_TEXT_PATTERNS = [
  "join meeting",
  "join now",
  "join the meeting",
  "join video",
  "加入会议",
  "腾讯会议",
  "飞书会议",
  "钉钉会议",
];

/** Hostnames whose registered domain identifies an e-signature / approval workflow. */
const APPROVAL_DOMAINS = new Set([
  "docusign.com",
  "docusign.net",
  "adobesign.com",
  "hellosign.com",
  "eversign.com",
]);

/** Phrases that strongly imply an explicit approve / reject / sign workflow. */
const APPROVAL_TEXT_PATTERNS = [
  "approve",
  "reject",
  "sign here",
  "审批",
  "批准",
  "驳回",
  "签署",
  "审批通过",
];

/** Hostnames whose registered domain identifies a document collaboration service. */
const DOCUMENT_DOMAINS = new Set([
  "docs.google.com",
  "drive.google.com",
  "dropbox.com",
  "sharepoint.com",
  "onedrive.live.com",
  "1drv.ms",
  "box.com",
  "notion.so",
  "quip.com",
  "yuque.com",
  "feishu.cn",
  "larksuite.com",
]);

/** Phrases that strongly imply opening / viewing a hosted document. */
const DOCUMENT_TEXT_PATTERNS = [
  "view document",
  "open document",
  "查看文档",
  "阅读文档",
  "打开文档",
];

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when the hostname (or any of its parent suffixes) appears in `set`.
 * Allows the domain whitelists to match both apex and subdomain forms
 * (e.g. `www.docusign.com` and `na2.docusign.net` both match `docusign.net`).
 * Multi-label suffixes like `docs.google.com` are matched directly.
 */
function hostnameInSet(hostname: string, set: ReadonlySet<string>): boolean {
  if (!hostname) return false;
  if (set.has(hostname)) return true;
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join(".");
    if (set.has(suffix)) return true;
  }
  return false;
}

function isMeetingCandidate(text: string, hostname: string, pathname: string): boolean {
  if (hostnameInSet(hostname, MEETING_DOMAINS)) return true;
  // lark.com hosts both meet and document paths; only meet routes count.
  if (hostname.endsWith("lark.com") && pathname.startsWith("/meet")) return true;
  // Zoom join paths like https://us02web.zoom.us/j/123456789
  if (hostname.endsWith("zoom.us") && pathname.startsWith("/j/")) return true;
  // Google / Outlook calendar invite links carry meeting join info.
  if (pathname.includes("/calendar/event")) return true;
  for (const pattern of MEETING_TEXT_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

function isApprovalCandidate(text: string, hostname: string): boolean {
  if (hostnameInSet(hostname, APPROVAL_DOMAINS)) return true;
  for (const pattern of APPROVAL_TEXT_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

function isDocumentCandidate(text: string, hostname: string): boolean {
  if (hostnameInSet(hostname, DOCUMENT_DOMAINS)) return true;
  for (const pattern of DOCUMENT_TEXT_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

function hasPaymentSignals(text: string): boolean {
  return (
    text.includes("pay") ||
    text.includes("payment") ||
    text.includes("invoice") ||
    text.includes("checkout") ||
    text.includes("billing")
  );
}

function categorize(candidate: CandidateLink): LinkCategory {
  const text = `${candidate.actionText} ${candidate.url}`.toLowerCase();
  const hostname = safeHostname(candidate.url);
  const pathname = safePathname(candidate.url);

  // Highest precedence: explicit unsubscribe / subscribe membership signals.
  if (candidate.fromListUnsubscribe || text.includes("unsubscribe") || text.includes("退订")) {
    return "unsubscribe";
  }
  if (text.includes("subscribe")) return "subscribe";

  // Payment is the highest-stakes generic action — keep it ahead of approval
  // and confirm so a "pay invoice" link with stray approve/confirm vocabulary
  // still surfaces in the payment bucket.
  if (hasPaymentSignals(text)) return "payment";

  // Enterprise workflows: meeting/approval are time-sensitive enterprise
  // buckets and outrank confirm/action when their hostname or vocabulary fits.
  if (isMeetingCandidate(text, hostname, pathname)) return "meeting";
  if (isApprovalCandidate(text, hostname)) return "approval";

  if (text.includes("confirm") || text.includes("verify") || text.includes("approve")) {
    return "confirm";
  }
  // download wins over document for raw binary URLs (.pdf / .docx / etc.) —
  // those are user-fetches a file, not a hosted-document view.
  if (/\.(pdf|zip|docx?|xlsx?|pptx?)(\?|#|$)/i.test(candidate.url)) {
    return "download";
  }

  // Hosted document viewers (Google Docs, Notion, Dropbox previews, Yuque, …).
  if (isDocumentCandidate(text, hostname)) return "document";

  if (
    text.includes("login") ||
    text.includes("action") ||
    text.includes("upgrade") ||
    text.includes("review") ||
    text.includes("book") ||
    text.includes("升级") ||
    text.includes("确认") ||
    text.includes("处理")
  ) {
    return "action";
  }
  return "navigate";
}

function looksFenced(text: string): boolean {
  return text.trim().startsWith("```");
}

function isBareUrlLabel(actionText: string): boolean {
  const text = actionText.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const parsed = new URL(text);
    return parsed.href.replace(/\/$/, "") === text.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function isLowValueCandidate(candidate: ScoredLinkCandidate, candidateCount: number): boolean {
  const text = `${candidate.actionText} ${candidate.url}`.toLowerCase();
  let hostname = "";
  try {
    hostname = new URL(candidate.url).hostname.toLowerCase();
  } catch {
    // Keep unparsable URLs in the normal risk path.
  }

  if (candidate.category === "unsubscribe") return true;
  if (candidateCount > 1 && isBareUrlLabel(candidate.actionText) && !candidate.risk) return true;
  if (/\b(support|help|privacy|terms|legal|policy|preferences|settings|profile)\b/i.test(text)) {
    return true;
  }
  if (/(隐私|条款|支持|帮助|账户|帐号|设置)/.test(text)) return true;
  if (
    hostname === "twitter.com" ||
    hostname === "x.com" ||
    hostname === "facebook.com" ||
    hostname === "www.facebook.com" ||
    hostname === "instagram.com" ||
    hostname === "www.instagram.com" ||
    hostname === "linkedin.com" ||
    hostname === "www.linkedin.com"
  ) {
    return true;
  }
  return false;
}

const CATEGORY_PRIORITY: Record<LinkCategory, number> = {
  payment: 60,
  approval: 55,
  confirm: 50,
  meeting: 45,
  download: 40,
  action: 30,
  document: 25,
  subscribe: 20,
  navigate: 10,
  unsubscribe: 0,
};

function fallbackSelect(candidates: ScoredLinkCandidate[]): ScoredLinkCandidate[] {
  const valuable = candidates.filter((candidate) => !isLowValueCandidate(candidate, candidates.length));
  return valuable
    .map((candidate, order) => ({ candidate, order }))
    .sort((a, b) => {
      const priority = CATEGORY_PRIORITY[b.candidate.category] - CATEGORY_PRIORITY[a.candidate.category];
      if (priority !== 0) return priority;
      return a.order - b.order;
    })
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function validateCategory(value: unknown): LinkCategory | null {
  if (
    value === "action" ||
    value === "subscribe" ||
    value === "confirm" ||
    value === "download" ||
    value === "navigate" ||
    value === "payment" ||
    value === "meeting" ||
    value === "approval" ||
    value === "document"
  ) {
    return value;
  }
  return null;
}

function buildResultLink(
  candidate: ScoredLinkCandidate,
  overrides?: { actionText?: string; category?: LinkCategory },
): LinkExtractionResult["links"][number] {
  return {
    url: candidate.url,
    actionText: overrides?.actionText ?? candidate.actionText,
    risk: candidate.risk,
    riskReasons: candidate.riskReasons,
    category: overrides?.category ?? candidate.category,
  };
}

// ── Risk scoring ─────────────────────────────────────────────────

/**
 * Compute risk signals for a candidate link. Returns risk boolean and
 * an array of machine-readable risk reason codes.
 *
 * Risk signals:
 * - display-domain-mismatch: link text shows one domain but href points to another
 * - suspicious-domain: href domain is a known phishing/impersonation domain
 * - shortener: href domain is a known URL shortener
 * - unsafe-scheme: href uses http: instead of https:
 * - credential-in-query: href query contains token/password-like keys
 * - suspicious-tld: href TLD is commonly used in phishing/spam
 * - deeply-nested-subdomain: href has more than 4 subdomain levels
 */
export function computeRiskSignals(candidate: { url: string; actionText: string }): RiskSignals {
  const riskReasons: LinkExtractionResult["links"][number]["riskReasons"] = [];

  try {
    const parsed = new URL(candidate.url);

    // mailto: is always safe
    if (parsed.protocol === "mailto:") {
      return { risk: false, riskReasons: [] };
    }

    // unsafe-scheme: HTTP instead of HTTPS
    if (parsed.protocol === "http:") {
      riskReasons.push("unsafe-scheme");
    }

    const hostname = parsed.hostname.toLowerCase();

    // deeply-nested-subdomain: more than 4 dot-separated parts
    // (e.g., a.b.c.d.evil.com has 5 parts, which is suspicious)
    const subdomainParts = hostname.split(".");
    if (subdomainParts.length > 4) {
      riskReasons.push("deeply-nested-subdomain");
    }

    // shortener
    const registeredDomain = getRegisteredDomain(hostname);
    if (URL_SHORTENER_DOMAINS.has(registeredDomain)) {
      riskReasons.push("shortener");
    }

    // suspicious-domain: known phishing/impersonation domains
    if (SUSPICIOUS_DOMAINS.has(registeredDomain) || SUSPICIOUS_DOMAINS.has(hostname)) {
      riskReasons.push("suspicious-domain");
    }

    // suspicious-tld
    const tld = subdomainParts[subdomainParts.length - 1]!;
    if (SUSPICIOUS_TLDS.has(tld)) {
      riskReasons.push("suspicious-tld");
    }

    // credential-in-query: check for sensitive query parameter keys
    for (const key of parsed.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
        riskReasons.push("credential-in-query");
        break;
      }
    }

    // display-domain-mismatch: link text shows a domain that differs from the href domain
    const displayDomain = extractDomainFromText(candidate.actionText);
    if (displayDomain) {
      const hrefDomain = getRegisteredDomain(hostname);
      if (displayDomain !== hrefDomain) {
        riskReasons.push("display-domain-mismatch");
      }
    }
  } catch {
    // If URL parsing fails, mark as risky
    riskReasons.push("unsafe-scheme");
  }

  return {
    risk: riskReasons.length > 0,
    riskReasons,
  };
}

// ── Sensitive URL log safety ─────────────────────────────────────

/**
 * Redact credential-bearing query parameter values from a URL for safe logging.
 * Preserves query parameter keys but replaces sensitive values with [REDACTED].
 * Non-sensitive query parameters are left intact.
 */
export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    let modified = false;
    for (const key of parsed.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "[REDACTED]");
        modified = true;
      }
    }
    return modified ? parsed.toString() : url;
  } catch {
    // If URL parsing fails, return as-is (shouldn't happen for valid URLs)
    return url;
  }
}

// ── Processor ────────────────────────────────────────────────────

/**
 * Deterministic smart-link extractor. It does not call the LLM and never
 * returns body content; it only emits URL, label, category, risk, and
 * risk reasons. It NEVER issues network requests — all parsing is local.
 */
export class LinkExtractionProcessor implements MailIntelligenceProcessor {
  readonly type = "linkExtraction" as const;
  private readonly llmClient?: LlmClient;
  private readonly model?: string;
  private readonly provider?: string;
  private readonly logger: (
    event: string,
    fields: Record<string, string | number>,
  ) => void;
  private readonly usage?: AiUsageRepository;
  private readonly timeoutMs: number;

  constructor(deps: LinkExtractionProcessorDeps = {}) {
    this.llmClient = deps.llmClient;
    this.model = deps.model;
    this.provider = deps.provider;
    this.logger = deps.logger ?? (() => {});
    this.usage = deps.usage;
    this.timeoutMs = deps.timeoutMs ?? 6_000;
  }

  async handle(
    job: IntelligenceJob,
    ctx: ProcessorContext,
  ): Promise<LinkExtractionResult> {
    const started = Date.now();
    const mail = ctx.getMessage(job.emailId);
    if (!mail) {
      throw new LinkExtractionProcessorError("mail-missing", false);
    }

    const rawCandidates = [
      ...extractListUnsubscribe(mail.headers),
      ...extractHtmlLinks(mail.bodyHtml),
      ...extractTextLinks(mail.bodyText),
    ];
    const seen = new Set<string>();
    const candidates: ScoredLinkCandidate[] = [];
    let unsubscribeUrl: string | null = null;
    for (const candidate of rawCandidates) {
      if (
        seen.has(candidate.url) ||
        isStaticResourceUrl(candidate.url) ||
        (isContactUrl(candidate.url) && !candidate.fromListUnsubscribe)
      ) continue;
      seen.add(candidate.url);

      const signals = computeRiskSignals(candidate);
      const category = categorize(candidate);

      if (category === "unsubscribe") {
        unsubscribeUrl ??= candidate.url;
        continue;
      }

      candidates.push({
        index: candidates.length,
        url: candidate.url,
        actionText: candidate.actionText,
        risk: signals.risk,
        riskReasons: signals.riskReasons,
        category,
      });
    }

    const { links, llmUsage } = await this.selectLinks(candidates, job.emailId);
    const duration = Date.now() - started;
    if (llmUsage && this.usage && mail.accountId) {
      this.usage.record({
        accountId: mail.accountId,
        category: "other",
        processor: "linkExtraction",
        emailId: job.emailId,
        inputTokens: llmUsage.inputTokens,
        outputTokens: llmUsage.outputTokens,
        model: this.model,
        provider: this.provider,
        durationMs: duration,
      });
    }
    const metadata: AiResultMetadata = {
      processor: "linkExtraction",
      version: LINK_EXTRACTION_PROCESSOR_VERSION,
      // The processor is hybrid: when an LLM ranked the candidates we
      // record the model name; otherwise the result was produced by the
      // local heuristic and we record "deterministic" so observability
      // can distinguish the two paths.
      model: llmUsage ? (this.model ?? "deterministic") : "deterministic",
      contextRefs: [`email:${job.emailId}`],
      createdAt: new Date(started).toISOString(),
      durationMs: duration,
      tokenUsage: {
        inputTokens: llmUsage?.inputTokens ?? 0,
        outputTokens: llmUsage?.outputTokens ?? 0,
      },
    };
    return {
      type: "linkExtraction",
      links,
      unsubscribeUrl,
      _metadata: metadata,
    };
  }

  private async selectLinks(
    candidates: ScoredLinkCandidate[],
    emailId: string,
  ): Promise<{
    links: LinkExtractionResult["links"];
    /** Non-null only when the LLM call actually succeeded and returned usage. */
    llmUsage: { inputTokens: number; outputTokens: number } | null;
  }> {
    if (candidates.length === 0) return { links: [], llmUsage: null };
    if (!this.llmClient || !this.model) {
      return {
        links: fallbackSelect(candidates).map((candidate) => buildResultLink(candidate)),
        llmUsage: null,
      };
    }

    try {
      const response = await this.llmClient.generate({
        model: this.model,
        system: LINK_SELECTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildLinkSelectionUserMessage(
              candidates.map((candidate) => ({
                index: candidate.index,
                url: candidate.url,
                actionText: candidate.actionText,
                category: candidate.category,
              })),
            ),
          },
        ],
        jsonSchema: LINK_SELECTION_JSON_SCHEMA,
        temperature: 0.1,
        maxTokens: 2048,
        timeoutMs: this.timeoutMs,
      });

      let responseText = response.text;
      if (looksFenced(responseText)) {
        responseText = stripJsonFence(responseText);
      }

      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      if (!Array.isArray(parsed.links)) {
        throw new Error("links-not-array");
      }

      const byIndex = new Map(candidates.map((candidate) => [candidate.index, candidate]));
      const selected: LinkExtractionResult["links"] = [];
      const seen = new Set<number>();
      for (const item of parsed.links.slice(0, 3)) {
        if (typeof item !== "object" || item === null) continue;
        const row = item as Record<string, unknown>;
        if (!Number.isInteger(row.index)) continue;
        const index = row.index as number;
        if (seen.has(index)) continue;
        const candidate = byIndex.get(index);
        if (!candidate) continue;
        const category = validateCategory(row.category) ?? candidate.category;
        const actionText =
          typeof row.actionText === "string" && row.actionText.trim().length > 0
            ? row.actionText.trim()
            : candidate.actionText;
        selected.push(buildResultLink(candidate, { actionText, category }));
        seen.add(index);
      }

      return {
        links: selected,
        llmUsage: {
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
        },
      };
    } catch (error) {
      this.logger("link-selection-fallback", {
        emailId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return {
        links: fallbackSelect(candidates).map((candidate) => buildResultLink(candidate)),
        llmUsage: null,
      };
    }
  }
}
