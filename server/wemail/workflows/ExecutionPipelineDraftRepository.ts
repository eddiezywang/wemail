import type {
  ExecutionPipelineDraft,
  ReviewCheckpoint,
} from "../../../shared/wemail/skillCenter.js";
import type { MailDatabase } from "../database/Database.js";

interface PipelineRow {
  id: string;
  account_id: string;
  session_id: string | null;
  mode: ExecutionPipelineDraft["mode"];
  revision: number;
  trigger_json: string | null;
  data_selection_json: string | null;
  analysis_recipe_json: string | null;
  artifact_recipe_json: string | null;
  delivery_plan_json: string | null;
  steps_json: string;
  skill_snapshots_json: string;
  capability_snapshots_json: string;
  validation_json: string;
  owner_json: string | null;
  account_scope_json: string | null;
  source_rule_id: string | null;
  source_rule_version: number | null;
  template_binding_json: string | null;
  template_configuration_json: string | null;
  advanced_policy_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewRow {
  id: string;
  pipeline_id: string;
  target: ReviewCheckpoint["target"];
  policy: ReviewCheckpoint["policy"];
  status: ReviewCheckpoint["status"];
  draft_revision: number;
  target_version: number;
  content_hash: string;
  preview_id: string | null;
  preview_url: string | null;
  depends_on_json: string;
  feedback: string | null;
  accepted_at: string | null;
}

export class PipelineDraftConflictError extends Error {
  readonly summary?: {
    currentRevision: number;
    changedSections: string[];
    updatedAt: string;
  };

  constructor(readonly current?: ExecutionPipelineDraft) {
    super("pipeline-draft-revision-conflict");
    this.name = "PipelineDraftConflictError";
    this.summary = current
      ? {
          currentRevision: current.revision,
          changedSections: changedSections(current),
          updatedAt: current.updatedAt,
        }
      : undefined;
  }
}

export class ExecutionPipelineDraftRepository {
  constructor(private readonly db: MailDatabase) {}

