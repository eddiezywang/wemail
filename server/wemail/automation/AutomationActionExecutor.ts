import type { AutomationAction } from "../../../shared/wemail/automation.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { UserTagRepository } from "../intelligence/UserTagRepository.js";
import type { EmailSmartTagRepository } from "../intelligence/EmailSmartTagRepository.js";
import type { ChannelConnectionRepository } from "../channels/ChannelConnectionRepository.js";
import type { ChannelDeliveryRepository } from "../channels/ChannelLedgerRepository.js";
import type { ChannelAuditRepository } from "../channels/ChannelAuditRepository.js";
import type { ChannelDestinationRepository } from "../channels/ChannelDestinationRepository.js";
import type { ChannelBindingRepository } from "../channels/ChannelBindingRepository.js";
import { createHash } from "node:crypto";

export type AutomationActionResult =
  | { type: AutomationAction["type"]; status: "applied"; emailId: string }
  | {
      type: AutomationAction["type"];
      status: "failed";
      emailId: string;
      reason: string;
    }
  | {
      type: "external";
      status: "unsupported";
      emailId: string;
      reason: "external-action-adapter-not-implemented";
    };

export interface AutomationActionExecutorOptions {
  mail: CanonicalMailRepository;
  /** Edition-specific adapters return undefined when they do not own an action. */
  editionExternalAction?: (accountId: string, emailId: string, action: Extract<AutomationAction, { type: "external" }>) => Promise<AutomationActionResult | undefined>;
  userTags?: UserTagRepository;
  emailSmartTags?: EmailSmartTagRepository;
  channels?: {
    connections: ChannelConnectionRepository;
    bindings: ChannelBindingRepository;
    deliveries: ChannelDeliveryRepository;
    destinations?: ChannelDestinationRepository;
    audit?: ChannelAuditRepository;
  };
}

export interface AutomationExecutionContext {
  ruleId: string;
  runId: string;
}

export class AutomationActionExecutor {
  constructor(private readonly options: AutomationActionExecutorOptions) {}

  setChannels(channels: NonNullable<AutomationActionExecutorOptions["channels"]>): void {
    this.options.channels = channels;
  }

  execute(emailId: string, actions: AutomationAction[]): AutomationActionResult[];
  execute(
    accountId: string,
    emailId: string,
    actions: AutomationAction[],
    context?: AutomationExecutionContext,
  ): Promise<AutomationActionResult[]>;
  execute(
    accountOrEmailId: string,
    emailIdOrActions: string | AutomationAction[],
    maybeActions?: AutomationAction[],
    context?: AutomationExecutionContext,
  ): AutomationActionResult[] | Promise<AutomationActionResult[]> {
    if (Array.isArray(emailIdOrActions)) {
      return emailIdOrActions.map((action) =>
        this.executeLegacyOne(accountOrEmailId, action),
      );
    }
    return this.executeAsync(
      accountOrEmailId,
      emailIdOrActions,
      maybeActions ?? [],
      context,
    );
  }

  private async executeAsync(
    accountId: string,
    emailId: string,
    actions: AutomationAction[],
    context?: AutomationExecutionContext,
  ): Promise<AutomationActionResult[]> {
    const results: AutomationActionResult[] = [];
    for (const [actionIndex, action] of actions.entries()) {
      results.push(
        await this.executeOne(
          accountId,
          emailId,
          action,
          context,
          actionIndex,
        ),
      );
    }
    return results;
  }

