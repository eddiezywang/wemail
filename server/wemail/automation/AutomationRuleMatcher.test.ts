import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationConditionRule } from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import {
  matchesConditionRules,
  matchesStructuredConditions,
} from "./AutomationRuleMatcher.js";

const message = {
  id: "email-1",
  accountId: "acct-1",
  threadId: "thread-1",
  folder: "inbox",
  messageId: "<email-1@example.com>",
  from: { email: "alerts@github.com", name: "GitHub" },
  to: [{ email: "me@example.com", name: "Me" }],
  cc: [],
  bcc: [],
  subject: "Build failed",
  snippet: "CI pipeline failed",
  bodyText: "CI pipeline failed on main",
  hasAttachments: true,
  attachments: [],
  receivedAt: "2026-06-26T00:00:00.000Z",
  flags: { seen: false, flagged: false, answered: false, draft: false },
  sync: { uid: 1, uidValidity: 1, internalDate: "2026-06-26T00:00:00.000Z" },
} satisfies MailMessage;

test("matches all condition rules", () => {
  const rules: AutomationConditionRule[] = [
    { id: "r1", field: "sender", operator: "contains", value: "github.com" },
    { id: "r2", field: "subject", operator: "notContains", value: "unsubscribe" },
  ];
  assert.equal(matchesConditionRules("all", rules, message), true);
});

test("matches any condition rule", () => {
  const rules: AutomationConditionRule[] = [
    { id: "r1", field: "sender", operator: "contains", value: "stripe.com" },
    { id: "r2", field: "body", operator: "contains", value: "main" },
  ];
  assert.equal(matchesConditionRules("any", rules, message), true);
});

test("supports exists and notExists operators", () => {
  assert.equal(
    matchesConditionRules(
      "all",
      [{ id: "r1", field: "hasAttachment", operator: "exists" }],
      message,
    ),
    true,
  );
  assert.equal(
    matchesConditionRules(
      "all",
      [{ id: "r1", field: "cc", operator: "notExists" }],
      message,
    ),
    true,
  );
});

test("supports aiTag condition rules", () => {
  assert.equal(
    matchesConditionRules(
      "all",
      [{ id: "r1", field: "aiTag", operator: "equals", value: "devops" }],
      message,
      (emailId, tagName) => emailId === "email-1" && tagName === "devops",
    ),
    true,
  );
});

test("keeps legacy structured condition fallback", () => {
  assert.equal(
    matchesStructuredConditions({ sender: "github.com" }, message),
    true,
  );
});
