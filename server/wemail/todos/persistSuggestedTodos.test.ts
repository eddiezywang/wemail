import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { insertCanonicalTestAccount, insertCanonicalTestMessage } from "../database/MailDatabase.test-support.js";
import { TodoRepository } from "./TodoRepository.js";
import { persistSuggestedTodos, type SuggestedTodos } from "./persistSuggestedTodos.js";

test("writer-side suggestion batches retain suppression and deduplication", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "account-1" });
    insertCanonicalTestMessage(db, { id: "message-1", accountId: "account-1" });
    const repository = new TodoRepository(db);
    const input: SuggestedTodos = [
      { title: "Prepare deck", confidence: 0.9, status: "suggested", evidence: ["Please prepare the deck"] },
      { title: "Review budget", confidence: 0.8, status: "suggested" },
    ];
    const save = () => db.transaction(() =>
      persistSuggestedTodos(repository, "account-1", "message-1", input),
    ).immediate();
    const first = save();
    assert.equal(first.length, 2);
    assert.deepEqual(save().map((todo) => todo.id), first.map((todo) => todo.id));
    assert.equal(repository.getById(first[0]!.id!)?.status, "suggested");
    assert.equal(repository.getById(first[0]!.id!)?.extractionConfidence, 0.9);
    repository.deleteAndSuppress(first[0]!.id!);
    assert.deepEqual(save().map((todo) => todo.title), ["Review budget"]);
  } finally { db.close(); }
});
