import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../../../shared/wemail/agent.js";
import type { AgentPendingAction } from "../../../shared/wemail/intelligence.js";
import type {
  ChannelBinding,
  ChannelDelivery,
  ChannelInboundEvent,
} from "../../../shared/wemail/channels.js";
import type { AgentRuntime } from "../agent/AgentRuntime.js";
import type {
  AgentConversationRepository,
  AgentMessageRecord,
} from "../agent/AgentConversationRepository.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import {
  ChannelDeliveryRepository,
  ChannelInboundRepository,
  type LeasedInbound,
} from "./ChannelLedgerRepository.js";
import {
  LangBotClient,
  LangBotClientError,
} from "./LangBotClient.js";
import type { LangBotConnectionService } from "./LangBotConnectionService.js";
import type { ChannelPairingService } from "./ChannelPairingService.js";
import type { ChannelApprovalService } from "./ChannelApprovalService.js";
import type { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import {
  BotChannelRuntime,
  BotChannelTransportError,
} from "./BotChannelRuntime.js";
import { sanitizePresentation } from "./channelText.js";
import { WecomStreamSession } from "./WecomStreamSession.js";
import { FeishuStreamSession } from "./FeishuStreamSession.js";
import {
  BaseStreamSession,
  type StreamFinishResult,
} from "./streamSessionBase.js";
import { FeishuStreamCircuitBreaker } from "./feishuStreamCircuitBreaker.js";
import { mapAgentEventToProgress } from "./streamProgress.js";

const MAX_CHUNK_LENGTH = 4_000;
const MAX_INBOUND_ATTEMPTS = 3;
export const CHANNEL_DELIVERY_RETRY_WINDOW_MS = 10 * 60_000;

export interface ChannelWorkerOptions {
  ledger?: Pick<MailDatabaseClient, "leaseChannelInbound" | "leaseChannelDelivery">;
  pollIntervalMs?: number;
  clientFactory?: (input: {
    baseUrl: string;
    apiKey: string;
  }) => Pick<LangBotClient, "sendMessage">;
  botRuntime?: BotChannelRuntime;
  conversations?: AgentConversationRepository;
  now?: () => Date;
  onAutomationDeliverySettled?: (delivery: ChannelDelivery) => void;
  logger?: {
    error(event: string, fields?: Record<string, unknown>): void;
  };
  /**
   * Internal kill switch for WeCom streaming agent replies. Defaults to ON
   * (enabled). When OFF, WeCom replies use the original one-shot delivery.
   * Persisting this to a profile setting + UI toggle is a separate task.
   */
  wecomStreamingEnabled?: boolean;
  /**
   * Internal kill switch for Feishu streaming agent replies. Defaults to ON.
   * A per-profile circuit breaker further gates it: repeated `startCard`
   * failures (e.g. missing `cardkit:card:write` permission) trip the breaker so
   * Feishu replies fall back to one-shot without a wasted attempt per request.
   */
  feishuStreamingEnabled?: boolean;
}

export class ChannelWorker {
  private readonly workerId = `channel-${randomUUID()}`;
  private readonly feishuBreaker = new FeishuStreamCircuitBreaker();
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = true;
  private generation = 0;
  private activeRunController?: AbortController;

  constructor(
    private readonly inbound: ChannelInboundRepository,
    private readonly deliveries: ChannelDeliveryRepository,
    private readonly bindings: ChannelBindingRepository,
    private readonly connections: ChannelConnectionRepository,
    private readonly connectionService: LangBotConnectionService,
    private readonly pairing: ChannelPairingService,
    private readonly approvals: ChannelApprovalService,
    private readonly audit: ChannelAuditRepository,
    private readonly runtime: AgentRuntime,
    private readonly options: ChannelWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = Math.max(100, this.options.pollIntervalMs ?? 750);
    this.timer = setInterval(() => this.scheduleTick(), interval);
    this.timer.unref?.();
    this.scheduleTick();
  }

  stop(): void {
    this.generation += 1;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.activeRunController?.abort();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.runOnce();
  }

  private scheduleTick(): void {
    void this.tick().catch((error) => {
      this.options.logger?.error("channel.worker.tick.failed", {
        workerId: this.workerId,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async runOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const generation = this.generation;
      await this.processOneInbound(generation);
      if (generation === this.generation) await this.processOneDelivery(generation);
    } finally {
      this.ticking = false;
    }
  }

  private async processOneInbound(generation: number): Promise<void> {
    const leased = this.options.ledger?.leaseChannelInbound
      ? await this.options.ledger.leaseChannelInbound(this.workerId)
      : this.inbound.leaseNext(this.workerId);
    if (!leased || generation !== this.generation) return;
    let streamSink: BaseStreamSession | undefined;
    try {
      const pairing = this.pairing.intercept(leased.event);
      if (pairing.handled) {
        this.inbound.ignore(leased.id, `pairing-${pairing.outcome}`);
        return;
      }
      const binding = this.resolveBinding(leased.event);
      if (!binding) {
        this.inbound.ignore(leased.id, "identity-not-bound");
        return;
      }
      if (
        leased.event.chatKind === "group" &&
        binding.requireMention &&
        !leased.event.mentionedBot
      ) {
        this.inbound.ignore(leased.id, "mention-required");
        return;
      }
      const processingReactionAdded =
        await this.updateFeishuProcessingReaction(leased.event, "add");
      try {
        const slash = await this.approvals.intercept(leased.event, binding);
        const resolved = slash.handled
          ? slash
          : await this.approvals.resolveByNaturalLanguage(leased.event, binding);
        if (resolved.handled) {
          const target = deliveryTarget(leased.event);
          this.deliveries.enqueue({
            connectionId: leased.event.connectionId,
            profileId: binding.profileId,
            botUuid: leased.event.botUuid,
            platform: leased.event.platform,
            targetType: target.type,
            targetId: target.id,
            purpose: "confirmation",
            text: resolved.message,
            sequence: 0,
            maxAttempts: 3,
            correlationKey: `approval-result:${leased.event.connectionId}:${leased.event.eventId}`,
          });
          this.inbound.complete(leased.id);
          return;
        }
        streamSink = this.createStreamSink(leased.event, binding);
        if (streamSink) {
          // Light up the bubble immediately, before MCP/agent init produces the
          // first token (which can take a second or two).
          streamSink.update({ type: "progress", text: "正在处理…" });
        }
        const { text, streamResult } = await this.runAgent(
          leased.event,
          binding,
          0,
          streamSink,
        );
        if (streamResult?.outcome !== "streamed") {
          // streamed → already in the bubble; skip the one-shot enqueue.
          // fallback-required → stream finished with a "see next message"
          //   notice; send the full text via the delivery queue.
          // failed / undefined → no usable stream; send the full text.
          // In every non-streamed case the user gets the complete answer exactly
          // once (never a near-complete bubble plus a duplicate full message).
          const chunks = splitChannelText(text);
          const target = deliveryTarget(leased.event);
          chunks.forEach((chunk, sequence) => {
            this.deliveries.enqueue({
              connectionId: leased.event.connectionId,
              profileId: binding.profileId,
              botUuid: leased.event.botUuid,
              platform: leased.event.platform,
              targetType: target.type,
              targetId: target.id,
              purpose: "agent_reply",
              text: chunk,
              sequence,
              maxAttempts: 3,
              correlationKey: `agent:${leased.event.connectionId}:${leased.event.eventId}`,
            });
          });
        }
        this.inbound.complete(leased.id);
      } finally {
        if (processingReactionAdded) {
          await this.updateFeishuProcessingReaction(leased.event, "remove");
        }
      }
    } catch {
      // The run was aborted or the runtime threw; don't leave a streaming
      // bubble dangling — best-effort terminal frame before re-queuing.
      await streamSink?.dispose().catch(() => undefined);
      this.retryInbound(leased, "agent-runtime-unavailable");
    }
  }

  private async updateFeishuProcessingReaction(
    event: ChannelInboundEvent,
    action: "add" | "remove",
  ): Promise<boolean> {
    if (event.platform !== "feishu" || !this.options.botRuntime) return false;
    const profile = this.connections
      .listProfiles("feishu")
      .find(
        (candidate) =>
          candidate.connectionId === event.connectionId &&
          candidate.botUuid === event.botUuid,
      );
    if (!profile) return false;
    try {
      await this.options.botRuntime.setReaction({
        profileId: profile.id,
        messageId: event.eventId,
        emojiType: "OnIt",
        action,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async runAgent(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
    retryCount = 0,
    streamSink?: BaseStreamSession,
  ): Promise<{ text: string; streamResult?: StreamFinishResult }> {
    const persisted = this.prepareConversation(event, binding);
    if (persisted.assistantText) {
      // Idempotent re-run of an already-answered inbound. A sink may already
      // have been opened (and shown the initial frame); finish it cleanly with
      // the cached answer instead of leaving the bubble dangling.
      if (streamSink) {
        const streamResult = await streamSink.finish(persisted.assistantText);
        return { text: persisted.assistantText, streamResult };
      }
      return { text: persisted.assistantText };
    }

    const controller = new AbortController();
    this.activeRunController = controller;
    const output: string[] = [];
    let conclusion = "";
    let ownerMailExecutionSummary: string | undefined;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const directOwnerSendAuthorized =
      this.isDirectWecomOwner(event, binding);
    const ownerMailPreviewConfirmed =
      directOwnerSendAuthorized &&
      isExplicitMailPreviewConfirmation(
        event.text,
        persisted.recentConversation,
      );
    try {
      for await (const item of this.runtime.run({
        userText: event.text,
        accountId: binding.accountId,
        sessionId: binding.conversationId,
        persist: true,
        signal: controller.signal,
        context: {
          timezone,
          channel: {
            platform: event.platform,
            connectionId: event.connectionId,
            botUuid: event.botUuid,
            chatKind: event.chatKind,
            chatId: event.chatId,
            senderId: event.senderId,
            eventId: event.eventId,
            directOwnerSendAuthorized,
            ownerMailPreviewConfirmed,
          },
          ...(persisted.recentConversation.length > 0
            ? { recentConversation: persisted.recentConversation }
            : {}),
        },
      })) {
        const safe = safeAgentPresentation(item);
        if (safe.kind === "text") output.push(safe.text);
        if (safe.kind === "conclusion") conclusion = safe.text;
        const progress = mapAgentEventToProgress(item);
        if (progress && streamSink) streamSink.update(progress);
        if (item.type === "pending_action") {
          if (
            directOwnerSendAuthorized &&
            (item.action.actionType === "send" ||
              item.action.actionType === "schedule_send")
          ) {
            if (ownerMailPreviewConfirmed) {
              const execution =
                await this.approvals.executePreauthorizedOwnerMailAction(
                  binding,
                  item.action,
                );
              ownerMailExecutionSummary = ownerMailExecutionReply(
                item.action,
                execution,
                timezone,
              );
              this.audit.record({
                eventType: "channel.owner.mail-action-preauthorized",
                actor: "channel-owner",
                connectionId: event.connectionId,
                profileId: binding.profileId,
                accountId: binding.accountId,
                scope: {
                  platform: event.platform,
                  chatKind: event.chatKind,
                  actionType: item.action.actionType,
                },
                result: execution.ok ? "executed" : "failed",
              });
            } else {
              this.approvals.rejectOwnerMailActionWithoutPreview(
                binding,
                item.action,
              );
              output.push(
                "\n本次未发送。请先保存草稿并展示【邮件预览】或【定时邮件预览】，待你确认或调整后再执行。\n",
              );
            }
          }
          // Non-send/schedule pending actions: the agent has already asked the
          // owner to confirm in natural language (e.g. "请回复「确认删除」继续").
          // Do NOT also append the /approve <token> prompt — that surfaced two
          // conflicting confirmation paths (users didn't know which to reply
          // with) and the slash-command execution was failing anyway. The
          // agent runtime executes the action on the owner's natural-language
          // confirmation, which is the single intended path.
        }
      }
    } finally {
      if (this.activeRunController === controller) {
        this.activeRunController = undefined;
      }
    }
    const result =
      ownerMailExecutionSummary ??
      (output.join("").trim() || conclusion.trim());
    const finalText = result || "本次请求已处理，但没有可展示的文本结果。";
    if (retryCount === 0 && isTransientAgentFailure(finalText)) {
      // A few OpenAI-compatible gateways occasionally acknowledge a request
      // without returning a visible assistant event. Retry once before
      // surfacing a failure to the channel user; tool failures and timeouts
      // are deliberately not retried here because they may have side effects.
      // Reuse the same streaming session so the bubble never hangs; this retry
      // only fires when there was no displayable output, so there is no body
      // to reset.
      streamSink?.update({
        type: "progress",
        text: "ℹ️ 模型响应异常，正在重试…",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      return this.runAgent(event, binding, 1, streamSink);
    }
    this.options.conversations?.addMessage({
      conversationId: binding.conversationId,
      role: "assistant",
      body: {
        text: finalText,
        channelEventId: event.eventId,
        channelPlatform: event.platform,
      },
    });
    if (streamSink) {
      const streamResult = await streamSink.finish(finalText);
      return { text: finalText, streamResult };
    }
    return { text: finalText };
  }

  /**
   * Create a streaming session for a passive agent reply, platform-aware.
   *  - WeCom: keyed on the inbound `eventId` (== the WeCom msgid bot-core
   *    caches the reply frame under).
   *  - Feishu: keyed on the inbound `chatId` (a chat_id; NOT `deliveryTarget`,
   *    which returns the sender open_id for person chats and would fail the
   *    card send), gated by the per-profile circuit breaker.
   * Returns undefined for unsupported platforms, when streaming is disabled,
   * when the breaker is tripped, or when no bot runtime is wired.
   */
  private createStreamSink(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
  ): BaseStreamSession | undefined {
    const runtime = this.options.botRuntime;
    if (!runtime) return undefined;
    if (event.platform === "wecom") {
      if (this.options.wecomStreamingEnabled === false) return undefined;
      // Duck-type so minimal (send-only) mock runtimes keep one-shot behavior.
      if (
        typeof (runtime as { streamFrame?: unknown }).streamFrame !== "function"
      ) {
        return undefined;
      }
      return new WecomStreamSession(runtime, binding.profileId, event.eventId);
    }
    if (event.platform === "feishu") {
      if (this.options.feishuStreamingEnabled === false) return undefined;
      if (!this.feishuBreaker.allow(binding.profileId)) return undefined;
      if (
        typeof (runtime as { feishuStreamStart?: unknown })
          .feishuStreamStart !== "function"
      ) {
        return undefined;
      }
      return new FeishuStreamSession(
        runtime,
        binding.profileId,
        event.chatId,
        {
          onStartOutcome: (ok) =>
            ok
              ? this.feishuBreaker.recordSuccess(binding.profileId)
              : this.feishuBreaker.recordFailure(binding.profileId),
        },
      );
    }
    return undefined;
  }

  private isDirectWecomOwner(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
  ): boolean {
    if (
      event.platform !== "wecom" ||
      event.chatKind !== "person" ||
      binding.platform !== "wecom" ||
      binding.chatKind !== "person" ||
      binding.senderId !== event.senderId ||
      binding.chatId !== event.chatId
    ) {
      return false;
    }
    const profile = this.connections.getProfile(binding.profileId);
    return (
      profile?.connectionId === event.connectionId &&
      profile.botUuid === event.botUuid &&
      profile.owner?.userId === event.senderId
    );
  }

  private prepareConversation(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
  ): {
    assistantText?: string;
    recentConversation: Array<{
      role: "user" | "assistant";
      text: string;
      at: string;
    }>;
  } {
    const conversations = this.options.conversations;
    if (!conversations) return { recentConversation: [] };

    const conversation = conversations.ensureConversation({
      id: binding.conversationId,
      accountId: binding.accountId,
    });
    if (conversation.accountId !== binding.accountId) {
      throw new Error("channel-conversation-account-mismatch");
    }

    const messages = conversations.listMessages(binding.conversationId);
    const messagesForEvent = messages.filter(
      (message) => message.body.channelEventId === event.eventId,
    );
    const existingAssistant = messagesForEvent.find(
      (message) => message.role === "assistant",
    );
    const assistantText = existingAssistant
      ? textFromConversationMessage(existingAssistant)
      : "";
    if (assistantText) {
      return { assistantText, recentConversation: [] };
    }

    const recentConversation = messages
      .filter((message) => message.body.channelEventId !== event.eventId)
      .slice(-8)
      .map((message) => ({
        role: message.role,
        text: textFromConversationMessage(message).slice(0, 1_200),
        at: message.createdAt,
      }))
      .filter((message) => message.text.length > 0);

    const existingUser = messagesForEvent.some(
      (message) => message.role === "user",
    );
    if (!existingUser) {
      conversations.addMessage({
        conversationId: binding.conversationId,
        role: "user",
        body: {
          text: event.text,
          channelEventId: event.eventId,
          channelPlatform: event.platform,
        },
      });
    }
    return { recentConversation };
  }

  private resolveBinding(event: ChannelInboundEvent): ChannelBinding | undefined {
    const exact = this.bindings.resolve({
      connectionId: event.connectionId,
      botUuid: event.botUuid,
      platform: event.platform,
      chatKind: event.chatKind,
      chatId: event.chatId,
      senderId: event.senderId,
    });
    if (exact) return exact;

    const profile = this.connections
      .listProfiles(event.platform)
      .find(
        (candidate) =>
          candidate.connectionId === event.connectionId &&
          candidate.botUuid === event.botUuid,
      );
    if (profile?.owner?.userId !== event.senderId) return undefined;
    const ownerBinding = this.bindings
      .listByProfile(profile.id)
      .find(
        (binding) =>
          binding.enabled &&
          !binding.revokedAt &&
          binding.chatKind === "person" &&
          binding.senderId === profile.owner!.userId,
      );
    if (!ownerBinding) return undefined;
    const inherited = this.bindings.save({
      connectionId: profile.connectionId,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      chatKind: event.chatKind,
      chatId: event.chatId,
      senderId: event.senderId,
      accountId: ownerBinding.accountId,
      conversationId: `channel:${profile.id}:${event.chatKind}:${event.chatId}:${event.senderId}`,
      enabled: true,
      requireMention: event.chatKind === "group",
    });
    this.audit.record({
      eventType: "channel.owner.scope-bound",
      actor: "channel-owner",
      connectionId: profile.connectionId,
      profileId: profile.id,
      accountId: ownerBinding.accountId,
      scope: {
        platform: profile.platform,
        chatKind: event.chatKind,
      },
      result: "inherited-current-mailbox",
    });
    return inherited;
  }

  private retryInbound(leased: LeasedInbound, code: string): void {
    if (leased.attempts >= MAX_INBOUND_ATTEMPTS) {
      this.inbound.fail(leased.id, code);
      return;
    }
    this.inbound.retry(
      leased.id,
      code,
      new Date(
        this.now().getTime() + Math.min(60_000, 1_000 * 2 ** leased.attempts),
      ).toISOString(),
    );
  }

  private async processOneDelivery(generation: number): Promise<void> {
    const delivery = this.options.ledger?.leaseChannelDelivery
      ? await this.options.ledger.leaseChannelDelivery(this.workerId)
      : this.deliveries.leaseNext(this.workerId);
    if (!delivery || generation !== this.generation) return;
    const connection = this.connections.getConnection(delivery.connectionId);
    const apiKey = this.connectionService.getApiKey(delivery.connectionId);
    if (!connection?.enabled) {
      this.failDelivery(
        delivery,
        "connection-disabled",
        "failed",
        "permanently-failed",
      );
      return;
    }
    if (!this.ownerVersionStillValid(delivery)) return;
    try {
      if (this.options.botRuntime) {
        await this.options.botRuntime.send({
          profileId: delivery.profileId,
          targetType: delivery.targetType,
          targetId: delivery.targetId,
          text: delivery.text,
        });
      } else if (this.options.clientFactory && apiKey) {
        const client = this.options.clientFactory({
          baseUrl: connection.baseUrl,
          apiKey,
        });
        await client.sendMessage({
          botUuid: delivery.botUuid,
          targetType: delivery.targetType,
          targetId: delivery.targetId,
          text: delivery.text,
        });
      } else {
        throw new BotChannelTransportError("bot-core-not-ready", true);
      }
    } catch (error) {
      const classified =
        error instanceof BotChannelTransportError
          ? error
          : error instanceof LangBotClientError
          ? error
          : new BotChannelTransportError("platform-connection-failed", true);
      this.bestEffort(() => {
        this.connections.setProfileActivity(delivery.profileId, "outbound", {
          success: false,
          errorCode: classified.code,
        });
      });
      if (!classified.retryable) {
        this.failDelivery(
          delivery,
          classified.code,
          "failed",
          "permanently-failed",
        );
        this.bestEffort(() => {
          this.updateStatusObservation(
            delivery.profileId,
            "disconnected",
            classified.code,
          );
        });
        return;
      }
      const retryDeadline = channelDeliveryRetryDeadline(delivery);
      if (this.now().getTime() >= retryDeadline.getTime()) {
        this.failDelivery(
          delivery,
          "delivery-retry-window-expired",
          "ambiguous",
          "ambiguous",
        );
        this.bestEffort(() => {
          this.updateStatusObservation(
            delivery.profileId,
            "attention",
            "delivery-retry-window-expired",
          );
        });
        return;
      }
      const proposedNextAttempt = this.now().getTime() +
        Math.min(5 * 60_000, 2_000 * 2 ** delivery.attempts);
      const retry = this.deliveries.markRetryAndActivateFallback(
        delivery,
        classified.code,
        new Date(
          Math.min(proposedNextAttempt, retryDeadline.getTime()),
        ).toISOString(),
      );
      this.bestEffort(() => {
        this.auditAutomationDelivery(
          delivery,
          retry.terminal ? "ambiguous" : "retrying",
          classified.code,
        );
      });
      if (retry.terminal) {
        this.notifyAutomationDeliverySettled(delivery);
      }
      this.bestEffort(() => {
        this.updateStatusObservation(
          delivery.profileId,
          "attention",
          classified.code,
        );
      });
      return;
    }

    this.deliveries.markSent(delivery.id);
    this.bestEffort(() => this.auditAutomationDelivery(delivery, "delivered"));
    this.notifyAutomationDeliverySettled(delivery);
    this.bestEffort(() => {
      this.connections.setProfileActivity(delivery.profileId, "outbound", {
        success: true,
      });
    });
    if (delivery.purpose === "initialization") {
      this.bestEffort(() => this.deliveries.markInitializationSent(delivery.id));
      this.bestEffort(() => {
        this.connections.setProfileState(delivery.profileId, {
          state: "ready",
          enabled: true,
          initializationVersion: 1,
          initializedAt: this.now().toISOString(),
        });
      });
    }
    this.bestEffort(() => {
      this.updateStatusObservation(delivery.profileId, "connected");
    });
  }

  private updateStatusObservation(
    profileId: string,
    state: "connected" | "attention" | "disconnected",
    reasonCode?: string,
  ): void {
    const profile = this.connections.getProfile(profileId);
    if (!profile) return;
    const lacksDetection =
      state === "connected" &&
      profile.onboardingState === "ready" &&
      !profile.lastDetectedAt;
    this.connections.upsertObservation({
      entryKey: `channel:${profile.platform}:${profile.id}`,
      integrationId: profile.platform,
      profileId: profile.id,
      state:
        state === "connected" &&
        (profile.onboardingState !== "ready" || lacksDetection)
          ? "attention"
          : state,
      reasonCode: lacksDetection ? "connection-detection-required" : reasonCode,
      nextAction: lacksDetection
        ? "请执行一次连接检测"
        : reasonCode
          ? "请检查 Bot Core 与平台机器人连接"
          : undefined,
    });
  }

  private ownerVersionStillValid(delivery: ChannelDelivery): boolean {
    if (delivery.ownerBindingVersion === undefined) return true;
    const profile = this.connections.getProfile(delivery.profileId);
    const currentTargetId = profile?.owner
      ? profile.platform === "wecom"
        ? this.bindings.findActiveOwner(profile.id, profile.owner.userId)?.chatId ??
          profile.owner.userId
        : profile.owner.userId
      : undefined;
    if (
      profile?.owner?.bindingVersion === delivery.ownerBindingVersion &&
      currentTargetId === delivery.targetId
    ) {
      return true;
    }
    this.failDelivery(
      delivery,
      "owner-binding-version-changed",
      "needs_reauthorization",
      "needs-reauthorization",
    );
    return false;
  }

  private failDelivery(
    delivery: ChannelDelivery,
    errorCode: string,
    state: "failed" | "ambiguous" | "needs_reauthorization",
    auditResult: string,
  ): void {
    this.deliveries.markTerminalAndActivateFallback(
      delivery,
      errorCode,
      state,
    );
    this.bestEffort(() => {
      this.auditAutomationDelivery(delivery, auditResult, errorCode);
    });
    this.notifyAutomationDeliverySettled(delivery);
  }

  private notifyAutomationDeliverySettled(delivery: ChannelDelivery): void {
    if (delivery.purpose !== "automation" || !delivery.automationRunId) return;
    try {
      this.options.onAutomationDeliverySettled?.(delivery);
    } catch {
      this.bestEffort(() => {
        this.auditAutomationDelivery(
          delivery,
          "run-reconciliation-failed",
          "run-reconciliation-failed",
        );
      });
    }
  }

  private bestEffort(operation: () => void): void {
    try {
      operation();
    } catch {
      // Delivery state is authoritative; telemetry and projections must not resend.
    }
  }

  private auditAutomationDelivery(
    delivery: ChannelDelivery,
    result: string,
    errorCode?: string,
  ): void {
    if (delivery.purpose !== "automation") return;
    this.audit.record({
      eventType: "automation.bot-message.delivery",
      actor: "automation-worker",
      connectionId: delivery.connectionId,
      profileId: delivery.profileId,
      scope: {
        platform: delivery.platform,
        botUuid: delivery.botUuid,
        ownerBindingVersion: delivery.ownerBindingVersion,
        automationRuleId: delivery.automationRuleId,
        automationRunId: delivery.automationRunId,
        automationActionIndex: delivery.automationActionIndex,
        ...(errorCode ? { errorCode } : {}),
      },
      result,
    });
  }
}

function deliveryTarget(event: Pick<ChannelInboundEvent, "chatKind" | "chatId" | "senderId">): {
  type: ChannelInboundEvent["chatKind"];
  id: string;
} {
  return {
    type: event.chatKind,
    id: event.chatKind === "person" ? event.senderId : event.chatId,
  };
}

export function isExplicitMailPreviewConfirmation(
  text: string,
  recentConversation: Array<{ role: "user" | "assistant"; text: string }>,
): boolean {
  const previousAssistant = [...recentConversation]
    .reverse()
    .find((message) => message.role === "assistant")?.text;
  if (
    !previousAssistant ||
    !/【(?:定时)?邮件预览】/.test(previousAssistant) ||
    !/(确认|调整|修改)/.test(previousAssistant)
  ) {
    return false;
  }
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  if (
    !normalized ||
    /(不确认|不要|别发|取消|修改|调整|改成|先不|等等|有问题)/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /(确认|可以|没问题|就这样|按.*(?:发|发送)|(?:发|发送)吧)/.test(
    normalized,
  );
}

function ownerMailExecutionReply(
  action: AgentPendingAction,
  execution: { ok: boolean; summary: string },
  timezone: string,
): string {
  if (!execution.ok || action.actionType !== "schedule_send") {
    return execution.summary;
  }
  try {
    const input = JSON.parse(action.inputJson) as { sendAt?: unknown };
    if (typeof input.sendAt !== "string") return execution.summary;
    const sendAt = new Date(input.sendAt);
    if (!Number.isFinite(sendAt.getTime())) return execution.summary;
    const localTime = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(sendAt);
    return `邮件已安排在 ${localTime}（${timezone}）发送。`;
  } catch {
    return execution.summary;
  }
}

export function channelDeliveryRetryDeadline(
  delivery: Pick<ChannelDelivery, "createdAt">,
): Date {
  return new Date(
    new Date(delivery.createdAt).getTime() + CHANNEL_DELIVERY_RETRY_WINDOW_MS,
  );
}

type SafePresentation =
  | { kind: "text"; text: string }
  | { kind: "conclusion"; text: string }
  | { kind: "ignored" };

export function safeAgentPresentation(event: AgentEvent): SafePresentation {
  if (event.type === "text_end" || event.type === "assistant_text") {
    return { kind: "text", text: sanitizePresentation(event.text) };
  }
  if (event.type === "conclusion") {
    return {
      kind: "conclusion",
      text: sanitizePresentation(
        [event.summary, event.reason, event.nextAction]
          .filter(Boolean)
          .join("\n"),
      ),
    };
  }
  if (event.type === "error") {
    return { kind: "conclusion", text: "处理请求时遇到问题，请稍后重试。" };
  }
  return { kind: "ignored" };
}

function isTransientAgentFailure(text: string): boolean {
  return text.includes("Agent 未返回任何可展示内容，可能是模型服务未正常响应。");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

export function splitChannelText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return ["本次请求已处理。"];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > MAX_CHUNK_LENGTH) {
    const window = remaining.slice(0, MAX_CHUNK_LENGTH + 1);
    const breakAt = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf("。"),
      window.lastIndexOf(" "),
    );
    const size = breakAt >= MAX_CHUNK_LENGTH / 2 ? breakAt + 1 : MAX_CHUNK_LENGTH;
    chunks.push(remaining.slice(0, size).trim());
    remaining = remaining.slice(size).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function textFromConversationMessage(message: AgentMessageRecord): string {
  const text = message.body.text;
  return typeof text === "string" ? text.trim() : "";
}
