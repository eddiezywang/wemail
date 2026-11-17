import { randomUUID } from "node:crypto";
import type {
  BotCoreConfiguration,
} from "../../../shared/wemail/botCoreProtocol.js";
import type {
  ChannelBotProfile,
  ChannelPlatform,
} from "../../../shared/wemail/channels.js";
import type { MailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";
import type { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import type { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import type { BotChannelRuntime } from "./BotChannelRuntime.js";
import { botPlatformSecretKey } from "./ChannelSecretKeys.js";

interface ConfigurationRow {
  platform: ChannelPlatform;
  connection_id: string;
  profile_id: string;
  external_bot_id: string;
  display_name: string;
  secret_ref: string;
  ws_url: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PublicBotChannelConfiguration {
  platform: ChannelPlatform;
  connectionId: string;
  profileId: string;
  externalBotId: string;
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  wsUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export class BotChannelConfigurationService {
  constructor(
    private readonly db: MailDatabase,
    private readonly connections: ChannelConnectionRepository,
    private readonly secrets: SecretStore,
    private readonly audit: ChannelAuditRepository,
    private readonly runtime: BotChannelRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): PublicBotChannelConfiguration[] {
    return this.rows().map((row) => this.publicView(row));
  }

  save(input: {
    platform: ChannelPlatform;
    externalBotId: string;
    secret?: string;
  }): PublicBotChannelConfiguration {
    const externalBotId = input.externalBotId.trim();
    const secret = input.secret?.trim() ?? "";
    if (!externalBotId) throw new Error("platform-bot-id-required");
    const existing = this.getRow(input.platform);
    const connectionId = existing?.connection_id ?? randomUUID();
    const profileId = existing?.profile_id ?? randomUUID();
    const secretRef =
      existing?.secret_ref ?? botPlatformSecretKey(input.platform, profileId);
    if (!secret && !this.secrets.getSecret(secretRef)) {
      throw new Error("platform-bot-secret-required");
    }
    const displayName =
      input.platform === "feishu" ? "WeMail 飞书机器人" : "WeMail 企业微信机器人";
    if (secret) this.secrets.saveSecret(secretRef, secret);
    try {
      if (!existing) {
        this.connections.createConnection({
          id: connectionId,
          name: displayName,
          baseUrl: `local://qwen-channels/${input.platform}`,
          compatibilityProfile: "qwen-channels@0.21.1",
          apiSecretRef: secretRef,
          webhookSecretRef: secretRef,
          trustMode: "loopback",
        });
      }
      this.connections.setConnectionCheck(connectionId, {
        compatible: true,
        enabled: true,
      });
      const timestamp = this.now().toISOString();
      const adapterName =
        input.platform === "feishu"
          ? "@qwen-code/channel-feishu"
          : "@qwen-code/channel-wecom";
      const previousProfile = existing
        ? this.connections.getProfile(profileId)
        : undefined;
      const botChanged =
        !!existing && existing.external_bot_id !== externalBotId;
      const inconsistentLifecycle =
        !!previousProfile &&
        previousProfile.onboardingState === "bot_selected" &&
        (!!previousProfile.owner || !!previousProfile.initializedAt);
      const profile = existing
        ? (() => {
            this.db
              .prepare(
                `UPDATE channel_bot_profiles SET
                  bot_uuid = ?, display_name = ?, adapter_name = ?,
                  enabled = 1, last_error_code = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                externalBotId,
                displayName,
                adapterName,
                timestamp,
                profileId,
              );
            return this.connections.getProfile(profileId)!;
          })()
        : this.connections.saveProfile({
            id: profileId,
            connectionId,
            botUuid: externalBotId,
            platform: input.platform,
            displayName,
            adapterName,
            enabled: true,
            onboardingState: "bot_selected",
          });
      this.db
        .prepare(
          `INSERT INTO bot_channel_configurations (
            platform, connection_id, profile_id, external_bot_id, display_name,
            secret_ref, ws_url, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(platform) DO UPDATE SET
            external_bot_id = excluded.external_bot_id,
            display_name = excluded.display_name,
            secret_ref = excluded.secret_ref,
            ws_url = excluded.ws_url,
            enabled = 1,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.platform,
          connectionId,
          profile.id,
          externalBotId,
          displayName,
          secretRef,
          null,
          timestamp,
          timestamp,
        );
      if (botChanged || inconsistentLifecycle) {
        this.resetLifecycle(
          profile.id,
          externalBotId,
          botChanged ? "bot-replaced" : "inconsistent-lifecycle",
        );
      }
      this.audit.record({
        eventType: "bot-channel.configuration.saved",
        actor: "local-operator",
        connectionId,
        profileId: profile.id,
        scope: { platform: input.platform },
        result: existing ? "updated" : "created",
      });
      this.runtime.notifyConfigurationChanged();
      return this.publicView(this.getRow(input.platform)!);
    } catch (error) {
      if (!existing) this.secrets.deleteSecret(secretRef);
      throw error;
    }
  }

  resetProfile(profileId: string): ChannelBotProfile {
    const row = this.db
      .prepare(
        "SELECT * FROM bot_channel_configurations WHERE profile_id = ?",
      )
      .get(profileId) as ConfigurationRow | undefined;
    if (!row) throw new Error("bot-channel-configuration-not-found");
    this.connections.setConnectionCheck(row.connection_id, {
      compatible: true,
      enabled: true,
    });
    this.resetLifecycle(
      row.profile_id,
      row.external_bot_id,
      "operator-requested",
    );
    this.runtime.notifyConfigurationChanged();
    return this.connections.getProfile(profileId)!;
  }

  disable(platform: ChannelPlatform): PublicBotChannelConfiguration {
    const row = this.requireRow(platform);
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE bot_channel_configurations
         SET enabled = 0, updated_at = ? WHERE platform = ?`,
      )
      .run(timestamp, platform);
    this.connections.disableConnection(row.connection_id);
    this.runtime.notifyConfigurationChanged();
    return this.publicView(this.requireRow(platform));
  }

  enable(platform: ChannelPlatform): PublicBotChannelConfiguration {
    const row = this.requireRow(platform);
    if (!this.secrets.getSecret(row.secret_ref)) {
      throw new Error("platform-bot-secret-required");
    }
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE bot_channel_configurations
         SET enabled = 1, updated_at = ? WHERE platform = ?`,
      )
      .run(timestamp, platform);
    this.connections.setConnectionCheck(row.connection_id, {
      compatible: true,
      enabled: true,
    });
    this.audit.record({
      eventType: "bot-channel.configuration.enabled",
      actor: "local-operator",
      connectionId: row.connection_id,
      profileId: row.profile_id,
      scope: { platform },
      result: "enabled",
    });
    this.runtime.notifyConfigurationChanged();
    return this.publicView(this.requireRow(platform));
  }

  resolvedConfigurations(): BotCoreConfiguration[] {
    const configurations: BotCoreConfiguration[] = [];
    for (const row of this.rows()) {
      if (row.enabled !== 1) continue;
      const secret = this.secrets.getSecret(row.secret_ref);
      if (!secret) continue;
      const base = {
        connectionId: row.connection_id,
        profileId: row.profile_id,
        botUuid: row.external_bot_id,
        displayName: row.display_name,
        enabled: true,
      };
      configurations.push(
        row.platform === "feishu"
          ? {
              ...base,
              platform: "feishu",
              appId: row.external_bot_id,
              appSecret: secret,
            }
          : {
              ...base,
              platform: "wecom",
              botId: row.external_bot_id,
              botSecret: secret,
              ...(row.ws_url ? { wsUrl: row.ws_url } : {}),
            },
      );
    }
    return configurations;
  }

  private resetLifecycle(
    profileId: string,
    botUuid: string,
    reason: "bot-replaced" | "inconsistent-lifecycle" | "operator-requested",
  ): void {
    const profile = this.connections.getProfile(profileId);
    if (!profile) throw new Error("channel-profile-not-found");
    const timestamp = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE channel_owner_history
           SET revoked_at = COALESCE(revoked_at, ?)
           WHERE profile_id = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, profileId);
      this.db
        .prepare(
          `UPDATE channel_bindings
           SET enabled = 0, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
           WHERE profile_id = ? AND (enabled = 1 OR revoked_at IS NULL)`,
        )
        .run(timestamp, timestamp, profileId);
      this.db
        .prepare(
          `UPDATE channel_pairing_challenges
           SET redeemed_at = COALESCE(redeemed_at, ?)
           WHERE profile_id = ? AND redeemed_at IS NULL`,
        )
        .run(timestamp, profileId);
      this.db
        .prepare("DELETE FROM channel_destinations WHERE profile_id = ?")
        .run(profileId);
      this.db
        .prepare(
          `UPDATE channel_inbound_events SET
             status = 'ignored', completed_at = ?, updated_at = ?,
             next_attempt_at = NULL, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = ?
           WHERE profile_id = ? AND status IN ('pending', 'leased')`,
        )
        .run(timestamp, timestamp, `channel-${reason}`, profileId);
      this.db
        .prepare(
          `UPDATE channel_deliveries SET
             state = 'needs_reauthorization',
             error_code = ?, next_attempt_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE profile_id = ? AND state IN ('pending', 'leased', 'retrying')`,
        )
        .run(`channel-${reason}`, timestamp, profileId);
      this.db
        .prepare(
          `UPDATE channel_bot_profiles SET
             bot_uuid = ?, enabled = 1, onboarding_state = 'bot_selected',
             initialization_version = NULL, initialized_at = NULL,
             last_inbound_at = NULL, last_outbound_at = NULL,
             last_detected_at = NULL, last_error_code = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(botUuid, timestamp, profileId);
      this.db
        .prepare(
          `UPDATE bot_channel_configurations
           SET enabled = 1, updated_at = ? WHERE profile_id = ?`,
        )
        .run(timestamp, profileId);
      this.audit.record({
        eventType: "bot-channel.lifecycle.reset",
        actor: reason === "operator-requested" ? "local-operator" : "system",
        connectionId: profile.connectionId,
        profileId,
        scope: {
          platform: profile.platform,
          previousBotUuid: profile.botUuid,
          botUuid,
          reason,
        },
        result: "owner-pairing-required",
      });
    });
    transaction();
    this.connections.upsertObservation({
      entryKey: `channel:${profile.platform}:${profile.id}`,
      integrationId: profile.platform,
      profileId: profile.id,
      state: "attention",
      reasonCode: "owner-pairing-required",
      nextAction: "请重新绑定主人",
    });
  }

  private rows(): ConfigurationRow[] {
    return this.db
      .prepare("SELECT * FROM bot_channel_configurations ORDER BY platform")
      .all() as ConfigurationRow[];
  }

  private getRow(platform: ChannelPlatform): ConfigurationRow | undefined {
    return this.db
      .prepare("SELECT * FROM bot_channel_configurations WHERE platform = ?")
      .get(platform) as ConfigurationRow | undefined;
  }

  private requireRow(platform: ChannelPlatform): ConfigurationRow {
    const row = this.getRow(platform);
    if (!row) throw new Error("bot-channel-configuration-not-found");
    return row;
  }

  private publicView(row: ConfigurationRow): PublicBotChannelConfiguration {
    return {
      platform: row.platform,
      connectionId: row.connection_id,
      profileId: row.profile_id,
      externalBotId: row.external_bot_id,
      displayName: row.display_name,
      enabled: row.enabled === 1,
      hasCredential: !!this.secrets.getSecret(row.secret_ref),
      ...(row.ws_url ? { wsUrl: row.ws_url } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
