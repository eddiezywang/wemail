import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJob,
  TodoExtractionResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import {
  LlmClientError,
  type LlmClient,
  type LlmResponse,
} from "../../ai/LlmClient.js";
import type { TodoRepository, TodoRecord } from "../../todos/TodoRepository.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  TODO_EXTRACTION_JSON_SCHEMA,
  TODO_EXTRACTION_PROCESSOR_VERSION,
  TodoExtractionProcessor,
  TodoExtractionProcessorError,
  isAmbiguousDueDate,
  normalizeTodoTitle,
} from "./TodoExtractionProcessor.js";

/**
 * In-memory mock TodoRepository that doesn't require SQLite.
 * Supports suppression, upsert, and basic operations.
 */
function makeMockTodoRepository() {
  const todos: Map<string, TodoRecord> = new Map();
  const suppressions: Map<string, { emailId: string; accountId: string; normalizedTitle: string; dueDate?: string }> = new Map();

  let nextId = 1;

  function normalizeTitleInternal(title: string): string {
    return title.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function suppressionKey(emailId: string, title: string, dueDate?: string): string {
    return `${emailId}::${normalizeTitleInternal(title)}::${dueDate ?? ""}`;
  }

  function doRecordSuppression(input: {
    emailId: string;
    accountId: string;
    normalizedTitle: string;
    dueDate?: string;
  }): void {
    const key = suppressionKey(input.emailId, input.normalizedTitle, input.dueDate);
    suppressions.set(key, input);
  }

  return {
    upsertSuggested(input: {
      emailId: string;
      accountId: string;
      title: string;
      description?: string;
      dueDate?: string;
      startTime?: string;
      source?: "ai" | "user" | "agent";
      evidence?: string[];
      extractionReason?: string;
      extractionConfidence?: number;
    }): TodoRecord {
      const key = `${input.emailId}::${input.title}::${input.dueDate ?? ""}`;
      const existing = todos.get(key);
      if (existing) {
        // Update existing in place — Route C / WP G: extraction provenance
        // (evidence/reason/confidence) is preserved on conflict, mirroring
        // the production SQL ON CONFLICT clause.
        existing.description = input.description ?? existing.description;
        existing.startTime = input.startTime ?? existing.startTime;
        existing.updatedAt = new Date().toISOString();
        return existing;
      }
      const record: TodoRecord = {
        id: `todo-mock-${nextId++}`,
        emailId: input.emailId,
        accountId: input.accountId,
        title: input.title,
        description: input.description,
        dueDate: input.dueDate,
        startTime: input.startTime,
        done: false,
        status: "suggested",
        source: input.source ?? "ai",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        evidence: input.evidence,
        extractionReason: input.extractionReason,
        extractionConfidence: input.extractionConfidence,
      };
      todos.set(key, record);
      return record;
    },

    isSuppressed(emailId: string, _accountId: string, title: string, dueDate?: string): boolean {
      const key = suppressionKey(emailId, title, dueDate);
      return suppressions.has(key);
    },

    recordSuppression(input: {
      emailId: string;
      accountId: string;
      normalizedTitle: string;
      dueDate?: string;
    }): void {
      doRecordSuppression(input);
    },

    delete(id: string): boolean {
      for (const [key, record] of todos.entries()) {
        if (record.id === id) {
          todos.delete(key);
          return true;
        }
      }
      return false;
    },

    deleteAndSuppress(id: string): boolean {
      for (const [key, record] of todos.entries()) {
        if (record.id === id) {
          todos.delete(key);
          if (record.source === "ai") {
            doRecordSuppression({
              emailId: record.emailId,
              accountId: record.accountId,
              normalizedTitle: normalizeTitleInternal(record.title),
              dueDate: record.dueDate,
            });
          }
          return true;
        }
      }
      return false;
    },

    listByEmail(emailId: string): TodoRecord[] {
      return [...todos.values()].filter((t) => t.emailId === emailId);
    },

    getById(id: string): TodoRecord | null {
      for (const record of todos.values()) {
        if (record.id === id) return record;
      }
      return null;
    },

    complete(id: string): TodoRecord | null {
      for (const record of todos.values()) {
        if (record.id === id) {
          record.done = true;
          record.status = "confirmed";
          record.doneDate = new Date().toISOString();
          return record;
        }
      }
      return null;
    },

    restore(id: string): TodoRecord | null {
      for (const record of todos.values()) {
        if (record.id === id) {
          record.done = false;
          record.doneDate = undefined;
          return record;
        }
      }
      return null;
    },

    confirm(id: string): TodoRecord | null {
      for (const record of todos.values()) {
        if (record.id === id) {
          record.status = "confirmed";
          return record;
        }
      }
      return null;
    },

    list(query: { accountId: string; status?: "open" | "completed"; emailId?: string }): TodoRecord[] {
      let result = [...todos.values()].filter((t) => t.accountId === query.accountId);
      if (query.status === "open") result = result.filter((t) => !t.done);
      if (query.status === "completed") result = result.filter((t) => t.done);
      if (query.emailId) result = result.filter((t) => t.emailId === query.emailId);
      return result;
    },
  } as unknown as TodoRepository;
}

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Q3 plans",
    snippet: "we need",
    bodyText: "Please prepare the Q3 deck by Friday.",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type: "todoExtraction",
    status: "running",
    attempts: 0,
    maxAttempts: 3,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(msg: MailMessage | null): ProcessorContext {
  return { getMessage: () => msg };
}

function fakeClient(impl: (req: unknown) => Promise<LlmResponse>): LlmClient {
  return { generate: impl as LlmClient["generate"] };
}

// ── Suggested-only AI todos ─────────────────────────────────────────

test("TodoExtractionProcessor awaits asynchronous prompt lookup and persistence", async () => {
  let saved = false;
  const processor = new TodoExtractionProcessor({
    model: "test-model",
    getTodoPrompt: async () => "Custom asynchronous todo instructions",
    llmClient: fakeClient(async (request) => {
      assert.ok((request as { system: string }).system.includes("Custom asynchronous todo instructions"));
      assert.equal((request as { timeoutMs: number }).timeoutMs, 60_000);
      return { text: JSON.stringify({ todos: [{ title: "Review budget", confidence: 0.8 }] }), finishReason: "stop" };
    }),
    persistTodos: async (accountId, emailId, todos) => {
      assert.equal(accountId, "acct-1");
      assert.equal(emailId, makeJob().emailId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      saved = true;
      return todos.map((todo) => ({ ...todo, id: "writer-todo-1" }));
    },
  });
  const result = await processor.handle(makeJob(), makeCtx(makeMessage()));
  assert.equal(saved, true);
  assert.equal(result.todos[0]?.id, "writer-todo-1");
});

test("TodoExtractionProcessor creates todos with status=suggested, never confirmed", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          { title: "Prepare Q3 deck", confidence: 0.9 },
          { title: "Review budget", confidence: 0.7 },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.equal(result.type, "todoExtraction");
  assert.equal(result.todos.length, 2);
  for (const todo of result.todos) {
    assert.equal(todo.status, "suggested", "AI-extracted todos must be suggested, not confirmed");
  }

  // Also verify in mock repo
  const dbTodos = todos.listByEmail("acct-1:INBOX:1:100");
  for (const t of dbTodos) {
    assert.equal(t.status, "suggested");
    assert.equal(t.source, "ai");
  }
});

test("TodoExtractionProcessor never auto-confirms even if LLM returns status=confirmed", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      // LLM tries to return confirmed status -- should be forced to suggested
      text: JSON.stringify({
        todos: [
          { title: "Prepare Q3 deck", confidence: 0.9, status: "confirmed" },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.equal(result.todos[0].status, "suggested", "status must be forced to suggested even when LLM returns confirmed");
});

// ── Duplicate merge ─────────────────────────────────────────────────

test("TodoExtractionProcessor deduplicates on rerun for same email", async () => {
  const todos = makeMockTodoRepository();
  const llmResponse = {
    text: JSON.stringify({
      todos: [{ title: "Prepare Q3 deck", confidence: 0.9 }],
    }),
    finishReason: "stop" as const,
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => llmResponse),
    todos,
  });

  const msg = makeMessage();

  // First run
  const result1 = (await processor.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  assert.equal(result1.todos.length, 1);
  const firstId = result1.todos[0].id;

  // Second run (rerun extraction for same email)
  const result2 = (await processor.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  assert.equal(result2.todos.length, 1);

  // Should reuse/update existing, not create duplicate
  const allTodos = todos.listByEmail("acct-1:INBOX:1:100");
  assert.equal(allTodos.length, 1, "rerun should not create duplicate todos");
  assert.equal(allTodos[0].id, firstId, "should reuse the same todo id");
});

test("TodoExtractionProcessor deduplicates by normalized title", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "  Prepare   Q3   deck  ", confidence: 0.9 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const msg = makeMessage();
  const result = (await processor.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;

  // Title should be normalized (trimmed, whitespace collapsed)
  assert.equal(result.todos[0].title, "Prepare Q3 deck");

  // If we run again with a slightly different whitespace version, it should dedupe
  const processor2 = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Prepare Q3 deck", confidence: 0.95 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result2 = (await processor2.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  const allTodos = todos.listByEmail("acct-1:INBOX:1:100");
  assert.equal(allTodos.length, 1, "normalized title should deduplicate");
});

// ── Conservative due dates ──────────────────────────────────────────

test("TodoExtractionProcessor strips ambiguous due dates", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          { title: "Review document", confidence: 0.7, dueDate: "soon" },
          { title: "Call client", confidence: 0.8, dueDate: "when possible" },
          { title: "File report", confidence: 0.9, dueDate: "2026-05-01" },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  // Ambiguous dates should be stripped
  const reviewTodo = result.todos.find((t) => t.title === "Review document")!;
  assert.equal(reviewTodo.dueDate, undefined, "'soon' is ambiguous, dueDate should be unset");

  const callTodo = result.todos.find((t) => t.title === "Call client")!;
  assert.equal(callTodo.dueDate, undefined, "'when possible' is ambiguous, dueDate should be unset");

  // Explicit ISO date should be preserved
  const fileTodo = result.todos.find((t) => t.title === "File report")!;
  assert.equal(fileTodo.dueDate, "2026-05-01", "explicit ISO date should be preserved");
});

test("TodoExtractionProcessor drops dates that cannot be persisted", async () => {
  const processor = new TodoExtractionProcessor({
    model: "test-model",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ todos: [
        { title: "Unparseable", confidence: 0.8, dueDate: "tomorrow", startTime: "next Monday" },
        { title: "Parseable", confidence: 0.9, dueDate: "2026-05-01", startTime: "2026-05-01T10:00:00Z" },
      ] }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos: makeMockTodoRepository(),
  });
  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as TodoExtractionResult;
  assert.equal(result.todos[0].dueDate, undefined);
  assert.equal(result.todos[0].startTime, undefined);
  assert.equal(result.todos[1].dueDate, "2026-05-01");
  assert.equal(result.todos[1].startTime, "2026-05-01T10:00:00Z");
});

test("isAmbiguousDueDate rejects vague phrases", () => {
  assert.equal(isAmbiguousDueDate("soon"), true);
  assert.equal(isAmbiguousDueDate("when possible"), true);
  assert.equal(isAmbiguousDueDate("eventually"), true);
  assert.equal(isAmbiguousDueDate("at some point"), true);
  assert.equal(isAmbiguousDueDate("sometime"), true);
  assert.equal(isAmbiguousDueDate("ASAP"), true);
  assert.equal(isAmbiguousDueDate("as soon as possible"), true);
  assert.equal(isAmbiguousDueDate("when you get a chance"), true);
  assert.equal(isAmbiguousDueDate("in a while"), true);
  assert.equal(isAmbiguousDueDate("later"), true);
});

test("isAmbiguousDueDate accepts explicit dates", () => {
  assert.equal(isAmbiguousDueDate("2026-05-01"), false);
  assert.equal(isAmbiguousDueDate("2026-12-31"), false);
  assert.equal(isAmbiguousDueDate("Friday"), false);
  assert.equal(isAmbiguousDueDate("next Monday"), false);
  assert.equal(isAmbiguousDueDate("by end of week"), false);
  assert.equal(isAmbiguousDueDate("tomorrow"), false);
  assert.equal(isAmbiguousDueDate("this Friday"), false);
  assert.equal(isAmbiguousDueDate("by 5pm today"), false);
});

// ── Deletion suppression ────────────────────────────────────────────

test("TodoExtractionProcessor suppresses deleted suggestions on rerun", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Prepare Q3 deck", confidence: 0.9 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const msg = makeMessage();

  // First run creates the todo
  const result1 = (await processor.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  assert.equal(result1.todos.length, 1);
  const todoId = result1.todos[0].id!;

  // User deletes the suggestion and records suppression
  todos.deleteAndSuppress(todoId);

  // Rerun extraction - same todo should NOT reappear
  const result2 = (await processor.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  assert.equal(result2.todos.length, 0, "deleted suggestion should not reappear");

  // Verify DB has no active todos for this email
  const allTodos = todos.listByEmail("acct-1:INBOX:1:100");
  assert.equal(allTodos.length, 0, "DB should have no todos after suppression");
});

test("TodoExtractionProcessor only suppresses for the specific email", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Prepare Q3 deck", confidence: 0.9 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  // First extraction on email A
  const msgA = makeMessage({ id: "acct-1:INBOX:1:100" });
  const result1 = (await processor.handle(makeJob(), makeCtx(msgA))) as TodoExtractionResult;
  const todoId = result1.todos[0].id!;

  // User deletes for email A
  todos.deleteAndSuppress(todoId);

  // Extraction on different email B should NOT be suppressed
  const msgB = makeMessage({ id: "acct-1:INBOX:1:200" });
  const jobB = { ...makeJob(), emailId: "acct-1:INBOX:1:200" };
  const result2 = (await processor.handle(jobB, makeCtx(msgB))) as TodoExtractionResult;
  assert.equal(result2.todos.length, 1, "suppression should be email-scoped, not global");
});

test("TodoExtractionProcessor allows new different todo after suppression", async () => {
  const todos = makeMockTodoRepository();

  // First extraction
  const processor1 = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Prepare Q3 deck", confidence: 0.9 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const msg = makeMessage();
  const result1 = (await processor1.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  const todoId = result1.todos[0].id!;

  // User deletes
  todos.deleteAndSuppress(todoId);

  // Re-extraction with different todo should still work
  const processor2 = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          { title: "Review budget spreadsheet", confidence: 0.85 },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result2 = (await processor2.handle(makeJob(), makeCtx(msg))) as TodoExtractionResult;
  assert.equal(result2.todos.length, 1, "different todo should not be suppressed");
  assert.equal(result2.todos[0].title, "Review budget spreadsheet");
});

// ── Normalization ───────────────────────────────────────────────────

test("normalizeTodoTitle collapses whitespace and lowercases", () => {
  assert.equal(normalizeTodoTitle("  Prepare   Q3   deck  "), "prepare q3 deck");
  assert.equal(normalizeTodoTitle("Review budget"), "review budget");
  assert.equal(normalizeTodoTitle("  TODO:  call   client  "), "todo: call client");
});

// ── Error handling ──────────────────────────────────────────────────

test("TodoExtractionProcessor throws when mail is missing", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new Error("should not be called");
    }),
    todos,
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof TodoExtractionProcessorError);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("TodoExtractionProcessor marks invalid JSON as non-retryable", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: "not json",
      finishReason: "stop",
    })),
    todos,
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof TodoExtractionProcessorError);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("TodoExtractionProcessor treats finishReason=length as non-retryable truncation", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "a", confidence: 0.5 }],
      }),
      finishReason: "length",
    })),
    todos,
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof TodoExtractionProcessorError);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("TodoExtractionProcessor propagates LlmClientError as retryable", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new LlmClientError({ status: 503, code: "overloaded", message: "busy" });
    }),
    todos,
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

