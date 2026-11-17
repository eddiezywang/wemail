import { Hono, type Context } from "hono";
import type { CanonicalMailRepository } from "../../wemail/mail/CanonicalMailRepository.js";
import {
  smartTagPromptHash,
  type UserTagRepository,
} from "../../wemail/intelligence/UserTagRepository.js";
import type { EmailSmartTagRepository } from "../../wemail/intelligence/EmailSmartTagRepository.js";
import type { SmartTagActionRepository } from "../../wemail/intelligence/SmartTagActionRepository.js";
import type { SmartTagBackfillRepository } from "../../wemail/intelligence/SmartTagBackfillRepository.js";
import type { SmartTagLearningRunRepository } from "../../wemail/intelligence/SmartTagLearningRunRepository.js";
import type { SmartTagPromptRevisionRepository } from "../../wemail/intelligence/SmartTagPromptRevisionRepository.js";
import type { IntelligenceResultRepository } from "../../wemail/intelligence/IntelligenceResultRepository.js";
import type { SmartTagPromptCompiler } from "../../wemail/intelligence/SmartTagPromptCompiler.js";
import {
  SmartTagPromotionError,
  type SmartTagPromotionService,
} from "../../wemail/intelligence/SmartTagPromotionService.js";
import type { TopicCandidateRepository } from "../../wemail/intelligence/TopicCandidateRepository.js";
import {
  buildSmartTagDefinitions,
  smartTagDefinitionFingerprint,
} from "../../wemail/ai/prompts/smartTagDefinitions.js";

export interface SmartTagRoutesDeps {
  tags: UserTagRepository;
  relations: EmailSmartTagRepository;
  actions: SmartTagActionRepository;
  backfills: SmartTagBackfillRepository;
  learningRuns: SmartTagLearningRunRepository;
  revisions: SmartTagPromptRevisionRepository;
  results: IntelligenceResultRepository;
  mail: CanonicalMailRepository;
  promptCompiler?: SmartTagPromptCompiler;
  promotions: SmartTagPromotionService;
  topics: TopicCandidateRepository;
  getActiveAccountId: () => string | undefined;
  now?: () => Date;
  tagBackfillBatchSize?: number;
  tagBackfillMaxMessages?: number;
  tagBackfillIntervalMs?: number;
}

