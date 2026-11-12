import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentConversationRepository } from "./AgentConversationRepository.js";
import { AgentRunCoordinator, retryAgentOperation } from "./AgentRunCoordinator.js";
import { AgentRunRepository } from "./AgentRunRepository.js";

function fixture() {
  const db = openOrCreateMailDatabase(":memory:");
  const conversations = new AgentConversationRepository(db);
  for (const id of ["conv-1", "conv-2", "conv-3"]) {
    conversations.ensureConversation({ id });
  }
  const repository = new AgentRunRepository(db);
  return { db, repository, coordinator: new AgentRunCoordinator(repository, 2) };
}

test("coordinator enforces one active run per conversation and two globally", async () => {
  const { db, coordinator } = fixture();
  const first = await coordinator.acquire({ conversationId: "conv-1", runId: "run-1" });
  const second = await coordinator.acquire({ conversationId: "conv-2", runId: "run-2" });
  const thirdPromise = coordinator.acquire({ conversationId: "conv-3", runId: "run-3" });
  const sameConversationPromise = coordinator.acquire({ conversationId: "conv-1", runId: "run-4" });
  assert.equal(coordinator.activeCount(), 2);
  assert.equal(coordinator.waitingCount(), 2);

  first.release();
  const third = await thirdPromise;
  assert.equal(third.waited, true);
  assert.equal(coordinator.activeCount(), 2);
  assert.equal(coordinator.waitingCount(), 1);

  third.release();
  const sameConversation = await sameConversationPromise;
  assert.equal(sameConversation.waited, true);
  sameConversation.release();
  second.release();
  db.close();
});

test("stop aborts the active run and pauses queued followups", async () => {
  const { db, repository, coordinator } = fixture();
  const followup = repository.enqueueFollowup({ conversationId: "conv-1", text: "later" });
  const lease = await coordinator.acquire({ conversationId: "conv-1", runId: "run-1" });
  assert.equal(coordinator.stop("conv-1"), true);
  assert.equal(lease.signal.aborted, true);
  assert.equal(repository.getFollowup(followup.id)?.state, "paused");
  assert.equal(coordinator.activeCount(), 1, "stop does not release a still-settling operation");
  lease.release();
  db.close();
});

test("transient model work retries once with exponential-backoff notices", async () => {
  let calls = 0;
  const notices: string[] = [];
  const result = await retryAgentOperation({
    capability: "model",
    baseDelayMs: 0,
    operation: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary timeout");
      return "ok";
    },
    isTransient: () => true,
    onNotice: (notice) => notices.push(`${notice.type}:${notice.attempt}`),
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(notices, ["scheduled:2", "started:2", "completed:2"]);
});

test("unsafe mutations are never retried", async () => {
  let calls = 0;
  await assert.rejects(() => retryAgentOperation({
    capability: "unsafe_mutation",
    operation: async () => {
      calls += 1;
      throw new Error("indeterminate send result");
    },
    isTransient: () => true,
  }), /indeterminate send result/);
  assert.equal(calls, 1);
});

test("retry backoff is cancellable", async () => {
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(() => retryAgentOperation({
    capability: "idempotent_read",
    baseDelayMs: 10_000,
    signal: abort.signal,
    operation: async () => {
      calls += 1;
      abort.abort();
      throw new Error("temporary timeout");
    },
    isTransient: () => true,
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});
