export const CHANNEL_PLATFORMS = ["feishu", "wecom"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export type ChannelChatKind = "person" | "group";
export type ChannelOnboardingState =
  | "draft"
  | "gateway_verified"
  | "bot_selected"
  | "owner_pairing"
  | "owner_verified"
  | "initialization_pending"
  | "ready";

/**
 * Wire-level union. `"wecli"` stays a member so observations written by an
 * internal edition still deserialize in the open build, but the open
 * renderer/connection center only exposes {@link OPEN_INTEGRATION_CONNECTION_IDS}
 * (the two bot platforms). WeCLI is an edition-only connection.
 */
export type IntegrationConnectionId = "wecli" | ChannelPlatform;
export const OPEN_INTEGRATION_CONNECTION_IDS: readonly ChannelPlatform[] = CHANNEL_PLATFORMS;
export type IntegrationConnectionState =
  | "connected"
  | "attention"
  | "disconnected"
  | "checking"
  | "not_configured"
  | "unknown";

/**
 * WeCLI runtime details surfaced alongside the integration observation.
 * Populated from `wecli --version` + `wecli doctor` by the health checker,
 * persisted in the observation's metadata_json, and round-tripped back through
 * `IntegrationConnectionSummary.meta` so the settings pane can render version /
 * daemon / extension status without a second spawn of the CLI.
 */
export interface WecliRuntimeMeta {
  version?: string;
  binary?: string;
  daemon?: { running: boolean; port?: number; version?: string };
  extension?: { connected: boolean; version?: string };
  /** Edition-supplied browser-extension download URL; open tree has none. */
  extensionDownloadUrl?: string;
}

export interface IntegrationConnectionSummary {
  id: IntegrationConnectionId;
  label: string;
  state: IntegrationConnectionState;
  observedAt: string | null;
  reasonCode?: string;
  nextAction?: string;
  profileId?: string;
  checking?: boolean;
  /** WeCLI-only runtime metadata; undefined for bot platforms. */
  meta?: WecliRuntimeMeta;
}

export interface IntegrationConnectionSnapshot {
  entries: IntegrationConnectionSummary[];
  loadedAt: string;
}

export interface LangBotConnection {
  id: string;
  name: string;
  baseUrl: string;
  compatibilityProfile: string;
  apiSecretRef: string;
  webhookSecretRef: string;
  enabled: boolean;
  trustMode: "loopback" | "remote";
  compatibilityState: "unknown" | "compatible" | "incompatible";
  lastCheckedAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotChannelConfiguration {
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

export type ChannelBotSetupStatus =
  | "waiting"
  | "connected"
  | "failed"
  | "expired";

export interface ChannelBotSetup {
  id: string;
  platform: ChannelPlatform;
  mode: "create";
  status: ChannelBotSetupStatus;
  configurationUrl: string;
  qrPayload: string;
  expiresAt: string;
  retryAfterMs: number;
  profileId?: string;
  errorCode?: string;
}

export interface ChannelOwnerIdentity {
  profileId: string;
  connectionId: string;
  botUuid: string;
  platform: ChannelPlatform;
  userId: string;
  displayName?: string;
  bindingVersion: number;
  verifiedAt: string;
}

export interface ChannelBotProfile {
  id: string;
  connectionId: string;
  botUuid: string;
  platform: ChannelPlatform;
  displayName: string;
  adapterName: string;
  enabled: boolean;
  onboardingState: ChannelOnboardingState;
  owner?: ChannelOwnerIdentity;
  initializationVersion?: number;
  initializedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastDetectedAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDestination {
  id: string;
  profileId: string;
  type: ChannelChatKind;
  externalId: string;
  displayName?: string;
  verified: boolean;
  createdAt: string;
}

export interface ChannelMessagePart {
  type: "text" | "mention" | "unsupported";
  text?: string;
  targetId?: string;
  sourceType?: string;
}

export interface ChannelInboundEvent {
  eventId: string;
  connectionId: string;
  botUuid: string;
  platform: ChannelPlatform;
  adapterName: string;
  chatKind: ChannelChatKind;
  chatId: string;
  chatName?: string;
  senderId: string;
  senderName?: string;
  text: string;
  message: ChannelMessagePart[];
  mentionedBot: boolean;
  occurredAt: string;
  peerKey: string;
}

export interface ChannelBinding {
  id: string;
  connectionId: string;
  profileId: string;
  botUuid: string;
  platform: ChannelPlatform;
  chatKind: ChannelChatKind;
  chatId: string;
  senderId: string;
  accountId: string;
  conversationId: string;
  enabled: boolean;
  requireMention: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export type ChannelDeliveryPurpose =
  | "agent_reply"
  | "initialization"
  | "diagnostic"
  | "automation"
  | "access_notice"
  | "confirmation";

export type ChannelDeliveryState =
  | "pending"
  | "leased"
  | "retrying"
  | "sent"
  | "ambiguous"
  | "failed"
  | "needs_reauthorization";

export interface ChannelDeliveryFallbackTarget {
  connectionId: string;
  profileId: string;
  botUuid: string;
  platform: ChannelPlatform;
  targetType: ChannelChatKind;
  targetId: string;
  ownerBindingVersion?: number;
}

export interface ChannelDelivery {
  id: string;
  connectionId: string;
  profileId: string;
  botUuid: string;
  platform: ChannelPlatform;
  targetType: ChannelChatKind;
  targetId: string;
  purpose: ChannelDeliveryPurpose;
  text: string;
  state: ChannelDeliveryState;
  sequence: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  correlationKey?: string;
  fallbackTargets?: ChannelDeliveryFallbackTarget[];
  automationRuleId?: string;
  automationRunId?: string;
  automationActionIndex?: number;
  ownerBindingVersion?: number;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  errorCode?: string;
}

export interface PublishBotMessageAction {
  type: "publishBotMessage";
  botProfileId: string;
  destination:
    | {
        type: "owner";
        ownerBindingVersion: number;
      }
    | {
        type: "conversation";
        destinationId: string;
      };
  title?: string;
  bodyTemplate?: string;
}

export interface ChannelApprovalReference {
  id: string;
  referenceHash: string;
  connectionId: string;
  profileId: string;
  botUuid: string;
  chatKind: ChannelChatKind;
  chatId: string;
  senderId: string;
  accountId: string;
  pendingActionId: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface ChannelDiagnostics {
  profile: ChannelBotProfile;
  gateway: {
    reachable: boolean;
    authenticated: boolean;
    compatible: boolean;
    checkedAt?: string;
    errorCode?: string;
  };
  bot: {
    exists: boolean;
    enabled: boolean;
    platformMatches: boolean;
    checkedAt?: string;
    errorCode?: string;
  };
  inbound: { lastSuccessAt?: string };
  outbound: { lastSuccessAt?: string; pending: number; failed: number };
}

export interface LeasedChannelInbound {
  id: string;
  event: ChannelInboundEvent;
  attempts: number;
}