  private executeLegacyOne(
    emailId: string,
    action: AutomationAction,
  ): AutomationActionResult {
    try {
      switch (action.type) {
        case "star":
        case "markImportant":
          this.options.mail.updateFlags(emailId, { flagged: true });
          return { type: action.type, status: "applied", emailId };
        case "markNotImportant":
          this.options.mail.updateFlags(emailId, { flagged: false });
          return { type: action.type, status: "applied", emailId };
        case "markRead":
          this.options.mail.updateFlags(emailId, { seen: true });
          return { type: action.type, status: "applied", emailId };
        case "markUnread":
          this.options.mail.updateFlags(emailId, { seen: false });
          return { type: action.type, status: "applied", emailId };
        case "archive":
          this.options.mail.moveMessage(emailId, "Archive");
          return { type: action.type, status: "applied", emailId };
        case "trash":
          this.options.mail.trashMessage(emailId);
          return { type: action.type, status: "applied", emailId };
        case "spam":
          this.options.mail.moveMessage(emailId, "Spam");
          return { type: action.type, status: "applied", emailId };
        case "notSpam":
          this.options.mail.moveMessage(emailId, "INBOX");
          return { type: action.type, status: "applied", emailId };
        case "applyLabel":
        case "suppressTodoCreation":
          return { type: action.type, status: "applied", emailId };
        case "publishApplicationMessage":
          return { type: action.type, status: "failed", emailId, reason: "collection-action-requires-collection-run" };
        case "publishBotMessage":
          return { type: action.type, status: "failed", emailId, reason: "account-context-required" };
        case "external":
          return {
            type: "external",
            status: "unsupported",
            emailId,
            reason: "external-action-adapter-not-implemented",
          };
      }
    } catch (error) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeOne(
    accountId: string,
    emailId: string,
    action: AutomationAction,
    context?: AutomationExecutionContext,
    actionIndex?: number,
  ): Promise<AutomationActionResult> {
    try {
      switch (action.type) {
        case "star":
        case "markImportant":
          this.options.mail.updateFlags(emailId, { flagged: true });
          return { type: action.type, status: "applied", emailId };
        case "markNotImportant":
          this.options.mail.updateFlags(emailId, { flagged: false });
          return { type: action.type, status: "applied", emailId };
        case "markRead":
          this.options.mail.updateFlags(emailId, { seen: true });
          return { type: action.type, status: "applied", emailId };
        case "markUnread":
          this.options.mail.updateFlags(emailId, { seen: false });
          return { type: action.type, status: "applied", emailId };
        case "archive":
          this.options.mail.moveMessage(emailId, "Archive");
          return { type: action.type, status: "applied", emailId };
        case "trash":
          this.options.mail.trashMessage(emailId);
          return { type: action.type, status: "applied", emailId };
        case "spam":
          this.options.mail.moveMessage(emailId, "Spam");
          return { type: action.type, status: "applied", emailId };
        case "notSpam":
          this.options.mail.moveMessage(emailId, "INBOX");
          return { type: action.type, status: "applied", emailId };
        case "applyLabel": {
          const tag = this.options.userTags
            ?.listByAccount(accountId)
            .find((item) => item.name === action.label);
          if (!tag || !this.options.emailSmartTags) {
            return { type: action.type, status: "failed", emailId, reason: "smart-tag-not-found" };
          }
          this.options.emailSmartTags.upsert({
            accountId,
            emailId,
            userTagId: tag.id,
            source: "user",
          });
          return { type: action.type, status: "applied", emailId };
        }
        case "suppressTodoCreation":
          return { type: action.type, status: "applied", emailId };
        case "publishApplicationMessage":
          return { type: action.type, status: "failed", emailId, reason: "collection-action-requires-collection-run" };
        case "publishBotMessage":
          return this.executeBotMessage(
            accountId,
            emailId,
            action,
            context,
            actionIndex,
          );
        case "external":
          return await this.executeExternal(accountId, emailId, action);
      }
    } catch (error) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private executeBotMessage(
    accountId: string,
    emailId: string,
    action: Extract<AutomationAction, { type: "publishBotMessage" }>,
    context?: AutomationExecutionContext,
    actionIndex?: number,
  ): AutomationActionResult {
    const mail = this.options.mail.getMessageById(emailId, accountId);
    if (!mail) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: "mail-not-found",
      };
    }
    const text = renderBotAutomationMessage(action, {
      sender: mail.from.name || mail.from.email,
      subject: mail.subject,
      receivedAt: mail.receivedAt,
      snippet: mail.snippet,
    });
    return this.queueFrozenBotMessage({
      accountId,
      correlationId: context
        ? `${context.ruleId}:${context.runId}:${actionIndex ?? 0}`
        : emailId,
      emailId,
      action,
      text,
      automationRuleId: context?.ruleId,
      automationRunId: context?.runId,
      automationActionIndex: actionIndex,
    });
  }

  queueBotSummary(input: {
    accountId: string;
    ruleId: string;
    runId: string;
    actionIndex: number;
    action: Extract<AutomationAction, { type: "publishBotMessage" }>;
    summary: string;
  }): AutomationActionResult {
    const title = input.action.title?.trim() || "WeMail 自动化通知";
    return this.queueFrozenBotMessage({
      accountId: input.accountId,
      correlationId: `${input.ruleId}:${input.runId}:${input.actionIndex}`,
      emailId: input.runId,
      action: input.action,
      text: `${title.slice(0, 120)}\n\n${input.summary.slice(0, 3_800)}`,
      automationRuleId: input.ruleId,
      automationRunId: input.runId,
      automationActionIndex: input.actionIndex,
    });
  }