export function buildSmartTagRoutes(deps: SmartTagRoutesDeps) {
  const app = new Hono();

  app.get("/", (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const learning = deps.learningRuns.listByAccount(accountId, 100);
    const latestLearning = new Map<string, (typeof learning)[number]>();
    for (const run of learning) if (!latestLearning.has(run.tagId)) latestLearning.set(run.tagId, run);
    const backfills = deps.backfills.listByAccount(accountId, 100);
    const latestRetag = new Map<string, (typeof backfills)[number]>();
    for (const run of backfills) {
      if (run.scope === "tagged-relations-only" && run.targetTagId && !latestRetag.has(run.targetTagId)) {
        latestRetag.set(run.targetTagId, run);
      }
    }
    const tags = deps.tags.listByAccount(accountId).map((tag) => {
      const feedback = deps.actions.listLatestByTag({ accountId, tagId: tag.id, limit: 200 });
      const counts = deps.mail.countMessages({
        accountId,
        smartTagId: tag.id,
        excludedFolders: ["spam", "trash"],
      });
      const positiveFeedbackCount = feedback.filter((item) => item.actionType === "apply").length;
      return {
        ...tag,
        count: counts.totalCount,
        unreadCount: counts.unreadCount,
        feedbackSampleCount: feedback.length,
        positiveFeedbackCount,
        negativeFeedbackCount: feedback.length - positiveFeedbackCount,
        latestLearningRun: latestLearning.get(tag.id),
        latestRetagRun: latestRetag.get(tag.id),
      };
    });
    return c.json({ ok: true, tags });
  });

  app.get("/backfills", (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const parsed = Number.parseInt(c.req.query("limit") ?? "5", 10);
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 5;
    return c.json({ ok: true, runs: deps.backfills.listByAccount(accountId, limit) });
  });

  app.post("/promotions/preview", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const validation = validatePromotionSource(body);
    if (validation) return c.json({ ok: false, code: validation }, 400);
    try {
      const draft = await deps.promotions.preview({
        accountId,
        emailId: String(body!.emailId),
        candidateName: String(body!.candidateName),
        topicId: optionalString(body!.topicId),
        refresh: body?.refresh === true,
      });
      return c.json({ ok: true, draft });
    } catch (error) {
      return promotionErrorResponse(c, error);
    }
  });

  app.post("/promotions", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const sourceValidation = validatePromotionSource(body);
    if (sourceValidation) return c.json({ ok: false, code: sourceValidation }, 400);
    const fieldsValidation = validateTagBody(body, true);
    if (fieldsValidation) return c.json({ ok: false, code: fieldsValidation }, 400);
    if (typeof body!.description !== "string" || !body!.description.trim()) {
      return c.json({ ok: false, code: "INVALID_DESCRIPTION" }, 400);
    }
    try {
      const source = deps.promotions.resolveSource({
        accountId,
        emailId: String(body!.emailId),
        candidateName: String(body!.candidateName),
        topicId: optionalString(body!.topicId),
      });
      const alreadyCreated = source.topic.userTagId
        ? deps.tags.getById(source.topic.userTagId)
        : null;
      if (alreadyCreated && alreadyCreated.accountId === accountId) {
        const existingRelation = deps.relations.get(source.message.id, alreadyCreated.id);
        if (!existingRelation) {
          deps.relations.transaction(() => {
            deps.relations.upsert({
              accountId,
              emailId: source.message.id,
              userTagId: alreadyCreated.id,
              source: "user",
              confidence: 1,
            });
            deps.actions.record({
              accountId,
              emailId: source.message.id,
              tagId: alreadyCreated.id,
              tagName: alreadyCreated.name,
              actionType: "apply",
              reason: "从候选标签创建",
            });
          });
        }
        return c.json({
          ok: true,
          tag: alreadyCreated,
          topicId: source.topic.id,
          sourceEmailId: source.message.id,
          backfill: existingPromotionBackfill(deps, accountId),
          idempotent: true,
        });
      }
      const name = String(body!.name).trim();
      const nameExists = deps.tags.listByAccount(accountId)
        .some((tag) => normalizeName(tag.name) === normalizeName(name));
      if (nameExists) {
        return c.json({ ok: false, code: "SMART_TAG_NAME_EXISTS" }, 409);
      }
      const description = String(body!.description).trim();
      const prompt = await compilePrompt(deps, { name, description });
      const tag = deps.relations.transaction(() => {
        const created = deps.tags.upsert({
          accountId,
          name,
          description,
          prompt,
          creationSource: "topic-suggestion",
          sourceTopicId: source.topic.id,
        });
        deps.topics.markCreated(source.topic.id, accountId, created.id);
        deps.relations.upsert({
          accountId,
          emailId: source.message.id,
          userTagId: created.id,
          source: "user",
          confidence: 1,
        });
        deps.actions.record({
          accountId,
          emailId: source.message.id,
          tagId: created.id,
          tagName: created.name,
          actionType: "apply",
          reason: "从候选标签创建",
        });
        return created;
      });
      const backfill = scheduleTagBackfill({
        accountId,
        deps,
        targetFingerprint: currentSmartTagFingerprint(deps.tags, accountId),
      });
      return c.json({
        ok: true,
        tag,
        topicId: source.topic.id,
        sourceEmailId: source.message.id,
        backfill,
        idempotent: false,
      });
    } catch (error) {
      return promotionErrorResponse(c, error);
    }
  });

  app.post("/backfills/:id/resume", (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const run = deps.backfills.resumeInterrupted(c.req.param("id"), accountId);
    if (!run) return c.json({ ok: false, code: "BACKFILL_NOT_RESUMABLE" }, 409);
    return c.json({ ok: true, run });
  });

  app.post("/", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const validation = validateTagBody(body, true);
    if (validation) return c.json({ ok: false, code: validation }, 400);
    const name = String(body!.name).trim();
    const description = optionalString(body!.description) ?? "";
    const prompt = await compilePrompt(deps, { name, description });
    const tag = deps.tags.upsert({
      accountId,
      name,
      description,
      prompt,
    });
    const backfill = scheduleTagBackfill({
      accountId,
      deps,
      targetFingerprint: currentSmartTagFingerprint(deps.tags, accountId),
    });
    return c.json({ ok: true, tag, backfill });
  });

  app.patch("/:id", async (c) => {
    const owned = ownedTag(c.req.param("id"), deps);
    if (owned instanceof Response) return owned;
    const existingRelations = deps.relations.listRelationsByTag(owned.accountId, owned.id);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const validation = validateTagBody(body, false);
    if (validation) return c.json({ ok: false, code: validation }, 400);
    const name = body!.name === undefined ? owned.name : String(body!.name).trim();
    const description = body!.description === undefined
      ? owned.description
      : String(body!.description).trim();
    const shouldCompile = body!.name !== undefined
      || body!.description !== undefined
      || body!.prompt !== undefined;
    const prompt = shouldCompile
      ? await compilePrompt(deps, {
          name,
          description: optionalString(body!.prompt) ?? description,
        })
      : owned.prompt;
    const tag = deps.tags.updateById({
      id: owned.id,
      name,
      description,
      prompt,
    });
    if (!tag) return c.json({ ok: false, code: "SMART_TAG_NOT_FOUND" }, 404);
    if (owned.optimizedPrompt && owned.effectivePrompt !== tag.effectivePrompt) {
      deps.revisions.create({
        accountId: tag.accountId,
        tagId: tag.id,
        tagName: tag.name,
        oldPrompt: owned.effectivePrompt,
        newPrompt: tag.effectivePrompt,
        summary: "用户修改原始提示词，AI 优化版本已停用",
        actionCount: 0,
      });
    }
    const backfill = deps.backfills.createTargeted({
      accountId: tag.accountId,
      tagId: tag.id,
      promptVersion: smartTagPromptHash(tag.effectivePrompt),
      emailRelations: existingRelations.map(({ emailId, source }) => ({ emailId, source })),
    });
    return c.json({ ok: true, tag, backfill });
  });

  app.post("/:id/restore-original", (c) => {
    const owned = ownedTag(c.req.param("id"), deps);
    if (owned instanceof Response) return owned;
    const existingRelations = deps.relations.listRelationsByTag(owned.accountId, owned.id);
    const tag = deps.tags.restoreOriginalPrompt(owned.id);
    if (!tag) return c.json({ ok: false, code: "SMART_TAG_NOT_FOUND" }, 404);
    if (owned.optimizedPrompt) {
      deps.revisions.create({
        accountId: tag.accountId,
        tagId: tag.id,
        tagName: tag.name,
        oldPrompt: owned.effectivePrompt,
        newPrompt: tag.effectivePrompt,
        summary: "用户恢复原始提示词",
        actionCount: 0,
      });
    }
    const backfill = deps.backfills.createTargeted({
      accountId: tag.accountId,
      tagId: tag.id,
      promptVersion: smartTagPromptHash(tag.effectivePrompt),
      emailRelations: existingRelations.map(({ emailId, source }) => ({ emailId, source })),
    });
    return c.json({ ok: true, tag, backfill });
  });

  app.delete("/:id", (c) => {
    const owned = ownedTag(c.req.param("id"), deps);
    if (owned instanceof Response) return owned;
    deps.learningRuns.cancelForTag(owned.accountId, owned.id);
    deps.backfills.cancelTargetedForTag(owned.accountId, owned.id);
    // removeTagFromAccount on IntelligenceResultRepository is a hard stub that
    // throws "canonical-tag-writes-require-db-service", so calling it here made
    // every smart-tag DELETE return 500. removeByTag already deletes this tag's
    // mail_message_user_tags rows (by public id) and returns the count, which is
    // the same account-wide sweep and supplies removedTagRelations.
    const removedTagRelations = deps.relations.removeByTag(owned.id);
    deps.tags.deleteById(owned.id);
    return c.json({ ok: true, removedTagRelations });
  });

  app.put("/messages/:messageId/:tagId", async (c) => {
    const target = ownedMessageAndTag(c.req.param("messageId"), c.req.param("tagId"), deps);
    if (target instanceof Response) return target;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    deps.relations.transaction(() => {
      deps.relations.upsert({
        accountId: target.accountId,
        emailId: target.emailId,
        userTagId: target.tag.id,
        source: "user",
        confidence: 1,
      });
      deps.actions.record({
        accountId: target.accountId,
        emailId: target.emailId,
        tagId: target.tag.id,
        tagName: target.tag.name,
        actionType: "apply",
        reason: optionalString(body.reason),
      });
    });
    return c.json({ ok: true });
  });

  app.delete("/messages/:messageId/:tagId", async (c) => {
    const target = ownedMessageAndTag(c.req.param("messageId"), c.req.param("tagId"), deps);
    if (target instanceof Response) return target;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    deps.relations.transaction(() => {
      deps.relations.remove(target.emailId, target.tag.id);
      deps.actions.record({
        accountId: target.accountId,
        emailId: target.emailId,
        tagId: target.tag.id,
        tagName: target.tag.name,
        actionType: "remove",
        reason: optionalString(body.reason),
      });
    });
    return c.json({ ok: true });
  });

  return app;
}

