import { createHash } from "node:crypto";
import type {
  AccountQualifiedMailReference,
  AutomationActionCandidate,
  SubscriptionInsightCategory,
  SubscriptionInsightHighlight,
  SubscriptionInsightResult,
} from "../../../shared/wemail/automationCenter.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import {
  NO_OP_OFFICE_SCENES,
  type OfficeScenePort,
} from "../intelligence/officeScenePort.js";

export interface SubscriptionInsightOptions {
  window: { start: string; end: string; timezone: string };
  accountIds: string[];
  maxMessages?: number;
  perAccountLimit?: number;
  maxHighlights?: number;
  maxCategories?: number;
  maxItemsPerCategory?: number;
  maxSemanticCandidates?: number;
  includePromotions?: boolean;
}

export interface SubscriptionSemanticCandidate {
  emailId: string;
  accountId: string;
  sender: string;
  subject: string;
  snippet: string;
  headerSignals: string[];
}

export interface SubscriptionSemanticDecision {
  emailId: string;
  decision: "useful_subscription" | "private_or_business" | "not_useful";
  kind?: SubscriptionInsightCategory["kind"];
  confidence: number;
  reason: string;
}

export interface SubscriptionSemanticClassifier {
  classify(
    candidates: SubscriptionSemanticCandidate[],
  ): Promise<SubscriptionSemanticDecision[]>;
}

interface Candidate {
  message: MailMessage;
  source: AccountQualifiedMailReference;
  kind: SubscriptionInsightCategory["kind"];
  score: number;
  reason: string;
  groupKey: string;
  unsubscribe?: string;
  securityDisposition?: "notice" | "suspected_phishing";
}

/**
 * Deterministic, bounded first-stage analysis for the built-in 邮箱速览
 * template. It deliberately operates on already-frozen mail inputs and never
 * opens its own rolling window. Ambiguous candidates can be handed to a model
 * by a later capability, while private/business/spam mail fails closed here.
 */
export class SubscriptionInsightService {
  /**
   * @param semanticClassifier Optional LLM classifier for ambiguous senders.
   * @param officeScenes Edition-registered office-scene detector (P2 module
   *   seam). System mail it recognizes is excluded from LLM semantic
   *   classification (it is clearly not a subscription). The default NO_OP
   *   port never filters, which is the safe open-edition behavior: ambiguous
   *   mail is simply classified.
   */
  constructor(
    private readonly semanticClassifier?: SubscriptionSemanticClassifier,
    private readonly officeScenes: OfficeScenePort = NO_OP_OFFICE_SCENES,
  ) {}

  analyze(
    inputMessages: MailMessage[],
    options: SubscriptionInsightOptions,
  ): SubscriptionInsightResult {
    return this.analyzeResolved(inputMessages, options, new Map());
  }

  async analyzeWithSemanticClassification(
    inputMessages: MailMessage[],
    options: SubscriptionInsightOptions,
  ): Promise<SubscriptionInsightResult> {
    if (!this.semanticClassifier) return this.analyze(inputMessages, options);
    const maxSemanticCandidates = clamp(
      options.maxSemanticCandidates ?? 20,
      0,
      30,
    );
    if (maxSemanticCandidates === 0) return this.analyze(inputMessages, options);
    const scoped = inputMessages.filter(
      (message) =>
        options.accountIds.includes(message.accountId) &&
        Date.parse(message.receivedAt) >= Date.parse(options.window.start) &&
        Date.parse(message.receivedAt) < Date.parse(options.window.end),
    );
    const { selected } = fairSelect(
      scoped,
      options.accountIds,
      clamp(options.maxMessages ?? 400, 1, 1_000),
      clamp(options.perAccountLimit ?? 150, 1, 500),
    );
    const ambiguous = selected
      .filter(isAmbiguousCandidate)
      .filter(
        (message) =>
          !this.officeScenes.isSystemMail(message.subject, message.from.email),
      )
      .slice(0, maxSemanticCandidates)
      .map(toSemanticCandidate);
    if (ambiguous.length === 0) return this.analyze(inputMessages, options);

    let rawDecisions: SubscriptionSemanticDecision[];
    try {
      rawDecisions = await this.semanticClassifier.classify(ambiguous);
    } catch {
      return this.analyze(inputMessages, options);
    }
    const allowedIds = new Set(ambiguous.map((candidate) => candidate.emailId));
    const decisions = new Map<string, SubscriptionSemanticDecision>();
    for (const decision of rawDecisions.slice(0, ambiguous.length)) {
      if (
        !allowedIds.has(decision.emailId) ||
        decisions.has(decision.emailId) ||
        !isSemanticDecision(decision)
      ) {
        continue;
      }
      decisions.set(decision.emailId, {
        ...decision,
        reason: decision.reason.replace(/[\r\n\0]+/g, " ").trim().slice(0, 240),
        confidence: Math.max(0, Math.min(1, decision.confidence)),
      });
    }
    return this.analyzeResolved(inputMessages, options, decisions);
  }

