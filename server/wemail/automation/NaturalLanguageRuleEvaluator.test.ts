import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { NaturalLanguageRuleEvaluator } from "./NaturalLanguageRuleEvaluator.js";

const message: MailMessage = {
  id: "m-1",
  accountId: "acct-1",
  folder: "INBOX",
  messageId: "<m-1@example.com>",
  from: { email: "boss@example.com", name: "Boss" },
  to: [{ email: "me@example.com" }],
  cc: [],
  bcc: [],
  subject: "Urgent review",
  snippet: "Please review today",
  bodyText: "Please review this contract today. ".repeat(200),
  receivedAt: "2026-06-26T10:00:00.000Z",
  hasAttachments: false,
  attachments: [],
  flags: { seen: false, flagged: false, answered: false, draft: false },
  sync: { uid: 1, uidValidity: 1, internalDate: "2026-06-26T10:00:00.000Z" },
};

test("NaturalLanguageRuleEvaluator parses strict JSON decisions", async () => {
  const calls: string[] = [];
  const evaluator = new NaturalLanguageRuleEvaluator({
    getLlmClient: () => ({
      complete: async (input: { prompt: string }) => {
        calls.push(input.prompt);
        return { text: '{"matched":true,"confidence":0.91,"reason":"needs reply today"}' };
      },
    }),
    getModel: () => "test-model",
  });

  const decision = await evaluator.evaluate({
    ruleId: "rule-1",
    accountId: "acct-1",
    triggerKind: "mailReceived",
    condition: "Needs a reply today",
    message,
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.confidence, 0.91);
  assert.equal(decision.reason, "needs reply today");
  assert.ok(calls[0].includes("Needs a reply today"));
  assert.ok(calls[0].length < (message.bodyText ?? "").length + 2000);
});

test("NaturalLanguageRuleEvaluator fails closed without a model client", async () => {
  const evaluator = new NaturalLanguageRuleEvaluator({
    getLlmClient: () => undefined,
    getModel: () => undefined,
  });

  const decision = await evaluator.evaluate({
    ruleId: "rule-1",
    accountId: "acct-1",
    triggerKind: "mailReceived",
    condition: "Needs a reply today",
    message,
  });

  assert.equal(decision.matched, false);
  assert.equal(decision.reason, "llm-unavailable");
});

test("NaturalLanguageRuleEvaluator fails closed on invalid JSON", async () => {
  const evaluator = new NaturalLanguageRuleEvaluator({
    getLlmClient: () => ({
      complete: async () => ({ text: "not json" }),
    }),
    getModel: () => "test-model",
  });

  const decision = await evaluator.evaluate({
    ruleId: "rule-1",
    accountId: "acct-1",
    triggerKind: "mailReceived",
    condition: "Needs a reply today",
    message,
  });

  assert.equal(decision.matched, false);
  assert.equal(decision.reason, "evaluation-failed");
});
