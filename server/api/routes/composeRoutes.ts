import { Hono } from "hono";
import type { IntelligenceService } from "../../wemail/intelligence/IntelligenceService.js";
import type { CallerContext } from "../../../shared/wemail/intelligence.js";

export interface ComposeRoutesDeps {
  service: Pick<IntelligenceService, "composeMail">;
  getActiveAccountId: () => string | undefined;
}

export function buildComposeRoutes(deps: ComposeRoutesDeps) {
  const app = new Hono();

  app.post("/draft", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, code: "INVALID_BODY" }, 400);
    if (body.operationType !== "NEW" && body.operationType !== "REPLY") {
      return c.json({ ok: false, code: "INVALID_OPERATION_TYPE" }, 400);
    }
    if (body.operationType === "REPLY" && !nonEmptyString(body.emailId)) {
      return c.json({ ok: false, code: "SOURCE_MESSAGE_REQUIRED" }, 400);
    }
    if (!nonEmptyString(body.intent)) {
      return c.json({ ok: false, code: "INTENT_REQUIRED" }, 400);
    }

    const caller: CallerContext = { source: "user" };
    try {
      const draft = await deps.service.composeMail({
        operationType: body.operationType,
        intent: body.intent.trim(),
        accountId,
        emailId: optionalString(body.emailId),
        to: stringArray(body.to),
        currentTo: stringArray(body.currentTo),
        currentCc: stringArray(body.currentCc),
        currentBcc: stringArray(body.currentBcc),
        targetLanguage: optionalString(body.targetLanguage),
        styleId: optionalString(body.styleId),
        currentBody: optionalString(body.currentBody),
        currentSubject: optionalString(body.currentSubject),
        clientNow: optionalString(body.clientNow),
        clientTimeZone: optionalString(body.clientTimeZone),
      }, caller);
      return c.json({ ok: true, draft });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("Invalid styleId")) {
        return c.json({ ok: false, code: "INVALID_STYLE" }, 400);
      }
      if (/^Original email .+ was not found$/.test(message)) {
        return c.json({ ok: false, code: "SOURCE_MESSAGE_NOT_FOUND" }, 404);
      }
      if (message === "AI compose is not configured") {
        return c.json({ ok: false, code: "AI_NOT_CONFIGURED" }, 503);
      }
      if (message.startsWith("AI compose")) {
        return c.json({ ok: false, code: "AI_COMPOSE_FAILED" }, 502);
      }
      throw error;
    }
  });

  return app;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return nonEmptyString(value) ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(nonEmptyString).map((item) => item.trim()).slice(0, 100);
}