  private analyzeResolved(
    inputMessages: MailMessage[],
    options: SubscriptionInsightOptions,
    semanticDecisions: Map<string, SubscriptionSemanticDecision>,
  ): SubscriptionInsightResult {
    const maxMessages = clamp(options.maxMessages ?? 400, 1, 1_000);
    const perAccountLimit = clamp(options.perAccountLimit ?? 150, 1, 500);
    const scoped = inputMessages.filter(
      (message) =>
        options.accountIds.includes(message.accountId) &&
        Date.parse(message.receivedAt) >= Date.parse(options.window.start) &&
        Date.parse(message.receivedAt) < Date.parse(options.window.end),
    );
    const { selected: fairMessages, truncated } = fairSelect(
      scoped,
      options.accountIds,
      maxMessages,
      perAccountLimit,
    );
    const candidates = fairMessages
      .map((message) => classifyCandidate(message, semanticDecisions.get(message.id)))
      .filter((candidate): candidate is Candidate => !!candidate)
      .filter((candidate) => options.includePromotions !== false || candidate.kind !== "promotion");
    const grouped = groupCandidates(candidates);
    const maxHighlights = clamp(options.maxHighlights ?? 4, 1, 4);
    const maxCategories = clamp(options.maxCategories ?? 3, 1, 3);
    const maxItemsPerCategory = clamp(options.maxItemsPerCategory ?? 2, 1, 2);
    const topHighlights = selectHighlights(grouped, maxHighlights).map(toHighlight);
    const curatedCategories = buildCategories(
      grouped,
      maxCategories,
      maxItemsPerCategory,
    );
    const recommendedActions = buildActions(grouped);
    const keepSubscriptions = grouped
      .filter((group) => group.score >= 75 && group.kind !== "promotion")
      .slice(0, 3)
      .map((group) => ({
        id: stableId("keep", group.groupKey),
        sourceName: group.message.from.name || group.message.from.email,
        reason: `${group.message.subject || categoryLabel(group.kind)}：内容具体且与决策相关。`,
        sourceEmails: group.sources,
      }));
    const perAccount: SubscriptionInsightResult["stats"]["perAccount"] = {};
    for (const accountId of options.accountIds) {
      const scanned = scoped.filter((message) => message.accountId === accountId).length;
      const selected = candidates.filter(
        (candidate) => candidate.message.accountId === accountId,
      ).length;
      perAccount[accountId] = {
        scanned,
        selected,
        excluded: Math.max(0, scanned - selected),
      };
    }
    return {
      type: "subscriptionDailyInsight",
      schemaVersion: 1,
      window: options.window,
      accountCount: options.accountIds.length,
      topHighlights,
      curatedCategories,
      recommendedActions,
      keepSubscriptions,
      stats: {
        scanned: scoped.length,
        selected: candidates.length,
        excluded: Math.max(0, scoped.length - candidates.length),
        groups: grouped.length,
        truncated,
        perAccount,
      },
      emptyReason:
        candidates.length === 0
          ? "noCandidates"
          : grouped.length === 0
            ? "noUsefulItems"
            : undefined,
    };
  }
}

function fairSelect(
  messages: MailMessage[],
  accountIds: string[],
  globalLimit: number,
  perAccountLimit: number,
): { selected: MailMessage[]; truncated: boolean } {
  const queues = new Map(
    accountIds.map((accountId) => [
      accountId,
      messages
        .filter((message) => message.accountId === accountId)
        .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
        .slice(0, perAccountLimit),
    ]),
  );
  const selected: MailMessage[] = [];
  let progressed = true;
  while (selected.length < globalLimit && progressed) {
    progressed = false;
    for (const accountId of accountIds) {
      const next = queues.get(accountId)?.shift();
      if (!next) continue;
      selected.push(next);
      progressed = true;
      if (selected.length >= globalLimit) break;
    }
  }
  return {
    selected,
    truncated:
      messages.length > selected.length ||
      accountIds.some(
        (accountId) =>
          messages.filter((message) => message.accountId === accountId).length >
          perAccountLimit,
      ),
  };
}

