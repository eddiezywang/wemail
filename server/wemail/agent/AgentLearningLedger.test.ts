import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentConversationRepository } from "./AgentConversationRepository.js";
import { AgentLearningLedger } from "./AgentLearningLedger.js";

test("learning records only meaningful user behavior and filters secrets", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const ledger = new AgentLearningLedger(db, () => new Date("2026-08-02T00:00:00.000Z"));
    assert.equal(ledger.record({
      accountId: "account-a",
      type: "reasoning_expanded",
      payload: { assistantOutput: "must not persist" },
    }), undefined);
    assert.equal(ledger.record({
      accountId: "account-a",
      type: "tool_trace",
      payload: { token: "secret" },
    }), undefined);
    ledger.record({
      accountId: "account-a",
      type: "user_input",
      payload: {
        text: "验证码 123456，Authorization: Bearer abc.def.ghi",
        password: "hunter2",
        nested: { cookie: "session=abc" },
      },
    });
    const serialized = JSON.stringify(ledger.listBehavior("account-a"));
    assert.equal(serialized.includes("123456"), false);
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("session=abc"), false);
    assert.equal(serialized.includes("abc.def.ghi"), false);
    assert.equal(ledger.listBehavior("account-a").length, 1);
  } finally {
    db.close();
  }
});

test("preferences expose provenance, correction, contradiction decay, and deletion", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const ledger = new AgentLearningLedger(db, () => now);
    const first = ledger.record({
      accountId: "account-a",
      type: "user_edit",
      payload: { key: "tone", value: "concise" },
    })!;
    const inferred = ledger.observePreference({
      accountId: "account-a",
      key: "tone",
      value: "concise",
      provenanceEventId: first.id,
    });
    assert.equal(inferred.value, "concise");
    assert.equal(inferred.confidence, 0.5);
    const contradiction = ledger.record({
      accountId: "account-a",
      type: "user_edit",
      payload: { key: "tone", value: "detailed" },
    })!;
    assert.equal(ledger.observePreference({
      accountId: "account-a",
      key: "tone",
      value: "detailed",
      provenanceEventId: contradiction.id,
    }).confidence, 0.25);
    const corrected = ledger.correctPreference("account-a", "tone", "balanced");
    assert.equal(corrected.value, "balanced");
    assert.equal(corrected.confidence, 1);
    assert.ok(corrected.provenanceEventIds.length >= 2);
    now = new Date("2027-01-01T00:00:00.000Z");
    assert.ok(ledger.listPreferences("account-a")[0]!.confidence < 1);
    assert.equal(ledger.deletePreference("account-a", "tone"), true);
    assert.equal(ledger.listPreferences("account-a").length, 0);
  } finally {
    db.close();
  }
});

test("conversation deletion and dedicated learning deletion are independent", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const conversations = new AgentConversationRepository(db);
    const conversation = conversations.ensureConversation({ id: "conversation-1", accountId: "account-a" });
    assert.ok(conversation);
    const ledger = new AgentLearningLedger(db);
    const event = ledger.record({
      accountId: "account-a",
      conversationId: "conversation-1",
      type: "user_input",
      payload: { text: "Prefer short replies" },
    })!;
    ledger.observePreference({
      accountId: "account-a",
      key: "reply.length",
      value: "short",
      provenanceEventId: event.id,
      confirmed: true,
    });
    conversations.clear();
    assert.equal(ledger.listBehavior("account-a").length, 1);
    assert.equal(ledger.listPreferences("account-a").length, 1);

    conversations.ensureConversation({ id: "conversation-2", accountId: "account-a" });
    const cleared = ledger.clearLearning("account-a");
    assert.equal(cleared.events > 0, true);
    assert.equal(cleared.preferences, 1);
    assert.ok(conversations.get("conversation-2"));
  } finally {
    db.close();
  }
});

test("raw behavior expires after 180 days while preferences remain reviewable", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const ledger = new AgentLearningLedger(db, () => now);
    const event = ledger.record({
      accountId: "account-a",
      type: "user_confirmed",
      payload: { preference: "tone" },
    })!;
    ledger.observePreference({
      accountId: "account-a",
      key: "tone",
      value: "concise",
      provenanceEventId: event.id,
      confirmed: true,
    });
    now = new Date("2026-07-01T00:00:01.000Z");
    assert.equal(ledger.cleanupRawBehavior(), 1);
    assert.equal(ledger.listBehavior("account-a").length, 0);
    assert.equal(ledger.listPreferences("account-a").length, 1);
  } finally {
    db.close();
  }
});
