import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";
import type { ActionExecutionCommand, ActionExecutionItem, ActionExecutionReply, ActionExecutionSnapshot, ActionUploadEligibility } from "../../../shared/wemail/actionExecution.js";
import { AgentPendingActionRepository, hashAgentActionParameters } from "./AgentPendingActionRepository.js";
import { AuditLogRepository } from "../telemetry/AuditLogRepository.js";
import {
  resolveActionExecutionLanePorts,
  type ActionExecutionLanePorts,
  type InvoiceStatusPort,
  type AllowanceReceiptsPort,
} from "./allowancePort.js";

interface Row {
  id: string; action_id: string; account_id: string; state: ActionExecutionSnapshot["state"];
  revision: number; generation: number; lease_owner: string | null; lease_until_ms: number | null;
  created_at_ms: number;
}
const LEASE_MS = 90_000;

/** Mutations run on the DB writer; snapshot reads use a consistent read-only transaction. */
export class ActionExecutionRepository {
  private readonly receipts: AllowanceReceiptsPort;
  private readonly invoiceStatuses: InvoiceStatusPort | undefined;

  constructor(
    private readonly db: MailDatabase,
    private readonly now = Date.now,
    ports?: Partial<ActionExecutionLanePorts>,
  ) {
    // P2.6: receipt parsing and the invoice status store are edition
    // modules. Defaults resolve the build-time registration
    // (`EditionModules.allowance`), which also reaches the DB reader/writer
    // worker lanes; the open edition resolves to no-op receipts and no
    // store. Explicit injection keeps tests deterministic.
    const resolved = resolveActionExecutionLanePorts(db);
    this.receipts = ports?.receipts ?? resolved.receipts;
    this.invoiceStatuses = ports?.invoiceStatuses ?? resolved.invoiceStatuses;
  }

  dispatch(command: ActionExecutionCommand): ActionExecutionReply {
    return this.db.transaction(() => this.apply(command))();
  }