function classifyCandidate(
  message: MailMessage,
  semantic?: SubscriptionSemanticDecision,
): Candidate | undefined {
  const folder = message.folder.toLowerCase();
  const subject = message.subject.trim();
  const body = `${message.snippet} ${message.bodyText ?? ""}`.slice(0, 8_000);
  const headers = lowerHeaders(message.headers);
  if (isHardExcluded(message)) return undefined;
  const listId = headers["list-id"];
  const unsubscribe = headers["list-unsubscribe"];
  const precedence = headers.precedence?.toLowerCase();
  const bulkEvidence =
    !!listId ||
    !!unsubscribe ||
    precedence === "bulk" ||
    precedence === "list" ||
    /\b(unsubscribe|退订|newsletter|digest)\b/i.test(body);
  const security = /\b(security|vulnerability|cve)\b|安全|漏洞|风险/i.test(
    `${subject} ${body}`,
  );
  const suspectedPhishing = /\b(verify (?:your )?account|account (?:is )?suspended|wire transfer|gift card|seed phrase)\b|立即验证(?:账号|账户)|账户(?:已)?冻结|转账汇款|助记词/i.test(
    `${subject} ${body}`,
  );
  const platform = /\b(release|changelog|product update)\b|版本更新|平台更新|发布说明/i.test(
    `${subject} ${body}`,
  );
  const promotion = /\b(sale|discount|coupon|promotion)\b|优惠|折扣|促销/i.test(
    `${subject} ${body}`,
  );
  const account = /\b(account|billing|subscription|workspace)\b.*\b(notice|alert|digest|report)\b|账号|账户|订阅到期|工作区摘要/i.test(
    `${subject} ${body}`,
  );
  const social = /\b(community|social|workspace|weekly digest|automated report)\b|社区周报|社交摘要|自动化报告/i.test(
    `${subject} ${body}`,
  );
  if (
    !bulkEvidence &&
    !suspectedPhishing &&
    !security &&
    !platform &&
    !promotion &&
    !account &&
    !social &&
    semantic?.decision !== "useful_subscription"
  ) {
    return undefined;
  }
  const kind: SubscriptionInsightCategory["kind"] = suspectedPhishing || security
    ? "security"
    : platform
      ? "product"
      : social
        ? "social"
        : account
          ? "account"
          : promotion
            ? "promotion"
            : semantic?.kind ?? "industry";
  const baseScore = suspectedPhishing
    ? 100
    : security
    ? 95
    : platform
      ? 80
      : account
        ? 72
        : social
          ? 68
          : promotion
            ? 45
            : semantic
              ? 50 + Math.round(semantic.confidence * 25)
              : 65;
  const score = baseScore + (listId ? 5 : 0) + (unsubscribe ? 3 : 0);
  const source: AccountQualifiedMailReference = {
    type: "email",
    accountId: message.accountId,
    emailId: message.id,
    subject: message.subject,
    label: message.from.name || message.from.email,
    availability: "available",
  };
  return {
    message,
    source,
    kind,
    score,
    reason: suspectedPhishing
      ? "检测到疑似钓鱼或欺诈信号，需要从可信入口核验"
      : security
        ? "检测到安全或风险更新"
      : platform
        ? "检测到产品或平台更新"
        : social
          ? "检测到社区或自动化摘要"
          : account
            ? "检测到账号、订阅或工作区通知"
            : promotion
              ? "检测到营销订阅"
              : semantic?.reason || "检测到订阅简报",
    groupKey: groupKey(message, listId),
    unsubscribe: verifiedUnsubscribe(unsubscribe),
    securityDisposition: suspectedPhishing
      ? "suspected_phishing"
      : security
        ? "notice"
        : undefined,
  };
}

function isHardExcluded(message: MailMessage): boolean {
  const folder = message.folder.toLowerCase();
  const subject = message.subject.trim();
  const body = `${message.snippet} ${message.bodyText ?? ""}`.slice(0, 2_000);
  return (
    /spam|junk|trash|垃圾|回收站/.test(folder) ||
    /archive|sent|draft|归档|已发送|草稿/.test(folder) ||
    message.flags.answered ||
    /^(?:true|1|yes)$/i.test(lowerHeaders(message.headers)["x-wemail-handled"] ?? "") ||
    /^(re|回复|答复)\s*:/i.test(subject) ||
    /\b(password|验证码|otp|one[- ]time code)\b/i.test(`${subject} ${body}`) ||
    /\b(meeting|quotation|invoice|contract|project update)\b|会议|报价|合同|项目进展|发票/i.test(
      subject,
    )
  );
}

