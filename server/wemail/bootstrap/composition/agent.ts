/**
 * Agent-domain composition: conversation persistence, the title
 * generator, the pending-action repository, the WeCLI skill runtime,
 * and the reloadable PI agent wrapper.
 *
 * The runtime itself is wrapped in `ReloadableAgentRuntime` so that
 * `composition.reloadLlmSettings()` in the root can swap the PI delegate
 * without invalidating tool registrations the renderer already holds
 * references to.
 */

import path from "node:path";
import { AgentConversationRepository } from "../../agent/AgentConversationRepository.js";
import { AgentPendingActionRepository } from "../../agent/AgentPendingActionRepository.js";
import { AgentAttachmentStore } from "../../agent/AgentAttachmentStore.js";
import { AgentLearningLedger } from "../../agent/AgentLearningLedger.js";
import { AgentTitleGenerator } from "../../agent/AgentTitleGenerator.js";
import { AgentRunRepository } from "../../agent/AgentRunRepository.js";
import { AgentEventPersistence } from "../../agent/AgentEventPersistence.js";
import { AgentRunCoordinator } from "../../agent/AgentRunCoordinator.js";
import type {
  ActionExecutionPort,
  AllowanceInvoicePort,
  EditionAllowanceModules,
} from "../../agent/allowancePort.js";
import { MailActionExecutor } from "../../agent/MailActionExecutor.js";
import type { AgentActionExecutionResult } from "../../agent/AgentActionExecutor.js";
import type {
  AgentEvent,
  AgentRunInput,
  AgentRuntime,
  AgentTool,
} from "../../agent/AgentRuntime.js";
import { createMailAgentTools } from "../../agent/MailAgentTools.js";
import {
  createWemailAgentTools,
  type DirectoryToolService,
} from "../../agent/WemailAgentTools.js";
import {
  PiAgentRuntime,
  type AgentPlanner,
  type PiAgentFactory,
  type PromptSections,
} from "../../agent/PiAgentRuntime.js";
import type { LlmClient } from "../../ai/LlmClient.js";
import type { LlmRuntime, LlmRuntimeSnapshot } from "../../ai/LlmRuntime.js";
import type { MailDatabase } from "../../database/Database.js";
import type { MailDatabaseClient } from "../../database/MailDatabaseClient.js";
import type { IntelligenceService } from "../../intelligence/IntelligenceService.js";
import type { FetchAttachmentResult, MailProvider } from "../../mail/MailProvider.js";
import type { InvoiceStatusPort } from "../../agent/allowancePort.js";
import type { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import {
  OPEN_WECLI_CLASSIFIER,
  OPEN_WECLI_RUNTIME,
  OPEN_WECLI_TOKENIZER,
  type EditionWecliModules,
  type WecliRuntimePort,
} from "../../skills/wecliPort.js";
import type { WecliRunner } from "../../../../shared/wemail/wecliTypes.js";
import type { LlmRuntimeSettings } from "../../settings/LlmSettingsService.js";
import type { AppLogger } from "../../telemetry/AppLogger.js";
import type { AuditLogRepository } from "../../telemetry/AuditLogRepository.js";
import type { AuditLogService } from "../../telemetry/AuditLogService.js";
import { piConfigForLane, type LlmProviderConfig } from "./settings.js";
import type { CuratorComposition } from "./curator.js";
import type { AutomationRuleRepository } from "../../automation/AutomationRuleRepository.js";
import type { AutomationDeferredExecutionRepository } from "../../automation/AutomationDeferredExecutionRepository.js";
import type { RuleDryRunner } from "../../automation/RuleDryRunner.js";
import type { UserTagRepository } from "../../intelligence/UserTagRepository.js";
import type { SmartTagPromptCompiler } from "../../intelligence/SmartTagPromptCompiler.js";
import type { IntelligenceResultRepository } from "../../intelligence/IntelligenceResultRepository.js";
import type { EmailSmartTagRepository } from "../../intelligence/EmailSmartTagRepository.js";
import type { ScheduledSendService } from "../../mail/ScheduledSendService.js";
import type { SnoozeService } from "../../mail/SnoozeService.js";
import type { TodoRepository } from "../../todos/TodoRepository.js";
import { AiProfileSettingsService } from "../../settings/AiProfileSettingsService.js";
import { BusinessPreferenceService } from "../../settings/BusinessPreferenceService.js";
import type { ConfigurationWorkflowService } from "../../configuration/ConfigurationWorkflowService.js";
import type { AutomationAuthoringAgentService } from "../../configuration/AutomationAuthoringAgentService.js";
import type { AgentArtifactDeliveryService } from "../../design/AgentArtifactDeliveryService.js";
import type { SkillSnapshot } from "../../../../shared/wemail/skillCenter.js";
import type { SkillDraftService } from "../../skill-center/SkillDraftService.js";
import type { PiSkillResources } from "../../skill-center/PiSkillResources.js";
import { ClaudeCodeTaskService } from "../../agent/ClaudeCodeRuntime.js";
import { createClaudeCodeAgentTools } from "../../agent/ClaudeCodeTools.js";

/**
 * Stub planner used when no LLM is configured. The agent routes still
 * mount, but `step` always returns a `final` apology so the app fails
 * gracefully instead of throwing at construction time.
 */
export function createStubPlanner(): AgentPlanner {
  return {
    async step() {
      return {
        kind: "final",
        text: "The agent is not configured — no LLM provider is wired up. Configure a model in settings to enable PI.",
      };
    },
  };
}

/**
 * AgentRuntime adapter that lets us swap the underlying delegate
 * (re-built when LLM settings change) without losing the tools that
 * were registered against it. Tool registrations are remembered and
 * replayed onto the new delegate.
 */
export class ReloadableAgentRuntime implements AgentRuntime {
  private delegate: AgentRuntime;
  private readonly tools = new Map<string, AgentTool>();

  constructor(delegate: AgentRuntime) {
    this.delegate = delegate;
  }

  setDelegate(delegate: AgentRuntime): void {
    this.delegate = delegate;
    for (const tool of this.tools.values()) {
      this.delegate.registerTool(tool);
    }
  }

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent, void, unknown> {
    yield* this.delegate.run(input);
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
    this.delegate.registerTool(tool);
  }

  listTools() {
    return this.delegate.listTools();
  }
}

export interface BuildAgentRuntimeOptions {
  llmSnapshot: LlmRuntimeSnapshot;
  aiUsage: AiUsageRepository;
  agentPlannerOverride?: AgentPlanner;
  piAgentFactory?: PiAgentFactory;
  skillPrompt?: (context: Record<string, unknown> | undefined) => string;
  /** Edition-only prompt sections appended to the PI system prompt. */
  extraPromptSections?: PromptSections;
}

/**
 * Build a fresh PiAgentRuntime delegate using the current LLM state.
 * Mirrors the original `buildAgentRuntime()` closure: planner override
 * wins, then a configured LLM with PI factory, then a bare LLM, then
 * the stub planner so unconfigured boots succeed.
 */
export function buildPiAgentDelegate(
  options: BuildAgentRuntimeOptions,
): PiAgentRuntime {
  const {
    llmSnapshot,
    aiUsage,
    agentPlannerOverride,
    piAgentFactory,
  } = options;
  if (agentPlannerOverride) {
    return new PiAgentRuntime({
      planner: agentPlannerOverride,
      skillPrompt: options.skillPrompt,
      extraPromptSections: options.extraPromptSections,
    });
  }
  if (llmSnapshot.config) {
    return new PiAgentRuntime({
      llm: llmSnapshot.client,
      pi: piConfigForLane(llmSnapshot.config, llmSnapshot.settings),
      piAgentFactory,
      usage: aiUsage,
      skillPrompt: options.skillPrompt,
      extraPromptSections: options.extraPromptSections,
    });
  }
  if (llmSnapshot.client) {
    return new PiAgentRuntime({
      llm: llmSnapshot.client,
      usage: aiUsage,
      skillPrompt: options.skillPrompt,
      extraPromptSections: options.extraPromptSections,
    });
  }
  return new PiAgentRuntime({
    planner: createStubPlanner(),
    skillPrompt: options.skillPrompt,
    extraPromptSections: options.extraPromptSections,
  });
}

export interface AgentComposition {
  agentConversations: AgentConversationRepository;
  agentRuns: AgentRunRepository;
  agentEventPersistence: AgentEventPersistence;
  agentRunCoordinator: AgentRunCoordinator;
  agentTitleGenerator: AgentTitleGenerator;
  pendingActions: AgentPendingActionRepository;
  agentAttachments: AgentAttachmentStore;
  agentLearning: AgentLearningLedger;
  wecli: WecliRuntimePort;
  claudeCode: ClaudeCodeTaskService;
  agent: ReloadableAgentRuntime;
  mailActionExecutor: MailActionExecutor;
  /**
   * P2.6: edition-supplied allowance service. Undefined in the open
   * edition — `AutomationActionExecutor`'s late-bound ref then reports
   * `allowance-not-wired` and no invoice tool/route exists.
   */
  allowance: AllowanceInvoicePort | undefined;
  /** Durable upload executor; undefined in the open edition. */
  actionExecutions: ActionExecutionPort | undefined;
}

export interface ComposeAgentOptions {
  db: MailDatabase;
  dataDir: string;
  logger: AppLogger;
  auditLog: AuditLogRepository;
  auditLogService: AuditLogService;
  mailDatabase: MailDatabaseClient;
  invoiceStatuses?: InvoiceStatusPort;
  /**
   * Edition allowance module bundle (P2.6). Absent in the open edition: no
   * allowance service / durable executor is constructed, the three
   * allowance agent tools stay unregistered and no invoice routes mount.
   */
  allowanceModules?: EditionAllowanceModules;
  /** Gate the allowance agent tools on both the feature flag and the module. */
  allowanceToolsEnabled?: boolean;
  /**
   * Resolves to the active per-account MailProvider, or undefined when
   * no account is logged in. The MailActionExecutor closes over this so
   * a logout/login cycle is observed on the next confirmed action.
   */
  getMailProvider: () => MailProvider | undefined;
  /** Fetches attachment bytes through the Mail Core gateway. */
  fetchAttachment?: (
    emailId: string,
    attachmentId: string,
    accountId?: string,
  ) => Promise<FetchAttachmentResult | null>;
  intelligenceService: IntelligenceService;
  aiUsage: AiUsageRepository;
  /**
   * Boot-time LLM client + config snapshot. The PI delegate inside
   * `ReloadableAgentRuntime` IS rebuilt on `reloadLlmSettings()` (via
   * `agent.setDelegate(buildPiAgentDelegate(...))`), but the
   * `AgentTitleGenerator` is patched via its `configure(...)` method
   * rather than re-instantiated. Either path is observed on the next
   * call after settings change.
   */
  llmRuntime: LlmRuntime;
  agentPlannerOverride?: AgentPlanner;
  piAgentFactory?: PiAgentFactory;
  wecliRunner?: WecliRunner;
  /**
   * Edition WeCLI module bundle (P2.5). Absent in the open edition: the
   * runtime is a non-functional port, no wecli_* agent tools register and
   * no installer is wired into the confirmed-action executor.
   */
  wecliModules?: EditionWecliModules;
  /** Gate the wecli_* agent tools on both the feature flag and the module. */
  wecliToolsEnabled?: boolean;
  /**
   * Curator composition (Route C / WP J.8). When wired, the chat agent
   * registers the `run_curator` tool so the user can ask for an
   * immediate workspace refresh without leaving the chat lane.
   */
  curator?: CuratorComposition;
  /** Resolves to the active account id; required to use {@link curator}. */
  getActiveAccountId?: () => string | undefined;
  automationRules: AutomationRuleRepository;
  deferredExecutions: AutomationDeferredExecutionRepository;
  ruleDryRunner: RuleDryRunner;
  automationRuleService?: import("../../automation/AutomationRuleService.js").AutomationRuleService;
  automationProviders?: import("../../automation/providers/AutomationProviderRegistry.js").AutomationProviderRegistry;
  pipelineAutomationRuleService?: import("../../automation/PipelineAutomationRuleService.js").PipelineAutomationRuleService;
  configurationWorkflow?: ConfigurationWorkflowService;
  automationAuthoring?: AutomationAuthoringAgentService;
  artifactDelivery?: AgentArtifactDeliveryService;
  skillDrafts?: SkillDraftService;
  skillResources?: PiSkillResources;
  skillsEnabled?: boolean;
  resolveSkillSnapshots?: (
    context: Record<string, unknown> | undefined,
  ) => SkillSnapshot[];
  userTags: UserTagRepository;
  smartTagPromptCompiler?: SmartTagPromptCompiler;
  intelligenceResults: IntelligenceResultRepository;
  todos: TodoRepository;
  emailSmartTags: EmailSmartTagRepository;
  scheduledSend: ScheduledSendService;
  snooze: SnoozeService;
  directoryService: DirectoryToolService;
  /** Edition switch: register the six directory tools only when the internal
   *  directory module is assembled and its feature flag is on. */
  directoryToolsEnabled?: boolean;
  onSmartTagConfigurationChanged?: (accountId: string) => void;
  runAutomationRule?: (ruleId: string) => Promise<AgentActionExecutionResult>;
  /** Edition-injected signature brand link; empty = plain-text footer. */
  signatureBrandUrl?: string;
  /**
   * Edition-only prompt sections appended to the PI agent system prompt
   * (P2 module seam; threaded to every PI delegate rebuild).
   */
  extraPromptSections?: PromptSections;
}

export function composeAgent(options: ComposeAgentOptions): AgentComposition {
  const {
    db,
    dataDir,
    logger,
    auditLog,
    auditLogService,
    invoiceStatuses,
    getMailProvider,
    intelligenceService,
    aiUsage,
    llmRuntime,
    agentPlannerOverride,
    piAgentFactory,
    wecliRunner,
    curator,
    getActiveAccountId,
    automationRules,
    deferredExecutions,
    ruleDryRunner,
    automationRuleService,
    pipelineAutomationRuleService,
    configurationWorkflow,
    automationAuthoring,
    artifactDelivery,
    userTags,
    smartTagPromptCompiler,
    intelligenceResults,
    todos,
    emailSmartTags,
    scheduledSend,
    snooze,
    directoryService,
    onSmartTagConfigurationChanged,
    runAutomationRule,
  } = options;
  const llmSnapshot = llmRuntime.snapshot();

  const agentConversations = new AgentConversationRepository(db);
  const agentRuns = new AgentRunRepository(db);
  const agentEventPersistence = new AgentEventPersistence(agentRuns);
  const agentRunCoordinator = new AgentRunCoordinator(agentRuns, 2);
  agentRunCoordinator.reconcileStartup();
  const agentTitleGenerator = new AgentTitleGenerator({
    conversations: agentConversations,
    llmRuntime,
    logger: {
      warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
    },
  });
  const pendingActions = new AgentPendingActionRepository({ db });
  const agentAttachments = new AgentAttachmentStore(
    db,
    path.join(dataDir, "agent-attachments"),
  );
  const agentLearning = new AgentLearningLedger(db);
  const aiProfile = new AiProfileSettingsService(db);
  const businessPreferences = new BusinessPreferenceService(db);
  // P2.5: the runtime is edition-supplied. The open edition keeps a typed
  // non-functional port so the generic allowance/action seams still compile.
  const wecliModules = options.wecliModules;
  const wecli: WecliRuntimePort = wecliModules
    ? wecliModules.createRuntime({
        audit: options.mailDatabase.actionExecution ? {
          async record(entry) {
            const result = await options.mailDatabase.actionExecution!({ op: "audit", entry: {
              ...entry, stdout: entry.stdout?.slice(0, 131072), stderr: entry.stderr?.slice(0, 131072),
            } });
            if (!result || typeof result !== "object" || !("classification" in result)) throw new Error("wecli-audit-not-persisted");
            return result;
          },
        } : auditLog,
        ...(wecliRunner ? { runner: wecliRunner } : {}),
      })
    : OPEN_WECLI_RUNTIME;
  const claudeCode = new ClaudeCodeTaskService({
    dataDir,
    logger,
  });
  // P2.6: the allowance/invoice services are edition modules. The open
  // edition constructs neither; every consumer falls back to its generic
  // "not wired" behavior (typed error, unregistered tools, no routes).
  const allowance: AllowanceInvoicePort | undefined =
    options.allowanceModules?.createInvoiceService({
      mailDatabase: options.mailDatabase,
      wecli,
      rootDir: path.join(dataDir, "wecli-attachments"),
      fetchAttachment: options.fetchAttachment ?? ((emailId, attachmentId) => {
        const p = getMailProvider();
        if (!p?.fetchAttachment) throw new Error("attachment fetch not supported");
        return p.fetchAttachment(emailId, attachmentId);
      }),
    });
  const actionExecutions: ActionExecutionPort | undefined =
    options.allowanceModules && allowance
      ? options.allowanceModules.createActionExecutions({
          mailDatabase: options.mailDatabase,
          allowance,
          onError: (error) => logger.warn("agent.actionExecution.failed", { error: error instanceof Error ? error.message : String(error) }),
        })
      : undefined;

  const agent = new ReloadableAgentRuntime(
    buildPiAgentDelegate({
      llmSnapshot,
      aiUsage,
      agentPlannerOverride,
      piAgentFactory,
      skillPrompt: options.skillsEnabled && options.skillResources
        ? (context) => options.skillResources!.formatPrompt(context)
        : undefined,
      extraPromptSections: options.extraPromptSections,
    }),
  );
  if (options.skillsEnabled && options.skillResources) {
    agent.registerTool(options.skillResources.createReadTool());
  }
  for (const tool of createClaudeCodeAgentTools(claudeCode)) {
    agent.registerTool(tool);
  }
  for (const tool of createMailAgentTools({
    mailDatabase: options.mailDatabase,
    intelligenceService,
    wecli,
    classify: wecliModules?.classifier ?? OPEN_WECLI_CLASSIFIER,
    tokenize: wecliModules?.tokenize ?? OPEN_WECLI_TOKENIZER,
    wecliInstallRequest: wecliModules?.installRequest,
    wecliToolsEnabled: options.wecliToolsEnabled === true,
    ...(allowance ? { allowance } : {}),
    allowanceToolsEnabled: options.allowanceToolsEnabled === true,
    pendingActionRepo: pendingActions,
    ...(curator ? { curator: curator.scheduler } : {}),
    ...(getActiveAccountId ? { getActiveAccountId } : {}),
  })) {
    agent.registerTool(tool);
  }
  for (const tool of createWemailAgentTools({
    rules: automationRules,
    dryRunner: ruleDryRunner,
    ruleService: automationRuleService,
    providers: options.automationProviders,
    pipelineRuleService: options.pipelineAutomationRuleService,
    configurationWorkflow,
    automationAuthoring,
    artifactDelivery,
    userTags,
    pendingActions,
    getActiveAccountId,
    mailDatabase: options.mailDatabase,
    emailSmartTags,
    scheduledSend,
    snooze,
    aiProfile,
    businessPreferences,
    directoryService,
    directoryToolsEnabled: options.directoryToolsEnabled,
    // P2.6 round-up: the automation adapter descriptions gate on the same
    // pair MailAgentTools' allowance tools receive — feature && module flag
    // plus this composition's service (built from `options.allowanceModules`
    // above), so a composition override can no longer diverge from the
    // description text.
    ...(allowance ? { allowance } : {}),
    allowanceToolsEnabled: options.allowanceToolsEnabled === true,
  })) {
    agent.registerTool(tool);
  }

  // MailProvider proxy that forwards every call to the per-account
  // provider resolved at request time. Keeps the executor a singleton
  // even though the underlying provider is rebuilt on login/logout.
  const providerProxy: MailProvider = {
    connect: () => getMailProvider()?.connect() ?? Promise.resolve(),
    disconnect: () => getMailProvider()?.disconnect() ?? Promise.resolve(),
    syncRecent: (limit) => {
      const p = getMailProvider();
      if (!p) throw new Error("mail provider not configured");
      return p.syncRecent(limit);
    },
    syncSince: (since) => {
      const p = getMailProvider();
      if (!p) throw new Error("mail provider not configured");
      return p.syncSince(since);
    },
    getMessage: (id) => {
      const p = getMailProvider();
      if (!p) throw new Error("mail provider not configured");
      return p.getMessage(id);
    },
    fetchAttachment: (emailId, partId) => {
      const p = getMailProvider();
      if (!p?.fetchAttachment) throw new Error("attachment fetch not supported");
      return p.fetchAttachment(emailId, partId);
    },
    sendDraft: (draft) => {
      const p = getMailProvider();
      if (!p) throw new Error("mail provider not configured");
      return p.sendDraft(draft);
    },
  };

  const mailActionExecutor = new MailActionExecutor({
    mailProvider: providerProxy,
    mailDatabase: options.mailDatabase,
    directoryService,
    audit: auditLogService,
    ...(allowance ? { allowance } : {}),
    // P2.6 round 8: platform delete-command assembly / receipt parsing are
    // edition contributions; the open edition runs this seam fail-closed.
    ...(options.allowanceModules?.platformCommands
      ? { allowancePlatformCommands: options.allowanceModules.platformCommands }
      : {}),
    wecli,
    tokenize: wecliModules?.tokenize ?? OPEN_WECLI_TOKENIZER,
    ...(wecliModules
      ? {
          wecliInstaller: wecliModules.createInstaller(),
          wecliInstallRequest: wecliModules.installRequest,
        }
      : {}),
    invoiceStatuses,
    automationRules,
    automationRuleService,
    pipelineAutomationRuleService,
    configurationWorkflow,
    deferredExecutions,
    userTags,
    smartTagPromptCompiler,
    intelligenceResults,
    emailSmartTags,
    scheduledSend,
    aiProfile,
    businessPreferences,
    onSmartTagConfigurationChanged,
    getUnsubscribeUrl: (emailId) => intelligenceService.getUnsubscribeUrl(emailId),
    runAutomationRule,
    signatureBrandUrl: options.signatureBrandUrl,
  });

  return {
    agentConversations,
    agentRuns,
    agentEventPersistence,
    agentRunCoordinator,
    agentTitleGenerator,
    pendingActions,
    agentAttachments,
    agentLearning,
    wecli,
    claudeCode,
    agent,
    mailActionExecutor,
    allowance,
    actionExecutions,
  };
}
