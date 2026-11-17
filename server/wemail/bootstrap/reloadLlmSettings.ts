/**
 * Builds the `composition.reloadLlmSettings()` closure.
 *
 * Pulled out of `composeApp()` to keep the root focused on orchestration.
 * Shape mirrors the original inline closure exactly: persist new
 * settings → rebuild the LLM client → rebuild the PI agent delegate →
 * reconfigure the title generator → update the IntelligenceService LLM
 * status → hot-swap only the account intelligence runtime if active.
 */

import type { AccountService } from "../account/AccountService.js";
import { imapPasswordKey } from "../account/AccountTypes.js";
import type { AgentTitleGenerator } from "../agent/AgentTitleGenerator.js";
import type { IntelligenceService } from "../intelligence/IntelligenceService.js";
import type { SecretStore } from "../security/SecretStore.js";
import type {
  LlmRuntimeSettings,
  LlmSettingsService,
} from "../settings/LlmSettingsService.js";
import type { AiUsageRepository } from "../settings/AiUsageRepository.js";
import type { AppLogger } from "../telemetry/AppLogger.js";
import type { ComposeAppOverrides } from "./AppCompositionTypes.js";
import {
  buildPiAgentDelegate,
  type ReloadableAgentRuntime,
} from "./composition/agent.js";
import type { PromptSections } from "../agent/PiAgentRuntime.js";
import type { CuratorComposition } from "./composition/curator.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import type { PiSkillResources } from "../skill-center/PiSkillResources.js";

export interface ReloadLlmSettingsDeps {
  llmRuntime: LlmRuntime;
  llmSettingsService: LlmSettingsService;
  accountService: AccountService;
  secrets: SecretStore;
  overrides: ComposeAppOverrides;
  logger: AppLogger;
  aiUsage: AiUsageRepository;
  agent: ReloadableAgentRuntime;
  agentTitleGenerator: AgentTitleGenerator;
  intelligenceService: IntelligenceService;
  curator: CuratorComposition;
  reloadAccountIntelligence: (account: AccountConfig) => Promise<void>;
  skillResources?: PiSkillResources;
  skillsEnabled?: boolean;
  /** Edition-only prompt sections for the rebuilt PI delegate (P2 seam). */
  extraPromptSections?: PromptSections;
}

export function createReloadLlmSettings(
  deps: ReloadLlmSettingsDeps,
): (settings?: LlmRuntimeSettings) => Promise<void> {
  const {
    llmRuntime,
    llmSettingsService,
    accountService,
    secrets,
    overrides,
    logger,
    aiUsage,
    agent,
    intelligenceService,
    curator,
    reloadAccountIntelligence,
  } = deps;

  return async (
    settings: LlmRuntimeSettings | null = llmSettingsService.getRuntimeSettings(),
  ): Promise<void> => {
    const snapshot = llmRuntime.replace(settings);
    agent.setDelegate(
      buildPiAgentDelegate({
        llmSnapshot: snapshot,
        aiUsage,
        agentPlannerOverride: overrides.agentPlanner,
        piAgentFactory: overrides.piAgentFactory,
        skillPrompt: deps.skillsEnabled && deps.skillResources
          ? (context) => deps.skillResources?.formatPrompt(context) ?? ""
          : undefined,
        extraPromptSections: deps.extraPromptSections,
      }),
    );
    curator.clearAll();

    const account = accountService.getCurrentAccount();
    if (account && secrets.getSecret(imapPasswordKey(account.id))) {
      await reloadAccountIntelligence(account);
    }
  };
}