// ── Confidence ──────────────────────────────────────────────────────

test("TodoExtractionProcessor filters out todos with empty titles", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          { title: "", confidence: 0.5 },
          { title: "   ", confidence: 0.5 },
          { title: "Valid todo", confidence: 0.8 },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].title, "Valid todo");
});

test("TodoExtractionProcessor clamps confidence to [0, 1]", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          { title: "High", confidence: 2.0 },
          { title: "Low", confidence: -0.5 },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.equal(result.todos[0].confidence, 1);
  assert.equal(result.todos[1].confidence, 0);
});

// ── Body-free logging ───────────────────────────────────────────────

test("TodoExtractionProcessor does not log mail body", async () => {
  const todos = makeMockTodoRepository();
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Prepare Q3 deck", confidence: 0.9 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
    logger: (event, fields) => logs.push({ event, fields }),
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));

  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("Q3 deck"));
  assert.ok(!serialized.includes("Please prepare"));
});

// ── System prompt contains conservative date instructions ───────────

test("TodoExtractionProcessor system prompt instructs conservative due dates", async () => {
  let capturedSystem = "";
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      capturedSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({
          todos: [{ title: "Test", confidence: 0.5 }],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    todos,
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(capturedSystem.includes("Use explicit dates from the email."));
  assert.ok(capturedSystem.includes("Do not invent precise dates."));
});

test("TodoExtractionProcessor prompt consolidates outcomes and skips conditional reference instructions", async () => {
  let capturedSystem = "";
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      capturedSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({ todos: [] }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    todos: makeMockTodoRepository(),
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));

  assert.match(capturedSystem, /Create one todo per outcome/);
  assert.match(capturedSystem, /conditional reference instructions/);
  assert.match(capturedSystem, /watch for the selection notice/);
});

test("TODO_EXTRACTION_JSON_SCHEMA requires every todo property for strict structured output", () => {
  const schema = TODO_EXTRACTION_JSON_SCHEMA as {
    properties: {
      todos: {
        items: {
          required: string[];
          properties: Record<string, unknown>;
        };
      };
    };
  };
  const itemSchema = schema.properties.todos.items;

  assert.deepEqual(
    [...itemSchema.required].sort(),
    Object.keys(itemSchema.properties).sort(),
  );
});

// ── _metadata (Route C / WP A) ──────────────────────────────────────

test("TodoExtractionProcessor emits _metadata with processor / version / model / tokenUsage", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Send Q3 deck", confidence: 0.85 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 17 },
    })),
    todos,
    now: () => 1_700_000_000_000,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.ok(result._metadata, "_metadata must be present");
  assert.equal(result._metadata.processor, "todoExtraction");
  assert.equal(typeof result._metadata.version, "number");
  assert.ok(result._metadata.version >= 1);
  assert.equal(result._metadata.model, "gpt-4o-mini");
  assert.equal(result._metadata.tokenUsage.inputTokens, 42);
  assert.equal(result._metadata.tokenUsage.outputTokens, 17);
  assert.ok(result._metadata.contextRefs.length > 0);
  assert.ok(result._metadata.createdAt);
  assert.equal(typeof result._metadata.durationMs, "number");
});

