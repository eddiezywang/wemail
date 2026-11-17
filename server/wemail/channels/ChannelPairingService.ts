import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChannelInboundEvent } from "../../../shared/wemail/channels.js";
import type { MailDatabase } from "../database/Database.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelBindingRepository } from "./ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelDeliveryRepository } from "./ChannelLedgerRepository.js";

const INITIALIZATION_CONTENT_VERSION = 1;
const PAIRING_PATTERN = /^\/wemail\s+connect\s+([A-Za-z0-9_-]{12,64})\s*$/i;

const hashReference = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface PairingChallenge {
  profileId: string;
  code: string;
  command: string;
  expiresAt: string;
}

export type PairingInterceptResult =
  | { handled: false }
  | {
      handled: true;
      outcome:
        | "paired"
        | "invalid"
        | "expired"
        | "replayed"
        | "wrong-scope"
        | "account-required"
        | "attempts-exhausted";
    };

interface PairingRow {
  id: string;
  profile_id: string;
  connection_id: string;
  bot_uuid: string;
  platform: ChannelInboundEvent["platform"];
  expires_at: string;
  attempts: number;
  max_attempts: number;
  redeemed_at: string | null;
}

export class ChannelPairingService {
  constructor(
    private readonly db: MailDatabase,
    private readonly connections: ChannelConnectionRepository,
    private readonly deliveries: ChannelDeliveryRepository,
    private readonly bindings: ChannelBindingRepository,
    private readonly audit: ChannelAuditRepository,
    private readonly getActiveAccountId: () => string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  reconcileCurrentMailboxBindings(): number {
    const accountId = this.getActiveAccountId();
    if (!accountId) return 0;
    let reconciled = 0;
    for (const profile of this.connections.listProfiles()) {
      if (!profile.owner) continue;
      const current = this.bindings.findActiveOwner(profile.id, profile.owner.userId);
      if (current?.accountId === accountId) continue;
      const transaction = this.db.transaction(() => {
        this.bindings.revokeByProfile(profile.id);
        this.bindOwnerMailbox(
          profile.id,
          current?.chatId ?? profile.owner!.userId,
          profile.owner!.userId,
          accountId,
        );
      });
      transaction();
      reconciled += 1;
    }
    return reconciled;
  }

  createChallenge(profileId: string, ttlMs = 10 * 60_000): PairingChallenge {
    const profile = this.connections.getProfile(profileId);
    if (!profile) throw new Error("channel-profile-not-found");
    const code = randomBytes(18).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE channel_pairing_challenges
           SET redeemed_at = ?
           WHERE profile_id = ? AND redeemed_at IS NULL`,
        )
        .run(createdAt.toISOString(), profileId);
      this.db
        .prepare(
          `INSERT INTO channel_pairing_challenges (
            id, profile_id, connection_id, bot_uuid, platform, code_hash,
            expires_at, attempts, max_attempts, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 5, ?)`,
        )
        .run(
          randomUUID(),
          profile.id,
          profile.connectionId,
          profile.botUuid,
          profile.platform,
          hashReference(code),
          expiresAt,
          createdAt.toISOString(),
        );
      this.connections.setProfileState(profileId, {
        state: "owner_pairing",
        enabled: false,
      });
    });
    transaction();
    return {
      profileId,
      code,
      command: `/wemail connect ${code}`,
      expiresAt,
    };
  }

  cancelChallenge(profileId: string) {
    const profile = this.connections.getProfile(profileId);
    if (!profile) throw new Error("channel-profile-not-found");
    const cancelledAt = this.now().toISOString();
    const restoredState = profile.owner
      ? profile.initializedAt
        ? "ready"
        : "initialization_pending"
      : "bot_selected";
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE channel_pairing_challenges
           SET redeemed_at = ?
           WHERE profile_id = ? AND redeemed_at IS NULL`,
        )
        .run(cancelledAt, profileId);
      this.connections.setProfileState(profileId, {
        state: restoredState,
        enabled: restoredState === "ready",
      });
      this.audit.record({
        eventType: "channel.owner-pairing.cancelled",
        actor: "operator",
        connectionId: profile.connectionId,
        profileId: profile.id,
        scope: {
          platform: profile.platform,
          restoredState,
        },
        result: `restored-${restoredState}`,
      });
    });
    transaction();
    return this.connections.getProfile(profileId)!;
  }

  retryInitialization(profileId: string) {
    const profile = this.connections.getProfile(profileId);
    if (!profile?.owner) throw new Error("channel-owner-not-paired");
    const row = this.db
      .prepare(
        `SELECT delivery_id
         FROM channel_initializations
         WHERE profile_id = ? AND owner_binding_version = ?
           AND content_version = ?`,
      )
      .get(
        profile.id,
        profile.owner.bindingVersion,
        INITIALIZATION_CONTENT_VERSION,
      ) as { delivery_id: string } | undefined;
    if (!row) throw new Error("channel-initialization-not-found");
    const delivery = this.deliveries.get(row.delivery_id);
    if (!delivery) throw new Error("channel-initialization-not-found");
    if (delivery.state === "sent") return delivery;
    if (
      !["failed", "ambiguous", "needs_reauthorization"].includes(
        delivery.state,
      )
    ) {
      return delivery;
    }
    this.deliveries.retryTerminal(delivery.id);
    this.connections.setProfileState(profile.id, {
      state: "initialization_pending",
      enabled: false,
    });
    this.audit.record({
      eventType: "channel.initialization.retry",
      actor: "operator",
      connectionId: profile.connectionId,
      profileId: profile.id,
      scope: {
        platform: profile.platform,
        ownerBindingVersion: profile.owner.bindingVersion,
      },
      result: "queued",
    });
    return this.deliveries.get(delivery.id)!;
  }

  intercept(event: ChannelInboundEvent): PairingInterceptResult {
    const match = event.text.trim().match(PAIRING_PATTERN);
    if (!match) return { handled: false };
    const hash = hashReference(match[1]);
    const row = this.db
      .prepare(
        `SELECT id, profile_id, connection_id, bot_uuid, platform, expires_at,
                attempts, max_attempts, redeemed_at
         FROM channel_pairing_challenges WHERE code_hash = ?`,
      )
      .get(hash) as PairingRow | undefined;
    if (!row) return { handled: true, outcome: "invalid" };
    if (row.redeemed_at) return { handled: true, outcome: "replayed" };
    if (row.attempts >= row.max_attempts) {
      return { handled: true, outcome: "attempts-exhausted" };
    }
    this.db
      .prepare(
        "UPDATE channel_pairing_challenges SET attempts = attempts + 1 WHERE id = ?",
      )
      .run(row.id);
    if (row.expires_at <= this.now().toISOString()) {
      return { handled: true, outcome: "expired" };
    }
    if (
      event.chatKind !== "person" ||
      row.connection_id !== event.connectionId ||
      row.bot_uuid !== event.botUuid ||
      row.platform !== event.platform
    ) {
      return { handled: true, outcome: "wrong-scope" };
    }
    const accountId = this.getActiveAccountId();
    if (!accountId) return { handled: true, outcome: "account-required" };

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE channel_pairing_challenges
           SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL`,
        )
        .run(this.now().toISOString(), row.id);
      const owner = this.connections.replaceOwner(row.profile_id, {
        userId: event.senderId,
        displayName: event.senderName,
      });
      this.bindings.revokeByProfile(row.profile_id);
      this.bindOwnerMailbox(
        row.profile_id,
        event.chatId,
        owner.userId,
        accountId,
      );
      this.connections.setProfileState(row.profile_id, {
        state: "initialization_pending",
        enabled: false,
      });
      const profile = this.connections.getProfile(row.profile_id)!;
      const delivery = this.deliveries.enqueue({
        connectionId: profile.connectionId,
        profileId: profile.id,
        botUuid: profile.botUuid,
        platform: profile.platform,
        targetType: "person",
        targetId: profile.platform === "wecom" ? event.chatId : owner.userId,
        purpose: "initialization",
        text: renderInitialization(profile.platform, profile.displayName),
        sequence: 0,
        maxAttempts: 3,
        correlationKey: `initialization:${profile.id}:${owner.bindingVersion}:${INITIALIZATION_CONTENT_VERSION}`,
        ownerBindingVersion: owner.bindingVersion,
      });
      this.db
        .prepare(
          `INSERT OR IGNORE INTO channel_initializations (
            id, profile_id, owner_binding_version, content_version,
            delivery_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          profile.id,
          owner.bindingVersion,
          INITIALIZATION_CONTENT_VERSION,
          delivery.id,
          this.now().toISOString(),
        );
      this.audit.record({
        eventType: "channel.owner.paired",
        actor: "channel-owner",
        connectionId: profile.connectionId,
        profileId: profile.id,
        scope: {
          platform: profile.platform,
          ownerBindingVersion: owner.bindingVersion,
          accountId,
        },
        result: "initialization-pending",
      });
    });
    transaction();
    return { handled: true, outcome: "paired" };
  }

  private bindOwnerMailbox(
    profileId: string,
    chatId: string,
    senderId: string,
    accountId: string,
  ): void {
    const profile = this.connections.getProfile(profileId);
    if (!profile) throw new Error("channel-profile-not-found");
    this.bindings.save({
      connectionId: profile.connectionId,
      profileId: profile.id,
      botUuid: profile.botUuid,
      platform: profile.platform,
      chatKind: "person",
      chatId,
      senderId,
      accountId,
      conversationId: `channel:${profile.id}:person:${chatId}:${senderId}`,
      enabled: true,
      requireMention: false,
    });
  }
}

export function renderInitialization(
  platform: ChannelInboundEvent["platform"],
  botName: string,
): string {
  const platformLabel = platform === "feishu" ? "飞书" : "企业微信";
  return [
    `WeMail 已成功连接到${platformLabel}机器人「${botName}」。`,
    "你已被验证为该机器人的主人。",
    "当前 WeMail 邮箱已自动连接，无需再次授权。",
    "现在可以直接发送消息与 WeMail 对话，群聊中请先 @机器人。",
    "连接、主人和自动化通知可在 WeMail「设置 → 连接」中管理。",
  ].join("\n");
}
