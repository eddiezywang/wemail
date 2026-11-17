import { randomUUID } from "node:crypto";
import type { AutomationStepResult } from "./providers/AutomationProvider.js";
import type { MailDatabase } from "../database/Database.js";

export class AutomationStepRunRepository {
  constructor(private readonly db: MailDatabase) {}

  start(input: {
    runId: string;
    ruleId: string;
    ruleVersion: number;
    stepId: string;
    provider: string;
    capability: string;
    capabilityFingerprint?: string;
    stage?: string;
    sequence?: number;
    runRevision?: number;
    inputSummary?: unknown;
    startedAt?: string;
  }): string {
    const id = `automation-step-${randomUUID()}`;
    this.db.prepare(`INSERT INTO automation_step_runs (
      id, run_id, rule_id, rule_version, step_id, provider, capability,
      capability_fingerprint, status, input_summary_json, output_json, warnings_json,
      side_effects_json, error_json, external_audit_id, started_at, completed_at,
      duration_ms, stage, sequence, run_revision, retry_safety_json,
      effect_evidence_json, retention_class, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, '[]',
              '[]', NULL, NULL, ?, ?, 0, ?, ?, ?, ?, ?, 'detail_30d', ?)`).run(
      id, input.runId, input.ruleId, input.ruleVersion, input.stepId,
      input.provider, input.capability, input.capabilityFingerprint ?? "pending",
      input.inputSummary === undefined ? null : boundedJson(input.inputSummary),
      input.startedAt ?? new Date().toISOString(),
      input.startedAt ?? new Date().toISOString(),
      input.stage ?? null,
      input.sequence ?? 0,
      input.runRevision ?? 0,
      boundedJson({ retrySafe: false, reason: "step-running" }),
      boundedJson({ state: "not_observed" }),
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
    );
    return id;
  }

  complete(
    id: string,
    input: {
      result: AutomationStepResult;
      runRevision?: number;
      outputSummary?: unknown;
      usage?: unknown;
      deliveryDestination?: unknown;
    },
  ): void {
    const sideEffects = input.result.sideEffects;
    const retrySafe =
      input.result.error?.retrySafe === true && sideEffects.length === 0;
    this.db.prepare(`UPDATE automation_step_runs SET
      provider = ?, capability = ?, capability_fingerprint = ?, status = ?,
      output_json = ?, output_summary_json = ?, warnings_json = ?,
      side_effects_json = ?, error_json = ?, external_audit_id = ?,
      started_at = ?, completed_at = ?, duration_ms = ?, run_revision = ?,
      usage_json = ?, retry_safety_json = ?, effect_evidence_json = ?,
      delivery_destination_json = ?
      WHERE id = ?`).run(
      input.result.audit.provider,
      input.result.audit.capability,
      input.result.audit.capabilityFingerprint,
      input.result.status,
      input.result.output === undefined ? null : boundedJson(input.result.output),
      input.outputSummary === undefined
        ? null
        : boundedJson(input.outputSummary),
      boundedJson(input.result.warnings),
      boundedJson(sideEffects),
      input.result.error ? boundedJson(redactError(input.result.error)) : null,
      input.result.audit.externalAuditId ?? null,
      input.result.audit.startedAt,
      input.result.audit.completedAt,
      input.result.audit.durationMs,
      input.runRevision ?? 0,
      input.usage === undefined ? null : boundedJson(input.usage),
      boundedJson({
        retrySafe,
        retryable: input.result.error?.retryable ?? false,
        reason: retrySafe
          ? "provider-declared-safe-and-no-side-effect"
          : "side-effect-or-provider-did-not-prove-safety",
      }),
      boundedJson({
        externalAuditId: input.result.audit.externalAuditId,
        observedSideEffectCount: sideEffects.length,
        state: sideEffects.length === 0 ? "none_observed" : "observed",
      }),
      input.deliveryDestination === undefined
        ? null
        : boundedJson(input.deliveryDestination),
      id,
    );
  }

  markOutcomeUnknown(id: string, runRevision: number, completedAt: string): void {
    this.db.prepare(`UPDATE automation_step_runs SET
      status = 'failed', completed_at = ?, run_revision = ?,
      error_json = ?, warnings_json = ?, retry_safety_json = ?
      WHERE id = ? AND status = 'running'`).run(
      completedAt, runRevision,
      JSON.stringify({ code: "outcome-unknown", message: "执行中断，结果尚未确认。" }),
      JSON.stringify(["请先核实是否已产生副作用。"]),
      JSON.stringify({ retrySafe: false, reason: "outcome-unknown" }),
      id,
    );
  }

  record(input: { runId: string; ruleId: string; ruleVersion: number; stepId: string; inputSummary?: unknown; result: AutomationStepResult; stage?: string; sequence?: number; runRevision?: number }): string {
    const id = this.start({
      runId: input.runId,
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      stepId: input.stepId,
      provider: input.result.audit.provider,
      capability: input.result.audit.capability,
      capabilityFingerprint: input.result.audit.capabilityFingerprint,
      stage: input.stage,
      sequence: input.sequence,
      runRevision: input.runRevision,
      inputSummary: input.inputSummary,
      startedAt: input.result.audit.startedAt,
    });
    this.complete(id, {
      result: input.result,
      runRevision: input.runRevision,
    });
    return id;
  }

  list(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM automation_step_runs WHERE run_id = ? ORDER BY run_revision, rowid").all(runId) as Array<Record<string, unknown>>;
  }
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= 32_000
    ? json
    : JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json) });
}

function redactError(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      typeof item === "string"
        ? item
            .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
            .replace(
              /\b(?:password|token|secret|authorization)\s*[:=]\s*\S+/gi,
              "$1=[REDACTED]",
            )
            .replace(/[A-Za-z]:\\[^\s]+/g, "[REDACTED_PATH]")
            .slice(0, 2_000)
        : item,
    ]),
  );
}
