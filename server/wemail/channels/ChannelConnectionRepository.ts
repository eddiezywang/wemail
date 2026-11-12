import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ChannelBotProfile,
  ChannelOnboardingState,
  ChannelOwnerIdentity,
  ChannelPlatform,
  IntegrationConnectionState,
  IntegrationConnectionSummary,
  LangBotConnection,
  WecliRuntimeMeta,
} from "../../../shared/wemail/channels.js";
import type { MailDatabase } from "../database/Database.js";

interface ConnectionRow {
  id: string;
  name: string;
  base_url: string;
  compatibility_profile: string;
  api_secret_ref: string;
  webhook_secret_ref: string;
  enabled: number;
  trust_mode: "loopback" | "remote";
  compatibility_state: "unknown" | "compatible" | "incompatible";
  last_checked_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  connection_id: string;
  bot_uuid: string;
  platform: ChannelPlatform;
  display_name: string;
  adapter_name: string;
  enabled: number;
  onboarding_state: ChannelOnboardingState;
  owner_binding_version: number;
  initialization_version: number | null;
  initialized_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_detected_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface OwnerRow {
  profile_id: string;
  connection_id: string;
  bot_uuid: string;
  platform: ChannelPlatform;
  user_id: string;
  display_name: string | null;
  binding_version: number;
  verified_at: string;
}

interface ObservationRow {
  integration_id: "wecli" | ChannelPlatform;
  profile_id: string | null;
  state: Exclude<IntegrationConnectionState, "checking">;
  reason_code: string | null;
  next_action: string | null;
  observed_at: string;
  metadata_json: string | null;
}

/**
 * Parse the WeCLI runtime metadata persisted in `metadata_json`. Only the
 * wecli observation writes these fields; rows without them yield undefined so
 * the summary stays free of an empty `meta` object.
 */
function metaFromObservationRow(row: ObservationRow): WecliRuntimeMeta | undefined {
  if (!row.metadata_json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata_json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  const meta: WecliRuntimeMeta = {};
  if (typeof value.version === "string") meta.version = value.version;
  if (typeof value.binary === "string") meta.binary = value.binary;
  if (value.daemon && typeof value.daemon === "object") {
    meta.daemon = value.daemon as WecliRuntimeMeta["daemon"];
  }
  if (value.extension && typeof value.extension === "object") {
    meta.extension = value.extension as WecliRuntimeMeta["extension"];
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

const connectionFromRow = (row: ConnectionRow): LangBotConnection => ({
  id: row.id,
  name: row.name,
  baseUrl: row.base_url,
  compatibilityProfile: row.compatibility_profile,
  apiSecretRef: row.api_secret_ref,
  webhookSecretRef: row.webhook_secret_ref,
  enabled: row.enabled === 1,
  trustMode: row.trust_mode,
  compatibilityState: row.compatibility_state,
  ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
  ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ChannelConnectionRepository {
  private readonly observations = new EventEmitter();
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createConnection(input: {
    id?: string;
    name: string;
    baseUrl: string;
    compatibilityProfile: string;
    apiSecretRef: string;
    webhookSecretRef: string;
    trustMode: "loopback" | "remote";
  }): LangBotConnection {
    const id = input.id ?? randomUUID();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO langbot_connections (
          id, name, base_url, compatibility_profile, api_secret_ref,
          webhook_secret_ref, enabled, trust_mode, compatibility_state,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'unknown', ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.baseUrl,
        input.compatibilityProfile,
        input.apiSecretRef,
        input.webhookSecretRef,
        input.trustMode,
        now,
        now,
      );
    return this.getConnection(id)!;
  }

  getConnection(id: string): LangBotConnection | undefined {
    const row = this.db
      .prepare("SELECT * FROM langbot_connections WHERE id = ?")
      .get(id) as ConnectionRow | undefined;
    return row ? connectionFromRow(row) : undefined;
  }

  listConnections(): LangBotConnection[] {
    return (
      this.db
        .prepare("SELECT * FROM langbot_connections ORDER BY created_at")
        .all() as ConnectionRow[]
    ).map(connectionFromRow);
  }

  setConnectionCheck(
    id: string,
    input: {
      compatible: boolean;
      enabled?: boolean;
      errorCode?: string;
    },
  ): LangBotConnection | undefined {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE langbot_connections SET
          compatibility_state = ?,
          enabled = COALESCE(?, enabled),
          last_checked_at = ?,
          last_error_code = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        input.compatible ? "compatible" : "incompatible",
        input.enabled === undefined ? null : input.enabled ? 1 : 0,
        now,
        input.errorCode ?? null,
        now,
        id,
      );
    return this.getConnection(id);
  }

  disableConnection(id: string, errorCode?: string): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE langbot_connections
         SET enabled = 0, last_error_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(errorCode ?? null, now, id);
  }

  deleteConnection(id: string): boolean {
    return this.db
      .prepare("DELETE FROM langbot_connections WHERE id = ?")
      .run(id).changes > 0;
  }

  saveProfile(input: {
    id?: string;
    connectionId: string;
    botUuid: string;
    platform: ChannelPlatform;
    displayName: string;
    adapterName: string;
    enabled?: boolean;
    onboardingState?: ChannelOnboardingState;
  }): ChannelBotProfile {
    const id = input.id ?? randomUUID();
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_bot_profiles (
          id, connection_id, bot_uuid, platform, display_name, adapter_name,
          enabled, onboarding_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, bot_uuid) DO UPDATE SET
          platform = excluded.platform,
          display_name = excluded.display_name,
          adapter_name = excluded.adapter_name,
          enabled = excluded.enabled,
          onboarding_state = excluded.onboarding_state,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.connectionId,
        input.botUuid,
        input.platform,
        input.displayName,
        input.adapterName,
        input.enabled ? 1 : 0,
        input.onboardingState ?? "bot_selected",
        now,
        now,
      );
    return this.getProfileByBot(input.connectionId, input.botUuid)!;
  }

  getProfile(id: string): ChannelBotProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM channel_bot_profiles WHERE id = ?")
      .get(id) as ProfileRow | undefined;
    return row ? this.profileFromRow(row) : undefined;
  }

  getProfileByBot(
    connectionId: string,
    botUuid: string,
  ): ChannelBotProfile | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM channel_bot_profiles WHERE connection_id = ? AND bot_uuid = ?",
      )
      .get(connectionId, botUuid) as ProfileRow | undefined;
    return row ? this.profileFromRow(row) : undefined;
  }

