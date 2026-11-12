import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { TodoItem } from "../../../shared/wemail/intelligence.js";
import type { TodoRepository } from "../../wemail/todos/TodoRepository.js";
import { buildTodoRoutes } from "./todoRoutes.js";

const todo: TodoItem = {
  id: "todo-1",
  accountId: "acct-active",
  emailId: "mail-1",
  title: "Reply",
  done: false,
  status: "confirmed",
  source: "user",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
};

function makeApp(options: {
  activeAccountId?: string;
  existing?: TodoItem | null;
  messageOwned?: boolean;
} = {}) {
  const calls: string[] = [];
  const todos = {
    list: () => [todo],
    getById: () => options.existing === undefined ? todo : options.existing,
    createManual: (input: unknown) => ({ ...todo, ...(input as object) }),
    setAgentStatus: () => todo,
  } as unknown as TodoRepository;
  const app = new Hono();
  app.route("/api/todos", buildTodoRoutes({
    todos,
    getActiveAccountId: () => options.activeAccountId ?? "acct-active",
    messageBelongsToAccount: () => options.messageOwned ?? true,
    service: {
      completeTodo: async (id) => { calls.push(`complete:${id}`); return todo; },
      restoreTodo: async (id) => { calls.push(`restore:${id}`); return todo; },
      confirmTodo: async (id) => { calls.push(`confirm:${id}`); return todo; },
      updateTodo: async (id) => { calls.push(`update:${id}`); return todo; },
      deleteTodo: async (id) => { calls.push(`delete:${id}`); return true; },
      rejectTodo: async (id) => { calls.push(`reject:${id}`); return true; },
    },
  }));
  return { app, calls };
}

test("todo mutations reject records owned by another active account", async () => {
  const { app, calls } = makeApp({ existing: { ...todo, accountId: "acct-other" } });
  const response = await app.request("/api/todos/todo-1/complete", { method: "POST" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, code: "TODO_NOT_FOUND" });
  assert.deepEqual(calls, []);
});

test("manual todo creation requires the source message to belong to the active account", async () => {
  const { app } = makeApp({ messageOwned: false });
  const response = await app.request("/api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailId: "mail-other", title: "Reply" }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, code: "MESSAGE_NOT_FOUND" });
});

test("todo routes return a stable authentication code without an active account", async () => {
  const { app } = makeApp({ activeAccountId: "" });
  const response = await app.request("/api/todos");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, code: "NO_ACTIVE_ACCOUNT" });
});

test("reject and delete keep distinct feedback semantics", async () => {
  const { app, calls } = makeApp();
  assert.equal((await app.request("/api/todos/todo-1/reject", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/todos/todo-1", { method: "DELETE" })).status, 200);
  assert.deepEqual(calls, ["reject:todo-1", "delete:todo-1"]);
});

test("todo details accept editable reminder fields", async () => {
  const { app, calls } = makeApp();
  const response = await app.request("/api/todos/todo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Reply by Friday",
      dueDate: "2026-08-14T09:00:00.000Z",
      timezone: "Asia/Shanghai",
      priority: "high",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["update:todo-1"]);
});
