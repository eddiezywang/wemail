import assert from "node:assert/strict";
import test from "node:test";
import {
  directToolPolicy,
  isConfirmationRequiredAction,
} from "./AgentOperationPolicy.js";

test("semantic operation matrix requires confirmation for external and batch mutations", () => {
  for (const action of [
    "send", "delete", "move", "archive", "mark_spam", "unsubscribe",
    "run_automation", "run_wecli_command", "upload_allowance_invoices",
  ]) {
    assert.equal(isConfirmationRequiredAction(action), true, action);
  }
  assert.equal(
    directToolPolicy("set_mail_state", {
      emailIds: ["mail-1", "mail-2"],
      operation: "mark_read",
    }).disposition,
    "confirmation_required",
  );
  assert.equal(
    directToolPolicy("set_mail_state", {
      emailId: "mail-1",
      operation: "mark_read",
    }).disposition,
    "direct_low_risk_single",
  );
});

test("reads and unsent drafts remain direct", () => {
  assert.equal(directToolPolicy("search_mail", {}).disposition, "direct_read");
  assert.equal(directToolPolicy("save_mail_draft", {}).disposition, "direct_draft");
});