function isAmbiguousCandidate(message: MailMessage): boolean {
  if (isHardExcluded(message)) return false;
  const headers = lowerHeaders(message.headers);
  const evidence = `${message.subject} ${message.snippet} ${message.bodyText ?? ""}`.slice(
    0,
    8_000,
  );
  const deterministic =
    !!headers["list-id"] ||
    !!headers["list-unsubscribe"] ||
    ["bulk", "list"].includes(headers.precedence?.toLowerCase() ?? "") ||
    /\b(unsubscribe|退订|newsletter|digest|security|vulnerability|cve|release|changelog|product update|sale|discount|coupon|promotion)\b|安全|漏洞|风险|版本更新|平台更新|发布说明|优惠|折扣|促销/i.test(
      evidence,
    );
  return !deterministic;
}

function toSemanticCandidate(message: MailMessage): SubscriptionSemanticCandidate {
  const headers = lowerHeaders(message.headers);
  return {
    emailId: message.id,
    accountId: message.accountId,
    sender: message.from.email.slice(0, 254),
    subject: message.subject.replace(/[\r\n\0]+/g, " ").slice(0, 240),
    snippet: message.snippet.replace(/[\r\n\0]+/g, " ").slice(0, 600),
    headerSignals: [
      headers["list-id"] ? "list-id" : "",
      headers["list-unsubscribe"] ? "list-unsubscribe" : "",
      headers.precedence ? `precedence:${headers.precedence.slice(0, 32)}` : "",
      headers["x-wemail-platform-signal"] ? "platform" : "",
      headers["x-wemail-security-signal"] ? "security" : "",
    ].filter(Boolean),
  };
}

function isSemanticDecision(
  value: SubscriptionSemanticDecision,
): boolean {
  return (
    !!value &&
    typeof value.emailId === "string" &&
    ["useful_subscription", "private_or_business", "not_useful"].includes(
      value.decision,
    ) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    typeof value.reason === "string" &&
    (value.kind === undefined ||
      [
        "industry",
        "product",
        "security",
        "account",
        "promotion",
        "social",
        "custom",
      ].includes(value.kind))
  );
}

function groupCandidates(candidates: Candidate[]): Array<
  Candidate & { sources: AccountQualifiedMailReference[] }
> {
  const groups = new Map<string, Candidate & { sources: AccountQualifiedMailReference[] }>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.groupKey);
    if (!existing) {
      groups.set(candidate.groupKey, { ...candidate, sources: [candidate.source] });
      continue;
    }
    existing.sources.push(candidate.source);
    if (candidate.score > existing.score) {
      existing.score = candidate.score;
      existing.kind = candidate.kind;
      existing.message = candidate.message;
      existing.reason = candidate.reason;
      existing.securityDisposition = candidate.securityDisposition;
    }
    existing.unsubscribe ??= candidate.unsubscribe;
  }
  return [...groups.values()].sort((left, right) => right.score - left.score);
}

function toHighlight(
  group: Candidate & { sources: AccountQualifiedMailReference[] },
): SubscriptionInsightHighlight {
  return {
    id: stableId("highlight", group.groupKey),
    kind:
      group.kind === "security"
        ? "risk"
        : group.kind === "promotion"
          ? "noise"
          : "content",
    text: `${concreteTakeaway(group.message)} ${group.securityDisposition === "suspected_phishing" ? group.reason : whyItMatters(group.kind)}`,
    sourceEmails: group.sources.slice(0, 20),
  };
}

function selectHighlights(
  groups: Array<Candidate & { sources: AccountQualifiedMailReference[] }>,
  limit: number,
) {
  const sorted = groups.slice().sort((left, right) => right.score - left.score);
  const content = sorted.find((group) => !["security", "promotion", "account"].includes(group.kind));
  const attention = sorted.find((group) => ["security", "promotion", "account"].includes(group.kind));
  const selected = [content, attention].filter(
    (group, index, values): group is Candidate & { sources: AccountQualifiedMailReference[] } =>
      !!group && values.indexOf(group) === index,
  );
  for (const group of sorted) {
    if (selected.length >= limit) break;
    if (!selected.includes(group)) selected.push(group);
  }
  return selected.slice(0, limit);
}

