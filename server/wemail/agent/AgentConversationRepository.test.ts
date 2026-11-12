import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentConversationRepository } from "./AgentConversationRepository.js";

function makeRepo() {
  const db = openOrCreateMailDatabase(":memory:");
  let counter = 0;
  // Increment by 1 minute per call so updated_at ordering is stable.
  const now = () => {
    counter += 1;
    return new Date(Date.UTC(2026, 3, 24, 12, counter)).toISOString();
  };
  const repo = new AgentConversationRepository(db, now);
  return { db, repo };
}

test("setTitle updates the title and bumps updated_at", () => {
  const { db, repo } = makeRepo();
  const c = repo.ensureConversation({ id: "conv-a", accountId: "acct-1" });
  const initialUpdated = c.updatedAt;

  const ok = repo.setTitle("conv-a", "Quarterly review");
  assert.equal(ok, true);

  const after = repo.get("conv-a")!;
  assert.equal(after.title, "Quarterly review");
  assert.notEqual(after.updatedAt, initialUpdated);

  const row = db
    .prepare("SELECT title FROM agent_conversations WHERE id = ?")
    .get("conv-a") as { title: string };
  assert.equal(row.title, "Quarterly review");
});

test("setTitle returns false for unknown conversations", () => {
  const { repo } = makeRepo();
  assert.equal(repo.setTitle("nope", "x"), false);
});

test("setTitle accepts null to clear", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a", title: "old" });
  repo.setTitle("conv-a", null);
  assert.equal(repo.get("conv-a")?.title, undefined);
});

test("archive stamps archived_at and is idempotent", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a" });
  assert.equal(repo.archive("conv-a"), true);
  const row = repo.get("conv-a")!;
  assert.ok(row.archivedAt, "archivedAt should be set");

  // Idempotent: a second archive call should not change archived_at and
  // should report `false` (no rows affected).
  const firstStamp = row.archivedAt;
  assert.equal(repo.archive("conv-a"), false);
  assert.equal(repo.get("conv-a")?.archivedAt, firstStamp);
});

test("unarchive clears archived_at", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a" });
  repo.archive("conv-a");
  assert.equal(repo.unarchive("conv-a"), true);
  assert.equal(repo.get("conv-a")?.archivedAt, undefined);

  // Idempotent on already-active rows.
  assert.equal(repo.unarchive("conv-a"), false);
});

test("list excludes archived rows by default and includes them on opt-in", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a", title: "active 1" });
  repo.ensureConversation({ id: "conv-b", title: "active 2" });
  repo.ensureConversation({ id: "conv-c", title: "to-archive" });
  repo.archive("conv-c");

  const active = repo.list();
  assert.deepEqual(
    active.map((c) => c.id).sort(),
    ["conv-a", "conv-b"],
  );

  const all = repo.list({ includeArchived: true });
  assert.deepEqual(
    all.map((c) => c.id).sort(),
    ["conv-a", "conv-b", "conv-c"],
  );
  const archived = all.find((c) => c.id === "conv-c");
  assert.ok(archived?.archivedAt);
});

test("clear hard-deletes everything including archived rows", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a" });
  repo.ensureConversation({ id: "conv-b" });
  repo.archive("conv-b");

  repo.clear();
  assert.equal(repo.list({ includeArchived: true }).length, 0);
});

test("pin stamps pinned_at and is idempotent", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a" });
  assert.equal(repo.pin("conv-a"), true);
  const row = repo.get("conv-a")!;
  assert.ok(row.pinnedAt, "pinnedAt should be set");

  const firstStamp = row.pinnedAt;
  assert.equal(repo.pin("conv-a"), false);
  assert.equal(repo.get("conv-a")?.pinnedAt, firstStamp);
});

test("unpin clears pinned_at", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a" });
  repo.pin("conv-a");
  assert.equal(repo.unpin("conv-a"), true);
  assert.equal(repo.get("conv-a")?.pinnedAt, undefined);
  // Idempotent on already-unpinned rows.
  assert.equal(repo.unpin("conv-a"), false);
});

test("list({ search }) does case-insensitive substring match on title", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a", title: "Quarterly review" });
  repo.ensureConversation({ id: "conv-b", title: "Tax planning" });
  repo.ensureConversation({ id: "conv-c", title: "REVIEW notes" });
  repo.ensureConversation({ id: "conv-d" }); // no title

  const hits = repo.list({ search: "review" });
  assert.deepEqual(
    hits.map((c) => c.id).sort(),
    ["conv-a", "conv-c"],
  );

  // Substring, not just prefix.
  const tax = repo.list({ search: "ann" });
  assert.deepEqual(tax.map((c) => c.id), ["conv-b"]);

  // Empty / whitespace search is treated as no filter.
  const all = repo.list({ search: "   " });
  assert.equal(all.length, 4);
});

test("list({ accountId }) filters by mailbox account", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "conv-a", accountId: "acct-1", title: "a" });
  repo.ensureConversation({ id: "conv-b", accountId: "acct-2", title: "b" });
  repo.ensureConversation({ id: "conv-c", accountId: "acct-1", title: "c" });

  const acct1 = repo.list({ accountId: "acct-1" });
  assert.deepEqual(
    acct1.map((c) => c.id).sort(),
    ["conv-a", "conv-c"],
  );
  assert.ok(acct1.every((c) => c.accountId === "acct-1"));
});

test("list combines includeArchived, search, and accountId filters", () => {
  const { repo } = makeRepo();
  repo.ensureConversation({ id: "c1", accountId: "a1", title: "review me" });
  repo.ensureConversation({ id: "c2", accountId: "a1", title: "review again" });
  repo.ensureConversation({ id: "c3", accountId: "a2", title: "review elsewhere" });
  repo.archive("c2");

  // Default: archived excluded, search applied, account scoped.
  const filtered = repo.list({ search: "review", accountId: "a1" });
  assert.deepEqual(filtered.map((c) => c.id), ["c1"]);

  // includeArchived: c2 returns too.
  const withArchived = repo.list({
    search: "review",
    accountId: "a1",
    includeArchived: true,
  });
  assert.deepEqual(
    withArchived.map((c) => c.id).sort(),
    ["c1", "c2"],
  );
});
