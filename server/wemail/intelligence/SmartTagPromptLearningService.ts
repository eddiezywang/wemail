import { createHash, randomUUID } from "node:crypto";
import type { IntelligenceJob, TagResult } from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import {
  SMART_TAG_CANDIDATE_SCHEMA,
  SMART_TAG_CANDIDATE_SYSTEM_PROMPT,
  SMART_TAG_EVIDENCE_SCHEMA,
  SMART_TAG_EVIDENCE_SYSTEM_PROMPT,
  buildSmartTagCandidateMessage,
  buildSmartTagEvidenceMessage,
  parseSmartTagCandidate,
  parseSmartTagEvidence,
  smartTagOptimizationBody,
  type SmartTagOptimizationSample,
} from "../ai/prompts/smartTagOptimizerPrompt.js";
import type { MailDatabase } from "../database/Database.js";
import type { TagFeedbackRuleRepository } from "../feedback/TagFeedbackRuleRepository.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { EmailSmartTagRepository } from "./EmailSmartTagRepository.js";
import type { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";
import type {
  SmartTagActionRecord,
  SmartTagActionRepository,
} from "./SmartTagActionRepository.js";
import type { SmartTagBackfillRepository } from "./SmartTagBackfillRepository.js";
import type {
  SmartTagLearningRunRepository,
  SmartTagLearningSampleSplit,
} from "./SmartTagLearningRunRepository.js";
import type { SmartTagPromptRevisionRepository } from "./SmartTagPromptRevisionRepository.js";
import {
  smartTagPromptHash,
  type UserTag,
  type UserTagRepository,
} from "./UserTagRepository.js";
import { TagProcessor } from "./processors/TagProcessor.js";

export interface SmartTagPromptLearningServiceDeps {
  db: MailDatabase;
  mail: CanonicalMailRepository;
  userTags: UserTagRepository;
  emailSmartTags: EmailSmartTagRepository;
  results: IntelligenceResultRepository;
  actions: SmartTagActionRepository;
  runs: SmartTagLearningRunRepository;
  backfills: SmartTagBackfillRepository;
  revisions: SmartTagPromptRevisionRepository;
  feedbackRules: TagFeedbackRuleRepository;
  llmRuntime: LlmRuntime;
  getCustomInstructions?: () => string | undefined;
  now?: () => Date;
  logger?: (event: string, fields: Record<string, string | number>) => void;
  config?: Partial<SmartTagLearningConfig>;
}

export interface SmartTagLearningConfig {
  maximumSamples: number;
  evidenceChunkSize: number;
  evaluationTimeoutMs: number;
  targetedBatchSize: number;
}

export interface SmartTagPromptLearningResult {
  updatedTags: number;
  processedActions: number;
  activatedRuns: number;
  rejectedRuns: number;
  failedRuns: number;
}

interface ResolvedSample {
  action: SmartTagActionRecord;
  mail: MailMessage;
  split: SmartTagLearningSampleSplit;
  isNewFeedback: boolean;
}

interface ClassificationOutcome {
  matched: boolean;
  confidence?: number;
}

interface EvaluationMetrics {
  currentCorrect: number;
  candidateCorrect: number;
  correctedCount: number;
  regressionCount: number;
}

const DEFAULT_CONFIG: SmartTagLearningConfig = {
  maximumSamples: 200,
  evidenceChunkSize: 10,
  evaluationTimeoutMs: 25_000,
  targetedBatchSize: 20,
};

const FORBIDDEN_CANDIDATE_PATTERNS = [
  /用户移入/i,
  /用户移出/i,
  /自动学习补充/i,
  /训练样本/i,
  /反馈记录/i,
  /ignore (all |any )?(previous|system)/i,
  /system prompt/i,
  /json schema/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

export class SmartTagPromptLearningService {
  private readonly now: () => Date;
  private readonly logger: (event: string, fields: Record<string, string | number>) => void;
  private readonly config: SmartTagLearningConfig;
  private readonly workerId = `smart-tag-learning-${randomUUID()}`;

  constructor(private readonly deps: SmartTagPromptLearningServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? (() => {});
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
  }

  async processAccount(accountId: string): Promise<SmartTagPromptLearningResult> {
    const result: SmartTagPromptLearningResult = {
      updatedTags: 0,
      processedActions: 0,
      activatedRuns: 0,
      rejectedRuns: 0,
      failedRuns: 0,
    };
    const snapshot = this.deps.llmRuntime.snapshot();
    const client = snapshot.client;
    const model = snapshot.modelFor("summary");
    if (!client || !model) return result;
    this.deps.runs.expireLeases(accountId, this.now().toISOString());

    for (const tag of this.deps.userTags.listByAccount(accountId)) {
      const latestRun = this.deps.runs.getLatestForTag(accountId, tag.id);
      if (latestRun?.status === "generating" || latestRun?.status === "evaluating") {
        continue;
      }
      const pendingActions = this.deps.actions.listUnprocessedByTag({
        accountId,
        tagId: tag.id,
        limit: this.config.maximumSamples,
      });
      if (pendingActions.length === 0) continue;
      const latestByMessage = new Map<string, SmartTagActionRecord>();
      for (const action of pendingActions) latestByMessage.set(action.emailId, action);
      const actions = [...latestByMessage.values()];

      try {
        const outcome = await this.processTag({
          accountId,
          tag,
          allTags: this.deps.userTags.listByAccount(accountId),
          actions,
          modelGeneration: snapshot.generation,
          model,
        });
        result.processedActions += outcome.processedActions;
        if (outcome.status === "activated" || outcome.status === "rejected") {
          this.deps.actions.markProcessed(pendingActions.map((action) => action.id));
        }
        if (outcome.status === "activated") {
          result.updatedTags += 1;
          result.activatedRuns += 1;
        } else if (outcome.status === "rejected") {
          result.rejectedRuns += 1;
        } else if (outcome.status === "failed") {
          result.failedRuns += 1;
        }
      } catch (error) {
        result.failedRuns += 1;
        this.logger("smart-tags.learning.tag-failed", {
          tagId: tag.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async processTargetedRetagging(accountId: string): Promise<{
    processed: number;
    failed: number;
  }> {
    const result = { processed: 0, failed: 0 };
    const snapshot = this.deps.llmRuntime.snapshot();
    const client = snapshot.client;
    const model = snapshot.modelFor("summary");
    if (!client || !model) return result;
    const allTags = this.deps.userTags.listByAccount(accountId);

    for (const run of this.deps.backfills.listRunningTargeted(accountId)) {
      const tag = allTags.find((candidate) => candidate.id === run.targetTagId);
      if (!tag || smartTagPromptHash(tag.effectivePrompt) !== run.promptVersion) {
        this.deps.backfills.fail(run.id, "target-tag-or-prompt-version-missing");
        continue;
      }
      const items = this.deps.backfills.listPendingTargetedItems(
        run.id,
        this.config.targetedBatchSize,
      );
      for (const item of items) {
        const mail = this.deps.mail.getMessageById(item.emailId, accountId);
        if (!mail) {
          this.deps.backfills.recordTargetedItem({
            runId: run.id,
            emailId: item.emailId,
            outcome: "failed",
            errorCode: "mail-missing",
          });
          result.failed += 1;
          continue;
        }
        try {
          const classified = await this.classify({
            mail,
            targetTag: tag,
            allTags,
            prompt: tag.effectivePrompt,
            model,
            feedbackMode: "apply",
          });
          const relation = this.deps.emailSmartTags.get(item.emailId, tag.id);
          if (classified.matched) {
            if (relation?.source === "ai") {
              const write = this.deps.db.transaction(() => {
                this.deps.emailSmartTags.upsert({
                  accountId,
                  emailId: item.emailId,
                  userTagId: tag.id,
                  source: "ai",
                  confidence: classified.confidence,
                });
                this.deps.results.upsertAiTagToMessage(
                  item.emailId,
                  tag.name,
                  classified.confidence ?? 0,
                );
              });
              write();
            }
            this.deps.backfills.recordTargetedItem({
              runId: run.id,
              emailId: item.emailId,
              matched: true,
              confidence: classified.confidence,
              outcome: "retained",
            });
          } else if (relation?.source === "ai") {
            const write = this.deps.db.transaction(() => {
              this.deps.emailSmartTags.remove(item.emailId, tag.id);
              this.deps.results.removeTagFromMessage(item.emailId, tag.name);
            });
            write();
            this.deps.backfills.recordTargetedItem({
              runId: run.id,
              emailId: item.emailId,
              matched: false,
              outcome: "removed",
            });
          } else {
            this.deps.backfills.recordTargetedItem({
              runId: run.id,
              emailId: item.emailId,
              matched: false,
              outcome: "retained",
            });
          }
          result.processed += 1;
        } catch (error) {
          this.deps.backfills.recordTargetedItem({
            runId: run.id,
            emailId: item.emailId,
            outcome: "failed",
            errorCode: shortErrorCode(error),
          });
          result.failed += 1;
        }
      }
    }
    return result;
  }

  private async processTag(input: {
    accountId: string;
    tag: UserTag;
    allTags: UserTag[];
    actions: SmartTagActionRecord[];
    modelGeneration: number;
    model: string;
  }): Promise<{
    status: "activated" | "rejected" | "failed" | "stale";
    processedActions: number;
  }> {
    const valid = input.actions.flatMap((action) => {
      const mail = this.deps.mail.getMessageById(action.emailId, input.accountId);
      if (!mail || smartTagOptimizationBody(mail).length === 0) return [];
      return [{ action, mail }];
    });
    const split = splitSmartTagSamples(valid, input.tag.id);
    if (!split) return { status: "rejected", processedActions: input.actions.length };
    const samples: ResolvedSample[] = split.map((sample) => ({
      ...sample,
      isNewFeedback: true,
    }));
    const positiveCount = samples.filter((sample) => sample.action.actionType === "apply").length;
    const negativeCount = samples.length - positiveCount;
    const optimizationCount = samples.filter((sample) => sample.split === "optimization").length;
    const validationCount = samples.length - optimizationCount;
    const run = this.deps.runs.create({
      accountId: input.accountId,
      tagId: input.tag.id,
      tagName: input.tag.name,
      sourcePromptHash: smartTagPromptHash(input.tag.prompt),
      activePromptHash: smartTagPromptHash(input.tag.effectivePrompt),
      modelGeneration: input.modelGeneration,
      model: input.model,
      sampleCount: samples.length,
      positiveCount,
      negativeCount,
      optimizationCount,
      validationCount,
      leaseOwner: this.workerId,
      leaseUntil: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    for (const sample of samples) {
      this.deps.runs.addSample({
        runId: run.id,
        actionId: sample.action.id,
        emailId: sample.mail.id,
        split: sample.split,
        expectedAction: sample.action.actionType,
        isNewFeedback: sample.isNewFeedback,
      });
    }

    try {
      const candidate = await this.generateCandidate(input.tag, samples, input.model);
      const candidateError = validateCandidatePrompt(
        candidate.candidatePrompt,
        input.tag.effectivePrompt,
      );
      if (candidateError) {
        this.deps.runs.finish({ id: run.id, status: "rejected", reason: candidateError });
        return { status: "rejected", processedActions: samples.length };
      }
      this.deps.runs.setCandidate({
        id: run.id,
        prompt: candidate.candidatePrompt,
        summary: {
          positiveSignals: candidate.positiveSignals,
          negativeSignals: candidate.negativeSignals,
          ignoredSignals: candidate.ignoredSignals,
        },
      });

      const validation = samples.filter((sample) => sample.split === "validation");
      const evaluationSamples = validation.length > 0 ? validation : samples;
      const metrics = await this.evaluateValidation({
        runId: run.id,
        samples: evaluationSamples,
        targetTag: input.tag,
        allTags: input.allTags,
        candidatePrompt: candidate.candidatePrompt,
        model: input.model,
      });
      const fullCandidate = await this.evaluateCandidateForSamples({
        runId: run.id,
        samples,
        targetTag: input.tag,
        allTags: input.allTags,
        candidatePrompt: candidate.candidatePrompt,
        model: input.model,
      });
      const newFeedbackCorrect = samples
        .filter((sample) => sample.isNewFeedback)
        .every((sample) => isExpected(
          fullCandidate.get(sample.mail.id)?.matched ?? false,
          sample.action.actionType,
        ));
      if (
        metrics.correctedCount < 1
        || metrics.regressionCount > 0
        || !newFeedbackCorrect
      ) {
        this.deps.runs.finish({
          id: run.id,
          status: "rejected",
          reason: !newFeedbackCorrect
            ? "new-feedback-not-fully-corrected"
            : metrics.regressionCount > 0
              ? "candidate-regression"
              : "candidate-no-improvement",
          ...metrics,
        });
        return { status: "rejected", processedActions: samples.length };
      }

      const confirmationTargets = samples.filter(
        (sample) => sample.isNewFeedback || sample.split === "validation",
      );
      const confirmation = await this.evaluateCandidateForSamples({
        runId: run.id,
        samples: confirmationTargets,
        targetTag: input.tag,
        allTags: input.allTags,
        candidatePrompt: candidate.candidatePrompt,
        model: input.model,
        confirmation: true,
      });
      const confirmed = confirmationTargets.every((sample) => isExpected(
        confirmation.get(sample.mail.id)?.matched ?? false,
        sample.action.actionType,
      ));
      if (!confirmed) {
        this.deps.runs.finish({
          id: run.id,
          status: "rejected",
          reason: "candidate-confirmation-unstable",
          ...metrics,
        });
        return { status: "rejected", processedActions: samples.length };
      }

      const currentSnapshot = this.deps.llmRuntime.snapshot();
      const currentTag = this.deps.userTags.getById(input.tag.id);
      if (
        currentSnapshot.generation !== input.modelGeneration
        || currentSnapshot.modelFor("summary") !== input.model
        || !currentTag
        || smartTagPromptHash(currentTag.prompt) !== run.sourcePromptHash
        || smartTagPromptHash(currentTag.effectivePrompt) !== run.activePromptHash
      ) {
        this.deps.runs.finish({
          id: run.id,
          status: "stale",
          reason: "tag-or-model-changed-during-run",
          ...metrics,
        });
        return { status: "stale", processedActions: samples.length };
      }

      const version = smartTagPromptHash(candidate.candidatePrompt);
      const relations = this.deps.emailSmartTags
        .listRelationsByTag(input.accountId, input.tag.id)
        .map((relation) => ({ emailId: relation.emailId, source: relation.source }));
      let activated: UserTag | null = null;
      const transaction = this.deps.db.transaction(() => {
        activated = this.deps.userTags.activateOptimizedPrompt({
          id: input.tag.id,
          prompt: candidate.candidatePrompt,
          version,
          expectedSourcePromptHash: run.sourcePromptHash,
          expectedActivePromptHash: run.activePromptHash,
        });
        if (!activated) throw new Error("stale-tag-before-activation");
        this.deps.revisions.create({
          accountId: input.accountId,
          tagId: input.tag.id,
          tagName: input.tag.name,
          oldPrompt: input.tag.effectivePrompt,
          newPrompt: candidate.candidatePrompt,
          summary: `正式打标验证 ${metrics.currentCorrect}/${evaluationSamples.length} → ${metrics.candidateCorrect}/${evaluationSamples.length}`,
          actionCount: samples.length,
        });
        this.deps.runs.finish({
          id: run.id,
          status: "activated",
          reason: "candidate-improved-without-regression",
          ...metrics,
        });
        this.deps.backfills.createTargeted({
          accountId: input.accountId,
          tagId: input.tag.id,
          promptVersion: version,
          emailRelations: relations,
        });
      });
      transaction();
      this.logger("smart-tags.learning.activated", {
        tagId: input.tag.id,
        sampleCount: samples.length,
        correctedCount: metrics.correctedCount,
      });
      return { status: "activated", processedActions: samples.length };
    } catch (error) {
      const existing = this.deps.runs.getById(run.id);
      if (existing?.status === "generating" || existing?.status === "evaluating") {
        this.deps.runs.finish({
          id: run.id,
          status: shortErrorCode(error).includes("stale") ? "stale" : "failed",
          reason: shortErrorCode(error),
        });
      }
      return {
        status: shortErrorCode(error).includes("stale") ? "stale" : "failed",
        processedActions: samples.length,
      };
    }
  }

  private async generateCandidate(
    tag: UserTag,
    samples: ResolvedSample[],
    model: string,
  ) {
    const client = this.deps.llmRuntime.snapshot().client;
    if (!client) throw new Error("llm-not-configured");
    const optimization = samples.filter((sample) => sample.split === "optimization");
    const evidence = [];
    for (let index = 0; index < optimization.length; index += this.config.evidenceChunkSize) {
      const chunk = optimization.slice(index, index + this.config.evidenceChunkSize);
      const promptSamples: SmartTagOptimizationSample[] = chunk.map((sample, offset) => ({
        id: `sample-${index + offset + 1}`,
        expectedAction: sample.action.actionType,
        reason: sample.action.reason,
        mail: sample.mail,
      }));
      const response = await client.generate({
        model,
        system: SMART_TAG_EVIDENCE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: buildSmartTagEvidenceMessage({
            tagName: tag.name,
            description: tag.description,
            sourcePrompt: tag.prompt,
            samples: promptSamples,
          }),
        }],
        jsonSchema: SMART_TAG_EVIDENCE_SCHEMA,
        temperature: 0,
        maxTokens: 1200,
        timeoutMs: this.config.evaluationTimeoutMs,
      });
      const parsed = parseSmartTagEvidence(response.text);
      if (!parsed) throw new Error("optimizer-invalid-evidence-json");
      evidence.push(parsed);
    }
    const response = await client.generate({
      model,
      system: SMART_TAG_CANDIDATE_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: buildSmartTagCandidateMessage({
          tagName: tag.name,
          description: tag.description,
          sourcePrompt: tag.prompt,
          activePrompt: tag.effectivePrompt,
          evidence,
        }),
      }],
      jsonSchema: SMART_TAG_CANDIDATE_SCHEMA,
      temperature: 0,
      maxTokens: 1800,
      timeoutMs: this.config.evaluationTimeoutMs,
    });
    const candidate = parseSmartTagCandidate(response.text);
    if (!candidate) throw new Error("optimizer-invalid-candidate-json");
    return candidate;
  }

  private async evaluateValidation(input: {
    runId: string;
    samples: ResolvedSample[];
    targetTag: UserTag;
    allTags: UserTag[];
    candidatePrompt: string;
    model: string;
  }): Promise<EvaluationMetrics> {
    const metrics: EvaluationMetrics = {
      currentCorrect: 0,
      candidateCorrect: 0,
      correctedCount: 0,
      regressionCount: 0,
    };
    for (const sample of input.samples) {
      const current = await this.classify({
        mail: sample.mail,
        targetTag: input.targetTag,
        allTags: input.allTags,
        prompt: input.targetTag.effectivePrompt,
        model: input.model,
        feedbackMode: "bypass",
      });
      const candidate = await this.classify({
        mail: sample.mail,
        targetTag: input.targetTag,
        allTags: input.allTags,
        prompt: input.candidatePrompt,
        model: input.model,
        feedbackMode: "bypass",
      });
      const currentCorrect = isExpected(current.matched, sample.action.actionType);
      const candidateCorrect = isExpected(candidate.matched, sample.action.actionType);
      if (currentCorrect) metrics.currentCorrect += 1;
      if (candidateCorrect) metrics.candidateCorrect += 1;
      if (!currentCorrect && candidateCorrect) metrics.correctedCount += 1;
      if (currentCorrect && !candidateCorrect) metrics.regressionCount += 1;
      this.deps.runs.recordSampleResult({
        runId: input.runId,
        emailId: sample.mail.id,
        currentMatched: current.matched,
        candidateMatched: candidate.matched,
        currentConfidence: current.confidence,
        candidateConfidence: candidate.confidence,
      });
    }
    return metrics;
  }

  private async evaluateCandidateForSamples(input: {
    runId: string;
    samples: ResolvedSample[];
    targetTag: UserTag;
    allTags: UserTag[];
    candidatePrompt: string;
    model: string;
    confirmation?: boolean;
  }): Promise<Map<string, ClassificationOutcome>> {
    const outcomes = new Map<string, ClassificationOutcome>();
    for (const sample of input.samples) {
      const outcome = await this.classify({
        mail: sample.mail,
        targetTag: input.targetTag,
        allTags: input.allTags,
        prompt: input.candidatePrompt,
        model: input.model,
        feedbackMode: "bypass",
      });
      outcomes.set(sample.mail.id, outcome);
      this.deps.runs.recordSampleResult({
        runId: input.runId,
        emailId: sample.mail.id,
        ...(input.confirmation
          ? {
              confirmationMatched: outcome.matched,
              confirmationConfidence: outcome.confidence,
            }
          : {
              candidateMatched: outcome.matched,
              candidateConfidence: outcome.confidence,
            }),
      });
    }
    return outcomes;
  }

  private async classify(input: {
    mail: MailMessage;
    targetTag: UserTag;
    allTags: UserTag[];
    prompt: string;
    model: string;
    feedbackMode: "apply" | "bypass";
  }): Promise<ClassificationOutcome> {
    const client = this.deps.llmRuntime.snapshot().client;
    if (!client) throw new Error("llm-not-configured");
    const tags = input.allTags.map((tag) => tag.id === input.targetTag.id
      ? {
          ...tag,
          optimizedPrompt: input.prompt,
          optimizedPromptVersion: "evaluation",
          effectivePrompt: input.prompt,
        }
      : tag);
    const processor = new TagProcessor({
      llmClient: client,
      model: input.model,
      feedbackRules: this.deps.feedbackRules,
      getUserTags: () => tags,
      getCustomInstructions: this.deps.getCustomInstructions,
      feedbackMode: input.feedbackMode,
      temperature: 0,
      timeoutMs: this.config.evaluationTimeoutMs,
    });
    const job: IntelligenceJob = {
      id: `smart-tag-eval-${randomUUID()}`,
      emailId: input.mail.id,
      type: "tags",
      status: "running",
      attempts: 0,
      maxAttempts: 1,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    const result = await processor.handle(job, { getMessage: () => input.mail }) as TagResult;
    const matched = result.tags.find((tag) => tag.name === input.targetTag.name);
    return { matched: !!matched, confidence: matched?.confidence };
  }
}

export function splitSmartTagSamples(
  samples: ReadonlyArray<{ action: SmartTagActionRecord; mail: MailMessage }>,
  tagId: string,
): Array<{
  action: SmartTagActionRecord;
  mail: MailMessage;
  split: SmartTagLearningSampleSplit;
}> | null {
  const positive = samples.filter((sample) => sample.action.actionType === "apply").length;
  const negative = samples.length - positive;
  if (samples.length === 0) return null;
  const groups = new Map<string, typeof samples[number][]>();
  for (const sample of samples) {
    const key = sample.mail.threadId?.trim() || sample.mail.id;
    const list = groups.get(key) ?? [];
    list.push(sample);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()].sort(([left], [right]) =>
    stableHash(`${tagId}:${left}`).localeCompare(stableHash(`${tagId}:${right}`)),
  );
  if (positive < 2 || negative < 2 || ordered.length < 3) {
    return samples.map((sample) => ({ ...sample, split: "optimization" }));
  }
  const targetPositive = Math.max(1, Math.floor(positive * 0.3));
  const targetNegative = Math.max(1, Math.floor(negative * 0.3));
  let validationPositive = 0;
  let validationNegative = 0;
  let remainingPositive = positive;
  let remainingNegative = negative;
  const validationGroups = new Set<string>();
  for (const [key, group] of ordered) {
    const groupPositive = group.filter((sample) => sample.action.actionType === "apply").length;
    const groupNegative = group.length - groupPositive;
    const needed = validationPositive < targetPositive || validationNegative < targetNegative;
    if (!needed) break;
    if (remainingPositive - groupPositive < 1 || remainingNegative - groupNegative < 1) {
      continue;
    }
    if (
      (validationPositive < targetPositive && groupPositive > 0)
      || (validationNegative < targetNegative && groupNegative > 0)
    ) {
      validationGroups.add(key);
      validationPositive += groupPositive;
      validationNegative += groupNegative;
      remainingPositive -= groupPositive;
      remainingNegative -= groupNegative;
    }
  }
  if (validationPositive < 1 || validationNegative < 1) {
    return samples.map((sample) => ({ ...sample, split: "optimization" }));
  }
  return samples.map((sample) => ({
    ...sample,
    split: validationGroups.has(sample.mail.threadId?.trim() || sample.mail.id)
      ? "validation"
      : "optimization",
  }));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isExpected(matched: boolean, action: "apply" | "remove"): boolean {
  return action === "apply" ? matched : !matched;
}

function validateCandidatePrompt(candidate: string, current: string): string | null {
  const clean = candidate.trim();
  if (clean.length < 20 || clean.length > 4000) return "candidate-length-invalid";
  if (smartTagPromptHash(clean) === smartTagPromptHash(current)) {
    return "candidate-unchanged";
  }
  if (FORBIDDEN_CANDIDATE_PATTERNS.some((pattern) => pattern.test(clean))) {
    return "candidate-forbidden-content";
  }
  return null;
}

function shortErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.trim().slice(0, 160) || "unknown-error";
}
