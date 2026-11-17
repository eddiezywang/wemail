import { createHash } from "node:crypto";
import type {
  AutomationActionCandidate,
  AccountQualifiedMailReference,
} from "../../../shared/wemail/automationCenter.js";
import type { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";

export interface SubscriptionActionCandidateResolverOptions {
  mail: Pick<CanonicalMailRepository, "getMessageById">;
  pendingActions: AgentPendingActionRepository;
}

/**
 * Converts model-independent 邮箱速览 recommendations into targets that
 * are re-derived from local mail state. Mutation candidates are never trusted
 * directly from the result payload.
 */
export class SubscriptionActionCandidateResolver {
  constructor(private readonly options: SubscriptionActionCandidateResolverOptions) {}

  resolve(
    runId: string,
    candidates: AutomationActionCandidate[],
  ): AutomationActionCandidate[] {
    return candidates
      .slice(0, 20)
      .map((candidate) => this.resolveOne(runId, candidate))
      .filter((candidate): candidate is AutomationActionCandidate => !!candidate);
  }

  private resolveOne(
    runId: string,
    candidate: AutomationActionCandidate,
  ): AutomationActionCandidate | undefined {
    switch (candidate.type) {
      case "unsubscribe":
        return this.resolveUnsubscribe(runId, candidate);
      case "mute_sender":
        return this.resolveMuteSender(candidate);
      case "verify_security_notice":
        return this.resolveSecurity(candidate);
      case "merge_duplicate_delivery":
        return this.resolveDuplicate(candidate);
      case "keep_subscription":
        return this.resolveKeep(candidate);
    }
  }

  private resolveUnsubscribe(
    runId: string,
    candidate: Extract<AutomationActionCandidate, { type: "unsubscribe" }>,
  ): AutomationActionCandidate | undefined {
    const message = this.options.mail.getMessageById(
      candidate.emailId,
      candidate.accountId,
    );
    if (!message || !sourceIncludes(candidate.sources, candidate.accountId, candidate.emailId)) {
      return undefined;
    }
    const trustedMethods = trustedUnsubscribeMethods(message.headers);
    if (!trustedMethods.includes(candidate.unsubscribeMethodId)) return undefined;

    const pendingActionId = stablePendingActionId(runId, candidate.id);
    if (!this.options.pendingActions.getById(pendingActionId)) {
      this.options.pendingActions.insert({
        id: pendingActionId,
        actionType: "unsubscribe",
        description: `退订“${message.from.name || message.from.email}”的邮件`,
        emailId: message.id,
        accountId: message.accountId,
        owner: { type: "localProfile", profileId: "default" },
        inputJson: JSON.stringify({
          source: "subscription_insight",
          runId,
          candidateId: candidate.id,
          accountId: message.accountId,
          details: { url: candidate.unsubscribeMethodId },
        }),
        riskReason: "退订会向外部站点发送请求或发送退订邮件，执行前需要你的确认。",
        riskLevel: "medium",
      });
    }
    return {
      ...candidate,
      status: "requires_confirmation",
      pendingActionId,
    };
  }

  private resolveMuteSender(
    candidate: Extract<AutomationActionCandidate, { type: "mute_sender" }>,
  ): AutomationActionCandidate | undefined {
    const sender = candidate.senderAddress.trim().toLowerCase();
    if (!sender || candidate.sourceEmailIds.length === 0) return undefined;
    const verified = candidate.sourceEmailIds.every((emailId) => {
      const message = this.options.mail.getMessageById(emailId, candidate.accountId);
      return (
        message?.from.email.toLowerCase() === sender &&
        sourceIncludes(candidate.sources, candidate.accountId, emailId)
      );
    });
    if (!verified) return undefined;
    // The target is trustworthy, but WeMail does not yet have a reversible
    // sender-mute primitive. Keep the recommendation visible without creating
    // a confirm button that would lead to a non-executable pending action.
    return { ...candidate, status: "unavailable", pendingActionId: undefined };
  }

  private resolveSecurity(
    candidate: Extract<
      AutomationActionCandidate,
      { type: "verify_security_notice" }
    >,
  ): AutomationActionCandidate | undefined {
    const message = this.options.mail.getMessageById(
      candidate.emailId,
      candidate.accountId,
    );
    if (!message || !sourceIncludes(candidate.sources, candidate.accountId, candidate.emailId)) {
      return undefined;
    }
    return { ...candidate, status: "available", pendingActionId: undefined };
  }

  private resolveDuplicate(
    candidate: Extract<
      AutomationActionCandidate,
      { type: "merge_duplicate_delivery" }
    >,
  ): AutomationActionCandidate | undefined {
    const accountIds = [...new Set(candidate.accountIds)];
    const verifiedAccounts = new Set(
      candidate.sources
        .filter((source) => !!this.options.mail.getMessageById(source.emailId, source.accountId))
        .map((source) => source.accountId),
    );
    if (
      accountIds.length < 2 ||
      accountIds.some((accountId) => !verifiedAccounts.has(accountId))
    ) {
      return undefined;
    }
    return { ...candidate, accountIds, status: "unavailable", pendingActionId: undefined };
  }

  private resolveKeep(
    candidate: Extract<
      AutomationActionCandidate,
      { type: "keep_subscription" }
    >,
  ): AutomationActionCandidate | undefined {
    const sender = candidate.senderAddress.trim().toLowerCase();
    const verified = candidate.sources.some((source) => {
      if (source.accountId !== candidate.accountId) return false;
      return (
        this.options.mail
          .getMessageById(source.emailId, source.accountId)
          ?.from.email.toLowerCase() === sender
      );
    });
    if (!sender || !verified) return undefined;
    return { ...candidate, status: "available", pendingActionId: undefined };
  }
}

function sourceIncludes(
  sources: AccountQualifiedMailReference[],
  accountId: string,
  emailId: string,
): boolean {
  return sources.some(
    (source) => source.accountId === accountId && source.emailId === emailId,
  );
}

function trustedUnsubscribeMethods(
  headers?: Record<string, string>,
): string[] {
  const value = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === "list-unsubscribe",
  )?.[1];
  if (!value) return [];
  return [...value.matchAll(/<(https:\/\/[^>]+|mailto:[^>]+)>/gi)]
    .map((match) => match[1])
    .filter((method): method is string => !!method)
    .slice(0, 4);
}

function stablePendingActionId(runId: string, candidateId: string): string {
  return `subscription-action-${createHash("sha256")
    .update(`${runId}:${candidateId}`)
    .digest("hex")
    .slice(0, 24)}`;
}