  create(draft: ExecutionPipelineDraft): ExecutionPipelineDraft {
    if (draft.revision !== 1) {
      throw new Error("new-pipeline-draft-revision-must-be-1");
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO execution_pipeline_drafts (
            id, account_id, session_id, mode, revision, trigger_json,
            data_selection_json, analysis_recipe_json, artifact_recipe_json,
            delivery_plan_json, steps_json, skill_snapshots_json,
            capability_snapshots_json, validation_json, created_at, updated_at
            , owner_json, account_scope_json, source_rule_id,
            source_rule_version, template_binding_json,
            template_configuration_json, advanced_policy_json
          ) VALUES (
            @id, @accountId, @sessionId, @mode, @revision, @trigger,
            @dataSelection, @analysis, @artifact, @delivery, @steps,
            @skillSnapshots, @capabilitySnapshots, @validation, @createdAt,
            @updatedAt
            , @owner, @accountScope, @sourceRuleId, @sourceRuleVersion,
            @templateBinding, @templateConfiguration, @advancedPolicy
          )`,
        )
        .run(serializeDraft(draft));
      this.replaceReviews(draft);
    })();
    return this.get(draft.id, draft.accountId)!;
  }

  replace(
    draft: ExecutionPipelineDraft,
    expectedRevision: number,
  ): ExecutionPipelineDraft {
    if (draft.revision !== expectedRevision + 1) {
      throw new Error("pipeline-draft-next-revision-required");
    }
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE execution_pipeline_drafts SET
            session_id = @sessionId,
            mode = @mode,
            revision = @revision,
            trigger_json = @trigger,
            data_selection_json = @dataSelection,
            analysis_recipe_json = @analysis,
            artifact_recipe_json = @artifact,
            delivery_plan_json = @delivery,
            steps_json = @steps,
            skill_snapshots_json = @skillSnapshots,
            capability_snapshots_json = @capabilitySnapshots,
            validation_json = @validation,
            owner_json = @owner,
            account_scope_json = @accountScope,
            source_rule_id = @sourceRuleId,
            source_rule_version = @sourceRuleVersion,
            template_binding_json = @templateBinding,
            template_configuration_json = @templateConfiguration,
            advanced_policy_json = @advancedPolicy,
            updated_at = @updatedAt
          WHERE id = @id AND account_id = @accountId AND revision = @expectedRevision`,
        )
        .run({
          ...serializeDraft(draft),
          expectedRevision,
        });
      if (result.changes !== 1) {
        throw new PipelineDraftConflictError(
          this.get(draft.id, draft.accountId) ?? undefined,
        );
      }
      this.replaceReviews(draft);
    })();
    return this.get(draft.id, draft.accountId)!;
  }

  get(id: string, accountId: string): ExecutionPipelineDraft | null {
    const row = this.db
      .prepare(
        "SELECT * FROM execution_pipeline_drafts WHERE id = ? AND account_id = ?",
      )
      .get(id, accountId) as PipelineRow | undefined;
    if (!row) return null;
    const reviews = this.db
      .prepare(
        `SELECT * FROM pipeline_review_checkpoints
         WHERE pipeline_id = ? ORDER BY target, target_version, id`,
      )
      .all(id) as ReviewRow[];
    return hydrateDraft(row, reviews);
  }

  list(accountId: string, limit = 50): ExecutionPipelineDraft[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_pipeline_drafts
         WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(accountId, Math.max(1, Math.min(200, limit))) as PipelineRow[];
    return rows.map((row) => {
      const reviews = this.db
        .prepare(
          `SELECT * FROM pipeline_review_checkpoints
           WHERE pipeline_id = ? ORDER BY target, target_version, id`,
        )
        .all(row.id) as ReviewRow[];
      return hydrateDraft(row, reviews);
    });
  }

  findBySourceRule(
    sourceRuleId: string,
    accountId: string,
  ): ExecutionPipelineDraft | null {
    const row = this.db
      .prepare(
        `SELECT * FROM execution_pipeline_drafts
          WHERE source_rule_id = ? AND account_id = ?
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sourceRuleId, accountId) as PipelineRow | undefined;
    if (!row) return null;
    const reviews = this.db
      .prepare(
        `SELECT * FROM pipeline_review_checkpoints
          WHERE pipeline_id = ? ORDER BY target, target_version, id`,
      )
      .all(row.id) as ReviewRow[];
    return hydrateDraft(row, reviews);
  }

  private replaceReviews(draft: ExecutionPipelineDraft): void {
    this.db
      .prepare("DELETE FROM pipeline_review_checkpoints WHERE pipeline_id = ?")
      .run(draft.id);
    const insert = this.db.prepare(
      `INSERT INTO pipeline_review_checkpoints (
        id, pipeline_id, target, policy, status, draft_revision,
        target_version, content_hash, preview_id, preview_url, depends_on_json,
        feedback, accepted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const review of draft.reviews) {
      insert.run(
        review.id,
        draft.id,
        review.target,
        review.policy,
        review.status,
        review.draftRevision,
        review.targetVersion,
        review.contentHash,
        review.previewId ?? null,
        review.previewUrl ?? null,
        JSON.stringify(review.dependsOn),
        review.feedback ?? null,
        review.acceptedAt ?? null,
        draft.createdAt,
        draft.updatedAt,
      );
    }
  }
}

