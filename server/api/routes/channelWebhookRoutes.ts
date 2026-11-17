import { Hono } from "hono";
import type { ChannelAuditRepository } from "../../wemail/channels/ChannelAuditRepository.js";
import type { ChannelConnectionRepository } from "../../wemail/channels/ChannelConnectionRepository.js";
import type { ChannelInboundRepository } from "../../wemail/channels/ChannelLedgerRepository.js";
import type { ChannelPairingService } from "../../wemail/channels/ChannelPairingService.js";
import {
  ChannelSenderRateLimiter,
  constantTimeSecretMatches,
} from "../../wemail/channels/ChannelSecurity.js";
import {
  LANGBOT_MAX_WEBHOOK_BYTES,
  LangBotPayloadError,
  parseLangBotWebhook,
} from "../../wemail/channels/LangBotProtocol.js";

export interface ChannelWebhookRoutesDeps {
  connections: ChannelConnectionRepository;
  inbound: ChannelInboundRepository;
  webhookSecrets: { getWebhookSecret(connectionId: string): string | undefined };
  audit: ChannelAuditRepository;
  pairing?: Pick<ChannelPairingService, "intercept">;
  rateLimiter?: ChannelSenderRateLimiter;
}

function receivedSecret(headers: Headers): string | undefined {
  const direct = headers.get("x-wemail-webhook-secret")?.trim();
  if (direct) return direct;
  const authorization = headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function createChannelWebhookApp(deps: ChannelWebhookRoutesDeps) {
  const app = new Hono();
  const rateLimiter = deps.rateLimiter ?? new ChannelSenderRateLimiter();

  app.post("/langbot/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
    const connection = deps.connections.getConnection(connectionId);
    const expected = connection
      ? deps.webhookSecrets.getWebhookSecret(connectionId)
      : undefined;
    if (
      !connection ||
      !connection.enabled ||
      !constantTimeSecretMatches(expected, receivedSecret(c.req.raw.headers))
    ) {
      deps.audit.record({
        eventType: "langbot.webhook.rejected",
        actor: "langbot-webhook",
        scope: { reason: "unauthenticated" },
        result: "rejected",
      });
      return c.json({ status: "rejected" }, 401);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (
      Number.isFinite(contentLength) &&
      contentLength > LANGBOT_MAX_WEBHOOK_BYTES
    ) {
      return c.json({ status: "rejected", error: "payload-too-large" }, 413);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > LANGBOT_MAX_WEBHOOK_BYTES) {
      return c.json({ status: "rejected", error: "payload-too-large" }, 413);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ status: "rejected", error: "invalid-json" }, 400);
    }

    try {
      const event = parseLangBotWebhook(json, connectionId);
      const profile = deps.connections.getProfileByBot(
        connectionId,
        event.botUuid,
      );
      if (!profile || profile.platform !== event.platform) {
        deps.audit.record({
          eventType: "langbot.webhook.rejected",
          actor: "langbot-webhook",
          connectionId,
          scope: {
            botUuid: event.botUuid,
            reason: "bot-profile-not-found",
          },
          result: "rejected",
        });
        return c.json({ status: "rejected", error: "bot-not-configured" }, 404);
      }
      const rateKey = [
        connectionId,
        event.botUuid,
        event.chatId,
        event.senderId,
      ].join(":");
      if (!rateLimiter.consume(rateKey)) {
        deps.audit.record({
          eventType: "langbot.webhook.rate-limited",
          actor: "langbot-webhook",
          connectionId,
          profileId: profile.id,
          scope: { chatKind: event.chatKind },
          result: "rate-limited",
        });
        return c.json({ status: "rejected", error: "rate-limited" }, 429);
      }
      const pairing = deps.pairing?.intercept(event);
      if (pairing?.handled) {
        return c.json({
          status: "ok",
          skip_pipeline: true,
          pairing: pairing.outcome,
        });
      }
      const accepted = deps.inbound.accept(event, profile.id);
      if (!accepted.duplicate) {
        deps.connections.setProfileActivity(profile.id, "inbound", {
          success: true,
        });
      }
      return c.json({
        status: "ok",
        skip_pipeline: true,
        duplicate: accepted.duplicate,
      });
    } catch (error) {
      const code =
        error instanceof LangBotPayloadError
          ? error.code
          : "invalid-payload";
      const status = code === "payload-too-large" ? 413 : 400;
      deps.audit.record({
        eventType: "langbot.webhook.rejected",
        actor: "langbot-webhook",
        connectionId,
        scope: { reason: code },
        result: "rejected",
      });
      return c.json({ status: "rejected", error: code }, status);
    }
  });

  return app;
}
