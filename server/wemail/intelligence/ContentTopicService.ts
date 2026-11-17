import type { ContentTopicTag } from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { normalizeContentTopic } from "./ContentTopicNormalizer.js";
import type { TopicCandidateRepository } from "./TopicCandidateRepository.js";

function senderKey(message: Pick<MailMessage, "from">): string | undefined {
  const email = message.from.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : email || undefined;
}

export class ContentTopicService {
  constructor(
    private readonly topics: TopicCandidateRepository,
    private readonly onCandidate?: (accountId: string, topicId: string) => void,
  ) {}

  recordForMessage(
    message: Pick<MailMessage, "id" | "accountId" | "threadId" | "from">,
    tags: readonly ContentTopicTag[],
  ): ContentTopicTag[] {
    return tags.slice(0, 3).map((tag) => {
      const normalized = normalizeContentTopic(tag.name);
      if (!normalized) return tag;
      const topic = this.topics.recordEvidence({
        accountId: message.accountId,
        normalizedKey: normalized.normalizedKey,
        displayName: normalized.displayName,
        emailId: message.id,
        threadId: message.threadId,
        senderKey: senderKey(message),
        confidence: tag.confidence,
      });
      this.onCandidate?.(message.accountId, topic.id);
      return { ...tag, topicId: topic.id };
    });
  }
}

