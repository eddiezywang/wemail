import type {
  ContentTopicTag,
  SmartTagPromotionDraft,
} from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import { ContextBuilder } from "../ai/context/ContextBuilder.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { normalizeContentTopic } from "./ContentTopicNormalizer.js";
import type { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";
import type {
  TopicCandidate,
  TopicCandidateRepository,
} from "./TopicCandidateRepository.js";

const PROMOTION_SYSTEM_PROMPT = [
  "You turn one email's candidate topic into a concise reusable smart-tag description.",
  "Generalize the recurring business meaning instead of copying the sample.",
  "Remove sample-specific people, dates, identifiers, exact amounts, exact metrics, and one-off wording.",
  "Describe which future emails belong to this tag in plain language.",
  "Write the description in simplified Chinese (简体中文) by default; keep an essential foreign term only when no natural Chinese equivalent exists.",
  "Do not write classification rules, required-signal lists, or exclusions; another step compiles the approved description into a rule.",
  "Return only JSON matching the schema.",
].join(" ");

const PROMOTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["description"],
  properties: {
    description: { type: "string", minLength: 1, maxLength: 1000 },
  },
}) as Record<string, unknown>;

export class SmartTagPromotionError extends Error {
  constructor(
    readonly code:
      | "MESSAGE_NOT_FOUND"
      | "SMART_TAG_CANDIDATE_NOT_FOUND"
      | "SMART_TAG_TOPIC_NOT_FOUND",
  ) {
    super(code);
    this.name = "SmartTagPromotionError";
  }
}

export interface SmartTagPromotionSource {
  message: MailMessage;
  candidate: ContentTopicTag;
  topic: TopicCandidate;
}

export class SmartTagPromotionService {
  private readonly contextBuilder = new ContextBuilder({ feature: "tags" });

  constructor(private readonly deps: {
    mail: CanonicalMailRepository;
    results: IntelligenceResultRepository;
    topics: TopicCandidateRepository;
    llmRuntime: LlmRuntime;
  }) {}

  resolveSource(input: {
    accountId: string;
    emailId: string;
    candidateName: string;
    topicId?: string;
  }): SmartTagPromotionSource {
    const message = this.deps.mail.getMessageById(input.emailId, input.accountId);
    if (!message) throw new SmartTagPromotionError("MESSAGE_NOT_FOUND");
    const saved = this.deps.results.findByEmailId(input.emailId).tags;
    const contentTags = saved?.type === "tags" ? saved.contentTags ?? [] : [];
    const candidateName = input.candidateName.trim();
    const candidate = contentTags.find((tag) => tag.name.trim() === candidateName);
    if (!candidate) {
      throw new SmartTagPromotionError("SMART_TAG_CANDIDATE_NOT_FOUND");
    }
    const normalized = normalizeContentTopic(candidate.name);
    if (!normalized) {
      throw new SmartTagPromotionError("SMART_TAG_CANDIDATE_NOT_FOUND");
    }
    const requestedTopicId = input.topicId ?? candidate.topicId;
    if (requestedTopicId) {
      const topic = this.deps.topics.getById(requestedTopicId, input.accountId);
      const hasEvidence = topic
        ? this.deps.topics.listEvidence(topic.id, 200).some((item) => item.emailId === message.id)
        : false;
      if (
        !topic
        || topic.normalizedKey !== normalized.normalizedKey
        || !hasEvidence
      ) {
        if (input.topicId) {
          throw new SmartTagPromotionError("SMART_TAG_TOPIC_NOT_FOUND");
        }
      } else {
        return { message, candidate, topic };
      }
    }
    const topic = this.deps.topics.recordEvidence({
      accountId: message.accountId,
      normalizedKey: normalized.normalizedKey,
      displayName: normalized.displayName,
      emailId: message.id,
      threadId: message.threadId,
      senderKey: senderKey(message),
      confidence: candidate.confidence,
    });
    return { message, candidate, topic };
  }

  async preview(input: {
    accountId: string;
    emailId: string;
    candidateName: string;
    topicId?: string;
    refresh?: boolean;
  }): Promise<SmartTagPromotionDraft> {
    const source = this.resolveSource(input);
    const fallback = (generationError: string): SmartTagPromotionDraft => ({
      name: source.candidate.name.trim(),
      description: `用于归类与“${source.candidate.name.trim()}”这一通用主题明确相关的邮件。`,
      topicId: source.topic.id,
      sourceEmailId: source.message.id,
      generationStatus: "fallback",
      generationError,
    });
    // 同一临时标签（topic）只生成一次描述：未保存再次点击直接复用缓存，
    // 用户显式“重新生成”（refresh）时才覆盖缓存。fallback 失败结果不缓存。
    if (!input.refresh) {
      const cached = this.deps.topics.getPromotionDescription(source.topic.id);
      if (cached) {
        return {
          name: source.candidate.name.trim(),
          description: cached,
          topicId: source.topic.id,
          sourceEmailId: source.message.id,
          generationStatus: "generated",
        };
      }
    }
    const snapshot = this.deps.llmRuntime.snapshot();
    const client = snapshot.client;
    const model = snapshot.modelFor("default");
    if (!client || !model) return fallback("MODEL_UNAVAILABLE");
    const context = this.contextBuilder.build({
      subject: source.message.subject,
      from: formatSender(source.message),
      bodyText: source.message.bodyText,
      bodyHtml: source.message.bodyHtml,
    });
    try {
      const response = await client.generate({
        model,
        system: PROMOTION_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            `Candidate topic: ${source.candidate.name.trim()}`,
            "Current email (the only sample; do not preserve its accidental specifics):",
            context.promptText,
          ].join("\n\n"),
        }],
        jsonSchema: PROMOTION_SCHEMA,
        temperature: 0,
        maxTokens: 1_000,
        timeoutMs: 25_000,
      });
      const description = parsePromotionDescription(response.text);
      if (!description) return fallback("INVALID_MODEL_RESULT");
      this.deps.topics.setPromotionDescription(source.topic.id, description.slice(0, 1000));
      return {
        name: source.candidate.name.trim(),
        description: description.slice(0, 1000),
        topicId: source.topic.id,
        sourceEmailId: source.message.id,
        generationStatus: "generated",
      };
    } catch {
      return fallback("GENERATION_FAILED");
    }
  }
}

function senderKey(message: Pick<MailMessage, "from">): string | undefined {
  const email = message.from.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : email || undefined;
}

function formatSender(message: Pick<MailMessage, "from">): string {
  const name = message.from.directoryName?.trim() || message.from.name?.trim();
  return name ? `${name} <${message.from.email}>` : message.from.email;
}

function parsePromotionDescription(text: string): string | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : null;
  } catch {
    return null;
  }
}
