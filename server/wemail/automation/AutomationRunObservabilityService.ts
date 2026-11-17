import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationAccountScope,
  AutomationInputManifest,
  AutomationInputManifestItem,
  AutomationRunDetail,
  AutomationRunOutcome,
  AutomationRunResultEnvelope,
  AutomationActionCandidate,
  AutomationProvenance,
  AutomationStepDetail,
  SubscriptionInsightResult,
  AutomationWorkflowStage,
} from "../../../shared/wemail/automationCenter.js";
import type {
  AutomationPipelineStep,
  AutomationRuleV2,
  AutomationValue,
} from "../../../shared/wemail/automation.js";
import type { MailDatabase } from "../database/Database.js";
import type { AutomationStepResult } from "./providers/AutomationProvider.js";
import type { SubscriptionActionCandidateResolver } from "./SubscriptionActionCandidateResolver.js";
import { projectAutomationDeliveries } from "./AutomationDeliveryProjection.js";

const DETAIL_RETENTION_MS = 30 * 86_400_000;

interface ClaimInput {
  rule: AutomationRuleV2;
  runId: string;
  occurrenceKey: string;
  plannedAt?: string;
  actualStartedAt: string;
  delayed: boolean;
  collection: Record<string, unknown>;
}

interface RunRow {
  id: string;
  rule_id: string;
  account_id: string;
  dry_run: number;
  matched_count: number;
  applied_count: number;
  status: string | null;
  created_at: string;
  completed_at: string | null;
  planned_occurrence_key: string | null;
  planned_window_start: string | null;
  planned_window_end: string | null;
  run_revision: number;
  rule_version: number | null;
  template_id: string | null;
  template_version: string | null;
  template_hash: string | null;
  pipeline_hash: string | null;
  recipe_hash: string | null;
  renderer_id: string | null;
  renderer_version: string | null;
  account_scope_json: string | null;
  resolved_accounts_json: string | null;
  result_envelope_id: string | null;
  expires_at: string | null;
}

