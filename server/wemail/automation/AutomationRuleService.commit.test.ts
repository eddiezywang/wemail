import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import { AutomationRulePreviewRepository } from "./AutomationRulePreviewRepository.js";
import { AutomationRuleService } from "./AutomationRuleService.js";

test("committing the same preview twice creates only one legacy rule", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => "2026-07-30T12:00:00.000Z";
  try {
    const rules = new AutomationRuleRepository(db, now);
    const service = new AutomationRuleService({
      rules, previews: new AutomationRulePreviewRepository(db, now),
      mail: { searchMessages: () => [] } as unknown as CanonicalMailRepository,
      now, editionValidation: {}, editionCapabilities: {},
    });
    const preview = service.preview({ accountId: "acct-1", name: "Rule", enabled: true,
      trigger: { type: "manual" }, conditions: {}, actions: [{ type: "star" }] });
    const input = { accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash };
    const created = service.commit(input);
    assert.equal(created.id, service.commit(input).id);
    assert.equal(rules.list("acct-1").length, 1);
    const changedCapabilities = new AutomationRuleService({
      rules, previews: new AutomationRulePreviewRepository(db, now),
      mail: { searchMessages: () => [] } as unknown as CanonicalMailRepository,
      now, editionValidation: {}, editionCapabilities: { actions: [{ id: "new", label: "New", description: "New", risk: "low", configurable: true }] },
    });
    assert.equal(changedCapabilities.commit(input).id, created.id);
    rules.update(created.id, { name: "Changed" });
    assert.throws(() => service.commit(input), /automation-committed-rule-changed/);
  } finally { db.close(); }
});

test("a failed commit rolls back both rule creation and the preview receipt", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => "2026-07-30T12:00:00.000Z";
  try {
    const rules = new AutomationRuleRepository(db, now);
    const previews = new AutomationRulePreviewRepository(db, now);
    const service = new AutomationRuleService({ rules, previews,
      mail: { searchMessages: () => [] } as unknown as CanonicalMailRepository,
      now, editionValidation: {}, editionCapabilities: {}, });
    const preview = service.preview({ accountId: "acct-1", name: "Rule", enabled: true,
      trigger: { type: "manual" }, conditions: {}, actions: [{ type: "star" }] });
    assert.throws(() => previews.commitOnce(preview.previewId, "acct-1", (value) => {
      rules.create(value.normalizedRule);
      throw new Error("simulated-failure");
    }, (id) => rules.get(id), () => "revision"), /simulated-failure/);
    assert.equal(rules.list("acct-1").length, 0);
    const committed = service.commit({ accountId: "acct-1", previewId: preview.previewId, ruleHash: preview.ruleHash });
    assert.equal(rules.list("acct-1")[0]?.id, committed.id);
  } finally { db.close(); }
});
