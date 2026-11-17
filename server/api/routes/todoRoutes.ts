import { Hono } from "hono";
import type { IntelligenceService } from "../../wemail/intelligence/IntelligenceService.js";
import type { TodoRepository } from "../../wemail/todos/TodoRepository.js";
import {
  TASK_AGENT_STATUSES,
  type CallerContext,
  type TaskAgentStatus,
} from "../../../shared/wemail/intelligence.js";

export interface TodoRoutesDeps {
  todos: TodoRepository;
  service: Pick<IntelligenceService,
    "completeTodo" | "confirmTodo" | "restoreTodo" | "updateTodo" | "deleteTodo" | "rejectTodo">;
  getActiveAccountId: () => string | undefined;
  messageBelongsToAccount: (messageId: string, accountId: string) => boolean;
}

const AGENT_STATUSES = new Set<string>(TASK_AGENT_STATUSES);
const caller: CallerContext = { source: "user" };

export function buildTodoRoutes(deps: TodoRoutesDeps) {
  const app = new Hono();

  app.get("/", (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const status = c.req.query("status");
    if (status && status !== "open" && status !== "completed") {
      return c.json({ ok: false, code: "INVALID_STATUS" }, 400);
    }
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50));
    return c.json({
      ok: true,
      ...deps.todos.listAccountPage({
        accountId,
        status: status as "open" | "completed" | undefined,
        page,
        limit,
      }),
    });
  });

  app.post("/", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !nonEmptyString(body.emailId) || !nonEmptyString(body.title)) {
      return c.json({ ok: false, code: "INVALID_TODO" }, 400);
    }
    if (!deps.messageBelongsToAccount(body.emailId, accountId)) {
      return c.json({ ok: false, code: "MESSAGE_NOT_FOUND" }, 404);
    }
    const agentStatus = parseAgentStatus(body.agentStatus);
    if (agentStatus === undefined && body.agentStatus !== undefined) {
      return c.json({ ok: false, code: "INVALID_AGENT_STATUS" }, 400);
    }
    const priority = body.priority === "high" || body.priority === "medium" || body.priority === "low"
      ? body.priority
      : undefined;
    const todo = deps.todos.createManual({
      accountId,
      emailId: body.emailId.trim(),
      title: body.title.trim().slice(0, 500),
      description: optionalString(body.description),
      dueDate: optionalString(body.dueDate),
      startTime: optionalString(body.startTime),
      endTime: optionalString(body.endTime),
      timezone: optionalString(body.timezone),
      priority,
      agentStatus,
    });
    return c.json({ ok: true, todo });
  });

  app.post("/:id/complete", (c) => mutateOwned(c.req.param("id"), deps, (id) => deps.service.completeTodo(id, caller)));
  app.post("/:id/restore", (c) => mutateOwned(c.req.param("id"), deps, (id) => deps.service.restoreTodo(id, caller)));
  app.post("/:id/confirm", (c) => mutateOwned(c.req.param("id"), deps, (id) => deps.service.confirmTodo(id, caller)));
  app.post("/:id/reject", (c) => mutateOwned(c.req.param("id"), deps, (id) => deps.service.rejectTodo(id, caller), true));
  app.delete("/:id", (c) => mutateOwned(c.req.param("id"), deps, (id) => deps.service.deleteTodo(id, caller), true));

  app.patch("/:id", async (c) => {
    const accountId = deps.getActiveAccountId();
    const existing = accountId ? deps.todos.getById(c.req.param("id")) : null;
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    if (!existing || existing.accountId !== accountId) return c.json({ ok: false, code: "TODO_NOT_FOUND" }, 404);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, code: "INVALID_BODY" }, 400);
    if (body.title !== undefined && !nonEmptyString(body.title)) {
      return c.json({ ok: false, code: "INVALID_TITLE" }, 400);
    }
    for (const field of ["dueDate", "startTime", "endTime"] as const) {
      const value = body[field];
      if (value !== undefined && value !== null &&
        (typeof value !== "string" || (value.trim() && !Number.isFinite(Date.parse(value))))) {
        return c.json({ ok: false, code: "INVALID_DATE", field }, 400);
      }
    }
    for (const field of ["description", "timezone"] as const) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
        return c.json({ ok: false, code: "INVALID_TEXT", field }, 400);
      }
    }
    const priority = body.priority === "high" || body.priority === "medium" || body.priority === "low"
      ? body.priority
      : undefined;
    if (body.priority !== undefined && !priority) {
      return c.json({ ok: false, code: "INVALID_PRIORITY" }, 400);
    }
    const todo = await deps.service.updateTodo(existing.id, accountId, {
      ...(typeof body.title === "string" ? { title: body.title.trim().slice(0, 500) } : {}),
      ...nullableStringPatch(body, "description"),
      ...nullableStringPatch(body, "dueDate"),
      ...nullableStringPatch(body, "startTime"),
      ...nullableStringPatch(body, "endTime"),
      ...nullableStringPatch(body, "timezone"),
      ...(priority ? { priority } : {}),
    }, caller);
    return c.json({ ok: true, todo });
  });

  app.patch("/:id/agent-status", async (c) => {
    const accountId = deps.getActiveAccountId();
    const existing = accountId ? deps.todos.getById(c.req.param("id")) : null;
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    if (!existing || existing.accountId !== accountId) return c.json({ ok: false, code: "TODO_NOT_FOUND" }, 404);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, code: "INVALID_BODY" }, 400);
    const status = parseAgentStatus(body.status);
    if (status === undefined) return c.json({ ok: false, code: "INVALID_AGENT_STATUS" }, 400);
    const todo = deps.todos.setAgentStatus({
      id: existing.id,
      status,
      lock: typeof body.lock === "boolean" ? body.lock : true,
    });
    return c.json({ ok: true, todo });
  });

  return app;
}

async function mutateOwned(
  id: string,
  deps: TodoRoutesDeps,
  action: (id: string) => unknown | Promise<unknown>,
  deletion = false,
) {
  const accountId = deps.getActiveAccountId();
  if (!accountId) return Response.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, { status: 401 });
  const existing = deps.todos.getById(id);
  if (!existing || existing.accountId !== accountId) {
    return Response.json({ ok: false, code: "TODO_NOT_FOUND" }, { status: 404 });
  }
  const result = await action(id);
  if (!result && !deletion) return Response.json({ ok: false, code: "TODO_NOT_FOUND" }, { status: 404 });
  return Response.json(deletion ? { ok: true } : { ok: true, todo: result });
}

function parseAgentStatus(value: unknown): TaskAgentStatus | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && AGENT_STATUSES.has(value)
    ? value as TaskAgentStatus
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value.trim() : undefined;
}

function nullableStringPatch<T extends string>(
  body: Record<string, unknown>,
  field: T,
): Partial<Record<T, string | null>> {
  if (!(field in body)) return {};
  const value = body[field];
  return { [field]: typeof value === "string" && value.trim() ? value.trim() : null } as Partial<Record<T, string | null>>;
}
