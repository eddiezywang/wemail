import { describe, expect, it } from "vitest";
import { applyActionExecution, mergePendingActionSnapshots } from "./actionExecution";
import type { AgentPendingAction } from "../../shared/wemail/intelligence";
import type { ActionExecutionSnapshot } from "../../shared/wemail/actionExecution";

const action: AgentPendingAction = { id: "a", actionType: "upload_allowance_invoices", description: "上传", toolName: "propose_action",
  inputJson: "{}", riskReason: "上传", riskLevel: "medium" };
const task: ActionExecutionSnapshot = { planVersion: 1, id: "task", actionId: "a", accountId: "account", state: "queued", revision: 1, generation: 0, items: [] };

describe("action execution snapshots", () => {
  it("retains accepted queued state after a response is recovered", () => {
    const accepted = applyActionExecution(action, task);
    expect(accepted.executionState).toBe("executing");
    expect(accepted.executionResult?.task).toEqual(task);
  });
  it("does not let an old query overwrite a completed task", () => {
    const completed = applyActionExecution(action, { ...task, state: "succeeded", revision: 5 });
    expect(applyActionExecution(completed, task)).toBe(completed);
    expect(mergePendingActionSnapshots([completed], [applyActionExecution(action, task)])[0]).toBe(completed);
    expect(mergePendingActionSnapshots([completed], [action])[0]).toBe(completed);
  });
  it("retains unknown outcomes as unknown rather than upload failure", () => {
    expect(applyActionExecution(action, { ...task, state: "outcome_unknown" }).executionState).toBe("outcome_unknown");
  });
});