function serializeDraft(draft: ExecutionPipelineDraft) {
  return {
    id: draft.id,
    accountId: draft.accountId,
    sessionId: draft.sessionId ?? null,
    mode: draft.mode,
    revision: draft.revision,
    trigger: draft.trigger ? JSON.stringify(draft.trigger) : null,
    dataSelection: draft.dataSelection
      ? JSON.stringify(draft.dataSelection)
      : null,
    analysis: draft.analysis ? JSON.stringify(draft.analysis) : null,
    artifact: draft.artifact ? JSON.stringify(draft.artifact) : null,
    delivery: draft.delivery ? JSON.stringify(draft.delivery) : null,
    steps: JSON.stringify(draft.steps),
    skillSnapshots: JSON.stringify(draft.skillSnapshots),
    capabilitySnapshots: JSON.stringify(draft.capabilitySnapshots),
    validation: JSON.stringify(draft.validation),
    owner: draft.owner ? JSON.stringify(draft.owner) : null,
    accountScope: draft.accountScope
      ? JSON.stringify(draft.accountScope)
      : null,
    sourceRuleId: draft.sourceRuleId ?? null,
    sourceRuleVersion: draft.sourceRuleVersion ?? null,
    templateBinding: draft.templateBinding
      ? JSON.stringify(draft.templateBinding)
      : null,
    templateConfiguration: draft.templateConfiguration
      ? JSON.stringify(draft.templateConfiguration)
      : null,
    advancedPolicy: draft.advancedPolicy
      ? JSON.stringify(draft.advancedPolicy)
      : null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function hydrateDraft(
  row: PipelineRow,
  reviews: ReviewRow[],
): ExecutionPipelineDraft {
  return {
    id: row.id,
    accountId: row.account_id,
    ...(row.owner_json
      ? { owner: parseJson(row.owner_json, undefined) }
      : {}),
    ...(row.account_scope_json
      ? { accountScope: parseJson(row.account_scope_json, undefined) }
      : {}),
    ...(row.source_rule_id ? { sourceRuleId: row.source_rule_id } : {}),
    ...(row.source_rule_version !== null
      ? { sourceRuleVersion: row.source_rule_version }
      : {}),
    ...(row.template_binding_json
      ? { templateBinding: parseJson(row.template_binding_json, undefined) }
      : {}),
    ...(row.template_configuration_json
      ? {
          templateConfiguration: parseJson(
            row.template_configuration_json,
            undefined,
          ),
        }
      : {}),
    ...(row.advanced_policy_json
      ? { advancedPolicy: parseJson(row.advanced_policy_json, undefined) }
      : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    revision: row.revision,
    mode: row.mode,
    ...(row.trigger_json
      ? { trigger: parseJson(row.trigger_json, undefined) }
      : {}),
    ...(row.data_selection_json
      ? { dataSelection: parseJson(row.data_selection_json, undefined) }
      : {}),
    ...(row.analysis_recipe_json
      ? { analysis: parseJson(row.analysis_recipe_json, undefined) }
      : {}),
    ...(row.artifact_recipe_json
      ? { artifact: parseJson(row.artifact_recipe_json, undefined) }
      : {}),
    ...(row.delivery_plan_json
      ? { delivery: parseJson(row.delivery_plan_json, undefined) }
      : {}),
    steps: parseJson(row.steps_json, []),
    skillSnapshots: parseJson(row.skill_snapshots_json, []),
    capabilitySnapshots: parseJson(row.capability_snapshots_json, []),
    reviews: reviews.map((review) => ({
      id: review.id,
      target: review.target,
      policy: review.policy,
      status: review.status,
      draftRevision: review.draft_revision,
      targetVersion: review.target_version,
      contentHash: review.content_hash,
      ...(review.preview_id ? { previewId: review.preview_id } : {}),
      ...(review.preview_url ? { previewUrl: review.preview_url } : {}),
      dependsOn: parseJson(review.depends_on_json, []),
      ...(review.feedback ? { feedback: review.feedback } : {}),
      ...(review.accepted_at ? { acceptedAt: review.accepted_at } : {}),
    })),
    validation: parseJson(row.validation_json, {
      status: "not_validated",
      issues: [],
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function changedSections(draft: ExecutionPipelineDraft): string[] {
  const sections = [
    draft.owner || draft.accountScope ? "ownership" : undefined,
    draft.trigger ? "trigger" : undefined,
    draft.dataSelection ? "data" : undefined,
    draft.analysis ? "analysis" : undefined,
    draft.artifact ? "artifact" : undefined,
    draft.delivery ? "delivery" : undefined,
    draft.templateConfiguration ? "template" : undefined,
    draft.advancedPolicy ? "advanced" : undefined,
  ].filter((value): value is string => !!value);
  return sections.slice(0, 8);
}