// ── Evidence / extractionReason / extractionConfidence (Route C / WP G) ─

test("TodoExtractionProcessor persists evidence + extractionReason + extractionConfidence", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          {
            title: "Prepare Q3 deck",
            confidence: 0.9,
            evidence: ["Please prepare the Q3 deck", "by Friday"],
            extractionReason: "Sender explicitly asks for the deck before Friday.",
          },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  // Result-level fields are populated.
  assert.deepEqual(result.todos[0].evidence, [
    "Please prepare the Q3 deck",
    "by Friday",
  ]);
  assert.equal(
    result.todos[0].extractionReason,
    "Sender explicitly asks for the deck before Friday.",
  );
  assert.equal(result.todos[0].extractionConfidence, 0.9);

  // Repository-level fields round-trip via the mock.
  const dbTodos = todos.listByEmail("acct-1:INBOX:1:100");
  assert.equal(dbTodos.length, 1);
  assert.deepEqual(dbTodos[0].evidence, [
    "Please prepare the Q3 deck",
    "by Friday",
  ]);
  assert.equal(
    dbTodos[0].extractionReason,
    "Sender explicitly asks for the deck before Friday.",
  );
  assert.equal(dbTodos[0].extractionConfidence, 0.9);
});

test("TodoExtractionProcessor caps evidence array at 3 and each string at 200 chars", async () => {
  const todos = makeMockTodoRepository();
  const longQuote = "x".repeat(500);
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          {
            title: "Big task",
            confidence: 0.7,
            evidence: ["one", "two", "three", "four", longQuote],
          },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  const evidence = result.todos[0].evidence!;
  assert.equal(evidence.length, 3, "evidence must be capped at 3 items");
  for (const item of evidence) {
    assert.ok(item.length <= 200, `evidence string must be capped at 200 chars (got ${item.length})`);
  }
});