  private apply(c: ActionExecutionCommand): ActionExecutionReply {
    if (c.op === "audit") return new AuditLogRepository(this.db).record(c.entry);
    if (c.op === "preflight") return { eligibility: c.items.map((item) => ({ ...item, reason: this.uploadBlockReason(c.accountId, item) })) };
    if (c.op === "get") {
      const row = this.db.prepare("SELECT * FROM agent_action_executions WHERE action_id = ? AND account_id = ?")
        .get(c.actionId, c.accountId) as Row | undefined;
      return row ? this.snapshot(row) : null;
    }
    if (c.op === "accept") {
      const pending = new AgentPendingActionRepository({ db: this.db, now: () => new Date(this.now()).toISOString() });
      const action = pending.getById(c.actionId);
      if (!action || pending.getAccountIdFor(c.actionId) !== c.accountId) throw new Error("action-not-owned");
      if (action.action_type !== "upload_allowance_invoices" || action.mcp_operation_id) throw new Error("unsupported-durable-action");
      const reservation = pending.reserveExecution({ id: c.actionId, idempotencyKey: c.idempotencyKey, parameters: c.parameters });
      const previous = this.db.prepare("SELECT * FROM agent_action_executions WHERE action_id = ?").get(c.actionId) as Row | undefined;
      if (reservation.kind === "duplicate" && previous) return this.snapshot(previous);
      if (reservation.kind !== "reserved") throw new Error(`action-${reservation.kind}`);
      const input = JSON.parse(action.input_json) as { items?: unknown };
      const shown = c.parameters.items;
      if (!Array.isArray(input.items) || !Array.isArray(shown) || input.items.length < 1 || input.items.length > 20 ||
          hashAgentActionParameters(input) !== hashAgentActionParameters(c.parameters)) throw new Error("action-parameter-mismatch");
      const items = input.items as Array<{ emailId?: unknown; attachmentId?: unknown; filename?: unknown }>;
      if (items.some((item) => !item || typeof item.emailId !== "string" || typeof item.attachmentId !== "string")) throw new Error("invalid-action-items");
      if (new Set(items.map((item) => `${item.emailId}\0${item.attachmentId}`)).size !== items.length) throw new Error("duplicate-action-items");
      if (items.some((item) => this.uploadBlockReason(c.accountId, { emailId: item.emailId as string, attachmentId: item.attachmentId as string }) === "in_progress")) {
        throw new Error("action-upload-list-stale");
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO agent_action_executions(id, action_id, account_id, state, created_at_ms) VALUES (?, ?, ?, 'queued', ?)")
        .run(id, c.actionId, c.accountId, this.now());
      for (const [index, item] of items.entries()) {
        const data: ActionExecutionItem = { index, emailId: item.emailId as string, attachmentId: item.attachmentId as string,
          ...(typeof item.filename === "string" ? { filename: item.filename.slice(0, 500) } : {}),
          allowNonPdf: c.parameters.includeNonPdf === true, retryUnverified: c.parameters.retryUnverified === true, phase: "queued" };
        const processed = this.priorProcessed(c.accountId, data);
        if (processed) Object.assign(data, processed, { phase: "succeeded" });
        else if (!data.retryUnverified && this.uploadBlockReason(c.accountId, data) === "pending_verification") {
          data.phase = "outcome_unknown";
          data.error = "历史提交结果待核实，本次未重复上传。";
        }
        this.db.prepare("INSERT INTO agent_action_execution_items(execution_id,item_index,account_id,phase,data_json) VALUES (?,?,?,?,?)")
          .run(id, index, c.accountId, data.phase, JSON.stringify(data));
      }
      return this.publish(this.row(id));
    }
    if (c.op === "nextDue") {
      const running = this.db.prepare("SELECT MIN(lease_until_ms) AS due FROM agent_action_executions WHERE state = 'running'").get() as { due: number | null };
      if (running.due !== null) return Number(running.due);
      return this.db.prepare("SELECT 1 FROM agent_action_executions WHERE state = 'queued' LIMIT 1").get() ? this.now() : null;
    }
    if (c.op === "claim") {
      if (this.db.prepare("SELECT 1 FROM agent_action_executions WHERE state = 'running' AND lease_until_ms > ? LIMIT 1").get(this.now())) return null;
      this.recoverDuplicateFailures();
      this.recoverAuthenticationFailures();
      this.recoverRejectedReceipts();
      const row = this.db.prepare(`SELECT * FROM agent_action_executions WHERE state = 'queued' OR (state = 'running' AND lease_until_ms <= ?)
        ORDER BY created_at_ms LIMIT 1`).get(this.now()) as Row | undefined;
      if (!row) return null;
      for (const item of this.snapshot(row).items) {
        if (item.phase === "submitting" || item.phase === "verifying") this.saveItem(row, { ...item, phase: "outcome_unknown", error: "上次提交中断，需核对平台结果，未自动重传。" });
        else if (item.phase === "preparing") this.saveItem(row, { ...item, phase: "queued" });
      }
      this.db.prepare("UPDATE agent_action_executions SET state='running',generation=generation+1,lease_owner=?,lease_until_ms=?,revision=revision+1 WHERE id=?")
        .run(c.owner, this.now() + LEASE_MS, row.id);
      return this.publish(this.row(row.id));
    }
    const row = this.row(c.id);
    if (row.state !== "running" || row.lease_owner !== c.owner || Number(row.generation) !== c.generation || Number(row.lease_until_ms) <= this.now()) throw new Error("action-lease-lost");
    if (c.op === "receipt") return { receipt: this.uploadReceipt(c.auditId)?.receipt ?? null };
    if (c.op === "renew") {
      this.db.prepare("UPDATE agent_action_executions SET lease_until_ms=? WHERE id=?").run(this.now() + LEASE_MS, row.id);
      return true;
    }
    if (c.op === "update") {
      const old = this.snapshot(row).items.find((item) => item.index === c.index);
      if (!old) throw new Error("action-item-not-found");
      const allowed: Record<ActionExecutionItem["phase"], string[]> = {
        queued: ["preparing", "failed"], preparing: ["submitting", "failed"],
        submitting: ["verifying", "succeeded", "failed", "outcome_unknown"], verifying: ["succeeded", "outcome_unknown"], succeeded: [], failed: [], outcome_unknown: [],
      };
      if (!allowed[old.phase].includes(c.phase)) throw new Error("invalid-action-transition");
      if (c.phase === "submitting") {
        if (!c.sha256) throw new Error("missing-content-hash");
        const processed = this.priorProcessed(row.account_id, old);
        const legacyUnknown = this.db.prepare(`SELECT 1 FROM agent_action_legacy_submissions
          WHERE account_id=? AND email_id=? AND attachment_id=?`)
          .get(row.account_id, old.emailId, old.attachmentId);
        const duplicate = this.db.prepare(`SELECT phase,data_json FROM agent_action_execution_items WHERE account_id=? AND sha256=?
          AND phase IN ('submitting','verifying','succeeded','outcome_unknown') AND NOT (execution_id=? AND item_index=?)
          ORDER BY CASE phase WHEN 'succeeded' THEN 0 WHEN 'outcome_unknown' THEN 2 ELSE 1 END LIMIT 1`)
          .get(row.account_id, c.sha256, row.id, c.index) as { phase: string; data_json: string } | undefined;
        const blocksRetry = duplicate && (duplicate.phase !== "outcome_unknown" || !old.retryUnverified);
        if (processed || (legacyUnknown && !old.retryUnverified) || blocksRetry) {
          const previous = duplicate?.phase === "succeeded" ? JSON.parse(duplicate.data_json) as ActionExecutionItem : undefined;
          const prior: Pick<ActionExecutionItem, "alreadyProcessed" | "invoiceId" | "invoiceNumber"> | null = processed ?? (previous ? { alreadyProcessed: previous.alreadyProcessed ?? "uploaded",
            invoiceId: previous.invoiceId, invoiceNumber: previous.invoiceNumber } : null);
          this.saveItem(row, prior ? { ...old, sha256: c.sha256, ...prior, phase: "succeeded" }
            : { ...old, sha256: c.sha256, phase: "outcome_unknown", error: "相同附件已有提交记录，结果待核实，本次未重复上传。" });
          this.db.prepare("UPDATE agent_action_executions SET revision=revision+1 WHERE id=?").run(row.id);
          return this.publish(this.row(row.id));
        }
      }
      const { op: _op, id: _id, owner: _owner, generation: _generation, ...patch } = c;
      this.saveItem(row, { ...old, ...patch });
      if (c.phase === "succeeded") {
        if (!c.invoiceId) throw new Error("missing-platform-receipt");
        this.invoiceStatuses?.markUploaded({ accountId: row.account_id,
          emailId: old.emailId, attachmentId: old.attachmentId, filename: c.filename ?? old.filename,
          invoiceId: c.invoiceId, invoiceNumber: c.invoiceNumber });
      }
      if (c.phase === "failed" && c.auditId) {
        this.projectRejectedReceipt(row, { ...old, ...patch });
        const processed = this.priorProcessed(row.account_id, old);
        if (processed) this.saveItem(row, { ...old, ...patch, ...processed, phase: "succeeded", error: undefined });
      }
      this.db.prepare("UPDATE agent_action_executions SET revision=revision+1 WHERE id=?").run(row.id);
      return this.publish(this.row(row.id));
    }
    const items = this.snapshot(row).items;
    if (items.some((item) => ["queued", "preparing", "submitting", "verifying"].includes(item.phase))) throw new Error("action-items-not-settled");
    const state = items.some((item) => item.phase === "outcome_unknown") ? "outcome_unknown"
      : items.every((item) => item.phase === "succeeded") ? "succeeded"
      : items.some((item) => item.phase === "succeeded") ? "partially_succeeded" : "failed";
    this.db.prepare("UPDATE agent_action_executions SET state=?,lease_owner=NULL,lease_until_ms=NULL,revision=revision+1 WHERE id=?").run(state, row.id);
    const result = this.publish(this.row(row.id));
    const action = new AgentPendingActionRepository({ db: this.db }).getById(row.action_id);
    if (action?.conversation_id && this.db.prepare("SELECT 1 FROM agent_conversations WHERE id=?").get(action.conversation_id)) {
      const input = JSON.parse(action.input_json) as { continuation?: { nextGoal?: unknown } };
      if (state !== "outcome_unknown" && items.some((item) => item.phase === "succeeded") && typeof input.continuation?.nextGoal === "string") {
        const goal = input.continuation.nextGoal === "upload_done_then_query_wallet_and_plan"
          ? "查询发票平台当前余额和关联状态，并给出后续处理建议"
          : input.continuation.nextGoal.slice(0, 4000);
        const succeeded = items.filter((item) => item.phase === "succeeded").length;
        const details = items.map((item) => `${item.filename ?? `附件 ${item.index + 1}`}：${item.alreadyProcessed === "associated" ? "此前已关联账单" : item.alreadyProcessed === "uploaded" ? "此前已上传" : item.phase}${item.error ? `，${item.error}` : ""}`).join("；");
        const text = `已确认的发票上传任务 ${row.id} 已结束，已处理 ${succeeded} 个，未完成 ${items.length - succeeded} 个。逐项结果：${details}。alreadyProcessed 表示此前已上传或关联账单，本次未重复上传。请继续后续目标：${goal}。不能将未完成项说成上传成功。本次仅做只读查询；任何新的写操作必须另建确认清单，不能再次上传上述附件。`;
        this.db.prepare(`INSERT OR IGNORE INTO agent_followup_queue
          (id,conversation_id,text,attachment_ids_json,position,state,created_at,updated_at)
          SELECT ?,?,?,'[]',COALESCE(MAX(position),-1)+1,'queued',?,?
          FROM agent_followup_queue WHERE conversation_id=? AND state!='removed'`)
          .run(`action-followup:${row.id}`, action.conversation_id, text,
            new Date(this.now()).toISOString(), new Date(this.now()).toISOString(), action.conversation_id);
      }
      try {
        const execution = JSON.parse(action.execution_result_json!) as { summary: string };
        const messageId = `action-result:${row.id}`;
        const at = new Date(this.now()).toISOString();
        this.db.prepare(`INSERT INTO agent_messages(id,conversation_id,role,body_json,created_at,parts_json,markdown_source,attachment_ids_json,updated_at)
          VALUES (?,?,'assistant',?,?,?,?, '[]',?) ON CONFLICT(id) DO UPDATE SET
          body_json=excluded.body_json,parts_json=excluded.parts_json,markdown_source=excluded.markdown_source,updated_at=excluded.updated_at`).run(messageId, action.conversation_id,
          JSON.stringify({ text: execution.summary, actionResolution: { status: state === "succeeded" ? "confirmed" : "failed", execution } }), at,
          JSON.stringify([{ id: `text:${messageId}`, type: "text", markdown: execution.summary, state: "completed", citationIds: [] }]), execution.summary, at);
        this.db.prepare("UPDATE agent_conversations SET updated_at=? WHERE id=?").run(at, action.conversation_id);
      } catch {
        // The persisted task result remains authoritative when conversation presentation fails.
      }
    }
    return result;
  }

  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM agent_action_executions WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("action-execution-not-found");
    return row;
  }
  private uploadBlockReason(accountId: string, item: { emailId: string; attachmentId: string }): ActionUploadEligibility["reason"] {
    const status = this.invoiceStatuses?.get(item.emailId, item.attachmentId, accountId) ?? null;
    if (status && ["associated_self", "associated_other"].includes(status.status)) return "already_associated";
    if (status?.status === "uploaded") return "already_processed";
    const records = this.db.prepare(`SELECT phase FROM agent_action_execution_items WHERE account_id=?
      AND json_extract(data_json,'$.emailId')=? AND json_extract(data_json,'$.attachmentId')=?
      AND phase IN ('queued','preparing','submitting','verifying','succeeded','outcome_unknown')`).all(accountId, item.emailId, item.attachmentId) as { phase: string }[];
    if (records.some((record) => record.phase === "succeeded")) return "already_processed";
    if (records.some((record) => record.phase !== "outcome_unknown")) return "in_progress";
    if (records.length) return "pending_verification";
    if (this.db.prepare("SELECT 1 FROM agent_action_legacy_submissions WHERE account_id=? AND email_id=? AND attachment_id=?")
      .get(accountId, item.emailId, item.attachmentId)) return "pending_verification";
    return null;
  }
  private priorProcessed(accountId: string, item: { emailId: string; attachmentId: string }): Pick<ActionExecutionItem, "alreadyProcessed" | "invoiceId" | "invoiceNumber"> | null {
    const status = this.invoiceStatuses?.get(item.emailId, item.attachmentId, accountId) ?? null;
    if (status && ["uploaded", "associated_self", "associated_other"].includes(status.status)) {
      return { alreadyProcessed: status.status === "uploaded" ? "uploaded" : "associated", invoiceId: status.invoiceId, invoiceNumber: status.invoiceNumber };
    }
    const previous = this.db.prepare(`SELECT data_json FROM agent_action_execution_items WHERE account_id=?
      AND json_extract(data_json,'$.emailId')=? AND json_extract(data_json,'$.attachmentId')=? AND phase='succeeded' LIMIT 1`)
      .get(accountId, item.emailId, item.attachmentId) as { data_json: string } | undefined;
    if (!previous) return null;
    const data = JSON.parse(previous.data_json) as ActionExecutionItem;
    return { alreadyProcessed: data.alreadyProcessed ?? "uploaded", invoiceId: data.invoiceId, invoiceNumber: data.invoiceNumber };
  }
  private uploadReceipt(auditId: string) {
    const audit = this.db.prepare("SELECT rowid,args_json,stdout,exit_code FROM wecli_audit_logs WHERE id=?").get(auditId) as
      { rowid: number | bigint; args_json: string; stdout: string | null; exit_code: number } | undefined;
    if (!audit?.stdout || Number(audit.exit_code) !== 0) return null;
    try {
      const args = JSON.parse(audit.args_json) as string[];
      if (args[0] !== "allowance" || args[1] !== "upload") return null;
      // shortcut: inspect the last 100 upload receipts; ambiguous identity stays unknown instead of guessing.
      const previous = this.db.prepare(`SELECT stdout FROM wecli_audit_logs WHERE rowid<?
        AND json_extract(args_json,'$[0]')='allowance' AND json_extract(args_json,'$[1]')='upload'
        ORDER BY rowid DESC LIMIT 100`).all(audit.rowid) as { stdout: string | null }[];
      const known = new Set<string>();
      for (const record of previous) {
        try {
          const rows = JSON.parse(record.stdout ?? "[]");
          if (Array.isArray(rows)) for (const item of rows) if (typeof item?.taskId === "string") known.add(item.taskId);
        } catch { /* Non-JSON historical output cannot prove task identity. */ }
      }
      return { receipt: this.receipts.selectAllowanceReceipt(JSON.parse(audit.stdout), known), stdout: audit.stdout, rowid: audit.rowid };
    } catch { return null; }
  }
  private rejectedReceipt(item: ActionExecutionItem) {
    const audit = item.auditId ? this.uploadReceipt(item.auditId) : null;
    const rejected = audit?.receipt ? this.receipts.rejectedAllowanceReceipt([audit.receipt], 0) : null;
    return rejected ? { ...rejected, stdout: JSON.stringify([audit!.receipt]) } : null;
  }
  private projectRejectedReceipt(row: Row, item: ActionExecutionItem): void {
    const rejected = this.rejectedReceipt(item);
    if (!rejected) return;
    this.invoiceStatuses?.markFromUploadFailure({ accountId: row.account_id,
      emailId: item.emailId, attachmentId: item.attachmentId, filename: item.filename,
      invoiceNumber: rejected.invoiceNumber, stdout: rejected.stdout, error: rejected.error });
  }
  private recoverDuplicateFailures(): void {
    const message = "相同附件已有提交或待核实记录，本次未重复上传。";
    const rows = this.db.prepare(`SELECT DISTINCT e.* FROM agent_action_executions e
      JOIN agent_action_execution_items i ON i.execution_id=e.id
      WHERE e.state IN ('failed','partially_succeeded') AND i.phase='failed'
        AND json_extract(i.data_json,'$.error')=? LIMIT 20`).all(message) as Row[];
    for (const row of rows) {
      for (const item of this.snapshot(row).items) {
        if (item.phase !== "failed" || item.error !== message) continue;
        const processed = this.priorProcessed(row.account_id, item);
        this.saveItem(row, processed ? { ...item, ...processed, phase: "succeeded", error: undefined }
          : { ...item, phase: "outcome_unknown", error: "历史提交结果待核实，本次未重复上传。" });
      }
      // All items remain terminal; the worker only republishes the corrected result.
      this.db.prepare("UPDATE agent_action_executions SET state='queued',revision=revision+1 WHERE id=?").run(row.id);
    }
  }
  private recoverAuthenticationFailures(): void {
    const rows = this.db.prepare(`SELECT DISTINCT e.* FROM agent_action_executions e
      JOIN agent_action_execution_items i ON i.execution_id=e.id
      JOIN wecli_audit_logs a ON a.id=json_extract(i.data_json,'$.auditId')
      WHERE e.state='outcome_unknown' AND i.phase='outcome_unknown' AND a.exit_code!=0
        AND (a.exit_code=77 OR a.stderr LIKE '%AUTH_REQUIRED%' OR a.stderr LIKE '%not logged in%' OR a.stdout LIKE '%AUTH_REQUIRED%') LIMIT 20`).all() as Row[];
    for (const row of rows) {
      let changed = false;
      for (const item of this.snapshot(row).items) {
        if (item.phase !== "outcome_unknown" || !item.auditId) continue;
        const audit = this.db.prepare("SELECT exit_code AS exitCode,stdout,stderr FROM wecli_audit_logs WHERE id=?").get(item.auditId) as
          { exitCode: number; stdout?: string; stderr?: string };
        const error = this.receipts.allowanceAuthenticationFailure(audit);
        if (!error) continue;
        this.saveItem(row, { ...item, phase: "failed", error });
        changed = true;
      }
      if (changed) this.db.prepare("UPDATE agent_action_executions SET state='queued',revision=revision+1 WHERE id=?").run(row.id);
    }
  }
  private recoverRejectedReceipts(): void {
    const rows = this.db.prepare(`SELECT DISTINCT e.* FROM agent_action_executions e
      JOIN agent_action_execution_items i ON i.execution_id=e.id
      JOIN wecli_audit_logs a ON a.id=json_extract(i.data_json,'$.auditId')
      WHERE e.state='outcome_unknown' AND i.phase='outcome_unknown' AND a.exit_code=0
      LIMIT 20`).all() as Row[];
    for (const row of rows) {
      let changed = false;
      for (const item of this.snapshot(row).items) {
        if (item.phase !== "outcome_unknown") continue;
        const rejected = this.rejectedReceipt(item);
        if (rejected) {
          const { stdout: _stdout, ...fields } = rejected;
          const resolved = { ...item, ...fields, phase: "failed" as const };
          this.saveItem(row, resolved);
          this.projectRejectedReceipt(row, resolved);
          const processed = this.priorProcessed(row.account_id, resolved);
          if (processed) this.saveItem(row, { ...resolved, ...processed, phase: "succeeded", error: undefined });
          changed = true;
          continue;
        }
        const audit = item.auditId ? this.uploadReceipt(item.auditId) : null;
        if (audit?.receipt?.invoiceStatus !== "check-success" || !audit.receipt.invoiceNumber) continue;
        const queries = this.db.prepare(`SELECT stdout FROM wecli_audit_logs WHERE rowid>? AND exit_code=0
          AND json_extract(args_json,'$[0]')='allowance' AND json_extract(args_json,'$[1]')='ls'
          AND json_extract(args_json,'$[2]')='available' ORDER BY rowid DESC LIMIT 20`).all(audit.rowid) as { stdout: string | null }[];
        for (const query of queries) {
          let entries: unknown;
          try { entries = JSON.parse(query.stdout ?? "null"); } catch { continue; }
          if (!Array.isArray(entries)) continue;
          const matches = entries.filter((entry) => entry?.invoiceNumber === audit.receipt!.invoiceNumber && typeof entry.invoiceId === "string" && entry.invoiceId);
          if (matches.length !== 1) continue;
          const receipt = matches[0] as { invoiceId: string; invoiceNumber: string };
          const { error: _error, ...rest } = item;
          this.saveItem(row, { ...rest, ...receipt, phase: "succeeded" });
          this.invoiceStatuses?.markUploaded({ accountId: row.account_id,
            emailId: item.emailId, attachmentId: item.attachmentId, filename: item.filename, ...receipt });
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      const items = this.snapshot(row).items;
      if (!items.some((item) => item.phase === "outcome_unknown")) {
        for (const item of items) {
          // Resume only items explicitly recorded as never submitted by this executor.
          if (item.phase === "failed" && !item.sha256 && item.error === "前一项结果待核实，此附件尚未提交。") {
            const { error: _error, ...rest } = item;
            this.saveItem(row, { ...rest, phase: "queued" });
          }
        }
        this.db.prepare("UPDATE agent_action_executions SET state='queued',lease_owner=NULL,lease_until_ms=NULL WHERE id=?").run(row.id);
      }
      this.db.prepare("UPDATE agent_action_executions SET revision=revision+1 WHERE id=?").run(row.id);
      this.publish(this.row(row.id));
    }
  }
  private snapshot(row: Row): ActionExecutionSnapshot {
    const items = this.db.prepare("SELECT data_json FROM agent_action_execution_items WHERE execution_id=? ORDER BY item_index").all(row.id) as { data_json: string }[];
    const terminal = row.state !== "queued" && row.state !== "running";
    const completed = terminal ? this.db.prepare("SELECT execution_completed_at FROM agent_pending_actions WHERE id=?")
      .get(row.action_id) as { execution_completed_at: string | null } | undefined : undefined;
    return { planVersion: 1, id: row.id, actionId: row.action_id, accountId: row.account_id, state: row.state,
      acceptedAt: Number(row.created_at_ms),
      ...(terminal ? { completedAt: completed?.execution_completed_at ? Date.parse(completed.execution_completed_at) : this.now() } : {}),
      revision: Number(row.revision), generation: Number(row.generation), items: items.map((item) => JSON.parse(item.data_json) as ActionExecutionItem) };
  }
  private saveItem(row: Row, item: ActionExecutionItem): void {
    this.db.prepare("UPDATE agent_action_execution_items SET phase=?,sha256=?,data_json=? WHERE execution_id=? AND item_index=?")
      .run(item.phase, item.sha256 ?? null, JSON.stringify(item), row.id, item.index);
  }
  private publish(row: Row): ActionExecutionSnapshot {
    const snapshot = this.snapshot(row);
    const terminal = !["queued", "running"].includes(snapshot.state);
    const successCount = snapshot.items.filter((item) => item.phase === "succeeded").length;
    const previousCount = snapshot.items.filter((item) => item.phase === "succeeded" && item.alreadyProcessed).length;
    const unknownCount = snapshot.items.filter((item) => item.phase === "outcome_unknown").length;
    const failureCount = snapshot.items.filter((item) => item.phase === "failed").length;
    const authError = snapshot.items.find((item) => item.phase === "failed" && item.error?.startsWith("发票平台未登录"))?.error;
    const summary = snapshot.state === "queued" ? "已确认，等待执行。" : snapshot.state === "running" ? "正在处理附件。"
      : `处理结果：本次上传 ${successCount - previousCount} 个，此前已上传或已关联 ${previousCount} 个，待核实 ${unknownCount} 个，失败 ${failureCount} 个。${authError ? ` ${authError}` : ""}`;
    const result = { ok: snapshot.state === "succeeded", summary, successCount,
      failureCount: snapshot.items.filter((item) => item.phase === "failed").length, task: snapshot,
      items: snapshot.items.map((item) => ({ ...item, ok: item.phase === "succeeded" })) };
    this.db.prepare(`UPDATE agent_pending_actions SET execution_state=?,execution_result_json=?,status=?,
      execution_completed_at=?,resolved_at=? WHERE id=?`).run(terminal ? snapshot.state === "succeeded" ? "succeeded" : snapshot.state === "outcome_unknown" ? "outcome_unknown" : "failed" : "executing",
      JSON.stringify(result), terminal ? "confirmed" : "pending", terminal ? new Date(this.now()).toISOString() : null,
      terminal ? new Date(this.now()).toISOString() : null, row.action_id);
    return snapshot;
  }
}
