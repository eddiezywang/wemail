/**
 * Public type surface for the composition root. Kept separate from
 * `AppComposition.ts` so the orchestration module can stay focused on
 * wiring and lifecycle without re-importing every leaf service just to
 * type its own return value.
 */

import type { AccountService } from "../account/AccountService.js";
import type { AiProfileSettingsService } from "./composition/settings.js";
import type { AiUsageRepository } from "../settings/AiUsageRepository.js";
import type { EditionRuntimeConfig } from "../../../shared/wemail/edition.js";
import type { AgentConversationRepository } from "../agent/AgentConversationRepository.js";
import type { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import type { AgentAttachmentStore } from "../agent/AgentAttachmentStore.js";
import type { AgentLearningLedger } from "../agent/AgentLearningLedger.js";
import type { AgentTitleGenerator } from "../agent/AgentTitleGenerator.js";
import type { AgentRunRepository } from "../agent/AgentRunRepository.js";
import type { AgentEventPersistence } from "../agent/AgentEventPersistence.js";
import type { AgentRunCoordinator } from "../agent/AgentRunCoordinator.js";
import type { AgentHomeSuggestionService } from "../agent/AgentHomeSuggestionService.js";
import type { MailActionExecutor } from "../agent/MailActionExecutor.js";
import type { ActionExecutionPort } from "../agent/allowancePort.js";
import type {
  AgentPlanner,
  PiAgentFactory,
} from "../agent/PiAgentRuntime.js";
import type { AgentRuntime } from "../agent/AgentRuntime.js";
import type { LlmClient } from "../ai/LlmClient.js";
import type { LlmRuntimeHealth, LlmRuntimeSnapshot } from "../ai/LlmRuntime.js";
import type { AutomationFieldRegistry } from "../automation/AutomationFieldRegistry.js";
import type { AutomationRuleExecutionService } from "../automation/AutomationRuleExecutionService.js";
import type { AutomationRuleRepository } from "../automation/AutomationRuleRepository.js";
import type { AutomationRulePreviewRepository } from "../automation/AutomationRulePreviewRepository.js";
import type { AutomationRuleService } from "../automation/AutomationRuleService.js";
import type { AutomationProviderRegistry } from "../automation/providers/AutomationProviderRegistry.js";
import type { PipelineAutomationRuleService } from "../automation/PipelineAutomationRuleService.js";
import type { UnifiedAutomationQueryService } from "../automation/UnifiedAutomationQueryService.js";
import type { AutomationRunObservabilityService } from "../automation/AutomationRunObservabilityService.js";
import type { CanonicalAutomationDraftService } from "../automation/CanonicalAutomationDraftService.js";
import type { AutomationTemplateRegistryService } from "../automation/AutomationTemplateRegistryService.js";
import type { ConfigurationTaskRepository } from "../configuration/ConfigurationTaskRepository.js";
import type { ConfigurationWorkflowService } from "../configuration/ConfigurationWorkflowService.js";
import type { AutomationAuthoringAgentService } from "../configuration/AutomationAuthoringAgentService.js";
import type { AutomationAuthoringCoordinator } from "../configuration/AutomationAuthoringCoordinator.js";
import type { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import type { MessageArtifactRepository } from "../design/MessageArtifactRepository.js";
import type { InsightReportRepository } from "../design/InsightReportRepository.js";
import type { RuleDryRunner } from "../automation/RuleDryRunner.js";
import type { RuleSuggester } from "../automation/RuleSuggester.js";
import type { MailDatabase } from "../database/Database.js";
import type { AiFeedbackEventRepository } from "../feedback/AiFeedbackEventRepository.js";
import type { TagFeedbackRuleRepository } from "../feedback/TagFeedbackRuleRepository.js";
import type { IntelligenceResultRepository } from "../intelligence/IntelligenceResultRepository.js";
import type { IntelligenceService } from "../intelligence/IntelligenceService.js";
import type { MailSemanticAttributeRepository } from "../intelligence/MailSemanticAttributeRepository.js";
import type {
  AllowanceInvoiceRoutesFactory,
  InvoiceStatusPort,
} from "../agent/allowancePort.js";
import type { SmartTagActionRepository } from "../intelligence/SmartTagActionRepository.js";
import type { SmartTagBackfillRepository } from "../intelligence/SmartTagBackfillRepository.js";
import type { SmartTagLearningRunRepository } from "../intelligence/SmartTagLearningRunRepository.js";
import type { SmartTagPromptLearningService } from "../intelligence/SmartTagPromptLearningService.js";
import type { SmartTagPromptCompiler } from "../intelligence/SmartTagPromptCompiler.js";
import type { SmartTagPromotionService } from "../intelligence/SmartTagPromotionService.js";
import type { SmartTagPromptRevisionRepository } from "../intelligence/SmartTagPromptRevisionRepository.js";
import type { UserTagRepository } from "../intelligence/UserTagRepository.js";
import type { EmailSmartTagRepository } from "../intelligence/EmailSmartTagRepository.js";
import type { TopicCandidateRepository } from "../intelligence/TopicCandidateRepository.js";
import type { ContentTopicService } from "../intelligence/ContentTopicService.js";
import type { SmartTagSuggestionService } from "../intelligence/SmartTagSuggestionService.js";
import type { MailDigestService } from "../digests/MailDigestService.js";
import type { DirectoryRepository } from "../directory/DirectoryRepository.js";
import type { DirectoryService } from "../directory/DirectoryService.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { MailCredentialInvalidEvent } from "../mail/MailCredentialError.js";
import type { ScheduledSendService } from "../mail/ScheduledSendService.js";
import type { SnoozeService } from "../mail/SnoozeService.js";
import type { MailAttachmentCache } from "../mail/MailAttachmentCache.js";
import type { JobRepository } from "../queue/JobRepository.js";
import type { DataRetentionService } from "../security/DataRetentionService.js";
import type { SecretStore } from "../security/SecretStore.js";
import type { LlmRuntimeSettings } from "../settings/LlmSettingsService.js";
import type { WecliRunner } from "../../../shared/wemail/wecliTypes.js";
import type { WecliRuntimePort } from "../skills/wecliPort.js";
import type { ClaudeCodeTaskService } from "../agent/ClaudeCodeRuntime.js";
import type { AppLogger } from "../telemetry/AppLogger.js";
import type { AuditLogRepository } from "../telemetry/AuditLogRepository.js";
import type { AuditLogService } from "../telemetry/AuditLogService.js";
import type { DraftFeedbackLog } from "../telemetry/DraftFeedbackLog.js";
import type { MailSyncErrorLog } from "../telemetry/MailSyncErrorLog.js";
import type { TodoRepository } from "../todos/TodoRepository.js";
import type { SemanticSearchService } from "../search/SemanticSearchService.js";
import type { MailQaService } from "../search/MailQaService.js";
import type { LearningSummaryService } from "../personalization/LearningSummaryService.js";
import type { PromptBuilder } from "../personalization/PromptBuilder.js";
import type { UsageStatsService } from "../personalization/UsageStatsService.js";
import type { LlmProviderConfig } from "./composition/settings.js";
import type { WorkspaceComposition } from "./composition/workspace.js";
import type { CuratorComposition } from "./composition/curator.js";
import type { ResourceGovernor } from "../performance/ResourceGovernor.js";
import type { McpComposition } from "../mcp/McpComposition.js";
import type { ChannelComposition } from "./composition/channels.js";
import type { SkillCenterService } from "../skill-center/SkillCenterService.js";
import type { SkillPackageRepository } from "../skill-center/SkillPackageRepository.js";
import type { SkillPackageImportService } from "../skill-center/SkillPackageImportService.js";
import type { SkillDraftService } from "../skill-center/SkillDraftService.js";
import type { WemailFeatureFlags } from "./FeatureFlags.js";
import type { EditionModules } from "./editionModules.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { MailRefreshResult } from "../../../shared/wemail/mailCoreProtocol.js";
import type { MailReceiptHealth } from "../../../shared/wemail/mailSync.js";
import type { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import type { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import type { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import type { PipelinePreviewStore } from "../workflows/PipelineReviewService.js";

/**
 * Optional overrides, primarily for integration tests.
 */
export interface ComposeAppOverrides {
  llmClient?: LlmClient;
  /** Replace the default planner when `llmClient` is also unavailable. */
  agentPlanner?: AgentPlanner;
  /** Replace the official PI Agent constructor for integration tests. */
  piAgentFactory?: PiAgentFactory;
  /** Override wecli's child-process runner so tests don't spawn. Only used
   *  when an edition assembles the WeCLI runtime. */
  wecliRunner?: WecliRunner;
  /** Electron injects its safeStorage-backed production secret store. */
  secretStore?: SecretStore;
  /** Explicitly enables the durable bot-channel worker; off by default. */
  channels?: { enabled?: boolean };
  /**
   * Queue tuning. Tests override `jobTimeoutMs` with a short value so
   * the Promise.race timeout token inside QueueRunner doesn't keep the
   * event loop alive for 60s after `stop()`.
   */
  queue?: { pollIntervalMs?: number; jobTimeoutMs?: number; maxConcurrentJobs?: number };
  /**
   * Edition module bundle (P2 seam). Explicit per-call registration wins
   * over the build-time `#edition-modules` entry; absent = the open
   * edition's empty bundle. composeApp threads each slot to its service.
   * See `editionModules.ts`.
   */
  modules?: EditionModules;
}

export interface MailChangedEvent {
  accountId: string;
  origin: "live-idle" | "live-poll" | "manual";
  insertedCount: number;
  inserted: Array<{
    id: string;
    subject: string;
    from: string;
  }>;
}

export interface ComposeAppOptions {
  dataDir: string;
  logsDir: string;
  mailDatabase: MailDatabaseClient;
  database?: MailDatabase;
  llmConfig?: LlmProviderConfig;
  now?: () => Date;
  /** Edition overlay loaded by the desktop main process at startup.
   *  Absent = open-source edition defaults (see shared/wemail/edition.ts). */
  edition?: EditionRuntimeConfig;
  overrides?: ComposeAppOverrides;
  /** Trigger an immediate mail metadata sync via the Mail Core worker. */
  refreshMail?: (accountId: string) => Promise<MailRefreshResult>;
  getMailReceipt?: (accountId: string) => MailReceiptHealth | null;
  /** Fetch an attachment's bytes through the Mail Core worker (MCP `get_mail_attachment`). */
  fetchAttachment?: (input: {
    accountId: string;
    remoteEmailId: string;
    partPath: string;
    source?: "inline" | "download";
    viewId?: string;
    signal?: AbortSignal;
  }) => Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export interface AutomationAttentionEvent {
  accountId: string;
  messageId: string;
  title: string;
  detail: string;
  urgent: boolean;
}

export interface AppComposition {
  /** Validated edition configuration (open defaults unless an overlay was loaded). */
  edition: EditionRuntimeConfig;
  /** Resolved P2 module bundle, exposed so the HTTP layer mounts the same
   *  edition-provided routes the composition root was assembled with. */
  editionModules: EditionModules;
  /** Effective local rollout switches. Disabling a surface never deletes data. */
  featureFlags: WemailFeatureFlags;
  db: MailDatabase;
  secrets: SecretStore;
  logger: AppLogger;
  accountService: AccountService;
  mailDatabase: MailDatabaseClient;
  aiUsage: AiUsageRepository;
  aiProfileService: AiProfileSettingsService;
  getLlmSnapshot(): LlmRuntimeSnapshot;
  getLlmHealth(): LlmRuntimeHealth;
  recordLlmFailure(error: unknown): LlmRuntimeHealth;
  recordLlmSuccess(): LlmRuntimeHealth;
  onLlmChanged(listener: (snapshot: LlmRuntimeSnapshot) => void): () => void;
  /**
   * Subscribe to AI worker concurrency changes. The Electron main process
   * uses this to resize the CanonicalAiWorkerPool at runtime. Mirrors
   * `onLlmChanged`; unsubscribe via the returned handle.
   */
  onAiWorkerConcurrencyChanged(listener: (concurrency: number) => void): () => void;
  /** Fan out a concurrency change to every `onAiWorkerConcurrencyChanged` listener. */
  notifyAiWorkerConcurrencyChanged(concurrency: number): void;
  /** Public local MCP services; listener enablement is owned by Electron. */
  mcp: McpComposition;
  /** Local Bot Core-backed Feishu and WeCom channel runtime. */
  channels: ChannelComposition;
  mailRepository: CanonicalMailRepository;
  mailAttachmentCache: MailAttachmentCache;
  /**
   * P2.6: edition-supplied `invoice_attachment_statuses` store. Undefined in
   * the open edition; the invoice refresh route does not mount without it.
   */
  invoiceStatuses: InvoiceStatusPort | undefined;
  /**
   * P2.6: edition-supplied invoice-status refresh route factory
   * (`POST /api/mail/messages/:id/invoice-status/refresh`). Undefined in the
   * open edition — the endpoint 404s and the renderer entry stays hidden.
   */
  allowanceInvoiceRoutes?: AllowanceInvoiceRoutesFactory;
  jobRepository: JobRepository;
  intelligenceResults: IntelligenceResultRepository;
  tagFeedback: TagFeedbackRuleRepository;
  aiFeedback: AiFeedbackEventRepository;
  userTags: UserTagRepository;
  emailSmartTags: EmailSmartTagRepository;
  smartTagActions: SmartTagActionRepository;
  smartTagBackfills: SmartTagBackfillRepository;
  smartTagLearningRuns: SmartTagLearningRunRepository;
  smartTagPromptRevisions: SmartTagPromptRevisionRepository;
  smartTagPromptLearning: SmartTagPromptLearningService;
  smartTagPromptCompiler: SmartTagPromptCompiler;
  smartTagPromotions: SmartTagPromotionService;
  topicCandidates: TopicCandidateRepository;
  contentTopics: ContentTopicService;
  smartTagSuggestions: SmartTagSuggestionService;
  automationRules: AutomationRuleRepository;
  automationPreviews: AutomationRulePreviewRepository;
  automationRuleService: AutomationRuleService;
  automationProviders: AutomationProviderRegistry;
  pipelineAutomationRuleService: PipelineAutomationRuleService;
  unifiedAutomationQuery: UnifiedAutomationQueryService;
  automationRunObservability: AutomationRunObservabilityService;
  canonicalAutomationDrafts: CanonicalAutomationDraftService;
  automationTemplates: AutomationTemplateRegistryService;
  configurationTasks: ConfigurationTaskRepository;
  configurationWorkflow: ConfigurationWorkflowService;
  automationAuthoring: AutomationAuthoringAgentService;
  automationAuthoringCoordinator: AutomationAuthoringCoordinator;
  agentCapabilityCatalog: AgentCapabilityCatalogService;
  executionPipelines: ExecutionPipelineService;
  skillCenter: SkillCenterService;
  skillPackages: SkillPackageRepository;
  skillImports: SkillPackageImportService;
  skillDrafts: SkillDraftService;
  pipelineDrafts: ExecutionPipelineDraftRepository;
  pipelinePreviews: PipelinePreviewStore;
  applicationMessages: ApplicationMessageRepository;
  messageArtifacts: MessageArtifactRepository;
  insightReports: InsightReportRepository;
  automationExecutionService: AutomationRuleExecutionService;
  automationFields: AutomationFieldRegistry;
  mailSemanticAttributes: MailSemanticAttributeRepository;
  ruleSuggester: RuleSuggester;
  ruleDryRunner: RuleDryRunner;
  todos: TodoRepository;
  agentConversations: AgentConversationRepository;
  agentRuns: AgentRunRepository;
  agentEventPersistence: AgentEventPersistence;
  agentRunCoordinator: AgentRunCoordinator;
  agentTitleGenerator: AgentTitleGenerator;
  agentHomeSuggestions: AgentHomeSuggestionService;
  pendingActions: AgentPendingActionRepository;
  agentAttachments: AgentAttachmentStore;
  agentLearning: AgentLearningLedger;
  mailActionExecutor: MailActionExecutor;
  /** P2.6: edition durable upload executor; undefined in the open edition. */
  actionExecutions: ActionExecutionPort | undefined;
  draftFeedbackLog: DraftFeedbackLog;
  mailSyncErrorLog: MailSyncErrorLog;
  mailDigestService: MailDigestService;
  directoryRepository: DirectoryRepository;
  directoryService: DirectoryService;
  intelligenceService: IntelligenceService;
  snoozeService: SnoozeService;
  scheduledSendService: ScheduledSendService;
  /** App-wide background workload governor. */
  resourceGovernor: ResourceGovernor;
  /** Subscribe to composition-level inserted-mail events. */
  onMailChanged(listener: (event: MailChangedEvent) => void): () => void;
  /** Subscribe to account credential failures detected by background sync. */
  onMailCredentialInvalid(
    listener: (event: MailCredentialInvalidEvent) => void,
  ): () => void;
  /** Subscribe to actionable or urgent automation results. */
  onAutomationAttention(
    listener: (event: AutomationAttentionEvent) => void,
  ): () => void;
  /** WeCLI runtime port. The open edition supplies a non-functional default;
   *  an edition module overrides it with the real runtime. */
  wecli: WecliRuntimePort;
  claudeCode: ClaudeCodeTaskService;
  auditLog: AuditLogRepository;
  auditLogService: AuditLogService;
  agent: AgentRuntime;
  retention: DataRetentionService;
  reloadLlmSettings(settings?: LlmRuntimeSettings): Promise<void>;
  semanticSearchService: SemanticSearchService;
  mailQaService: MailQaService;
  learningSummary: LearningSummaryService;
  promptBuilder: PromptBuilder;
  usageStats: UsageStatsService;
  /** Per-account agent workspace handles (Route C / WP J). */
  workspace: WorkspaceComposition;
  /** Mail Curator scheduler + per-account runtime cache (Route C / WP J.5/J.6). */
  curator: CuratorComposition;
  /**
   * Start the periodic curator tick (Route C / WP J.8). Idempotent —
   * subsequent calls are no-ops while a ticker is already running.
   * Default interval: 1 hour. Safe to call zero times in tests.
   */
  startCuratorTicker(intervalMs?: number): void;
  /** Stop the periodic curator tick (no-op when not running). */
  stopCuratorTicker(): void;
  /** Reverse-order teardown. Safe to call after partial init. */
  stop(): Promise<void>;
}