test("TodoExtractionProcessor leaves evidence undefined when LLM omits it", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Plain task", confidence: 0.6 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.equal(result.todos[0].evidence, undefined);
  assert.equal(result.todos[0].extractionReason, undefined);
  // Model confidence still flows into extractionConfidence even when no evidence.
  assert.equal(result.todos[0].extractionConfidence, 0.6);
});

test("TodoExtractionProcessor coerces non-string evidence entries away", async () => {
  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [
          {
            title: "Mixed",
            confidence: 0.5,
            evidence: ["valid quote", 123, null, "  ", "another"],
          },
        ],
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.deepEqual(result.todos[0].evidence, ["valid quote", "another"]);
});

test("TODO_EXTRACTION_PROCESSOR_VERSION is at least 2 and shows up in _metadata", async () => {
  assert.ok(
    TODO_EXTRACTION_PROCESSOR_VERSION >= 2,
    `expected version >= 2, got ${TODO_EXTRACTION_PROCESSOR_VERSION}`,
  );

  const todos = makeMockTodoRepository();
  const processor = new TodoExtractionProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        todos: [{ title: "Versioned", confidence: 0.5 }],
      }),
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    todos,
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as TodoExtractionResult;

  assert.equal(result._metadata?.version, TODO_EXTRACTION_PROCESSOR_VERSION);
});