function ownedTag(id: string, deps: SmartTagRoutesDeps) {
  const accountId = deps.getActiveAccountId();
  if (!accountId) return Response.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, { status: 401 });
  const tag = deps.tags.getById(id);
  if (!tag || tag.accountId !== accountId) {
    return Response.json({ ok: false, code: "SMART_TAG_NOT_FOUND" }, { status: 404 });
  }
  return tag;
}

function ownedMessageAndTag(messageId: string, tagId: string, deps: SmartTagRoutesDeps) {
  const tag = ownedTag(tagId, deps);
  if (tag instanceof Response) return tag;
  const message = deps.mail.getMessageById(messageId, tag.accountId);
  if (!message) return Response.json({ ok: false, code: "MESSAGE_NOT_FOUND" }, { status: 404 });
  return { accountId: tag.accountId, emailId: messageId, tag };
}

function validateTagBody(body: Record<string, unknown> | null, requireName: boolean): string | null {
  if (!body) return "INVALID_BODY";
  if ((requireName || body.name !== undefined) &&
      (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 30)) return "INVALID_NAME";
  if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 1000)) return "INVALID_DESCRIPTION";
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || body.prompt.length > 4000)) return "INVALID_PROMPT";
  return null;
}

function validatePromotionSource(body: Record<string, unknown> | null): string | null {
  if (!body) return "INVALID_BODY";
  if (typeof body.emailId !== "string" || !body.emailId.trim()) return "INVALID_EMAIL_ID";
  if (
    typeof body.candidateName !== "string"
    || !body.candidateName.trim()
    || body.candidateName.trim().length > 100
  ) return "INVALID_CANDIDATE_NAME";
  if (body.topicId !== undefined && (typeof body.topicId !== "string" || !body.topicId.trim())) {
    return "INVALID_TOPIC_ID";
  }
  return null;
}

