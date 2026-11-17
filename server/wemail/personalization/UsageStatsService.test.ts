import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AiUsageRepository } from "../settings/AiUsageRepository.js";
import { UsageStatsService } from "./UsageStatsService.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-usagestats-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  return { db, dir };
}

test("UsageStatsService returns stable UI buckets", () => {
  const { db, dir } = makeDb();
  const usage = new AiUsageRepository(db, () => "2026-04-26T12:00:00.000Z");
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o-mini",
    processorVersion: 1,
  });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 200,
    outputTokens: 80,
    model: "gpt-4o-mini",
    processorVersion: 2,
  });

  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });

  // Should return all 7 stable UI buckets
  assert.equal(stats.length, 7);

  const summaryBucket = stats.find((b) => b.category === "summary");
  assert.ok(summaryBucket);
  assert.equal(summaryBucket.tokens, 430); // 150 + 280
  assert.equal(summaryBucket.calls, 2);

  // Buckets with no usage should have 0 values
  const composeBucket = stats.find((b) => b.category === "compose");
  assert.ok(composeBucket);
  assert.equal(composeBucket.tokens, 0);
  assert.equal(composeBucket.calls, 0);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService returns detailed processor-version rows", () => {
  const { db, dir } = makeDb();
  const usage = new AiUsageRepository(db, () => "2026-04-26T12:00:00.000Z");
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o-mini",
    processorVersion: 1,
    durationMs: 1200,
  });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 200,
    outputTokens: 80,
    model: "gpt-4o-mini",
    processorVersion: 2,
    durationMs: 800,
  });

  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });

  const summaryBucket = stats.find((b) => b.category === "summary");
  assert.ok(summaryBucket);
  assert.equal(summaryBucket.details.length, 2);

  const v1Detail = summaryBucket.details.find((d) => d.processorVersion === 1);
  assert.ok(v1Detail);
  assert.equal(v1Detail.tokens, 150);
  assert.equal(v1Detail.calls, 1);
  assert.equal(v1Detail.model, "gpt-4o-mini");

  const v2Detail = summaryBucket.details.find((d) => d.processorVersion === 2);
  assert.ok(v2Detail);
  assert.equal(v2Detail.tokens, 280);
  assert.equal(v2Detail.calls, 1);
  assert.equal(v2Detail.processor, "summary");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService includes canonical AI artifact token metadata", () => {
  const { db, dir } = makeDb();
  const completedAtMs = Date.parse("2026-04-25T12:00:00.000Z");
  db.prepare(
    `INSERT INTO mail_accounts (
       id, public_id, email_address, display_name, provider_kind,
       imap_host, imap_port, imap_secure, imap_username,
       smtp_host, smtp_port, smtp_secure, smtp_username,
       credential_ref, credential_generation, state,
       created_at_ms, updated_at_ms, row_version
     ) VALUES (
       1, 'acct-1', 'owner@example.com', 'Owner', 'imap-smtp',
       'imap.example.com', 993, 1, 'owner@example.com',
       'smtp.example.com', 465, 1, 'owner@example.com',
       'test-secret', 1, 'active',
       @completedAtMs, @completedAtMs, 1
     )`,
  ).run({ completedAtMs });
  db.prepare(
    `INSERT INTO mail_messages (
       id, public_id, account_id, normalized_subject, subject,
       received_at_ms, internal_date_ms, row_version
     ) VALUES (
       @id, @publicId, 1, @subject, @subject,
       @completedAtMs, @completedAtMs, 1
     )`,
  ).run({ id: 1, publicId: "mail-1", subject: "Test", completedAtMs });

  const insertArtifact = db.prepare(
    `INSERT INTO mail_ai_artifacts (
       public_id, account_id, scope_kind, message_id, artifact_kind,
       source_version, processor_version, model_id, state, json_value,
       created_at_ms, completed_at_ms, row_version
     ) VALUES (
       @publicId, 1, 'message', 1, @artifactKind,
       1, @processorVersion, 'gpt-test', 'ready', @jsonValue,
       @completedAtMs, @completedAtMs, 1
     )`,
  );
  insertArtifact.run({
    publicId: "artifact-summary",
    artifactKind: "summary",
    processorVersion: "3",
    jsonValue: JSON.stringify({
      _metadata: {
        processor: "summary",
        durationMs: 1200,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      },
    }),
    completedAtMs,
  });
  insertArtifact.run({
    publicId: "artifact-tags",
    artifactKind: "tags",
    processorVersion: "3",
    jsonValue: JSON.stringify({
      _metadata: {
        processor: "tags",
        durationMs: 800,
        tokenUsage: { inputTokens: 40, outputTokens: 35 },
      },
    }),
    completedAtMs,
  });

  const statsService = new UsageStatsService({
    db,
    now: () => "2026-04-26T12:00:00.000Z",
  });
  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });

  const summaryBucket = stats.find((bucket) => bucket.category === "summary");
  assert.ok(summaryBucket);
  assert.equal(summaryBucket.tokens, 150);
  assert.equal(summaryBucket.calls, 1);
  assert.deepEqual(summaryBucket.details[0], {
    processor: "summary",
    processorVersion: 3,
    model: "gpt-test",
    tokens: 150,
    inputTokens: 100,
    outputTokens: 50,
    calls: 1,
    avgDurationMs: 1200,
  });

  const otherBucket = stats.find((bucket) => bucket.category === "other");
  assert.ok(otherBucket);
  assert.equal(otherBucket.label, "标签 / 其他");
  assert.equal(otherBucket.tokens, 75);
  assert.equal(otherBucket.calls, 1);
  assert.equal(otherBucket.details[0]?.processor, "tags");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService groups processors into correct buckets", () => {
  const { db, dir } = makeDb();
  const usage = new AiUsageRepository(db, () => "2026-04-26T12:00:00.000Z");
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  // replyDraft should go into "compose" bucket
  usage.record({
    accountId: "acct-1",
    category: "compose",
    processor: "replyDraft",
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o-mini",
  });

  // composeMail should go into "compose" bucket
  usage.record({
    accountId: "acct-1",
    category: "compose",
    processor: "composeMail",
    inputTokens: 200,
    outputTokens: 80,
    model: "gpt-4o-mini",
  });

  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });

  const composeBucket = stats.find((b) => b.category === "compose");
  assert.ok(composeBucket);
  assert.equal(composeBucket.tokens, 430); // 150 + 280
  assert.equal(composeBucket.calls, 2);
  assert.equal(composeBucket.details.length, 2);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService isolates accounts", () => {
  const { db, dir } = makeDb();
  const usage = new AiUsageRepository(db, () => "2026-04-26T12:00:00.000Z");
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 100,
    outputTokens: 50,
  });

  usage.record({
    accountId: "acct-2",
    category: "summary",
    processor: "summary",
    inputTokens: 999,
    outputTokens: 999,
  });

  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });

  const summaryBucket = stats.find((b) => b.category === "summary");
  assert.ok(summaryBucket);
  assert.equal(summaryBucket.tokens, 150);
  assert.equal(summaryBucket.calls, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService buckets are stable across versions", () => {
  const { db, dir } = makeDb();
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });

  // Verify the fixed set of 7 stable buckets
  const categories = stats.map((b) => b.category);
  assert.ok(categories.includes("summary"));
  assert.ok(categories.includes("agent_chat"));
  assert.ok(categories.includes("compose"));
  assert.ok(categories.includes("todo"));
  assert.ok(categories.includes("translation"));
  assert.ok(categories.includes("automation"));
  assert.ok(categories.includes("other"));
  assert.equal(categories.length, 7);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService applies the selected account usage period", () => {
  const { db, dir } = makeDb();
  const usage = new AiUsageRepository(db, () => "2026-02-01T12:00:00.000Z");
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 80,
    outputTokens: 20,
  });

  const monthly = statsService.getStats({ accountId: "acct-1", period: "30d" });
  const quarterly = statsService.getStats({ accountId: "acct-1", period: "90d" });

  assert.equal(monthly.find((bucket) => bucket.category === "summary")!.tokens, 0);
  assert.equal(quarterly.find((bucket) => bucket.category === "summary")!.tokens, 100);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService groups usage by provider and model name", () => {
  const { db, dir } = makeDb();
  const usage = new AiUsageRepository(db, () => "2026-04-26T12:00:00.000Z");
  const statsService = new UsageStatsService({ db, now: () => "2026-04-26T12:00:00.000Z" });

  // Same model from the same provider merges into one row
  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 100,
    outputTokens: 50,
    model: "gpt-4o-mini",
    provider: "openai",
  });
  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 200,
    outputTokens: 80,
    model: "gpt-4o-mini",
    provider: "openai",
  });
  // Different provider or model becomes a separate row
  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 40,
    outputTokens: 10,
    model: "claude-3-5-sonnet",
    provider: "anthropic",
  });
  // Missing provider falls back to "unknown"
  usage.record({
    accountId: "acct-1",
    category: "summary",
    processor: "summary",
    inputTokens: 7,
    outputTokens: 3,
    model: "legacy-model",
  });

  const stats = statsService.getStats({ accountId: "acct-1", period: "30d" });
  const summaryBucket = stats.find((b) => b.category === "summary");
  assert.ok(summaryBucket);

  const byKey = new Map(
    summaryBucket.models.map((m) => [`${m.provider}/${m.model}`, m]),
  );
  assert.equal(byKey.size, 3);
  assert.equal(byKey.get("openai/gpt-4o-mini")?.tokens, 430);
  assert.equal(byKey.get("openai/gpt-4o-mini")?.calls, 2);
  assert.equal(byKey.get("anthropic/claude-3-5-sonnet")?.tokens, 50);
  assert.equal(byKey.get("unknown/legacy-model")?.tokens, 10);

  // No usage means an empty model list
  const composeBucket = stats.find((b) => b.category === "compose");
  assert.ok(composeBucket);
  assert.deepEqual(composeBucket.models, []);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService timeseries zero-fills minute buckets and isolates windows", () => {
  const { db, dir } = makeDb();
  const now = "2026-04-26T12:00:00.000Z";
  const statsService = new UsageStatsService({ db, now: () => now });

  const insert = db.prepare(
    `INSERT INTO ai_usage (id, account_id, category, processor, input_tokens, output_tokens, created_at)
     VALUES (@id, 'acct-1', @category, 'p', @inputTokens, @outputTokens, @createdAt)`,
  );
  // in-window: 12:00 and 11:59 buckets (now=12:00:00Z, fromIso=11:57:00Z)
  insert.run({ id: "1", category: "summary", inputTokens: 100, outputTokens: 50, createdAt: "2026-04-26T12:00:00.000Z" });
  insert.run({ id: "2", category: "summary", inputTokens: 80, outputTokens: 20, createdAt: "2026-04-26T11:59:30.000Z" });
  insert.run({ id: "3", category: "compose", inputTokens: 40, outputTokens: 10, createdAt: "2026-04-26T12:00:00.000Z" });
  // out-of-window (before 11:57) must be excluded
  insert.run({ id: "4", category: "summary", inputTokens: 9999, outputTokens: 0, createdAt: "2026-04-26T11:50:00.000Z" });

  const result = statsService.getTimeseries({ accountId: "acct-1", granularity: "minute", window: 3 });

  assert.equal(result.granularity, "minute");
  assert.equal(result.buckets.length, 4); // 11:57, 11:58, 11:59, 12:00

  const summary = result.series.find((s) => s.category === "summary");
  assert.ok(summary);
  assert.equal(summary.tokens.length, 4);
  assert.equal(summary.tokens.reduce((a, b) => a + b, 0), 250); // 150 + 100, old row excluded
  assert.equal(summary.calls.reduce((a, b) => a + b, 0), 2);
  assert.equal(summary.tokens[0], 0); // earliest bucket empty (zero-filled)

  const compose = result.series.find((s) => s.category === "compose");
  assert.ok(compose);
  assert.equal(compose.tokens.reduce((a, b) => a + b, 0), 50);

  assert.equal(result.totals.tokens, 300);
  assert.equal(result.totals.calls, 3);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("UsageStatsService timeseries isolates accounts and supports hour granularity", () => {
  const { db, dir } = makeDb();
  const now = "2026-04-26T12:00:00.000Z";
  const statsService = new UsageStatsService({ db, now: () => now });

  const insert = db.prepare(
    `INSERT INTO ai_usage (id, account_id, category, processor, input_tokens, output_tokens, created_at)
     VALUES (@id, @accountId, @category, 'p', @inputTokens, @outputTokens, @createdAt)`,
  );
  insert.run({ id: "1", accountId: "acct-1", category: "summary", inputTokens: 10, outputTokens: 5, createdAt: now });
  insert.run({ id: "2", accountId: "acct-2", category: "summary", inputTokens: 9999, outputTokens: 0, createdAt: now });

  const minute = statsService.getTimeseries({ accountId: "acct-1", granularity: "minute", window: 5 });
  assert.equal(minute.totals.tokens, 15); // acct-2 excluded

  const hourly = statsService.getTimeseries({ accountId: "acct-1", granularity: "hour", window: 2 });
  assert.equal(hourly.granularity, "hour");
  assert.equal(hourly.buckets.length, 3); // 10:00, 11:00, 12:00
  assert.equal(hourly.totals.tokens, 15);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
