/**
 * Composition root for the WeMail local API (Package L).
 *
 * Wires the shipped Package A–K services into a single `AppComposition`
 * handle that the Electron main process + Hono app mount. The graph is
 * hand-written on purpose — it is fully known at compile time and a DI
 * framework would add weight without buying us anything (see design.md).
 *
 * As of Batch 0 of Route C, the graph is split across
 * `composition/{system,settings,mail,intelligence,agent,workspace,
 * lifecycle}.ts`. This file owns only the cross-domain glue: boot
 * ordering, `buildForAccount()`, `reloadLlmSettings()`, and `stop()`.
 *
 * Invariants (Handoff §2 / §6):
 *   - No mail body content is ever logged.
 *   - Logout does NOT touch the SQLite DB; only session credentials
 *     and the in-memory provider/sync/bus are torn down.
 *   - Paths use `node:path` for cross-platform correctness.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import {
  OPEN_EDITION_DEFAULT,
  validateEditionRuntimeConfig,
  type EditionRuntimeConfig,
} from "../../../shared/wemail/edition.js";
import { PROVIDER_PRESETS } from "../../../shared/wemail/providers.js";
import { AccountService } from "../account/AccountService.js";
import { imapPasswordKey } from "../account/AccountTypes.js";
import type { MailCredentialInvalidEvent } from "../mail/MailCredentialError.js";
import { MailAttachmentCache } from "../mail/MailAttachmentCache.js";
import { queryOptionsForEdition } from "../database/MailDatabaseQueryRepository.js";
import { AutomationActionExecutor } from "../automation/AutomationActionExecutor.js";
import { AutomationFieldRegistry } from "../automation/AutomationFieldRegistry.js";
import { AutomationRuleExecutionService } from "../automation/AutomationRuleExecutionService.js";
import { AutomationDeferredExecutionRepository } from "../automation/AutomationDeferredExecutionRepository.js";
import { NaturalLanguageRuleEvaluator } from "../automation/NaturalLanguageRuleEvaluator.js";
import { AutomationRulePreviewRepository } from "../automation/AutomationRulePreviewRepository.js";
import { AutomationRuleService } from "../automation/AutomationRuleService.js";
import { AutomationProviderRegistry } from "../automation/providers/AutomationProviderRegistry.js";
import { MailAutomationProvider } from "../automation/providers/MailAutomationProvider.js";
import { ProcessorAutomationProvider } from "../automation/providers/ProcessorAutomationProvider.js";
import { AnalysisRecipeAutomationProvider } from "../automation/providers/AnalysisRecipeAutomationProvider.js";
import { DesignAutomationProvider } from "../automation/providers/DesignAutomationProvider.js";
import { ApplicationMessageAutomationProvider } from "../automation/providers/ApplicationMessageAutomationProvider.js";
import { BotMessageAutomationProvider } from "../automation/providers/BotMessageAutomationProvider.js";
import { PipelineAutomationRuleService } from "../automation/PipelineAutomationRuleService.js";
import { AutomationStepRunRepository } from "../automation/AutomationStepRunRepository.js";
import { AutomationRuleRuntimeRepository } from "../automation/AutomationRuleRuntimeRepository.js";
import { UnifiedAutomationQueryService } from "../automation/UnifiedAutomationQueryService.js";
import { AutomationRunObservabilityService } from "../automation/AutomationRunObservabilityService.js";
import { SubscriptionActionCandidateResolver } from "../automation/SubscriptionActionCandidateResolver.js";
import { LlmSubscriptionSemanticClassifier } from "../automation/LlmSubscriptionSemanticClassifier.js";
import { AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import { CanonicalAutomationDraftService } from "../automation/CanonicalAutomationDraftService.js";
import {
  AutomationTemplateRegistryService,
  resolveAutomationTemplateRegistryPaths,
} from "../automation/AutomationTemplateRegistryService.js";
import { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import { MessageArtifactRepository } from "../design/MessageArtifactRepository.js";
import { AgentArtifactDeliveryService } from "../design/AgentArtifactDeliveryService.js";
import { InsightReportRepository } from "../design/InsightReportRepository.js";
import { MailDigestRepository } from "../digests/MailDigestRepository.js";
import { MailDigestService } from "../digests/MailDigestService.js";
import { MailSemanticAttributeRepository } from "../intelligence/MailSemanticAttributeRepository.js";
import { LlmRuntime } from "../ai/LlmRuntime.js";
import { DirectoryRepository } from "../directory/DirectoryRepository.js";
import { OPEN_DIRECTORY_PINYIN } from "../directory/DirectoryRemoteClient.js";
import { DirectoryService } from "../directory/DirectoryService.js";
import type {
  AppComposition,
  AutomationAttentionEvent,
  ComposeAppOptions,
  MailChangedEvent,
} from "./AppCompositionTypes.js";
import { composeAgent } from "./composition/agent.js";
import { composeCurator } from "./composition/curator.js";
import { composeIntelligence } from "./composition/intelligence.js";
import {
  type BuildForAccount,
  createPerAccountState,
  createTransitionDriver,
  teardownAccount,
} from "./composition/lifecycle.js";
import { composeMail } from "./composition/mail.js";
import { composeSettings } from "./composition/settings.js";
import { composeInfrastructure, composeSystem } from "./composition/system.js";
import { composeWorkspace } from "./composition/workspace.js";
import { composeChannels } from "./composition/channels.js";
import { createReloadLlmSettings } from "./reloadLlmSettings.js";
import { ResourceGovernor } from "../performance/ResourceGovernor.js";
import { materializeDataSelection } from "../workflows/DataSelectionRuntime.js";
import { createMcpComposition } from "../mcp/McpComposition.js";
import { AgentHomeSuggestionService } from "../agent/AgentHomeSuggestionService.js";
import { resolveEditionModules, resolveEditionPromptSections, resolveAutomationFormContributions } from "./editionModules.js";
import { ConfigurationTaskRepository } from "../configuration/ConfigurationTaskRepository.js";
import { ConfigurationWorkflowService } from "../configuration/ConfigurationWorkflowService.js";
import { SkillPackageRepository } from "../skill-center/SkillPackageRepository.js";
import { SkillPackageStore } from "../skill-center/SkillPackageStore.js";
import { SkillCenterService } from "../skill-center/SkillCenterService.js";
import { SkillPackageImportService } from "../skill-center/SkillPackageImportService.js";
import {
  SkillDraftRepository,
  SkillDraftService,
} from "../skill-center/SkillDraftService.js";
import {
  SkillRegistry,
  SkillResolver,
} from "../skill-center/SkillRuntime.js";
import { PiSkillResources } from "../skill-center/PiSkillResources.js";
import { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import { PipelinePreviewStore } from "../workflows/PipelineReviewService.js";
import { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import { AutomationAuthoringCoordinator } from "../configuration/AutomationAuthoringCoordinator.js";
import { AutomationAuthoringAgentService } from "../configuration/AutomationAuthoringAgentService.js";
import { ConfigurationTaskReconciler } from "../configuration/ConfigurationTaskReconciler.js";
import { readWemailFeatureFlags } from "./FeatureFlags.js";


export { BootError, type BootPhase } from "./BootError.js";
export type {
  AppComposition,
  ComposeAppOptions,
  ComposeAppOverrides,
} from "./AppCompositionTypes.js";
/**
 * Single-shot compose factory. Call once at Electron boot; call
 * {@link AppComposition.stop} before quit (or in test teardown).
 */
