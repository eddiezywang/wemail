import { Hono } from "hono";
import type { ApplicationMessageType } from "../../../shared/wemail/applicationMessages.js";
import type { ApplicationMessageRepository } from "../../wemail/applicationMessages/ApplicationMessageRepository.js";
import type { MessageArtifactRepository } from "../../wemail/design/MessageArtifactRepository.js";
import type { SmartTagSuggestionService } from "../../wemail/intelligence/SmartTagSuggestionService.js";

export function buildApplicationMessageRoutes(deps: { messages: ApplicationMessageRepository; artifacts?: MessageArtifactRepository; smartTagSuggestions?: SmartTagSuggestionService; getActiveAccountId?: () => string | undefined }): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) return c.json({ ok: false, error: "accountId is required" }, 400);
    if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) return c.json({ ok: false, error: "cross-account-request" }, 403);
    const type = c.req.query("type") as ApplicationMessageType | undefined;
    return c.json({ ok: true, ...deps.messages.list(accountId, {
      unread: parseBoolean(c.req.query("unread")), archived: parseBoolean(c.req.query("archived")),
      type, sourceType: c.req.query("sourceType") as "automation" | "system" | "agent" | undefined,
      limit: parseNumber(c.req.query("limit")), offset: parseNumber(c.req.query("offset")),
    }) });
  });
  app.get("/:id", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) return c.json({ ok: false, error: "accountId is required" }, 400);
    if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) return c.json({ ok: false, error: "cross-account-request" }, 403);
    const message = deps.messages.get(c.req.param("id"), accountId);
    return message ? c.json({ ok: true, message }) : c.json({ ok: false, error: "message-not-found" }, 404);
  });
  app.get("/:id/artifact", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) return c.json({ ok: false, error: "accountId is required" }, 400);
    if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) return c.json({ ok: false, error: "cross-account-request" }, 403);
    const message = deps.messages.get(c.req.param("id"), accountId);
    if (!message?.artifact || !deps.artifacts) return c.json({ ok: false, error: "artifact-not-found" }, 404);
    const resource = deps.artifacts.readResource(message.artifact.id, message.artifact.version, "index.html", accountId);
    if (!resource) return c.json({ ok: false, error: "artifact-not-found" }, 404);
    c.header("Content-Type", resource.contentType);
    c.header("Cache-Control", "private, max-age=300, immutable");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(resource.body));
  });
  app.patch("/:id/read", async (c) => mutate(c, deps, "read"));
  app.patch("/:id/archive", async (c) => mutate(c, deps, "archive"));
  app.post("/smart-tag-topics/:topicId/actions", async (c) => {
    if (!deps.smartTagSuggestions) return c.json({ ok: false, error: "smart-tag-suggestions-unavailable" }, 503);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!accountId) return c.json({ ok: false, error: "accountId is required" }, 400);
    if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) return c.json({ ok: false, error: "cross-account-request" }, 403);
    try {
      if (action === "create") {
        const result = deps.smartTagSuggestions.createTag({
          accountId,
          topicId: c.req.param("topicId"),
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
        });
        return c.json({ ok: true, ...result });
      }
      if (action === "defer") return c.json({ ok: true, topic: deps.smartTagSuggestions.defer(accountId, c.req.param("topicId")) });
      if (action === "suppress") return c.json({ ok: true, topic: deps.smartTagSuggestions.suppress(accountId, c.req.param("topicId")) });
      return c.json({ ok: false, error: "unsupported-action" }, 400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, message === "topic-not-found" ? 404 : 409);
    }
  });
  return app;
}

async function mutate(c: any, deps: { messages: ApplicationMessageRepository; getActiveAccountId?: () => string | undefined }, kind: "read" | "archive") {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const value = body.value;
  if (!accountId || typeof value !== "boolean") return c.json({ ok: false, error: "accountId and boolean value are required" }, 400);
  if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) return c.json({ ok: false, error: "cross-account-request" }, 403);
  const message = kind === "read" ? deps.messages.markRead(c.req.param("id"), accountId, value) : deps.messages.archive(c.req.param("id"), accountId, value);
  return message ? c.json({ ok: true, message }) : c.json({ ok: false, error: "message-not-found" }, 404);
}

function parseBoolean(value?: string): boolean | undefined { return value === "true" ? true : value === "false" ? false : undefined; }
function parseNumber(value?: string): number | undefined { const number = value === undefined ? undefined : Number(value); return Number.isInteger(number) ? number : undefined; }
