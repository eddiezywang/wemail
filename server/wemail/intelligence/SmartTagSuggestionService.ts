import type { ApplicationMessageContentBlock } from "../../../shared/wemail/applicationMessages.js";
import { buildSmartTagDefinitions, smartTagDefinitionFingerprint } from "../ai/prompts/smartTagDefinitions.js";
import type { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import type { JobRepository } from "../queue/JobRepository.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { defaultSmartTagPrompt, type UserTag, type UserTagRepository } from "./UserTagRepository.js";
import type { SmartTagBackfillRepository, SmartTagBackfillRun } from "./SmartTagBackfillRepository.js";
import type { TopicCandidate, TopicCandidateRepository, TopicWindowCounts } from "./TopicCandidateRepository.js";

export class SmartTagSuggestionService {
  constructor(private readonly deps: {
    topics: TopicCandidateRepository;
    messages: ApplicationMessageRepository;
    userTags: UserTagRepository;
    mail: CanonicalMailRepository;
    jobs: JobRepository;
    backfills: SmartTagBackfillRepository;
    now?: () => Date;
  }) {}

  evaluate(accountId: string, topicId?: string): TopicCandidate[] {
    return evaluateSmartTagSuggestions(this.deps, accountId, topicId);
  }

  createTag(input: { accountId: string; topicId: string; name?: string; description?: string }): {
    topic: TopicCandidate;
    tag: UserTag;
    backfill: SmartTagBackfillRun;
  } {
    const topic = this.requireTopic(input.accountId, input.topicId);
    if (topic.state === "suppressed") throw new Error("topic-suppressed");
    if (topic.state === "created") throw new Error("topic-already-created");
    const name = input.name?.trim() || topic.displayName;
    const description = input.description?.trim() || `由邮件内容主题「${topic.displayName}」自动归纳，经用户确认创建。`;
    const tag = this.deps.userTags.upsert({
      accountId: input.accountId,
      name,
      description,
      prompt: defaultSmartTagPrompt(name, description),
      creationSource: "topic-suggestion",
      sourceTopicId: topic.id,
    });
    const created = this.deps.topics.markCreated(topic.id, input.accountId, tag.id)!;
    const backfill = this.enqueueBackfill(input.accountId);
    this.updateMessage(created, "created", `已创建智能标签「${tag.name}」，历史邮件正在回溯分类。`);
    return { topic: created, tag, backfill };
  }

  defer(accountId: string, topicId: string): TopicCandidate {
    const topic = this.deps.topics.defer(topicId, accountId);
    if (!topic) throw new Error("topic-not-found");
    this.updateMessage(topic, "deferred", "已设为稍后提醒；出现新的相关邮件后会再次评估。", "info");
    return topic;
  }

  suppress(accountId: string, topicId: string): TopicCandidate {
    const topic = this.deps.topics.suppress(topicId, accountId);
    if (!topic) throw new Error("topic-not-found");
    this.updateMessage(topic, "suppressed", "已记录为不再建议，后续不会再为该主题生成标签建议。", "success");
    return topic;
  }

  get(accountId: string, topicId: string): TopicCandidate | null {
    return this.deps.topics.getById(topicId, accountId);
  }

  private requireTopic(accountId: string, topicId: string): TopicCandidate {
    const topic = this.get(accountId, topicId);
    if (!topic) throw new Error("topic-not-found");
    return topic;
  }

  private updateMessage(topic: TopicCandidate, status: string, text: string, severity: "info" | "success" = "success"): void {
    if (!topic.applicationMessageId) return;
    this.deps.messages.replaceContentAndInteractions({
      id: topic.applicationMessageId,
      accountId: topic.accountId,
      preview: text,
      severity,
      content: [
        { type: "status", label: "处理状态", value: statusLabel(status), tone: severity },
        { type: "paragraph", text },
      ],
      interactions: [],
    });
  }

  private enqueueBackfill(accountId: string): SmartTagBackfillRun {
    const targetFingerprint = smartTagDefinitionFingerprint(buildSmartTagDefinitions(this.deps.userTags.listByAccount(accountId)));
    const run = this.deps.backfills.create({ accountId, reason: "smart-tag-suggestion", targetFingerprint });
    let cursor: { receivedAt: string; id: string } | undefined;
    let order = 0;
    try {
      while (true) {
        const messages = this.deps.mail.listAllMessagesByAccountPage({ accountId, limit: 500, cursor });
        if (messages.length === 0) break;
        let queued = 0;
        let recent = 0;
        let historical = 0;
        const cutoff = this.now();
        cutoff.setUTCDate(cutoff.getUTCDate() - 7);
        for (const message of messages) {
          if (new Date(message.receivedAt) >= cutoff) recent += 1;
          else historical += 1;
          const result = this.deps.jobs.enqueueOrResetJob({
            accountId,
            emailId: message.id,
            type: "tags",
            maxAttempts: 3,
            payload: { reason: "smart-tag-suggestion", runId: run.id, tagDefinitionFingerprint: targetFingerprint },
            createdAt: new Date(this.now().getTime() - order++).toISOString(),
          });
          if (result.inserted || result.reset) queued += 1;
        }
        const last = messages.at(-1)!;
        cursor = { receivedAt: last.receivedAt, id: last.id };
        this.deps.backfills.addProgress({
          id: run.id, scannedDelta: messages.length, queuedDelta: queued,
          recentDelta: recent, historicalDelta: historical,
          cursorReceivedAt: cursor.receivedAt, cursorEmailId: cursor.id,
        });
      }
      return this.deps.backfills.finishEnqueue(run.id)!;
    } catch (error) {
      return this.deps.backfills.fail(run.id, error instanceof Error ? error.message : String(error))!;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export function evaluateSmartTagSuggestions(
  deps: Pick<ConstructorParameters<typeof SmartTagSuggestionService>[0], "topics" | "messages" | "userTags" | "now">,
  accountId: string,
  topicId?: string,
): TopicCandidate[] {
  const now = deps.now?.() ?? new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 30);
  const candidates = topicId
    ? [deps.topics.getById(topicId, accountId)].filter((item): item is TopicCandidate => !!item)
    : deps.topics.listEligible(accountId, since.toISOString(), 5);
  const existingNames = new Set(deps.userTags.listByAccount(accountId).map((tag) => normalizeName(tag.name)));
  const suggested: TopicCandidate[] = [];
  for (const topic of candidates) {
    if (topic.state !== "collecting" && topic.state !== "deferred" && topic.state !== "failed") continue;
    const recent = deps.topics.countEvidenceSince(topic.id, since.toISOString());
    if (recent.mailCount < 5 || (recent.threadCount < 2 && recent.senderCount < 2)) continue;
    if (existingNames.has(normalizeName(topic.displayName))) {
      const existing = deps.userTags.listByAccount(accountId).find((tag) => normalizeName(tag.name) === normalizeName(topic.displayName));
      if (existing) deps.topics.markCreated(topic.id, accountId, existing.id);
      continue;
    }
    const evidence = deps.topics.listEvidence(topic.id, 5);
    const emailIds = evidence.map((item) => item.emailId);
    const message = deps.messages.create({
      accountId,
      sourceType: "system",
      sourceRuleId: "smart-tag-suggestion",
      sourceRunId: topic.id,
      type: "smart-tag-suggestion",
      severity: "info",
      title: `建议创建智能标签「${topic.displayName}」`,
      preview: `近 30 天已在 ${recent.mailCount} 封邮件中识别到该主题，确认后会创建标签并回溯历史邮件。`,
      content: suggestionContent(topic, recent),
      references: emailIds.map((id) => ({ type: "email" as const, id })),
      interactions: [
        { type: "previewSmartTagTopic", topicId: topic.id, emailIds, label: "查看样例" },
        { type: "createSmartTagFromTopic", topicId: topic.id, label: "创建标签" },
        { type: "editSmartTagFromTopic", topicId: topic.id, label: "编辑后创建" },
        { type: "deferSmartTagTopic", topicId: topic.id, label: "稍后提醒" },
        { type: "suppressSmartTagTopic", topicId: topic.id, label: "不再建议" },
      ],
    });
    const updated = deps.topics.markPending(topic.id, message.id);
    if (updated) suggested.push(updated);
  }
  return suggested;
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/[\s_-]+/gu, "");
}

function suggestionContent(topic: TopicCandidate, recent: TopicWindowCounts): ApplicationMessageContentBlock[] {
  return [
    { type: "paragraph", text: `系统持续识别到内容主题「${topic.displayName}」。它不是 IMAP 文件夹，也不会在未经确认时自动创建为长期标签。` },
    { type: "table", headers: ["近 30 天邮件", "会话", "发件来源"], rows: [[String(recent.mailCount), String(recent.threadCount), String(recent.senderCount)]] },
    { type: "callout", tone: "info", title: "确认后会发生什么", text: "创建一个用户智能标签，并重新扫描当前账号的历史邮件进行匹配。" },
  ];
}

function statusLabel(status: string): string {
  if (status === "created") return "已创建";
  if (status === "deferred") return "稍后提醒";
  if (status === "suppressed") return "不再建议";
  return status;
}