function buildCategories(
  groups: Array<Candidate & { sources: AccountQualifiedMailReference[] }>,
  maxCategories: number,
  maxItemsPerCategory: number,
): SubscriptionInsightCategory[] {
  const byKind = new Map<
    SubscriptionInsightCategory["kind"],
    Array<Candidate & { sources: AccountQualifiedMailReference[] }>
  >();
  for (const group of groups) {
    const bucket = byKind.get(group.kind) ?? [];
    bucket.push(group);
    byKind.set(group.kind, bucket);
  }
  return [...byKind.entries()]
    .slice(0, maxCategories)
    .map(([kind, values]) => ({
      id: stableId("category", kind),
      kind,
      label: categoryLabel(kind),
      items: values.slice(0, maxItemsPerCategory).map((group) => ({
        id: stableId("item", group.groupKey),
        takeaway: concreteTakeaway(group.message),
        whyItMatters: whyItMatters(group.kind),
        sourceEmails: group.sources.slice(0, 20),
      })),
    }));
}

function buildActions(
  groups: Array<Candidate & { sources: AccountQualifiedMailReference[] }>,
): AutomationActionCandidate[] {
  const actions: AutomationActionCandidate[] = [];
  for (const group of groups) {
    if (group.unsubscribe && group.kind === "promotion") {
      actions.push({
        id: stableId("unsubscribe", group.groupKey),
        type: "unsubscribe",
        reason: "该订阅以营销内容为主，且存在可验证退订方式。",
        sources: group.sources.slice(0, 20),
        status: "requires_confirmation",
        accountId: group.message.accountId,
        emailId: group.message.id,
        unsubscribeMethodId: group.unsubscribe,
      });
    }
    if (group.kind === "security") {
      actions.push({
        id: stableId("verify-security", group.groupKey),
        type: "verify_security_notice",
        reason: group.securityDisposition === "suspected_phishing"
          ? "疑似钓鱼邮件：不要点击邮件内链接，请从可信入口核验账号状态。"
          : "安全通知需要打开原邮件核验影响范围。",
        sources: group.sources.slice(0, 20),
        status: "available",
        accountId: group.message.accountId,
        emailId: group.message.id,
      });
    }
  }
  return actions.slice(0, 3);
}

function concreteTakeaway(message: MailMessage): string {
  const detail = (message.snippet || message.bodyText || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[。！？.!?])\s*/)[0]
    ?.slice(0, 180);
  return detail ? `${message.subject}：${detail}` : message.subject;
}

function whyItMatters(kind: SubscriptionInsightCategory["kind"]): string {
  return {
    industry: "帮助判断近期趋势是否值得继续跟进。",
    product: "可能影响当前工具使用、升级计划或工作流程。",
    security: "需要核验影响范围并决定是否立即处理。",
    account: "可能涉及账号状态、费用或访问权限。",
    promotion: "用于判断是否值得购买或退订降噪。",
    social: "帮助快速了解社区或工作区的重要变化。",
    custom: "保留了与后续判断直接相关的信息。",
  }[kind];
}

function groupKey(message: MailMessage, listId?: string): string {
  const sender = message.from.email.toLowerCase();
  const normalizedSubject = message.subject
    .toLowerCase()
    .replace(/^(fw|fwd|转发)\s*:/i, "")
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const links = `${message.bodyText ?? ""} ${message.bodyHtml ?? ""}`
    .match(/https?:\/\/[^\s"'<>]+/gi)
    ?.slice(0, 10)
    .map((value) => {
      try {
        const url = new URL(value);
        return `${url.hostname}${url.pathname}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .sort()
    .join("|");
  return createHash("sha256")
    .update(`${listId ?? sender}|${normalizedSubject}|${links ?? ""}`)
    .digest("hex");
}

function lowerHeaders(value?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([key, item]) => [key.toLowerCase(), item]),
  );
}

function verifiedUnsubscribe(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /<(https:\/\/[^>]+|mailto:[^>]+)>/i.exec(value);
  return match?.[1];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function categoryLabel(kind: SubscriptionInsightCategory["kind"]): string {
  return {
    industry: "行业动态",
    product: "产品更新",
    security: "安全与风险",
    account: "账号通知",
    promotion: "营销订阅",
    social: "社区动态",
    custom: "其他",
  }[kind];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
