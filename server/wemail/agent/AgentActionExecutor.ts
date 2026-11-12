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