  listProfiles(platform?: ChannelPlatform): ChannelBotProfile[] {
    const rows = platform
      ? (this.db
          .prepare(
            "SELECT * FROM channel_bot_profiles WHERE platform = ? ORDER BY created_at",
          )
          .all(platform) as ProfileRow[])
      : (this.db
          .prepare("SELECT * FROM channel_bot_profiles ORDER BY created_at")
          .all() as ProfileRow[]);
    return rows.map((row) => this.profileFromRow(row));
  }

  setProfileState(
    id: string,
    input: {
      state: ChannelOnboardingState;
      enabled?: boolean;
      initializationVersion?: number;
      initializedAt?: string;
      errorCode?: string;
    },
  ): ChannelBotProfile | undefined {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE channel_bot_profiles SET
          onboarding_state = ?,
          enabled = COALESCE(?, enabled),
          initialization_version = COALESCE(?, initialization_version),
          initialized_at = COALESCE(?, initialized_at),
          last_error_code = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.state,
        input.enabled === undefined ? null : input.enabled ? 1 : 0,
        input.initializationVersion ?? null,
        input.initializedAt ?? null,
        input.errorCode ?? null,
        now,
        id,
      );
    return this.getProfile(id);
  }

  setProfileActivity(
    id: string,
    kind: "inbound" | "outbound" | "detection",
    input: { success: boolean; errorCode?: string },
  ): void {
    const now = this.now().toISOString();
    const column =
      kind === "inbound"
        ? "last_inbound_at"
        : kind === "outbound"
          ? "last_outbound_at"
          : "last_detected_at";
    this.db
      .prepare(
        `UPDATE channel_bot_profiles
         SET ${column} = ?, last_error_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.success ? now : null, input.errorCode ?? null, now, id);
  }

  replaceOwner(
    profileId: string,
    input: { userId: string; displayName?: string },
  ): ChannelOwnerIdentity {
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error("channel-profile-not-found");
    const now = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE channel_owner_history SET revoked_at = ? WHERE profile_id = ? AND revoked_at IS NULL",
        )
        .run(now, profileId);
      const nextVersion = this.db
        .prepare(
          `SELECT COALESCE(MAX(binding_version), 0) + 1
           FROM channel_owner_history WHERE profile_id = ?`,
        )
        .pluck()
        .get(profileId) as number;
      this.db
        .prepare(
          `INSERT INTO channel_owner_history (
            id, profile_id, connection_id, bot_uuid, platform, user_id,
            display_name, binding_version, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          profileId,
          profile.connectionId,
          profile.botUuid,
          profile.platform,
          input.userId,
          input.displayName ?? null,
          nextVersion,
          now,
        );
      this.db
        .prepare(
          `UPDATE channel_bot_profiles SET
            owner_binding_version = ?, onboarding_state = 'owner_verified',
            enabled = 0, initialized_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextVersion, now, profileId);
    });
    transaction();
    return this.getProfile(profileId)!.owner!;
  }

  upsertObservation(input: {
    entryKey: string;
    integrationId: "wecli" | ChannelPlatform;
    profileId?: string;
    state: Exclude<IntegrationConnectionState, "checking">;
    reasonCode?: string;
    nextAction?: string;
    metadata?: Record<string, unknown>;
    observedAt?: string;
  }): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO integration_connection_observations (
          entry_key, integration_id, profile_id, state, reason_code,
          next_action, metadata_json, observed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_key) DO UPDATE SET
          integration_id = excluded.integration_id,
          profile_id = excluded.profile_id,
          state = excluded.state,
          reason_code = excluded.reason_code,
          next_action = excluded.next_action,
          metadata_json = excluded.metadata_json,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.entryKey,
        input.integrationId,
        input.profileId ?? null,
        input.state,
        input.reasonCode ?? null,
        input.nextAction ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.observedAt ?? now,
        now,
      );
    this.observations.emit("changed");
  }

  onObservationChanged(listener: () => void): () => void {
    this.observations.on("changed", listener);
    return () => this.observations.off("changed", listener);
  }

  listObservations(): IntegrationConnectionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT integration_id, profile_id, state, reason_code, next_action, observed_at, metadata_json
         FROM integration_connection_observations
         ORDER BY integration_id, observed_at DESC`,
      )
      .all() as ObservationRow[];
    return rows.map((row) => {
      const meta = metaFromObservationRow(row);
      return {
        id: row.integration_id,
        label:
          row.integration_id === "wecli"
            ? "WeCLI"
            : row.integration_id === "feishu"
              ? "飞书"
              : "企业微信",
        state: row.state,
        observedAt: row.observed_at,
        ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
        ...(row.next_action ? { nextAction: row.next_action } : {}),
        ...(row.profile_id ? { profileId: row.profile_id } : {}),
        ...(meta ? { meta } : {}),
      };
    });
  }

  private profileFromRow(row: ProfileRow): ChannelBotProfile {
    const owner = this.db
      .prepare(
        `SELECT profile_id, connection_id, bot_uuid, platform, user_id,
                display_name, binding_version, verified_at
         FROM channel_owner_history
         WHERE profile_id = ? AND revoked_at IS NULL`,
      )
      .get(row.id) as OwnerRow | undefined;
    return {
      id: row.id,
      connectionId: row.connection_id,
      botUuid: row.bot_uuid,
      platform: row.platform,
      displayName: row.display_name,
      adapterName: row.adapter_name,
      enabled: row.enabled === 1,
      onboardingState: row.onboarding_state,
      ...(owner
        ? {
            owner: {
              profileId: owner.profile_id,
              connectionId: owner.connection_id,
              botUuid: owner.bot_uuid,
              platform: owner.platform,
              userId: owner.user_id,
              ...(owner.display_name
                ? { displayName: owner.display_name }
                : {}),
              bindingVersion: owner.binding_version,
              verifiedAt: owner.verified_at,
            },
          }
        : {}),
      ...(row.initialization_version !== null
        ? { initializationVersion: row.initialization_version }
        : {}),
      ...(row.initialized_at ? { initializedAt: row.initialized_at } : {}),
      ...(row.last_inbound_at ? { lastInboundAt: row.last_inbound_at } : {}),
      ...(row.last_outbound_at
        ? { lastOutboundAt: row.last_outbound_at }
        : {}),
      ...(row.last_detected_at
        ? { lastDetectedAt: row.last_detected_at }
        : {}),
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
