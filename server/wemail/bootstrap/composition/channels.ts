import type { MailDatabaseClient } from "../../database/MailDatabaseClient.js";
import type { AgentRuntime } from "../../agent/AgentRuntime.js";
import type { AgentConversationRepository } from "../../agent/AgentConversationRepository.js";
import type { AgentActionExecutor } from "../../agent/AgentActionExecutor.js";
import type { AgentPendingActionRepository } from "../../agent/AgentPendingActionRepository.js";
import { ChannelApprovalService } from "../../channels/ChannelApprovalService.js";
import { ChannelAuditRepository } from "../../channels/ChannelAuditRepository.js";
import { ChannelBindingRepository } from "../../channels/ChannelBindingRepository.js";
import { ChannelConnectionRepository } from "../../channels/ChannelConnectionRepository.js";
import { ChannelDestinationRepository } from "../../channels/ChannelDestinationRepository.js";
import { ChannelManagementService } from "../../channels/ChannelManagementService.js";
import {
  ChannelDeliveryRepository,
  ChannelInboundRepository,
} from "../../channels/ChannelLedgerRepository.js";
import { ChannelPairingService } from "../../channels/ChannelPairingService.js";
import { ChannelWorker } from "../../channels/ChannelWorker.js";
import { IntegrationStatusService } from "../../channels/IntegrationStatusService.js";
import { LangBotConnectionService } from "../../channels/LangBotConnectionService.js";
import type { MailDatabase } from "../../database/Database.js";
import type { SecretStore } from "../../security/SecretStore.js";
import type { WecliHealthPort } from "../../skills/wecliPort.js";
import { BotChannelRuntime } from "../../channels/BotChannelRuntime.js";
import { BotChannelConfigurationService } from "../../channels/BotChannelConfigurationService.js";
import { ChannelBotOnboardingService } from "../../channels/ChannelBotOnboardingService.js";
import type { ChannelDelivery } from "../../../../shared/wemail/channels.js";
import type { AppLogger } from "../../telemetry/AppLogger.js";

export function composeChannels(input: {
  db: MailDatabase;
  mailDatabase?: MailDatabaseClient;
  secrets: SecretStore;
  agent: AgentRuntime;
  conversations: AgentConversationRepository;
  pendingActions: AgentPendingActionRepository;
  actionExecutor: AgentActionExecutor;
  getActiveAccountId: () => string | undefined;
  logger: Pick<AppLogger, "error">;
  enabled?: boolean;
  now?: () => Date;
  /** Edition-supplied WeCLI health probe (P2.5). Absent in the open edition. */
  wecliHealth?: WecliHealthPort;
  onAutomationDeliverySettled?: (delivery: ChannelDelivery) => void;
}) {
  const connections = new ChannelConnectionRepository(input.db, input.now);
  const bindings = new ChannelBindingRepository(input.db, input.now);
  const inbound = new ChannelInboundRepository(input.db, input.now);
  const destinations = new ChannelDestinationRepository(input.db, input.now);
  const deliveries = new ChannelDeliveryRepository(input.db, input.now);
  deliveries.reconcileTerminalFallbacks();
  const audit = new ChannelAuditRepository(input.db, input.now);
  const runtime = new BotChannelRuntime(inbound, connections, destinations);
  const configurations = new BotChannelConfigurationService(
    input.db,
    connections,
    input.secrets,
    audit,
    runtime,
    input.now,
  );
  const onboarding = new ChannelBotOnboardingService(
    configurations,
    fetch,
    input.now,
  );
  const connectionService = new LangBotConnectionService(
    connections,
    input.secrets,
    audit,
  );
  const pairing = new ChannelPairingService(
    input.db,
    connections,
    deliveries,
    bindings,
    audit,
    input.getActiveAccountId,
    input.now,
  );
  pairing.reconcileCurrentMailboxBindings();
  const approvals = new ChannelApprovalService(
    input.db,
    input.pendingActions,
    input.actionExecutor,
    input.now,
  );
  const management = new ChannelManagementService(
    connections,
    connectionService,
    bindings,
    destinations,
    deliveries,
    { botRuntime: runtime },
  );
  const status = new IntegrationStatusService(
    connections,
    management,
    input.wecliHealth,
    input.now,
  );
  const worker = new ChannelWorker(
    inbound,
    deliveries,
    bindings,
    connections,
    connectionService,
    pairing,
    approvals,
    audit,
    input.agent,
    {
      now: input.now,
      ledger: input.mailDatabase,
      botRuntime: runtime,
      conversations: input.conversations,
      logger: input.logger,
      onAutomationDeliverySettled: input.onAutomationDeliverySettled,
    },
  );
  if (input.enabled) worker.start();
  return {
    connections,
    bindings,
    destinations,
    inbound,
    deliveries,
    audit,
    connectionService,
    pairing,
    approvals,
    management,
    status,
    runtime,
    configurations,
    onboarding,
    worker,
    enabled: input.enabled === true,
  };
}

export type ChannelComposition = ReturnType<typeof composeChannels>;
