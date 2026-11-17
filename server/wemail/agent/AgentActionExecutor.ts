import type { AgentPendingActionRow } from "./AgentPendingActionRepository.js";

export interface AgentActionExecutionContext {
  accountId?: string;
}

export interface AgentActionExecutionItem {
  filename?: string;
  ok: boolean;
  command?: string;
  binary?: string;
  resolvedBinary?: string;
  args?: string[];
  errorCode?: string;
  exitCode?: number;
  auditId?: string;
  messageId?: string;
  deliveryStatus?: "sent" | "partial";
  accepted?: string[];
  rejected?: string[];
  localRecordPersisted?: boolean;
  draftDeleted?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  warning?: string;
  /** A submission was attempted; retained without storing command output. */
  externalSubmission?: boolean;
}

export interface AgentActionExecutionResult {
  ok: boolean;
  summary: string;
  successCount?: number;
  failureCount?: number;
  items?: AgentActionExecutionItem[];
}

/**
 * Executes a previously-proposed high-risk action after the user confirms
 * it. Implementations are responsible for the actual side effect — sending
 * mail, deleting, archiving, marking spam, etc. Legacy synchronous actions
 * settle failures in the route; invoice uploads use the edition's durable
 * action-execution module (see allowancePort.ts).
 *
 * The pending-action route refuses to confirm when no executor is wired
 * (returns 501) so that "confirmed" never decays into a silent no-op.
 */
export interface AgentActionExecutor {
  execute(
    action: AgentPendingActionRow,
    context?: AgentActionExecutionContext,
  ): Promise<AgentActionExecutionResult>;
}

export function publicActionExecution(execution: AgentActionExecutionResult): AgentActionExecutionResult {
  return {
    ok: execution.ok,
    summary: execution.summary,
    ...(execution.successCount === undefined ? {} : { successCount: execution.successCount }),
    ...(execution.failureCount === undefined ? {} : { failureCount: execution.failureCount }),
    ...(execution.items ? { items: execution.items.map((item) => ({
      ok: item.ok,
      ...(item.filename ? { filename: item.filename } : {}),
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(item.deliveryStatus ? { deliveryStatus: item.deliveryStatus } : {}),
      ...(item.accepted ? { accepted: item.accepted } : {}),
      ...(item.rejected ? { rejected: item.rejected } : {}),
      ...(item.localRecordPersisted === undefined ? {} : { localRecordPersisted: item.localRecordPersisted }),
      ...(item.draftDeleted === undefined ? {} : { draftDeleted: item.draftDeleted }),
      ...((item.externalSubmission || item.command || item.auditId) ? { externalSubmission: true } : {}),
      ...(!item.ok ? { error: "操作未完成，请检查操作状态。" } : {}),
    })) } : {}),
  };
}
