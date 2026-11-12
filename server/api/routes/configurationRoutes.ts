import { Hono, type Context } from "hono";
import type {
  ConfigurationPreviewAuthorization,
  ConfigurationRecoveryRequest,
  ConfigurationTaskSnapshot,
  StartConfigurationRequest,
} from "../../../shared/wemail/configuration.js";
import { ConfigurationOutcomeProjector } from "../../wemail/configuration/ConfigurationOutcomeProjector.js";
import {
  ConfigurationTaskConflictError,
} from "../../wemail/configuration/ConfigurationTaskRepository.js";
import type { ConfigurationWorkflowService } from "../../wemail/configuration/ConfigurationWorkflowService.js";

export interface ConfigurationRoutesDeps {
  workflow: ConfigurationWorkflowService;
  getActiveAccountId: () => string | undefined;
}

export function buildConfigurationRoutes(deps: ConfigurationRoutesDeps) {
  const app = new Hono();
  const projector = new ConfigurationOutcomeProjector();

  app.get("/", (context) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return context.json({ error: "account-required" }, 401);
    const limit = Math.max(1, Math.min(100, Number(context.req.query("limit")) || 25));
    const tasks = deps.workflow.list(accountId, limit);
    return context.json({
      tasks: tasks.map((snapshot) => ({ snapshot, outcome: projector.project(snapshot) })),
    });
  });

  app.post("/", async (context) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return context.json({ error: "account-required" }, 401);
    const body = await readObject(context);
    if (!body) return context.json({ error: "invalid-json-body" }, 400);
    const request = body as unknown as StartConfigurationRequest;
    if (
      typeof request.kind !== "string" ||
      typeof request.targetKey !== "string" ||
      typeof request.operation !== "string" ||
      typeof request.title !== "string" ||
      !request.source ||
      typeof request.source !== "object"
    ) {
      return context.json({ error: "invalid-configuration-start" }, 400);
    }
    const snapshot = deps.workflow.start({ ...request, accountId });
    return context.json({ snapshot, outcome: projector.project(snapshot) }, 201);
  });

  app.get("/:taskId", (context) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return context.json({ error: "account-required" }, 401);
    const snapshot = deps.workflow.get(context.req.param("taskId"), accountId);
    if (!snapshot) return context.json({ error: "configuration-task-not-found" }, 404);
    return context.json({ snapshot, outcome: projector.project(snapshot) });
  });

  app.post("/:taskId/recover", async (context) => mutate(context, deps, projector, async (body, accountId) => {
    const request = body as unknown as ConfigurationRecoveryRequest;
    if (!Number.isInteger(request.expectedRevision) || typeof request.recoveryActionId !== "string") {
      throw new RouteInputError("invalid-recovery-request");
    }
    return deps.workflow.resume({
      taskId: context.req.param("taskId"),
      accountId,
      expectedRevision: request.expectedRevision,
      recoveryActionId: request.recoveryActionId,
    });
  }));

  app.post("/:taskId/confirm", async (context) => mutate(context, deps, projector, async (body, accountId) => {
    const expectedRevision = body.expectedRevision;
    const authorization = body.authorization as ConfigurationPreviewAuthorization | undefined;
    if (!Number.isInteger(expectedRevision) || !authorization || typeof authorization !== "object") {
      throw new RouteInputError("invalid-confirmation-request");
    }
    return deps.workflow.confirm({
      taskId: context.req.param("taskId"),
      accountId,
      expectedRevision: expectedRevision as number,
      authorization,
    });
  }));

  app.post("/:taskId/cancel", async (context) => mutate(context, deps, projector, async (body, accountId) => {
    if (!Number.isInteger(body.expectedRevision)) throw new RouteInputError("invalid-cancel-request");
    return deps.workflow.cancel({
      taskId: context.req.param("taskId"),
      accountId,
      expectedRevision: body.expectedRevision as number,
    });
  }));

  app.post("/:taskId/retry", async (context) => mutate(context, deps, projector, async (body, accountId) => {
    if (!Number.isInteger(body.expectedRevision)) throw new RouteInputError("invalid-retry-request");
    const task = deps.workflow.get(context.req.param("taskId"), accountId);
    if (!task) throw new RouteNotFoundError();
    if (task.revision !== body.expectedRevision) throw new ConfigurationTaskConflictError(task);
    if (
      task.effects.some((effect) => effect.state === "partial" || effect.state === "unknown" || effect.state === "committed")
    ) {
      throw new RouteInputError("configuration-retry-requires-reconciliation");
    }
    const recovery = task.recoveries.find((item) => !item.resolvedAt && item.type === "retry_phase")
      ?? task.recoveries.find((item) => !item.resolvedAt && item.preferred);
    if (!recovery) throw new RouteInputError("configuration-safe-retry-unavailable");
    return deps.workflow.resume({
      taskId: task.id,
      accountId,
      expectedRevision: task.revision,
      recoveryActionId: recovery.id,
    });
  }));

  return app;
}

async function mutate(
  context: Context,
  deps: ConfigurationRoutesDeps,
  projector: ConfigurationOutcomeProjector,
  operation: (
    body: Record<string, unknown>,
    accountId: string,
  ) => Promise<ConfigurationTaskSnapshot | null> | ConfigurationTaskSnapshot | null,
) {
  const accountId = deps.getActiveAccountId();
  if (!accountId) return context.json({ error: "account-required" }, 401);
  const body = await readObject(context);
  if (!body) return context.json({ error: "invalid-json-body" }, 400);
  try {
    const snapshot = await operation(body, accountId);
    if (!snapshot) return context.json({ error: "configuration-task-not-found" }, 404);
    return context.json({ snapshot, outcome: projector.project(snapshot) });
  } catch (error) {
    if (error instanceof ConfigurationTaskConflictError) {
      if (!error.current) {
        return context.json({ error: "configuration-task-revision-conflict" }, 409);
      }
      return context.json({
        error: "configuration-task-revision-conflict",
        snapshot: error.current,
        outcome: projector.project(error.current),
      }, 409);
    }
    if (error instanceof RouteNotFoundError || (error instanceof Error && error.message === "configuration-task-not-found")) {
      return context.json({ error: "configuration-task-not-found" }, 404);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof RouteInputError ? 400 : 409;
    return context.json({ error: message }, status);
  }
}

async function readObject(context: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

class RouteInputError extends Error {}
class RouteNotFoundError extends Error {}