export async function composeApp(
  options: ComposeAppOptions,
): Promise<AppComposition> {
  const { dataDir, logsDir, overrides = {} } = options;
  if (!options.mailDatabase) {
    throw new Error("Canonical Database Service client is required");
  }
  // P2 module seam: an explicit `overrides.modules` bundle (tests) wins over
  // the build-time `#edition-modules` registration; the open edition
  // resolves to the empty bundle and every consumer keeps its generic
  // behavior. Scene-action contributors are instance-bound on the DB query
  // repository (which lives in the independent reader lane), not global
  // state here, so repeated compositions cannot change each other's queries.
  const modules = resolveEditionModules(overrides.modules);

  // 1–3. Infrastructure.
  const { db, secrets, logger } = composeInfrastructure({
    dataDir,
    logsDir,
    database: options.database,
    secretStore: overrides.secretStore,
  });
  const resourceGovernor = new ResourceGovernor({ logger, now: options.now });
  resourceGovernor.start();

  // 4. Account service + persisted LLM settings + LLM client (lazy).
  // A failure to build the LLM client is non-fatal: the agent falls
  // back to the stub planner so unconfigured boots still succeed.
  const accountService = new AccountService({
    mailDatabase: options.mailDatabase,
    secrets,
    now: options.now ? () => options.now!().toISOString() : undefined,
  });
  await accountService.initialize();
  // Edition seam: an edition overlay (loaded by the desktop main process)
  // may add provider presets, a signature brand link, and an enterprise
  // directory endpoint. The open edition stays at the validated default.
  const edition: EditionRuntimeConfig = validateEditionRuntimeConfig(
    options.edition ?? OPEN_EDITION_DEFAULT,
  );
  const editionPromptSections = resolveEditionPromptSections(modules, edition.features);
  const basePresetIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
  for (const preset of edition.providerPresets) {
    if (basePresetIds.has(preset.id)) {
      throw new Error(`edition provider preset id collides with a built-in preset: ${preset.id}`);
    }
  }
  // P2.4: the snapshot engine stays open; the remote client and pinyin port
  // come from EditionModules.directory (registered only by the internal
  // edition). With no factory, DirectoryService keeps its P1
  // "directory-not-configured" fallback and the edition domain gate still
  // rejects non-matching accounts before any credential is read.
  const directoryRepository = new DirectoryRepository(
    db,
    undefined,
    edition.features?.enterpriseDirectory ? modules.directory?.pinyin ?? OPEN_DIRECTORY_PINYIN : OPEN_DIRECTORY_PINYIN,
  );
  const directoryService = new DirectoryService({
    repository: directoryRepository,
    mailDatabase: options.mailDatabase,
    accounts: accountService,
    secrets,
    logger,
    ...(edition.features?.enterpriseDirectory && edition.enterpriseDirectory
      ? {
          ...(modules.directory?.clientFactory
            ? {
                clientFactory: (input: { username: string; password: string }) =>
                  modules.directory!.clientFactory!({
                    ...input,
                    baseUrl: edition.enterpriseDirectory!.coremailBaseUrl,
                  }),
              }
            : {}),
          internalDomain: edition.enterpriseDirectory.autoInitDomain,
        }
      : {}),
  });
  const maybeInitDirectory = (account: { id: string; emailAddress: string } | null | undefined) => {
    if (!edition.features?.enterpriseDirectory) return;
    const directoryConfig = edition.enterpriseDirectory;
    if (!directoryConfig || !account) return;
    if (!account.emailAddress.toLowerCase().endsWith(directoryConfig.autoInitDomain)) return;
    void directoryService.initialize(account.id).catch((error) => {
      logger.warn("directory.initialize.failed", {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const { llmSettingsService, aiUsage } = composeSettings({ db, secrets });
  const llmRuntime = new LlmRuntime({
    initialSettings: llmSettingsService.getRuntimeSettings(),
    initialConfig: options.llmConfig,
    initialClient: overrides.llmClient,
    overrideClient: overrides.llmClient,
    logger,
  });

  // AI worker concurrency live-update channel. Mirrors onLlmChanged: the
  // renderer writes via an HTTP settings route → createSettingsApp dep →
  // notifyAiWorkerConcurrencyChanged, and the Electron main process subscribes
  // at boot to resize the CanonicalAiWorkerPool without a restart.
  const aiWorkerConcurrencyListeners = new Set<(concurrency: number) => void>();

  // 5. Per-account state holder. Domain composers and the lifecycle
  // helpers all close over this; the holder fields swap synchronously
  // during login/logout so subsequent reads observe the right state.
  const perAccount = createPerAccountState();
  const mailChanged = new EventEmitter();
  const mailCredentialInvalid = new EventEmitter();
  const automationAttention = new EventEmitter();
  const pendingMailChanges = new Map<
    string,
    {
      origin: MailChangedEvent["origin"];
      insertedCount: number;
      inserted: Map<string, MailChangedEvent["inserted"][number]>;
    }
  >();
  let mailChangedTimer: NodeJS.Timeout | undefined;

  function flushMailChanged(): void {
    mailChangedTimer = undefined;
    for (const [accountId, pending] of pendingMailChanges) {
      mailChanged.emit("mail-changed", {
        accountId,
        origin: pending.origin,
        insertedCount: pending.insertedCount,
        inserted: [...pending.inserted.values()].slice(0, 100),
      } satisfies MailChangedEvent);
    }
    pendingMailChanges.clear();
  }

  function emitMailChanged(event: MailChangedEvent): void {
    const pending = pendingMailChanges.get(event.accountId) ?? {
      origin: event.origin,
      insertedCount: 0,
      inserted: new Map<string, MailChangedEvent["inserted"][number]>(),
    };
    pending.origin = event.origin;
    pending.insertedCount += event.insertedCount;
    for (const message of event.inserted) pending.inserted.set(message.id, message);
    pendingMailChanges.set(event.accountId, pending);
    if (!mailChangedTimer) {
      mailChangedTimer = setTimeout(flushMailChanged, 300);
      mailChangedTimer.unref?.();
    }
  }

  function onMailChanged(listener: (event: MailChangedEvent) => void): () => void {
    mailChanged.on("mail-changed", listener);
    return () => {
      mailChanged.off("mail-changed", listener);
    };
  }

  function emitMailCredentialInvalid(event: MailCredentialInvalidEvent): void {
    mailCredentialInvalid.emit("credential-invalid", event);
  }

  function onMailCredentialInvalid(
    listener: (event: MailCredentialInvalidEvent) => void,
  ): () => void {
    mailCredentialInvalid.on("credential-invalid", listener);
    return () => {
      mailCredentialInvalid.off("credential-invalid", listener);
    };
  }

  function onAutomationAttention(
    listener: (event: AutomationAttentionEvent) => void,
  ): () => void {
    automationAttention.on("attention", listener);
    return () => {
      automationAttention.off("attention", listener);
    };
  }

  // 6. Mail-domain singletons + scheduler tick.
  const mailQueryOptions = queryOptionsForEdition(db, edition.features, modules);
  const mail = composeMail({
    db,
    mailDatabase: options.mailDatabase,
    logger,
    logsDir,
    // P2.6: the invoice_attachment_statuses store is an edition module; the
    // open edition passes nothing and every consumer falls back to its
    // empty/null invoice read.
    ...(mailQueryOptions.invoiceStatuses ? { invoiceStatuses: mailQueryOptions.invoiceStatuses } : {}),
    queryOptions: mailQueryOptions,
  });
  const mailAttachmentCache = new MailAttachmentCache({
    rootDir: path.join(dataDir, "mail-attachment-cache"),
  });
  const automationNowDate = () => options.now?.() ?? new Date();
  const automationNowString = () => automationNowDate().toISOString();
  const mailSemanticAttributes = new MailSemanticAttributeRepository({
    db,
    now: automationNowString,
  });
  const automationFields = AutomationFieldRegistry.withNativeFields();
  // P2.6: the invoice.issueDate automation field (definition + resolver) is
  // an edition module contribution. The open catalog lists only the native
  // fields and rule authoring never offers the invoice field.
  if (edition.features?.allowanceInvoice && modules.allowance) {
    automationFields.register(
      modules.allowance.createIssueDateFieldProvider({
        repository: mailSemanticAttributes,
      }),
    );
  }

  const digests = new MailDigestRepository({
    db,
    now: automationNowString,
  });
  const mailDigestService = new MailDigestService({
    digests,
    mail: mail.public.mailRepository,
    getLlmClient: () => llmRuntime.snapshot().client,
    getModel: () => llmRuntime.snapshot().modelFor("summary"),
    now: options.now,
  });
  const applicationMessages = new ApplicationMessageRepository(db, automationNowString);
  const messageArtifacts = new MessageArtifactRepository(db, dataDir, automationNowString);
  const insightReports = new InsightReportRepository(db, automationNowString);
  const agentArtifactDelivery = new AgentArtifactDeliveryService(
    applicationMessages,
    messageArtifacts,
    insightReports,
  );
  const automationProviders = new AutomationProviderRegistry();
  automationProviders.register(new MailAutomationProvider(mail.public.mailRepository));
  automationProviders.register(
    new ProcessorAutomationProvider(
      mail.public.mailRepository,
      new LlmSubscriptionSemanticClassifier({
        getClient: () => llmRuntime.snapshot().client,
        getModel: () =>
          llmRuntime.snapshot().modelFor("summary") ??
          llmRuntime.snapshot().modelFor("agent"),
      }),
      edition.features?.officeSceneDetection ? modules.officeScenes : undefined,
      edition.features?.allowanceInvoice ? modules.allowance?.buildInvoiceAutomationDataset : undefined,
    ),
  );
  automationProviders.register(
    new AnalysisRecipeAutomationProvider({
      getClient: () => llmRuntime.snapshot().client,
      getModel: () =>
        llmRuntime.snapshot().modelFor("summary") ??
        llmRuntime.snapshot().modelFor("agent"),
      getProvider: () => llmRuntime.snapshot().provider,
      usage: aiUsage,
    }),
  );
  automationProviders.register(new DesignAutomationProvider(messageArtifacts));
  automationProviders.register(
    new ApplicationMessageAutomationProvider(
      applicationMessages,
      messageArtifacts,
      (event) => automationAttention.emit("attention", event),
    ),
  );

  // 7. System-domain services (audit, retention, semantic, personalization).
  const system = composeSystem({
    db,
    mailDatabase: options.mailDatabase,
    logger,
    logsDir,
    mailRepository: mail.public.mailRepository,
    llmRuntime,
  });
  system.retention.start();

  // 8. Workspace composition (Route C). Per-account WorkspaceFileSystem
  // + ContextLoader + FeedbackSink handles. Built before intel so the
  // intelligence composition can hand its routing sink to the shared
  // feedback repositories.
  const workspace = composeWorkspace({
    dataDir,
    logger: (event, fields) => {
      const level = event.endsWith("-failed") || event.includes("invalid") || event.includes("missing")
        ? "warn"
        : "debug";
      if (level === "warn") logger.warn(event, fields);
      else logger.debug(event, fields);
    },
  });

  // 9. Intelligence-domain singletons.
  const intel = composeIntelligence({
    db,
    mailRepository: mail.public.mailRepository,
    auditLogService: system.auditLogService,
    getOrchestrator: () => undefined,
    llmRuntime,
    workspace,
    applicationMessages,
    directoryService,
  });
  const agentHomeSuggestions = new AgentHomeSuggestionService({
    mailDatabase: options.mailDatabase,
    llmRuntime,
    now: options.now,
    logger,
    officeSceneProvider: edition.features?.officeSceneDetection && edition.features?.wecli ? modules.officeScenes : undefined,
  });
  const automationPreviews = new AutomationRulePreviewRepository(db, automationNowString);
  const configurationTasks = new ConfigurationTaskRepository(db);
  const configurationWorkflow = new ConfigurationWorkflowService(
    configurationTasks,
    undefined,
    automationNowString,
  );
  const configurationReconciler = new ConfigurationTaskReconciler(
    configurationTasks,
    automationNowString,
  );
  for (const row of db
    .prepare("SELECT public_id AS id FROM mail_accounts")
    .all() as Array<{ id: string }>) {
    const reconciled = configurationReconciler.reconcile(row.id);
    if (reconciled.normalized || reconciled.superseded) {
      logger.info("configuration.reconciled", {
        accountId: row.id,
        ...reconciled,
      });
    }
  }
  const skillPackages = new SkillPackageRepository(db, automationNowString);
  const skillStore = new SkillPackageStore({
    userDataDir: dataDir,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath,
    developmentRoot: process.cwd(),
  });
  const skillCenter = new SkillCenterService(skillPackages, skillStore);
  skillCenter.synchronizeBuiltIns();
  skillCenter.synchronizeExternal();
  const skillImports = new SkillPackageImportService(skillCenter);
  const skillDrafts = new SkillDraftService(
    new SkillDraftRepository(db),
    skillCenter,
    automationNowString,
  );
  const skillRegistry = new SkillRegistry(skillPackages);
  const skillResolver = new SkillResolver(skillRegistry);
  const skillResources = new PiSkillResources(
    skillRegistry,
    skillResolver,
    process.cwd(),
  );
  const featureFlags = readWemailFeatureFlags();
  const resolveSkillSnapshots = (context: Record<string, unknown> | undefined) => {
    try {
      const resolved = skillResources.resolveSnapshots(context);
      if (context) delete context.skillResolutionIssue;
      return resolved;
    } catch (error) {
      if (context) {
        context.skillResolutionIssue =
          error instanceof Error ? error.message : String(error);
      }
      logger.warn("skill.dynamic-resolution.snapshot-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
  const pipelineDrafts = new ExecutionPipelineDraftRepository(db);
  const pipelinePreviews = new PipelinePreviewStore(dataDir);
  const automationRuleService = new AutomationRuleService({
    rules: intel.automationRules,
    previews: automationPreviews,
    mail: mail.public.mailRepository,
    now: automationNowString,
    editionValidation: {
      validateAction: edition.features?.wecli && modules.automationRuleValidation?.validateAction
        ? (action) => modules.automationRuleValidation!.validateAction!(action, edition.features)
        : undefined,
      validateProcessor: edition.features?.allowanceInvoice ? modules.automationRuleValidation?.validateProcessor : undefined,
    },
    editionCapabilities: {
      actions: edition.features?.wecli ? modules.automationCapabilities?.actions : undefined,
      processors: edition.features?.allowanceInvoice ? modules.automationCapabilities?.processors : undefined,
    },
    editionFieldDefinitions: edition.features?.allowanceInvoice ? modules.allowance?.automationFieldDefinitions : undefined,
    editionForm: resolveAutomationFormContributions(modules, edition.features),
  });

  let allowanceRef: ReturnType<typeof composeAgent>["allowance"] | undefined;
  let wecliRef: ReturnType<typeof composeAgent>["wecli"] | undefined;
  const automationActionExecutor = new AutomationActionExecutor({
    mail: mail.public.mailRepository,
    editionExternalAction: async (accountId, emailId, action) => {
      if (edition.features?.allowanceInvoice && edition.features?.wecli && allowanceRef && modules.allowance?.executeAutomationAction) {
        const result = await modules.allowance.executeAutomationAction(accountId, emailId, action, allowanceRef);
        if (result) return result;
      }
      if (edition.features?.wecli && wecliRef && modules.wecli?.executeAutomationAction) {
        return modules.wecli.executeAutomationAction(accountId, emailId, action, wecliRef);
      }
      return undefined;
    },
    userTags: intel.userTags,
    emailSmartTags: intel.emailSmartTags,
  });
  const automationDeferredExecutions = new AutomationDeferredExecutionRepository(
    db,
    automationNowString,
  );
  const naturalLanguageRuleEvaluator = new NaturalLanguageRuleEvaluator({
    getLlmClient: () => {
      const snapshot = llmRuntime.snapshot();
      const client = snapshot.client;
      const model = snapshot.modelFor("agent") ?? snapshot.modelFor("summary");
      if (!client || !model) return undefined;
      return {
        complete: async (input) =>
          client.generate({
            model: input.model ?? model,
            messages: [{ role: "user", content: input.prompt }],
            temperature: 0,
            maxTokens: 512,
          }),
      };
    },
    getModel: () =>
      llmRuntime.snapshot().modelFor("agent") ??
      llmRuntime.snapshot().modelFor("summary"),
  });
  const automationExecutionService = new AutomationRuleExecutionService({
    rules: intel.automationRules,
    mail: mail.public.mailRepository,
    evaluator: naturalLanguageRuleEvaluator,
    actionExecutor: automationActionExecutor,
    deferredExecutions: automationDeferredExecutions,
    fieldRegistry: automationFields,
    now: automationNowString,
    messageHasTag: (emailId, tagName) =>
      intel.intelligenceResults.messageHasTag(emailId, tagName),
    mailDigestService,
    applicationMessages,
    editionCollectionProcessor: edition.features?.allowanceInvoice ? modules.allowance?.processCollection : undefined,
  });
  const subscriptionPendingActions = new AgentPendingActionRepository({
    db,
    now: automationNowString,
  });
  const automationRunObservability = new AutomationRunObservabilityService(
    db,
    automationNowString,
    new SubscriptionActionCandidateResolver({
      mail: mail.public.mailRepository,
      pendingActions: subscriptionPendingActions,
    }),
  );
  const pipelineAutomationRuleService = new PipelineAutomationRuleService({ db, rules: intel.automationRules, providers: automationProviders, stepRuns: new AutomationStepRunRepository(db), runtime: new AutomationRuleRuntimeRepository(db, automationNowString), accountIds: () => accountService.listAccounts().map((account) => account.id), accountExists: (accountId) => accountService.listAccounts().some((account) => account.id === accountId), mail: mail.public.mailRepository, intelligenceResults: intel.intelligenceResults, observability: automationRunObservability, now: automationNowString });
  const legacyProcessorCapabilities = edition.features?.allowanceInvoice ? modules.legacyProcessorCapabilities : undefined;
  const unifiedAutomationQuery = new UnifiedAutomationQueryService(
    db,
    intel.automationRules,
    legacyProcessorCapabilities,
  );
  const agentCapabilityCatalog = new AgentCapabilityCatalogService(
    automationProviders,
    edition.features?.wecli && modules.wecli ? ["wecli"] : [],
  );
  const executionPipelines = new ExecutionPipelineService(
    agentCapabilityCatalog,
    automationProviders,
    automationNowString,
    (draft) => draft.dataSelection
      ? materializeDataSelection({
          spec: draft.dataSelection,
          accountId: draft.accountId,
          mail: mail.public.mailRepository,
          now: automationNowString,
        })
      : {},
  );
  executionPipelines.setSkillSnapshotValidator((snapshots) => {
    skillResolver.resolve({ taskBound: snapshots });
  });
  const canonicalAutomationDrafts = new CanonicalAutomationDraftService(
    pipelineDrafts,
    intel.automationRules,
    agentCapabilityCatalog,
    executionPipelines,
    automationNowString,
    legacyProcessorCapabilities,
  );
  const automationTemplates = new AutomationTemplateRegistryService({
    db,
    paths: resolveAutomationTemplateRegistryPaths({
      repositoryRoot: process.cwd(),
      userDataDir: dataDir,
      resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })
        .resourcesPath,
      packaged: !!(process as NodeJS.Process & { resourcesPath?: string })
        .resourcesPath,
    }),
    drafts: pipelineDrafts,
    rules: intel.automationRules,
    catalog: agentCapabilityCatalog,
    pipeline: executionPipelines,
    now: automationNowString,
  });
  await automationTemplates.synchronize();
  const automationAuthoringCoordinator = new AutomationAuthoringCoordinator(
    configurationWorkflow,
    pipelineDrafts,
    executionPipelines,
    agentCapabilityCatalog,
    automationNowString,
    (draft) => {
      const accountIds =
        draft.accountScope?.type === "selectedAccounts"
          ? [...new Set(draft.accountScope.accountIds)]
          : draft.accountScope?.type === "allConnectedAccounts"
            ? (
                db
                  .prepare("SELECT public_id AS id FROM mail_accounts ORDER BY created_at_ms, public_id")
                  .all() as Array<{ id: string }>
              ).map((row) => row.id)
            : [draft.accountId];
      if (accountIds.length === 0) return [];
      const placeholders = accountIds.map(() => "?").join(",");
      const labels = db
        .prepare(
          `SELECT public_id AS id, email_address AS email
           FROM mail_accounts WHERE public_id IN (${placeholders})`,
        )
        .all(...accountIds) as Array<{ id: string; email: string }>;
      const byId = new Map(labels.map((row) => [row.id, row.email]));
      return accountIds.map((id) => byId.get(id) ?? id);
    },
  );
  const automationAuthoring = new AutomationAuthoringAgentService(
    configurationWorkflow,
    pipelineDrafts,
    executionPipelines,
    agentCapabilityCatalog,
    pipelinePreviews,
    automationAuthoringCoordinator,
    intel.automationRules,
    pipelineAutomationRuleService,
    automationNowString,
    canonicalAutomationDrafts,
    unifiedAutomationQuery,
    {
      messages: applicationMessages,
      artifacts: messageArtifacts,
    },
    skillDrafts,
    skillPackages,
  );

  // 10a. Curator-domain singletons. Built before the chat agent so the
  // chat agent can later DI a `triggerManual` reference if needed.
  const curator = composeCurator({
    workspace,
    intelligenceResults: intel.intelligenceResults,
    mailRepository: mail.public.mailRepository,
    logger,
    accountIds: () => (perAccount.accountId ? [perAccount.accountId] : []),
    llmRuntime,
    dataDir,
  });

  // 10. Agent-domain singletons + ReloadableAgentRuntime wrapper.
  const agentDomain = composeAgent({
    db,
    mailDatabase: options.mailDatabase,
    dataDir,
    extraPromptSections: editionPromptSections,
    // P2.4: the six directory agent tools are registered only when the
    // edition advertises the feature AND the internal directory module is
    // assembled. The open build registers none of them, but the tool factory
    // (mechanism layer) stays in the open tree.
    directoryToolsEnabled: !!edition.features?.enterpriseDirectory && !!modules.directory,
    // P2.6: the allowance agent tools register only when BOTH the edition
    // feature flag and the assembled allowance module are present. The open
    // edition has neither, so `listTools()` never contains an invoice tool.
    allowanceModules: edition.features?.allowanceInvoice ? modules.allowance : undefined,
    allowanceToolsEnabled: !!edition.features?.allowanceInvoice && !!modules.allowance,
    // P2.5: wecli_* agent tools register only when BOTH the edition feature
    // flag and the assembled WeCLI module are present. The open edition has
    // neither, so `listTools()` never contains a wecli_* entry.
    wecliModules: edition.features?.wecli ? modules.wecli : undefined,
    wecliToolsEnabled: !!edition.features?.wecli && !!modules.wecli,
    signatureBrandUrl: edition.signature.brandUrl || undefined,
    logger,
    auditLog: system.auditLog,
    auditLogService: system.auditLogService,
    invoiceStatuses: mail.public.invoiceStatuses,
    getMailProvider: () => undefined,
    fetchAttachment: options.fetchAttachment
      ? async (emailId, attachmentId, accountId) => {
          const descriptor = mail.public.mailRepository.getAttachmentFetchDescriptor(
            emailId,
            attachmentId,
          );
          // Accepted tasks retain their account when the user switches the visible mailbox.
          if (!descriptor || descriptor.accountId !== (accountId ?? accountService.getCurrentAccount()?.id)) return null;
          const fetched = await options.fetchAttachment!({
            accountId: descriptor.accountId,
            remoteEmailId: descriptor.remoteEmailId,
            partPath: descriptor.partPath,
            source: "download",
            viewId: `agent:allowance:${emailId}`,
          });
          return { bytes: Buffer.from(fetched.bytes), mimetype: fetched.mediaType };
        }
      : undefined,
    intelligenceService: intel.intelligenceService,
    aiUsage,
    llmRuntime,
    agentPlannerOverride: overrides.agentPlanner,
    piAgentFactory: overrides.piAgentFactory,
    skillsEnabled: featureFlags.dynamicSkills,
    skillResources,
    resolveSkillSnapshots,
    wecliRunner: overrides.wecliRunner,
    curator,
    getActiveAccountId: () => accountService.getCurrentAccount()?.id,
    automationRules: intel.automationRules,
    deferredExecutions: automationDeferredExecutions,
    ruleDryRunner: intel.ruleDryRunner,
    automationRuleService,
    automationProviders,
    pipelineAutomationRuleService,
    configurationWorkflow,
    automationAuthoring:
      featureFlags.agentCapabilityCatalog &&
      featureFlags.pipelineAuthoringSessions
        ? automationAuthoring
        : undefined,
    artifactDelivery: agentArtifactDelivery,
    skillDrafts,
    userTags: intel.userTags,
    smartTagPromptCompiler: intel.smartTagPromptCompiler,
    intelligenceResults: intel.intelligenceResults,
    todos: intel.todos,
    emailSmartTags: intel.emailSmartTags,
    scheduledSend: mail.public.scheduledSendService,
    snooze: mail.public.snoozeService,
    directoryService,
    onSmartTagConfigurationChanged: async (accountId) => {
      let cursor: { receivedAt: string; id: string } | undefined;
      let scanned = 0;
      do {
        const messages = mail.public.mailRepository.listAllMessagesByAccountPage({
          accountId,
          limit: Math.min(50, 2_000 - scanned),
          cursor,
        });
        for (const message of messages) {
          intel.jobRepository.enqueueOrResetJob({
            accountId,
            emailId: message.id,
            type: "tags",
            maxAttempts: 3,
            payload: { reason: "agent-smart-tag-configuration" },
          });
          scanned += 1;
          if (scanned < 2_000) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        const last = messages.at(-1);
        cursor = last ? { receivedAt: last.receivedAt, id: last.id } : undefined;
        if (messages.length < 50) break;
      } while (cursor && scanned < 2_000);
    },
    runAutomationRule: async (ruleId) => {
      const summary = await automationExecutionService.runRuleManually(ruleId);
      return {
        ok: true,
        summary: summary.appliedCount > 0
          ? `自动化规则已执行，处理 ${summary.appliedCount} 封邮件。`
          : "自动化规则已运行，但没有邮件被处理。",
        successCount: summary.appliedCount,
        failureCount: 0,
      };
    },
  });
  const channels = composeChannels({
    db,
    mailDatabase: options.mailDatabase,
    secrets,
    agent: agentDomain.agent,
    conversations: agentDomain.agentConversations,
    pendingActions: agentDomain.pendingActions,
    actionExecutor: agentDomain.mailActionExecutor,
    getActiveAccountId: () => accountService.getCurrentAccount()?.id,
    logger,
    enabled:
      overrides.channels?.enabled ??
      process.env.WEMAIL_CHANNELS_ENABLED === "1",
    now: options.now,
    // P2.5: the open edition has no WeCLI health checker, so the connection
    // center lists only bot platforms. An edition module supplies one.
    ...(edition.features?.wecli && modules.wecli ? { wecliHealth: modules.wecli.createHealth({ now: options.now }) } : {}),
    onAutomationDeliverySettled: (delivery) => {
      if (delivery.automationRunId) {
        automationRunObservability.reconcileChannelDeliveries(
          delivery.automationRunId,
        );
      }
    },
  });
  automationRunObservability.reconcileOutstandingChannelDeliveries();
  automationActionExecutor.setChannels({
    connections: channels.connections,
    bindings: channels.bindings,
    deliveries: channels.deliveries,
    destinations: channels.destinations,
    audit: channels.audit,
  });
  automationProviders.register(new BotMessageAutomationProvider(
    channels.connections,
    channels.bindings,
    channels.destinations,
    channels.deliveries,
    messageArtifacts,
    applicationMessages,
  ));
  // P2.5: the WeCLI automation provider is an edition module. The open
  // edition registers none, so no wecli capability ever appears in the
  // automation catalog. Internal builds supply the provider through the
  // same module bundle that powers the routes and agent tools.
  if (edition.features?.wecli && modules.wecli) {
    automationProviders.register(modules.wecli.createAutomationProvider(
      agentDomain.wecli,
      async () => {
        throw new Error("attachment-materialization-client-not-configured");
      },
    ));
  }
  allowanceRef = agentDomain.allowance;
  wecliRef = agentDomain.wecli;

  // Curator scheduler "feedback-event" fan-out (Route C / WP J.8). The
  // routing sink notifies the scheduler after every successful per-
  // account JSONL append; failures inside the scheduler must never
  // propagate (the sink wraps in try/catch so the call is non-fatal).
  workspace.setFeedbackObserver((accountId) => {
    void curator.scheduler.notifyEvent(accountId, "feedback-event").catch(() => {
      // Counter persistence is best-effort; scheduler logs its own errors.
    });
  });

  // Mail synchronization and body/AI scheduling are owned by Mail Core and
  // DB Service. The local API only observes account lifecycle; it must not
  // construct another provider, queue, watcher, body worker, or mail writer.
  const buildForAccount: BuildForAccount = Object.assign(
    (account: AccountConfig) => {
      logger.info("compose.account.local-services-attached", {
        accountId: account.id,
      });
    },
    { reloadIntelligence: async () => undefined },
  );

  // Login/logout transitions. Holder fields are cleared synchronously
  // (inside the driver) so getMailSync() etc. observe the post-event
  // state immediately. Mail Core owns provider teardown and queue drain,
  // so the local API never retains a per-account sync writer.
  const { runTransition, getTransition } = createTransitionDriver({
    state: perAccount,
    logger,
    buildForAccount,
    workspace,
    curator,
  });


  const unsubscribe = accountService.onAccountChanged((event) => {
    const previousAccountId = perAccount.accountId;
    if (previousAccountId && (event.kind === "logout" || event.account?.id !== previousAccountId)) {
      mcp.tokens.revokeForAccount(previousAccountId);
    }
    runTransition({ kind: event.kind, account: event.account });
    directoryService.invalidate(event.account?.id);
    if (event.kind === "login") maybeInitDirectory(event.account);
  });

  // Existing-account boot: resume the previous session if both the
  // account row AND its IMAP secret are still present. (Logout clears
  // secrets but not the DB row, so a re-opened app might see an
  // account row without credentials.)
  const existing = accountService.getCurrentAccount();
  if (existing && secrets.getSecret(imapPasswordKey(existing.id))) {
    buildForAccount(existing);
    maybeInitDirectory(existing);
  }

  const reloadLlmSettings = createReloadLlmSettings({
    llmRuntime,
    llmSettingsService,
    accountService,
    secrets,
    overrides,
    logger,
    aiUsage,
    agent: agentDomain.agent,
    agentTitleGenerator: agentDomain.agentTitleGenerator,
    intelligenceService: intel.intelligenceService,
    curator,
    reloadAccountIntelligence: buildForAccount.reloadIntelligence,
    skillsEnabled: featureFlags.dynamicSkills,
    skillResources,
    extraPromptSections: editionPromptSections,
  });
  const mcp = createMcpComposition({
    db,
    secrets,
    accounts: accountService,
    mailDatabase: options.mailDatabase,
    mail: mail.public.mailRepository,
    signatureBrandUrl: edition.signature.brandUrl || undefined,
    todos: intel.todos,
    pendingActions: agentDomain.pendingActions,
    attachmentCache: mailAttachmentCache,
    intelligenceService: intel.intelligenceService,
    semanticSearchService: system.semanticSearchService,
    mailQaService: system.mailQaService,
    // P2.4: MCP search_directory_contacts is an edition capability too;
    // without the internal module the open edition does not expose it.
    ...(edition.features?.enterpriseDirectory && modules.directory
      ? { directoryService }
      : {}),
    agentRuns: agentDomain.agentRuns,
    getProvider: () => undefined,
    refreshMail: options.refreshMail,
    getMailReceipt: options.getMailReceipt,
    fetchAttachment: options.fetchAttachment,
  });

  // Snooze + Schedule Send (Feature F1) tick. Unref'd so a pending tick
  // never keeps Electron / unit tests alive past their natural exit.
  const schedulerInterval: NodeJS.Timeout | undefined = undefined;

  // Hourly background intelligence maintenance. Off by default so tests
  // don't observe an unsolicited ticker; the lifecycle layer starts it.
  // Smart-tag feedback is consumed on every tick without sample-count or
  // polarity gates. Curator keeps its own 24h eligibility check.
  let curatorInterval: NodeJS.Timeout | undefined;
  let maintenanceInFlight: Promise<void> | undefined;

  function runMaintenanceTick(): Promise<void> {
    if (maintenanceInFlight) return maintenanceInFlight;
    maintenanceInFlight = (async () => {
      const accountId = perAccount.accountId;
      const work: Promise<unknown>[] = [];
      work.push((async () => {
        const pending = await curator.scheduler.tickTime();
        await Promise.allSettled(pending);
      })());
      if (accountId) {
        work.push(intel.smartTagPromptLearning.processAccount(accountId));
        work.push(intel.smartTagPromptLearning.processTargetedRetagging(accountId));
      }
      const settled = await Promise.allSettled(work);
      for (const item of settled) {
        if (item.status === "rejected") {
          logger.error("background.intelligence.tick.failed", {
            err: item.reason instanceof Error ? item.reason.message : String(item.reason),
          });
        }
      }
    })().finally(() => {
      maintenanceInFlight = undefined;
    });
    return maintenanceInFlight;
  }

  function startCuratorTicker(intervalMs = 60 * 60 * 1000): void {
    if (curatorInterval) return;
    void runMaintenanceTick();
    curatorInterval = setInterval(() => {
      void runMaintenanceTick();
    }, Math.max(60_000, intervalMs));
    curatorInterval.unref();
  }
  function stopCuratorTicker(): void {
    if (curatorInterval) {
      clearInterval(curatorInterval);
      curatorInterval = undefined;
    }
  }

  logger.info("compose.ready", { dataDir, logsDir });
  if (!options.fetchAttachment) agentDomain.actionExecutions?.wake();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await agentDomain.actionExecutions?.stop();
    unsubscribe();
    if (mailChangedTimer) clearTimeout(mailChangedTimer);
    mailChangedTimer = undefined;
    pendingMailChanges.clear();
    if (schedulerInterval) clearInterval(schedulerInterval);
    stopCuratorTicker();
    if (maintenanceInFlight) {
      try {
        await maintenanceInFlight;
      } catch {
        // Tick failures are logged by runMaintenanceTick.
      }
    }
    channels.worker.stop();
    mcp.close();
    directoryService.invalidate();
    system.retention.stop();
    resourceGovernor.stop();
    // Let any in-flight login/logout transition finish its async tail
    // before we tear down what the current generation built. Otherwise
    // the transition could re-open the provider against an already-
    // closed DB handle.
    try {
      await getTransition();
    } catch {
      // already logged inside the chain
    }
    await teardownAccount({ state: perAccount, logger, workspace, curator });
    try {
      db.close();
    } catch {
      // Already closed / corrupt — nothing we can do here.
    }
  };

  // Each domain object is already keyed by its AppComposition field names.
  return {
    edition,
    editionModules: modules,
    featureFlags,
    db,
    secrets,
    logger,
    accountService,
    mailDatabase: options.mailDatabase,
    getLlmSnapshot: () => llmRuntime.snapshot(),
    getLlmHealth: () => llmRuntime.health(),
    recordLlmFailure: (error) => llmRuntime.recordFailure(error),
    recordLlmSuccess: () => llmRuntime.recordSuccess(),
    onLlmChanged: (listener) => llmRuntime.onChanged(listener),
    onAiWorkerConcurrencyChanged: (listener) => {
      aiWorkerConcurrencyListeners.add(listener);
      return () => {
        aiWorkerConcurrencyListeners.delete(listener);
      };
    },
    notifyAiWorkerConcurrencyChanged: (concurrency) => {
      for (const listener of aiWorkerConcurrencyListeners) listener(concurrency);
    },
    mcp,
    channels,
    directoryRepository,
    directoryService,
    ...mail.public,
    ...(edition.features?.allowanceInvoice && modules.allowance
      ? { allowanceInvoiceRoutes: modules.allowance.buildInvoiceRoutes }
      : {}),
    mailAttachmentCache,
    mailDigestService,
    applicationMessages,
    messageArtifacts,
    insightReports,
    automationPreviews,
    automationRuleService,
    automationProviders,
    pipelineAutomationRuleService,
    unifiedAutomationQuery,
    automationRunObservability,
    canonicalAutomationDrafts,
    automationTemplates,
    configurationTasks,
    configurationWorkflow,
    automationAuthoring,
    automationAuthoringCoordinator,
    agentCapabilityCatalog,
    executionPipelines,
    skillCenter,
    skillPackages,
    skillImports,
    skillDrafts,
    pipelineDrafts,
    pipelinePreviews,
    ...system,
    aiUsage,
    ...intel,
    automationExecutionService,
    automationFields,
    mailSemanticAttributes,
    ...agentDomain,
    agentHomeSuggestions,
    resourceGovernor,
    onMailChanged,
    onMailCredentialInvalid,
    onAutomationAttention,
    reloadLlmSettings,
    workspace,
    curator,
    startCuratorTicker,
    stopCuratorTicker,
    stop,
  };
}