  private queueFrozenBotMessage(input: {
    accountId: string;
    correlationId: string;
    emailId: string;
    action: Extract<AutomationAction, { type: "publishBotMessage" }>;
    text: string;
    automationRuleId?: string;
    automationRunId?: string;
    automationActionIndex?: number;
  }): AutomationActionResult {
    const { action, emailId } = input;
    const channels = this.options.channels;
    if (!channels) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: "channel-delivery-not-configured",
      };
    }
    const profile = channels.connections.getProfile(action.botProfileId);
    if (!profile?.owner) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: "channel-profile-not-ready",
      };
    }
    if (
      action.destination.type === "owner" &&
      profile.owner.bindingVersion !== action.destination.ownerBindingVersion
    ) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: "owner-binding-version-changed",
      };
    }
    if (
      !profile.enabled ||
      profile.onboardingState !== "ready" ||
      !profile.initializedAt
    ) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: "channel-profile-not-ready",
      };
    }
    const destination =
      action.destination.type === "conversation"
        ? channels.destinations?.get(
            action.destination.destinationId,
            profile.id,
          )
        : undefined;
    if (
      action.destination.type === "conversation" &&
      (!destination || !destination.verified)
    ) {
      return {
        type: action.type,
        status: "failed",
        emailId,
        reason: "channel-destination-not-eligible",
      };
    }
    const targetType =
      action.destination.type === "owner" ? "person" : destination!.type;
    const targetId =
      action.destination.type === "owner"
        ? profile.platform === "wecom"
          ? channels.bindings.findActiveOwner(profile.id, profile.owner.userId)?.chatId ??
            profile.owner.userId
          : profile.owner.userId
        : destination!.externalId;
    const ownerBindingVersion =
      action.destination.type === "owner"
        ? profile.owner.bindingVersion
        : undefined;
    const destinationVersion =
      action.destination.type === "owner"
        ? `owner:${profile.owner.bindingVersion}`
        : `conversation:${destination!.id}`;
    const fingerprint = createHash("sha256")
      .update(input.text)
      .digest("hex")
      .slice(0, 20);
    channels.deliveries.enqueue({
      connectionId: profile.connectionId,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      targetType,
      targetId,
      purpose: "automation",
      text: input.text,
      sequence: 0,
      maxAttempts: 3,
      correlationKey: [
        "automation",
        input.accountId,
        input.correlationId,
        profile.id,
        destinationVersion,
        fingerprint,
      ].join(":"),
      ...(ownerBindingVersion !== undefined ? { ownerBindingVersion } : {}),
      automationRuleId: input.automationRuleId,
      automationRunId: input.automationRunId,
      automationActionIndex: input.automationActionIndex,
    });
    channels.audit?.record({
      eventType: "automation.bot-message.delivery",
      actor: "automation-executor",
      connectionId: profile.connectionId,
      profileId: profile.id,
      accountId: input.accountId,
      scope: {
        platform: profile.platform,
        botUuid: profile.botUuid,
        destinationType: action.destination.type,
        ...(ownerBindingVersion !== undefined ? { ownerBindingVersion } : {}),
        ...(destination ? { destinationId: destination.id } : {}),
        automationRuleId: input.automationRuleId,
        automationRunId: input.automationRunId,
        automationActionIndex: input.automationActionIndex,
      },
      result: "queued",
    });
    return { type: action.type, status: "applied", emailId };
  }

  private async executeExternal(
    accountId: string,
    emailId: string,
    action: Extract<AutomationAction, { type: "external" }>,
  ): Promise<AutomationActionResult> {
    const editionResult = await this.options.editionExternalAction?.(accountId, emailId, action);
    if (editionResult) return editionResult;
    return { type: "external", status: "unsupported", emailId, reason: "external-action-adapter-not-implemented" };
  }
}

export function renderBotAutomationMessage(
  action: Extract<AutomationAction, { type: "publishBotMessage" }>,
  values: {
    sender: string;
    subject: string;
    receivedAt: string;
    snippet: string;
  },
): string {
  const title = (action.title?.trim() || "WeMail 自动化通知").slice(0, 120);
  const template =
    action.bodyTemplate?.trim() ||
    "发件人：{{sender}}\n主题：{{subject}}\n时间：{{receivedAt}}\n摘要：{{snippet}}";
  const safeTemplate = template.slice(0, 2_000);
  const body = safeTemplate.replace(
    /\{\{(sender|subject|receivedAt|snippet)\}\}/g,
    (_, key: keyof typeof values) =>
      String(values[key] ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
  );
  return `${title}\n\n${body}`.slice(0, 4_000);
}
