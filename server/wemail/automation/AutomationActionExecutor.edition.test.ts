import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { AutomationActionExecutor } from "./AutomationActionExecutor.js";

const action = { type: "external" as const, adapter: "wecli.allowance.upload", input: {} };
const mail = {} as CanonicalMailRepository;

test("an absent edition adapter fails closed for a persisted invoice action", async () => {
  const executor = new AutomationActionExecutor({ mail });
  assert.deepEqual(await executor.execute("account", "mail", [action]), [
    { type: "external", status: "unsupported", emailId: "mail", reason: "external-action-adapter-not-implemented" },
  ]);
});

test("an edition adapter receives the account, mail and action unchanged", async () => {
  const calls: unknown[] = [];
  const executor = new AutomationActionExecutor({
    mail,
    editionExternalAction: async (accountId, emailId, received) => {
      calls.push({ accountId, emailId, received });
      return { type: "external", status: "applied", emailId };
    },
  });
  assert.deepEqual(await executor.execute("account", "mail", [action]), [
    { type: "external", status: "applied", emailId: "mail" },
  ]);
  assert.deepEqual(calls, [{ accountId: "account", emailId: "mail", received: action }]);
});

test("a rejected edition adapter is recorded as a failure and later actions continue", async () => {
  const executor = new AutomationActionExecutor({
    mail,
    editionExternalAction: async () => { throw new Error("adapter-unavailable"); },
  });
  assert.deepEqual(await executor.execute("account", "mail", [action, { type: "suppressTodoCreation" }]), [
    { type: "external", status: "failed", emailId: "mail", reason: "adapter-unavailable" },
    { type: "suppressTodoCreation", status: "applied", emailId: "mail" },
  ]);
});
