import type { AgentPendingAction } from "../../shared/wemail/intelligence";
import type { ActionExecutionSnapshot } from "../../shared/wemail/actionExecution";

export function applyActionExecution(action: AgentPendingAction, task: ActionExecutionSnapshot): AgentPendingAction {
  const previous = action.executionResult?.task as ActionExecutionSnapshot | undefined;
  if (previous && previous.revision > task.revision) return action;
  const active = task.state === "queued" || task.state === "running";
  return { ...action, status: active ? "pending" : "confirmed",
    executionState: active ? "executing" : task.state === "succeeded" ? "succeeded" : task.state === "outcome_unknown" ? "outcome_unknown" : "failed",
    executionResult: { ...action.executionResult, task, ok: task.state === "succeeded" } };
}

export function mergePendingActionSnapshots(current: AgentPendingAction[] | undefined, incoming: AgentPendingAction[]): AgentPendingAction[] {
  const retained = new Map(current?.map((action) => [action.id, action]));
  return incoming.map((action) => {
    const old = retained.get(action.id);
    const before = old?.executionResult?.task as ActionExecutionSnapshot | undefined;
    const after = action.executionResult?.task as ActionExecutionSnapshot | undefined;
    return before && (!after || before.revision > after.revision) ? old! : action;
  });
}
