import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { MailChangedEvent } from "../../wemail/bootstrap/AppCompositionTypes.js";
import type { MailCredentialInvalidEvent } from "../../wemail/mail/MailCredentialError.js";

export interface MailEventsRoutesDeps {
  getCurrentAccountId: () => string | undefined;
  onMailChanged: (listener: (event: MailChangedEvent) => void) => () => void;
  onMailCredentialInvalid?: (
    listener: (event: MailCredentialInvalidEvent) => void,
  ) => () => void;
  heartbeatIntervalMs?: number;
}

interface MailChangedSsePayload {
  type: "mail-changed";
  accountId: string;
  origin: "live-idle" | "live-poll" | "manual";
  insertedCount: number;
  insertedIds: string[];
  ts: string;
}

interface MailAuthRequiredSsePayload {
  type: "mail-auth-required";
  accountId: string;
  code: "MAIL_CREDENTIAL_INVALID";
  stage: "imap.login";
  ts: string;
}

function toSsePayload(event: MailChangedEvent): MailChangedSsePayload {
  return {
    type: "mail-changed",
    accountId: event.accountId,
    origin: event.origin,
    insertedCount: event.insertedCount,
    insertedIds: event.inserted.map((message) => message.id),
    ts: new Date().toISOString(),
  };
}

function toAuthRequiredSsePayload(
  event: MailCredentialInvalidEvent,
): MailAuthRequiredSsePayload {
  return {
    type: "mail-auth-required",
    accountId: event.accountId,
    code: event.code,
    stage: event.stage,
    ts: new Date().toISOString(),
  };
}

export function buildMailEventsRoutes(deps: MailEventsRoutesDeps) {
  const router = new Hono();
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 15_000;

  router.get("/events", async (c) => {
    const accountId = c.req.query("accountId");
    const currentAccountId = deps.getCurrentAccountId();

    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required", field: "accountId" }, 400);
    }
    if (!currentAccountId || currentAccountId !== accountId) {
      return c.json({ ok: false, error: "account mismatch" }, 403);
    }

    return streamSSE(c, async (stream) => {
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeAuthRequired?.();
      };

      const writeEvent = async (event: MailChangedEvent) => {
        if (event.accountId !== accountId) return;
        await stream.writeSSE({
          event: "mail-changed",
          data: JSON.stringify(toSsePayload(event)),
        });
      };

      const unsubscribe = deps.onMailChanged((event) => {
        void writeEvent(event);
      });
      const unsubscribeAuthRequired = deps.onMailCredentialInvalid?.((event) => {
        if (event.accountId !== accountId) return;
        void stream.writeSSE({
          event: "mail-auth-required",
          data: JSON.stringify(toAuthRequiredSsePayload(event)),
        });
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ ts: new Date().toISOString() }),
        });
      }, heartbeatIntervalMs);
      stream.onAbort(cleanup);

      const waitForAbort = new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

      try {
        await waitForAbort;
      } finally {
        cleanup();
      }
    });
  });

  return router;
}
