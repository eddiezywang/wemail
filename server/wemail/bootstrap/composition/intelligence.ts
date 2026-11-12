/**
 * Long-lived intelligence, feedback, automation, todo, and settings
 * services used by the local API composition.
 */

import { AutomationRuleRepository } from "../../automation/AutomationRuleRepository.js";
import { RuleDryRunner } from "../../automation/RuleDryRunner.js";
import { RuleSuggester } from "../../automation/RuleSuggester.js";
import { LlmRuntime } from "../../ai/LlmRuntime.js";
import type { MailDatabase } from "../../database/Database.js";
import { AiFeedbackEventRepository } from "../../feedback/AiFeedbackEventRepository.js";
import { TagFeedbackRuleRepository } from "../../feedback/TagFeedbackRuleRepository.js";
import { IntelligenceOrchestrator } from "../../intelligence/IntelligenceOrchestrator.js";
import { IntelligenceResultRepository } from "../../intelligence/IntelligenceResultRepository.js";
import { IntelligenceService } from "../../intelligence/IntelligenceService.js";
import { EmailSmartTagRepository } from "../../intelligence/EmailSmartTagRepository.js";
import { SmartTagActionRepository } from "../../intelligence/SmartTagActionRepository.js";
import { SmartTagBackfillRepository } from "../../intelligence/SmartTagBackfillRepository.js";
import { SmartTagLearningRunRepository } from "../../intelligence/SmartTagLearningRunRepository.js";
import { SmartTagPromptLearningService } from "../../intelligence/SmartTagPromptLearningService.js";
import { SmartTagPromptCompiler } from "../../intelligence/SmartTagPromptCompiler.js";
import { SmartTagPromotionService } from "../../intelligence/SmartTagPromotionService.js";
import { SmartTagPromptRevisionRepository } from "../../intelligence/SmartTagPromptRevisionRepository.js";
import { UserTagRepository } from "../../intelligence/UserTagRepository.js";
import { TopicCandidateRepository } from "../../intelligence/TopicCandidateRepository.js";
import { ContentTopicService } from "../../intelligence/ContentTopicService.js";
import { SmartTagSuggestionService } from "../../intelligence/SmartTagSuggestionService.js";
import type { ApplicationMessageRepository } from "../../applicationMessages/ApplicationMessageRepository.js";
import type { DirectoryService } from "../../directory/DirectoryService.js";
import type { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import { JobRepository } from "../../queue/JobRepository.js";
import type { AuditLogService } from "../../telemetry/AuditLogService.js";
import { TodoRepository } from "../../todos/TodoRepository.js";
import { AiProfileSettingsService } from "./settings.js";
import type { WorkspaceComposition } from "./workspace.js";

export interface IntelligenceComposition {
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
  ruleSuggester: RuleSuggester;
  ruleDryRunner: RuleDryRunner;
  todos: TodoRepository;
  aiProfileService: AiProfileSettingsService;
  intelligenceService: IntelligenceService;
}

export function composeIntelligence(opts: {
  db: MailDatabase;
  mailRepository: CanonicalMailRepository;
  auditLogService: AuditLogService;
  /**
   * Lazy getter — the orchestrator is per-account so the long-lived
   * IntelligenceService cannot capture it directly.
   */
  getOrchestrator: () => IntelligenceOrchestrator | undefined;
  /** The sole runtime source for all LLM consumers. */
  llmRuntime: LlmRuntime;
  /**
   * Workspace composition. Its `routingSink` is handed to the SHARED
   * feedback repositories (TagFeedbackRuleRepository, TodoRepository)
   * so user accept/reject/complete/delete events are appended to the
   * per-account JSONL files (`feedback/tag-events.jsonl`,
   * `feedback/todo-events.jsonl`). The sink reads `event.accountId`
   * from the emitted payload to pick the right per-account dir.
   */
  workspace: WorkspaceComposition;
  applicationMessages: ApplicationMessageRepository;
  directoryService: DirectoryService;
}): IntelligenceComposition {
  const {
    db,
    mailRepository,
    auditLogService,
    getOrchestrator,
    llmRuntime,
    workspace,
  } = opts;

  const jobRepository = new JobRepository(db);
  const intelligenceResults = new IntelligenceResultRepository(db);
  const tagFeedback = new TagFeedbackRuleRepository(
    db,
    undefined,
    workspace.routingSink,
  );
  const aiFeedback = new AiFeedbackEventRepository({ db });
  const userTags = new UserTagRepository(db);
  const emailSmartTags = new EmailSmartTagRepository(db);
  const smartTagActions = new SmartTagActionRepository(db);
  const smartTagBackfills = new SmartTagBackfillRepository(db);
  const smartTagLearningRuns = new SmartTagLearningRunRepository(db);
  const smartTagPromptRevisions = new SmartTagPromptRevisionRepository(db);
  const topicCandidates = new TopicCandidateRepository(db);
  let smartTagSuggestions: SmartTagSuggestionService;
  const contentTopics = new ContentTopicService(topicCandidates, (accountId, topicId) => {
    smartTagSuggestions.evaluate(accountId, topicId);
  });
  smartTagSuggestions = new SmartTagSuggestionService({
    topics: topicCandidates,
    messages: opts.applicationMessages,
    userTags,
    mail: mailRepository,
    jobs: jobRepository,
    backfills: smartTagBackfills,
  });
  const aiProfileService = new AiProfileSettingsService(db);
  const smartTagPromptLearning = new SmartTagPromptLearningService({
    db,
    mail: mailRepository,
    userTags,
    emailSmartTags,
    results: intelligenceResults,
    actions: smartTagActions,
    runs: smartTagLearningRuns,
    backfills: smartTagBackfills,
    revisions: smartTagPromptRevisions,
    feedbackRules: tagFeedback,
    llmRuntime,
    getCustomInstructions: () => {
      try {
        return aiProfileService.getProfile()?.customInstructions ?? undefined;
      } catch {
        return undefined;
      }
    },
  });
  const smartTagPromptCompiler = new SmartTagPromptCompiler(llmRuntime);
  const smartTagPromotions = new SmartTagPromotionService({
    mail: mailRepository,
    results: intelligenceResults,
    topics: topicCandidates,
    llmRuntime,
  });
  const automationRules = new AutomationRuleRepository(db);
  const ruleDryRunner = new RuleDryRunner({
    mail: mailRepository,
    rules: automationRules,
    messageHasTag: (emailId, tagName) =>
      intelligenceResults.messageHasTag(emailId, tagName),
  });
  const ruleSuggester = new RuleSuggester({
    mail: mailRepository,
    llmRuntime,
  });
  const todos = new TodoRepository(db, undefined, workspace.routingSink);
  const aiProfile = aiProfileService.getProfile();
  const resolveMessage = (emailId: string): MailMessage | null => {
    return mailRepository.getMessageById(emailId);
  };

  const intelligenceService = new IntelligenceService({
    getOrchestrator,
    jobs: jobRepository,
    results: intelligenceResults,
    mail: mailRepository,
    feedbackRules: tagFeedback,
    aiFeedback,
    audit: auditLogService,
    todos,
    llmRuntime,
    resolveMessage,
    summaryLanguage:
      aiProfile?.defaultSummaryLanguage ?? aiProfile?.summaryLanguage,
    translationLanguage: aiProfile?.translationLanguage,
    composeLanguage: aiProfile?.composeLanguage,
    styleLookup: (styleId) => aiProfileService.getStyle(styleId),
    resolveComposeRecipient: async (accountId, query) => {
      const result = await opts.directoryService.searchContacts(accountId, query, { limit: 20 });
      const exact = result.contacts.filter((contact) =>
        contact.name.localeCompare(query.trim(), undefined, { sensitivity: "base" }) === 0 ||
        contact.email.localeCompare(query.trim(), undefined, { sensitivity: "base" }) === 0
      );
      const candidates = exact.length > 0 ? exact : result.contacts;
      if (candidates.length === 1) {
        const contact = candidates[0]!;
        return { status: "exact" as const, name: contact.name, email: contact.email };
      }
      if (candidates.length > 1) {
        return {
          status: "ambiguous" as const,
          candidates: candidates.slice(0, 10).map((contact) => ({
            name: contact.name,
            email: contact.email,
            departmentPath: contact.departmentPath,
            title: contact.title,
          })),
        };
      }
      return { status: result.remoteAvailable ? "not_found" as const : "unavailable" as const };
    },
  });

  return {
    jobRepository,
    intelligenceResults,
    tagFeedback,
    aiFeedback,
    userTags,
    emailSmartTags,
    smartTagActions,
    smartTagBackfills,
    smartTagLearningRuns,
    smartTagPromptRevisions,
    smartTagPromptLearning,
    smartTagPromptCompiler,
    smartTagPromotions,
    topicCandidates,
    contentTopics,
    smartTagSuggestions,
    automationRules,
    ruleSuggester,
    ruleDryRunner,
    todos,
    aiProfileService,
    intelligenceService,
  };
}