function promotionErrorResponse(c: Context, error: unknown): Response {
  if (!(error instanceof SmartTagPromotionError)) throw error;
  const status = error.code === "MESSAGE_NOT_FOUND" ? 404
    : error.code === "SMART_TAG_TOPIC_NOT_FOUND" ? 404
    : 400;
  return c.json({ ok: false, code: error.code }, status);
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function existingPromotionBackfill(deps: SmartTagRoutesDeps, accountId: string) {
  const run = deps.backfills.listByAccount(accountId, 100)
    .find((item) => item.reason === "smart-tag-backfill");
  return {
    runId: run?.id ?? "",
    status: run?.status === "running" ? "running" as const : "completed" as const,
    scanned: run?.scannedCount ?? 0,
    queued: run?.queuedCount ?? 0,
    recent: run?.recentCount ?? 0,
    historical: run?.historicalCount ?? 0,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function compilePrompt(
  deps: SmartTagRoutesDeps,
  input: { name: string; description: string },
): Promise<string> {
  if (deps.promptCompiler) return deps.promptCompiler.compile(input);
  return [
    `智能标签：${input.name}`,
    `用户原始描述：${input.description || input.name}`,
    "仅在邮件完整符合用户描述时命中；孤立关键词、信息缺失或不确定时不要命中。",
  ].join("\n");
}

function currentSmartTagFingerprint(tags: UserTagRepository, accountId: string) {
  return smartTagDefinitionFingerprint(
    buildSmartTagDefinitions(tags.listByAccount(accountId)),
  );
}

function scheduleTagBackfill(input: {
  accountId: string;
  deps: SmartTagRoutesDeps;
  targetFingerprint: string;
}) {
  const reason = "smart-tag-backfill";
  const run = input.deps.backfills.create({
    accountId: input.accountId,
    reason,
    targetFingerprint: input.targetFingerprint,
  });
  setImmediate(() => {
    void processTagBackfill({ ...input, reason, runId: run.id });
  });
  return {
    runId: run.id,
    status: "running" as const,
    scanned: 0,
    queued: 0,
    recent: 0,
    historical: 0,
  };
}

async function processTagBackfill(input: {
  accountId: string;
  deps: SmartTagRoutesDeps;
  targetFingerprint: string;
  reason: string;
  runId: string;
}) {
  const now = input.deps.now ?? (() => new Date());
  const cutoff = now();
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const maxMessages = Math.max(
    1,
    Math.min(2_000, input.deps.tagBackfillMaxMessages ?? 2_000),
  );
  const batchSize = Math.max(
    1,
    Math.min(100, input.deps.tagBackfillBatchSize ?? 50),
  );
  const intervalMs = Math.max(
    0,
    Math.min(5_000, input.deps.tagBackfillIntervalMs ?? 100),
  );
  let cursor: { receivedAt: string; id: string } | undefined;
  let scanned = 0;
  try {
    while (scanned < maxMessages) {
      const messages = input.deps.mail.listAllMessagesByAccountPage({
        accountId: input.accountId,
        limit: Math.min(batchSize, maxMessages - scanned),
        cursor,
      });
      if (messages.length === 0) break;
      let batchQueued = 0;
      let batchRecent = 0;
      let batchHistorical = 0;
      let batchFailed = 0;
      let firstFailure: string | undefined;
      for (const message of messages) {
        const receivedAt = new Date(message.receivedAt);
        if (!Number.isNaN(receivedAt.getTime()) && receivedAt >= cutoff) {
          batchRecent += 1;
        } else {
          batchHistorical += 1;
        }
        try {
          batchQueued += await input.deps.mail.requestSmartTagBackfill(
            message.id,
            input.runId,
          );
        } catch (error) {
          batchFailed += 1;
          firstFailure ??= error instanceof Error ? error.message : String(error);
        }
        scanned += 1;
        if (intervalMs > 0 && scanned < maxMessages) {
          await delay(intervalMs);
        }
      }
      const last = messages.at(-1)!;
      cursor = { receivedAt: last.receivedAt, id: last.id };
      input.deps.backfills.addProgress({
        id: input.runId,
        scannedDelta: messages.length,
        queuedDelta: batchQueued,
        recentDelta: batchRecent,
        historicalDelta: batchHistorical,
        failedDelta: batchFailed,
        cursorReceivedAt: cursor.receivedAt,
        cursorEmailId: cursor.id,
      });
      if (batchQueued === 0 && batchFailed === messages.length) {
        input.deps.backfills.fail(
          input.runId,
          (firstFailure || "smart-tag-backfill-batch-failed").slice(0, 500),
        );
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    input.deps.backfills.finishEnqueue(input.runId);
  } catch (error) {
    input.deps.backfills.fail(
      input.runId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
