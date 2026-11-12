import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailDatabase } from "../database/Database.js";
import { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";

const row = (emailId: string, jobState: string | null) => ({
  email_id: emailId,
  account_id: "acct-1",
  subject: emailId,
  sender: "sender@example.com",
  received_at_ms: 1n,
  artifact_json: null,
  job_id: jobState ? `job-${emailId}` : null,
  job_state: jobState,
  job_attempt_count: 0n,
  job_max_attempts: 3n,
  job_available_at_ms: null,
  job_created_at_ms: 1n,
  job_updated_at_ms: 1n,
  last_error_code: null,
});

test("summary health page stops after finding one look-ahead item", () => {
  const rows = [row("failed", "failed"), row("missing", null), row("pending", "pending")];
  const db = {
    prepare(sql: string) {
      return {
        all() {
          return sql.includes("ORDER BY messages.received_at_ms") ? rows : [];
        },
      };
    },
  } as unknown as MailDatabase;
  const repository = new IntelligenceResultRepository(db);

  const result = repository.getSummaryHealth({
    accountId: "acct-1",
    states: ["failed", "missing", "pending"],
    offset: 1,
    limit: 1,
    pageOnly: true,
  });

  assert.deepEqual(result.items?.map((item) => item.emailId), ["missing"]);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 2);
});

/** Mirrors hasSummary (summaryItem) so the mock can classify artifact content. */
function hasSummaryContent(json: string | null): boolean {
  if (!json) return false;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const hasText = (v: unknown) =>
      Array.isArray(v) && v.some((s) => typeof s === "string" && s.trim().length > 0);
    return (
      o._status === "completed" ||
      hasText(o.bullets) ||
      hasText(o.actionItems) ||
      (typeof o.headline === "string" && o.headline.trim().length > 0)
    );
  } catch {
    return false;
  }
}

/** Mirrors summaryItem's state derivation for the count-aggregation mock. */
function stateOf(r: RetryRow): string {
  if (hasSummaryContent(r.artifact_json)) return "succeeded";
  if (r.artifact_json) return "invalid";
  if (r.job_state === "leased") return "running";
  if (r.job_state === "pending")
    return Number(r.job_attempt_count ?? 0) >= Number(r.job_max_attempts ?? 0) ? "failed" : "pending";
  if (r.job_state === "failed" || r.job_state === "terminal") return "failed";
  if (r.job_state === "cancelled") return "skipped";
  return "missing";
}

type RetryRow = {
  job_id: string | null;
  job_state: string | null;
  artifact_json: string | null;
  job_attempt_count: bigint | number | null;
  job_max_attempts: bigint | number | null;
};

/**
 * Mock DB that honors the retry state filters by inspecting the SQL clause,
 * mirroring RETRY_STATE_FILTERS on the row data, then applies LIMIT/OFFSET.
 */
function retryMockDb(rows: RetryRow[]) {
  return {
    prepare(sql: string) {
      return {
        all() {
          if (!sql.includes("ORDER BY messages.received_at_ms")) return [];
          let filtered = rows;
          if (sql.includes("jobs.id IS NULL")) {
            filtered = rows.filter((r) => !r.job_id);
          } else if (sql.includes("jobs.state IN")) {
            filtered = rows.filter(
              (r) =>
                !r.artifact_json &&
                r.job_state !== null &&
                (r.job_state === "failed" ||
                  r.job_state === "terminal" ||
                  (r.job_state === "pending" &&
                    Number(r.job_attempt_count ?? 0) >= Number(r.job_max_attempts ?? 0))),
            );
          } else if (sql.includes("json_extract(artifact.json_value")) {
            filtered = rows.filter((r) => !!r.artifact_json && !hasSummaryContent(r.artifact_json));
          }
          // Pagination lives at the end of the outer query; the jobs lookup in
          // SUMMARY_FROM_JOIN carries its own inner `LIMIT 1`, so take the last
          // LIMIT/OFFSET occurrence rather than the first.
          const offset = Number(
            /OFFSET (\d+)/.exec(sql.slice(sql.lastIndexOf("ORDER BY messages.received_at_ms")))?.[1] ?? 0,
          );
          const limit = Number(
            /LIMIT (\d+)/.exec(sql.slice(sql.lastIndexOf("ORDER BY messages.received_at_ms")))?.[1] ?? 500,
          );
          return filtered.slice(offset, offset + limit);
        },
      };
    },
  } as unknown as MailDatabase;
}