export class AutomationRunObservabilityService {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly subscriptionActions?: SubscriptionActionCandidateResolver,
  ) {}

  claim(input: ClaimInput): { runId: string; claimed: boolean; revision: number } {
    const existing = this.db
      .prepare(
        `SELECT id, run_revision
           FROM automation_rule_runs
          WHERE rule_id = ? AND trigger_key = ?`,
      )
      .get(input.rule.id, input.occurrenceKey) as
      | { id: string; run_revision: number }
      | undefined;
    if (existing) {
      return {
        runId: existing.id,
        claimed: false,
        revision: existing.run_revision,
      };
    }

    const manifest = buildManifest(input.rule, input.collection, input.actualStartedAt);
    const window = readWindow(input.collection);
    const resolvedAccounts = resolveAccountIds(
      input.rule,
      manifest,
      input.collection,
    );
    const expiresAt = new Date(
      Date.parse(input.actualStartedAt) + DETAIL_RETENTION_MS,
    ).toISOString();
    const recipeHash = hash({
      data: input.rule.dataSelectionRecipe,
      analysis: input.rule.analysisRecipe,
      artifact: input.rule.artifactRecipe,
      delivery: input.rule.deliveryPlan,
    });

    return this.db.transaction(() => {
      const activeRule = this.db.prepare(`SELECT 1 FROM automation_rules
        WHERE id = ? AND account_id = ? AND schema_version = 2 AND current_version = ?
          AND enabled = 1 AND archived_at IS NULL`)
        .get(input.rule.id, input.rule.accountId, input.rule.version);
      if (!activeRule) throw new Error("automation-source-rule-stale");
      const inserted = this.db.prepare(`
        INSERT INTO automation_rule_runs (
          id, rule_id, account_id, dry_run, matched_count, applied_count,
          trigger_kind, trigger_key, status, action_results_json, created_at,
          planned_occurrence_key, planned_window_start, planned_window_end,
          run_revision, rule_version, template_id, template_version,
          template_hash, pipeline_hash, recipe_hash, renderer_id,
          renderer_version, account_scope_json, resolved_accounts_json,
          model_resolution_json, delivery_policy_json, expires_at,
          retention_class
        ) VALUES (
          ?, ?, ?, 0, ?, 0, ?, ?, 'running', '[]', ?, ?, ?, ?, 1, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'summary'
        ) ON CONFLICT(rule_id, trigger_key) DO NOTHING
      `).run(
        input.runId,
        input.rule.id,
        input.rule.accountId,
        manifest.items.length,
        input.rule.trigger.type,
        input.occurrenceKey,
        input.actualStartedAt,
        input.occurrenceKey,
        window?.start ?? null,
        window?.end ?? null,
        input.rule.version,
        input.rule.templateBinding?.templateId ?? null,
        input.rule.templateBinding?.templateVersion ?? null,
        input.rule.templateBinding?.templateHash ?? null,
        input.rule.compiledPipelineHash ?? hash(input.rule.pipeline),
        recipeHash,
        input.rule.templateBinding?.rendererId ?? null,
        input.rule.templateBinding?.rendererVersion ?? null,
        JSON.stringify(
          input.rule.accountScope ?? {
            type: "currentAccount",
            accountId: input.rule.accountId,
          },
        ),
        JSON.stringify(resolvedAccounts),
        JSON.stringify({ policy: "runtime_default" }),
        JSON.stringify(input.rule.deliveryPlan ?? {}),
        expiresAt,
      );
      if (inserted.changes === 0) {
        const existing = this.db.prepare("SELECT id, run_revision FROM automation_rule_runs WHERE rule_id = ? AND trigger_key = ?")
          .get(input.rule.id, input.occurrenceKey) as { id: string; run_revision: number } | undefined;
        if (!existing) throw new Error("automation-run-claim-conflict");
        return { runId: existing.id, claimed: false, revision: existing.run_revision };
      }
      persistManifest(this.db, input.runId, manifest);
      return { runId: input.runId, claimed: true, revision: 1 };
    }).immediate();
  }

  beginStep(
    runId: string,
    step: AutomationPipelineStep,
    sequence: number,
  ): number {
    return this.advanceRevision(runId);
  }

  completeStep(runId: string): number {
    return this.advanceRevision(runId);
  }

  completeRun(
    runId: string,
    outcome: AutomationRunOutcome,
    resultCount: number,
    result?: {
      rule: AutomationRuleV2;
      value?: AutomationValue;
    },
  ): number {
    const revision = this.advanceRevision(runId);
    let envelopeId: string | null = null;
    if (result?.rule.templateBinding && result.value !== undefined) {
      envelopeId = `automation-result-${randomUUID()}`;
      const binding = result.rule.templateBinding;
      const normalized = normalizeEnvelopeValue(result.value);
      const actionCandidates = this.subscriptionActions
        ? this.subscriptionActions.resolve(runId, normalized.actionCandidates)
        : normalized.actionCandidates;
      const envelope: AutomationRunResultEnvelope = {
        resultType: binding.resultSchemaId,
        schemaVersion: binding.resultSchemaVersion,
        rendererId: binding.rendererId,
        rendererVersion: binding.rendererVersion,
        data: sanitizeResult(normalized.data),
        provenance: normalized.provenance,
        actionCandidates,
      };
      const now = this.now();
      this.db.prepare(`
        INSERT INTO automation_result_envelopes (
          id, run_id, schema_id, schema_version, renderer_id, renderer_version,
          status, result_json, provenance_json, action_candidates_json,
          warnings_json, content_hash, retention_class, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, '[]', ?,
                  'detail_30d', ?, ?)
      `).run(
        envelopeId,
        runId,
        binding.resultSchemaId,
        binding.resultSchemaVersion.toString(),
        binding.rendererId,
        binding.rendererVersion,
        JSON.stringify(envelope),
        JSON.stringify(envelope.provenance),
        JSON.stringify(envelope.actionCandidates),
        hash(envelope),
        now,
        new Date(Date.parse(now) + DETAIL_RETENTION_MS).toISOString(),
      );
    }
    this.db.prepare(`
      UPDATE automation_rule_runs
         SET status = ?, applied_count = ?, completed_at = ?,
             result_envelope_id = COALESCE(?, result_envelope_id),
             run_revision = ?
       WHERE id = ?
    `).run(outcome, resultCount, this.now(), envelopeId, revision, runId);
    return revision;
  }

  reconcileChannelDeliveries(
    runId: string,
  ): "pending" | "succeeded" | "partial" | "failed" | "outcome_unknown" | "not_found" {
    const groups = this.db.prepare(`
      SELECT
        COALESCE(correlation_key, id) AS delivery_group,
        SUM(CASE WHEN state IN ('pending', 'leased', 'retrying') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent
      FROM channel_deliveries
      WHERE automation_run_id = ?
      GROUP BY COALESCE(correlation_key, id)
    `).all(runId) as Array<{
      delivery_group: string;
      pending: number;
      sent: number;
    }>;
    if (groups.length === 0) return "not_found";
    const run = this.db.prepare(
      "SELECT status, completed_at, rule_id, rule_version FROM automation_rule_runs WHERE id = ?",
    ).get(runId) as {
      status: string | null;
      completed_at: string | null;
      rule_id: string;
      rule_version: number | null;
    } | undefined;
    if (!run) return "not_found";
    if (run.status === "outcome_unknown") return "outcome_unknown";
    const activeStep = this.db.prepare(
      "SELECT 1 FROM automation_step_runs WHERE run_id = ? AND status = 'running' LIMIT 1",
    ).get(runId);
    if (activeStep) return "pending";
    if (groups.some((group) => group.pending > 0)) {
      if (
        run.status === "succeeded" ||
        run.status === "empty" ||
        run.status === "partial"
      ) {
        this.db.prepare(`
          UPDATE automation_rule_runs
          SET status = 'running', completed_at = NULL,
              run_revision = run_revision + 1
          WHERE id = ?
        `).run(runId);
      }
      return "pending";
    }

    const failedGroups = groups.filter((group) => group.sent === 0).length;
    if (failedGroups === 0) {
      const failedSteps = this.db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT status, ROW_NUMBER() OVER (
            PARTITION BY step_id ORDER BY run_revision DESC, rowid DESC
          ) AS attempt_rank
          FROM automation_step_runs WHERE run_id = ?
        ) WHERE attempt_rank = 1 AND status = 'failed'
      `).get(runId) as { count: number };
      const snapshot = this.db.prepare(
        "SELECT rule_json FROM automation_rule_versions WHERE rule_id = ? AND version = ?",
      ).get(run.rule_id, run.rule_version ?? 1) as { rule_json: string } | undefined;
      const pipeline = parseJson<{ pipeline?: Array<{ id: string }> }>(snapshot?.rule_json ?? null, {}).pipeline;
      const latestSteps = this.readSteps(runId);
      const complete = !!pipeline?.length && pipeline.every((step) =>
        latestSteps.some((attempt) => attempt.stepId === step.id && attempt.status === "succeeded"),
      );
      const outcome = failedSteps.count > 0 || !complete ? "partial" : "succeeded";
      if (run.status !== outcome || run.completed_at === null) {
        this.db.prepare(`
          UPDATE automation_rule_runs
          SET status = ?, completed_at = ?,
              run_revision = run_revision + 1
          WHERE id = ?
        `).run(outcome, this.now(), runId);
      }
      return outcome;
    }
    const successfulBotGroups = groups.length - failedGroups;
    const otherDelivery = this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY step_id ORDER BY run_revision DESC, rowid DESC
        ) AS attempt_rank
        FROM automation_step_runs WHERE run_id = ?
      ) WHERE attempt_rank = 1 AND stage = 'delivery'
        AND status = 'succeeded'
        AND NOT (provider = 'bot-message' AND capability = 'publish-connected')
    `).get(runId) as { count: number };
    const outcome = successfulBotGroups > 0 || otherDelivery.count > 0
      ? "partial"
      : "failed";
    if (run.status !== outcome || run.completed_at === null) {
      this.db.prepare(`
        UPDATE automation_rule_runs
        SET status = ?, completed_at = ?, run_revision = run_revision + 1
        WHERE id = ? AND status IN ('running', 'succeeded', 'empty', 'partial')
      `).run(outcome, this.now(), runId);
    }
    return outcome;
  }

  reconcileOutstandingChannelDeliveries(): number {
    const rows = this.db.prepare(`
      SELECT DISTINCT automation_run_id AS run_id
      FROM channel_deliveries
      WHERE automation_run_id IS NOT NULL
    `).all() as Array<{ run_id: string }>;
    for (const row of rows) this.reconcileChannelDeliveries(row.run_id);
    return rows.length;
  }

  detail(
    runId: string,
    visibility: { accountId: string; profileId?: "default" },
  ): AutomationRunDetail | null {
    const row = this.db.prepare(`
      SELECT r.*
        FROM automation_rule_runs r
        JOIN automation_rules rule ON rule.id = r.rule_id
       WHERE r.id = ?
         AND (
              (rule.owner_type = 'account' AND rule.account_id = ?)
           OR (rule.owner_type = 'local_profile' AND rule.owner_profile_id = ?)
         )
    `).get(runId, visibility.accountId, visibility.profileId ?? "default") as
      | RunRow
      | undefined;
    if (!row) return null;

    const expired = row.expires_at
      ? row.expires_at <= this.now()
      : false;
    const manifest = expired ? undefined : this.readManifest(runId);
    const result = expired ? undefined : this.readResult(row.result_envelope_id);
    const accountScope = parseJson<AutomationAccountScope>(
      row.account_scope_json,
      {
        type: "currentAccount",
        accountId: row.account_id,
      },
    );
    const resolvedAccountIds = parseJson<string[]>(
      row.resolved_accounts_json,
      [row.account_id],
    );
    const ruleOwner = this.db
      .prepare(
        "SELECT owner_type, owner_profile_id, schema_version, current_version, enabled, archived_at FROM automation_rules WHERE id = ?",
      )
      .get(row.rule_id) as {
      owner_type: "account" | "local_profile";
      owner_profile_id: string | null;
      schema_version: number;
      current_version: number;
      enabled: number;
      archived_at: string | null;
    };
    const runningStep = this.db.prepare(
      "SELECT 1 FROM automation_step_runs WHERE run_id = ? AND status = 'running' LIMIT 1",
    ).get(runId);
    const ruleAllowsRetry = ruleOwner.schema_version === 2 && ruleOwner.enabled === 1 &&
      !ruleOwner.archived_at && ruleOwner.current_version === (row.rule_version ?? 1) &&
      row.status !== "running" && !runningStep && !!manifest;
    const steps = expired ? [] : this.readSteps(runId).map((step) => ({
      ...step,
      retrySafe: step.retrySafe && ruleAllowsRetry,
      warnings: step.status === "running"
        ? [...step.warnings, "步骤结果尚未确认；如果执行被中断，请先核实是否已产生副作用。"]
        : step.warnings,
    }));
    const outcome = mapOutcome(row.status);
    const scheduledPrefix = `${row.rule_id}:${row.rule_version ?? 1}:`;
    const scheduledValue = row.planned_occurrence_key?.startsWith(scheduledPrefix)
      ? row.planned_occurrence_key.slice(scheduledPrefix.length) : undefined;
    const plannedAt = scheduledValue && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(scheduledValue) && Number.isFinite(Date.parse(scheduledValue))
      ? scheduledValue : undefined;
    const recoveryActions = steps.flatMap((step) => step.retrySafe
      ? [{
          id: `retry:${runId}:${step.stepId}`,
          type: step.stage === "delivery" ? "retry_delivery" as const : "retry_step" as const,
          label: step.stage === "delivery" ? "重试投递" : "重试此步骤",
          runId,
          stepId: step.stepId,
          requiresConfirmation: step.stage === "delivery",
        }]
      : []);

    return {
      id: row.id,
      ruleId: row.rule_id,
      ruleVersion: row.rule_version ?? 1,
      owner:
        ruleOwner.owner_type === "local_profile"
          ? { type: "localProfile", profileId: "default" }
          : { type: "account", accountId: row.account_id },
      accountScope,
      resolvedAccountIds,
      dryRun: row.dry_run === 1,
      outcome,
      plannedAt,
      startedAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      delayed: plannedAt ? Date.parse(row.created_at) - Date.parse(plannedAt) > 60_000 : undefined,
      inputCount: row.matched_count,
      resultCount: row.applied_count,
      truncated: manifest?.truncated ?? false,
      deliveries: projectDeliveries(this.db, runId, steps),
      revision: row.run_revision,
      occurrenceKey: row.planned_occurrence_key ?? undefined,
      window:
        row.planned_window_start && row.planned_window_end
          ? {
              start: row.planned_window_start,
              end: row.planned_window_end,
              timezone: readTimezone(accountScope),
            }
          : undefined,
      template:
        row.template_id &&
        row.template_version &&
        row.template_hash &&
        row.renderer_id &&
        row.renderer_version
          ? {
              templateId: row.template_id,
              templateVersion: row.template_version,
              templateHash: row.template_hash,
              resultSchemaId: result?.resultType ?? "unknown",
              resultSchemaVersion: result?.schemaVersion ?? 1,
              rendererId: row.renderer_id,
              rendererVersion: row.renderer_version,
              configuration: {},
            }
          : undefined,
      pipelineHash: row.pipeline_hash ?? undefined,
      recipeHashes: row.recipe_hash
        ? { combined: row.recipe_hash }
        : undefined,
      capabilityFingerprints: steps
        .map((step) => step.capabilityFingerprint)
        .filter((value): value is string => !!value),
      renderer:
        row.renderer_id && row.renderer_version
          ? { id: row.renderer_id, version: row.renderer_version }
          : undefined,
      manifest,
      manifestAvailability: expired
        ? "expired"
        : manifest
          ? "available"
          : "missing",
      result,
      resultAvailability: expired
        ? "expired"
        : result
          ? "available"
          : "missing",
      output: expired ? undefined : this.readLatestOutput(runId),
      steps,
      recoveryActions,
      warnings: expired
        ? ["运行明细已超过本地保留期，仅保留运行摘要。"]
        : [],
    };
  }

  progress(
    runId: string,
    visibility: { accountId: string; profileId?: "default" },
    afterRevision: number,
    expectedRuleId?: string,
  ): { changed: boolean; revision: number; detail?: AutomationRunDetail } | null {
    const detail = this.detail(runId, visibility);
    if (!detail || (expectedRuleId && detail.ruleId !== expectedRuleId)) return null;
    return detail.revision <= afterRevision
      ? { changed: false, revision: detail.revision }
      : { changed: true, revision: detail.revision, detail };
  }

  canRetryStep(
    runId: string,
    stepId: string,
    currentFingerprint: string | undefined,
  ):
    | { ok: true; step: Record<string, unknown> }
    | { ok: false; code: string; message: string } {
    const active = this.db.prepare(`
      SELECT 1 FROM automation_rule_runs WHERE id = ? AND status = 'running'
      UNION ALL
      SELECT 1 FROM automation_step_runs WHERE run_id = ? AND status = 'running'
      LIMIT 1
    `).get(runId, runId);
    if (active) return { ok: false, code: "run-in-progress", message: "运行仍在执行或结果尚未确认，暂不能重试。" };
    const row = this.db
      .prepare(
        `SELECT * FROM automation_step_runs
          WHERE run_id = ? AND step_id = ?
          ORDER BY run_revision DESC, rowid DESC LIMIT 1`,
      )
      .get(runId, stepId) as Record<string, unknown> | undefined;
    if (!row) {
      return { ok: false, code: "missing-step", message: "找不到需要重试的步骤。" };
    }
    if (row.status !== "failed") {
      return { ok: false, code: "step-not-failed", message: "只有失败步骤可以重试。" };
    }
    const retry = parseJson<{ retrySafe?: boolean }>(
      row.retry_safety_json as string | null,
      {},
    );
    if (!retry.retrySafe) {
      return {
        ok: false,
        code: "uncertain-side-effect",
        message: "无法证明上次执行没有产生副作用，已拒绝自动重试。",
      };
    }
    if (
      currentFingerprint &&
      row.capability_fingerprint !== currentFingerprint
    ) {
      return {
        ok: false,
        code: "capability-changed",
        message: "执行能力已变化，请发起一次新运行。",
      };
    }
    const manifest = this.db
      .prepare(
        "SELECT expires_at FROM automation_run_manifests WHERE run_id = ?",
      )
      .get(runId) as { expires_at: string | null } | undefined;
    if (!manifest) {
      return { ok: false, code: "missing-input", message: "原始输入清单不存在。" };
    }
    if (manifest.expires_at && manifest.expires_at <= this.now()) {
      return { ok: false, code: "expired-input", message: "原始输入清单已过期。" };
    }
    return { ok: true, step: row };
  }

  private advanceRevision(runId: string): number {
    this.db
      .prepare(
        "UPDATE automation_rule_runs SET run_revision = run_revision + 1 WHERE id = ?",
      )
      .run(runId);
    return (
      this.db
        .prepare("SELECT run_revision AS revision FROM automation_rule_runs WHERE id = ?")
        .get(runId) as { revision: number }
    ).revision;
  }

  private readManifest(runId: string): AutomationInputManifest | undefined {
    const header = this.db
      .prepare("SELECT * FROM automation_run_manifests WHERE run_id = ?")
      .get(runId) as
      | {
          per_account_counts_json: string;
          item_count: number;
          created_at: string;
          expires_at: string | null;
        }
      | undefined;
    if (!header) return undefined;
    const rows = this.db
      .prepare(
        `SELECT account_id, reference_id, occurred_at, selection_reason,
                content_hash
           FROM automation_run_manifest_items
          WHERE run_id = ? ORDER BY ordinal`,
      )
      .all(runId) as Array<{
      account_id: string;
      reference_id: string;
      occurred_at: string;
      selection_reason: string;
      content_hash: string;
    }>;
    return {
      version: 1,
      items: rows.map((row) => ({
        accountId: row.account_id,
        emailId: row.reference_id,
        receivedAt: row.occurred_at,
        contentHash: row.content_hash,
        selectedReasons: [row.selection_reason],
      })),
      accountCounts: parseJson(header.per_account_counts_json, {}),
      globalLimit: header.item_count,
      perAccountLimit: header.item_count,
      truncated: false,
      frozenAt: header.created_at,
      expiresAt: header.expires_at ?? undefined,
    };
  }

  private readResult(
    id: string | null,
  ): AutomationRunResultEnvelope | undefined {
    if (!id) return undefined;
    const row = this.db
      .prepare(
        "SELECT result_json FROM automation_result_envelopes WHERE id = ?",
      )
      .get(id) as { result_json: string | null } | undefined;
    return row?.result_json
      ? parseJson<AutomationRunResultEnvelope | undefined>(
          row.result_json,
          undefined,
        )
      : undefined;
  }

  private readSteps(runId: string): AutomationStepDetail[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY step_id ORDER BY run_revision DESC, rowid DESC
           ) AS attempt_rank
           FROM automation_step_runs WHERE run_id = ?
         ) WHERE attempt_rank = 1 ORDER BY sequence, run_revision`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const retry = parseJson<{ retrySafe?: boolean }>(
        row.retry_safety_json as string | null,
        {},
      );
      const error = parseJson<{ code?: string; message?: string } | undefined>(
        row.error_json as string | null,
        undefined,
      );
      const delivery = parseJson<AutomationStepDetail["delivery"]>(
        row.delivery_destination_json as string | null,
        undefined,
      );
      const expiresAt =
        typeof row.expires_at === "string" ? row.expires_at : undefined;
      return {
        id: String(row.id),
        stepId: String(row.step_id),
        stage: normalizeStage(row.stage),
        capabilityId: String(row.capability),
        capabilityFingerprint: String(row.capability_fingerprint),
        status: normalizeStepStatus(row.status),
        startedAt:
          typeof row.started_at === "string" ? row.started_at : undefined,
        completedAt:
          typeof row.completed_at === "string" ? row.completed_at : undefined,
        durationMs:
          typeof row.duration_ms === "number" ? row.duration_ms : undefined,
        inputSummary: parseJson(
          row.input_summary_json as string | null,
          undefined,
        ),
        outputSummary: parseJson(
          row.output_summary_json as string | null,
          undefined,
        ),
        warnings: parseJson<string[]>(
          row.warnings_json as string | null,
          [],
        ),
        sideEffects: parseJson<Array<{ summary?: string }> | string[]>(
          row.side_effects_json as string | null,
          [],
        ).map((item) =>
          typeof item === "string" ? item : item.summary ?? "已记录副作用",
        ),
        retrySafe: retry.retrySafe === true,
        error:
          error?.code && error.message
            ? { code: error.code, message: error.message }
            : undefined,
        delivery,
        retention: {
          class: "detail",
          expiresAt,
          status: expiresAt && expiresAt <= this.now() ? "expired" : "available",
        },
      };
    });
  }

  private readLatestOutput(runId: string): AutomationRunDetail["output"] {
    const message = this.db.prepare(`
      SELECT id, title, preview, artifact_id, artifact_version
        FROM application_messages
       WHERE source_run_id = ? AND archived_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
    `).get(runId) as {
      id: string;
      title: string;
      preview: string;
      artifact_id: string | null;
      artifact_version: number | null;
    } | undefined;
    if (message) {
      return {
        type: "application_message",
        id: message.id,
        title: message.title,
        preview: message.preview,
        artifactId: message.artifact_id ?? undefined,
        artifactVersion: message.artifact_version ?? undefined,
        availability: "available",
      };
    }
    const artifact = this.db.prepare(`
      SELECT id, version, title, preview
        FROM message_artifacts
       WHERE source_run_id = ?
       ORDER BY created_at DESC
       LIMIT 1
    `).get(runId) as {
      id: string;
      version: number;
      title: string;
      preview: string;
    } | undefined;
    return artifact
      ? {
          type: "artifact",
          title: artifact.title,
          preview: artifact.preview,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          availability: "available",
        }
      : undefined;
  }
}

function projectDeliveries(
  db: MailDatabase,
  runId: string,
  steps: AutomationStepDetail[],
) {
  const ledger = projectAutomationDeliveries(db, runId);
  if (ledger.length > 0) return ledger;
  return steps
    .map((step) => step.delivery)
    .filter((delivery) => delivery !== undefined);
}

function buildManifest(
  rule: AutomationRuleV2,
  collection: Record<string, unknown>,
  frozenAt: string,
): AutomationInputManifest {
  const messagesContainer = collection.messages;
  const messages =
    messagesContainer &&
    typeof messagesContainer === "object" &&
    Array.isArray((messagesContainer as Record<string, unknown>).messages)
      ? ((messagesContainer as Record<string, unknown>).messages as Array<
          Record<string, unknown>
        >)
      : [];
  const items: AutomationInputManifestItem[] = messages
    .filter(
      (message) =>
        typeof message.accountId === "string" &&
        typeof message.emailId === "string",
    )
    .slice(0, 5_000)
    .map((message) => ({
      accountId: String(message.accountId),
      emailId: String(message.emailId),
      receivedAt:
        typeof message.receivedAt === "string"
          ? message.receivedAt
          : frozenAt,
      contentHash: manifestItemContentHash({
        accountId: String(message.accountId),
        emailId: String(message.emailId),
        subject:
          typeof message.subject === "string" ? message.subject : undefined,
      }),
      selectedReasons: ["matched-confirmed-rule"],
    }));
  const accountCounts: AutomationInputManifest["accountCounts"] = {};
  for (const item of items) {
    const counts = accountCounts[item.accountId] ?? {
      scanned: 0,
      selected: 0,
      excluded: 0,
    };
    counts.scanned += 1;
    counts.selected += 1;
    accountCounts[item.accountId] = counts;
  }
  return {
    version: 1,
    items,
    accountCounts,
    globalLimit: 5_000,
    perAccountLimit: Math.max(1, Math.ceil(5_000 / Math.max(1, Object.keys(accountCounts).length))),
    truncated: messages.length > items.length,
    frozenAt,
    expiresAt: new Date(Date.parse(frozenAt) + DETAIL_RETENTION_MS).toISOString(),
  };
}

function persistManifest(
  db: MailDatabase,
  runId: string,
  manifest: AutomationInputManifest,
): void {
  db.prepare(`
    INSERT INTO automation_run_manifests (
      run_id, account_scope_json, per_account_counts_json, item_count,
      content_hash, retention_class, created_at, expires_at
    ) VALUES (?, '{}', ?, ?, ?, 'detail_30d', ?, ?)
  `).run(
    runId,
    JSON.stringify(manifest.accountCounts),
    manifest.items.length,
    hash(manifest),
    manifest.frozenAt,
    manifest.expiresAt ?? null,
  );
  const insert = db.prepare(`
    INSERT INTO automation_run_manifest_items (
      run_id, ordinal, account_id, reference_type, reference_id,
      parent_reference_id, occurred_at, selection_reason, content_hash,
      metadata_json
    ) VALUES (?, ?, ?, 'mail', ?, NULL, ?, ?, ?, '{}')
  `);
  manifest.items.forEach((item, ordinal) => {
    insert.run(
      runId,
      ordinal,
      item.accountId,
      item.emailId,
      item.receivedAt,
      item.selectedReasons.join(","),
      item.contentHash,
    );
  });
}

function readWindow(
  collection: Record<string, unknown>,
): { start?: string; end?: string } | undefined {
  const value = collection.window;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    start:
      typeof record.start === "string"
        ? record.start
        : typeof record.from === "string"
          ? record.from
          : undefined,
    end:
      typeof record.end === "string"
        ? record.end
        : typeof record.to === "string"
          ? record.to
          : undefined,
  };
}

function resolveAccountIds(
  rule: AutomationRuleV2,
  manifest: AutomationInputManifest,
  collection?: Record<string, unknown>,
): string[] {
  const declared =
    collection &&
    Array.isArray(collection.accountIds)
      ? collection.accountIds.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
  if (declared.length > 0) return [...new Set(declared)];
  const fromManifest = [...new Set(manifest.items.map((item) => item.accountId))];
  if (fromManifest.length > 0) return fromManifest;
  if (rule.accountScope?.type === "selectedAccounts") {
    return rule.accountScope.accountIds;
  }
  return [rule.accountId];
}

function normalizeStage(value: unknown): AutomationWorkflowStage {
  return value === "trigger" ||
    value === "data" ||
    value === "analysis" ||
    value === "artifact" ||
    value === "delivery"
    ? value
    : "analysis";
}

export function stageForStep(step: AutomationPipelineStep): AutomationWorkflowStage {
  const value = `${step.provider}.${step.capability}.${step.name ?? ""}`.toLowerCase();
  if (/deliver|publish|send|notify|bot|message/.test(value)) return "delivery";
  if (/artifact|chart|html|image|report|design|render/.test(value)) return "artifact";
  if (/search|read|mail|collect|source|attachment/.test(value)) return "data";
  return "analysis";
}

export function manifestItemContentHash(input: {
  accountId: string;
  emailId: string;
  subject?: string;
}): string {
  return hash(input);
}

function normalizeStepStatus(value: unknown): AutomationStepDetail["status"] {
  return value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped"
    ? value
    : "failed";
}

function mapOutcome(value: string | null): AutomationRunOutcome {
  return value === "running" ||
    value === "succeeded" ||
    value === "empty" ||
    value === "partial" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "outcome_unknown"
    ? value
    : "outcome_unknown";
}

function readTimezone(scope: { type: string }): string {
  return "timezone" in scope && typeof scope.timezone === "string"
    ? scope.timezone
    : "Asia/Shanghai";
}

function sanitizeResult(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[bounded]";
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeResult(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/body|html|credential|token|secret|password|authorization/i.test(key))
        .slice(0, 100)
        .map(([key, item]) => [key, sanitizeResult(item, depth + 1)]),
    );
  }
  return typeof value === "string" ? value.slice(0, 4_000) : value;
}

function normalizeEnvelopeValue(value: AutomationValue): {
  data: unknown;
  provenance: AutomationProvenance[];
  actionCandidates: AutomationActionCandidate[];
} {
  const data = value.type === "scalar" ? value.value : value;
  if (!isSubscriptionInsightResult(data)) {
    return { data, provenance: [], actionCandidates: [] };
  }
  const provenance: AutomationProvenance[] = [];
  data.topHighlights.forEach((highlight, index) => {
    provenance.push({
      outputPath: `topHighlights.${index}`,
      sources: highlight.sourceEmails,
      operation: "subscription-insight-highlight",
    });
  });
  data.curatedCategories.forEach((category, categoryIndex) => {
    category.items.forEach((item, itemIndex) => {
      provenance.push({
        outputPath: `curatedCategories.${categoryIndex}.items.${itemIndex}`,
        sources: item.sourceEmails,
        operation: "subscription-insight-group",
      });
    });
  });
  return {
    data,
    provenance: provenance.slice(0, 200),
    actionCandidates: data.recommendedActions.slice(0, 20),
  };
}

function isSubscriptionInsightResult(
  value: unknown,
): value is SubscriptionInsightResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "subscriptionDailyInsight" &&
    record.schemaVersion === 1 &&
    Array.isArray(record.topHighlights) &&
    Array.isArray(record.curatedCategories) &&
    Array.isArray(record.recommendedActions)
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