test("summary retry candidates continue beyond the newest 500 messages", () => {
  const succeeded = Array.from({ length: 500 }, (_, index) => ({
    ...row(`done-${index}`, "succeeded"),
    artifact_json: JSON.stringify({ type: "summary", headline: "done" }),
  }));
  const rows = [...succeeded, row("failed-after-500", "failed")];
  const repository = new IntelligenceResultRepository(retryMockDb(rows));

  const candidates = repository.listSummaryRetryCandidates({ accountId: "acct-1" });

  assert.deepEqual(candidates.map((candidate) => candidate.emailId), ["failed-after-500"]);
});

test("summary retry candidates exclude active work", () => {
  const rows = [
    row("failed", "failed"),
    row("already-pending", "pending"),
    row("already-running", "leased"),
  ];
  const repository = new IntelligenceResultRepository(retryMockDb(rows));

  const candidates = repository.listSummaryRetryCandidates({ accountId: "acct-1" });

  assert.deepEqual(candidates.map((candidate) => candidate.emailId), ["failed"]);
  assert.equal(candidates.some((candidate) => candidate.emailId === "already-pending"), false);
  assert.equal(candidates.some((candidate) => candidate.emailId === "already-running"), false);
});

test("summary retry candidates prefer never-tried mail over previously-failed", () => {
  const rows = [
    row("failed-a", "failed"),
    row("missing-a", null),
    row("failed-b", "failed"),
    row("missing-b", null),
    row("missing-c", null),
  ];
  const repository = new IntelligenceResultRepository(retryMockDb(rows));

  const candidates = repository.listSummaryRetryCandidates({ accountId: "acct-1" });

  // Never-tried (missing) always wins a slot; previously-failed backfills
  // the leftover slots. The candidate's state is known from which filtered
  // query produced it, so no application-side scan is needed.
  assert.deepEqual(
    candidates.map((candidate) => candidate.emailId),
    ["missing-a", "missing-b", "missing-c", "failed-a", "failed-b"],
  );
});

test("summary retry candidates fill the pool with never-tried mail when the backlog is large", () => {
  const missing = Array.from({ length: 550 }, (_, index) => row(`missing-${index}`, null));
  const rows = [...missing, row("failed-old", "failed")];
  const repository = new IntelligenceResultRepository(retryMockDb(rows));

  const candidates = repository.listSummaryRetryCandidates({ accountId: "acct-1" });

  // 500 never-tried mail fills the pool; the previously-failed item never
  // enters, so it cannot occupy a worker slot.
  assert.equal(candidates.length, 500);
  assert.equal(
    candidates.every((candidate) => candidate.emailId.startsWith("missing-")),
    true,
  );
  assert.equal(candidates.some((candidate) => candidate.emailId === "failed-old"), false);
});

test("summary health aggregates counts via SQL without loading every row", () => {
  const rows: RetryRow[] = [
    { ...row("s1", "succeeded"), artifact_json: JSON.stringify({ type: "summary", headline: "done" }) },
    { ...row("s2", "succeeded"), artifact_json: JSON.stringify({ type: "summary", _status: "completed", bullets: [] }) },
    row("m1", null),
    row("m2", null),
    row("f1", "failed"),
    row("p1", "pending"),
    row("r1", "leased"),
    row("k1", "cancelled"),
  ];
  const db = {
    prepare(sql: string) {
      return {
        all() {
          // countSummaryStates: SQL GROUP BY state (no ORDER BY) — the DB
          // aggregates, the app never materializes every row.
          if (sql.includes("GROUP BY state")) {
            const counts = new Map<string, number>();
            for (const r of rows) {
              const state = stateOf(r);
              counts.set(state, (counts.get(state) ?? 0) + 1);
            }
            return [...counts.entries()].map(([state, n]) => ({ state, n }));
          }
          if (!sql.includes("ORDER BY messages.received_at_ms")) return [];
          const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
          const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 500);
          return rows.slice(offset, offset + limit);
        },
      };
    },
  } as unknown as MailDatabase;
  const repository = new IntelligenceResultRepository(db);

  const health = repository.getSummaryHealth({ accountId: "acct-1", limit: 1 });

  assert.equal(health.total, 8);
  assert.equal(health.succeeded, 2);
  assert.equal(health.missing, 2);
  assert.equal(health.failed, 1);
  assert.equal(health.pending, 1);
  assert.equal(health.running, 1);
  assert.equal(health.skipped, 1);
  assert.equal(health.invalid, 0);
  assert.equal(health.retryable, 3);
});
