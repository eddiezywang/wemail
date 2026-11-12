import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChannelPlatform } from "../../../shared/wemail/channels.js";
import type { ChannelBindingRepository } from "../../wemail/channels/ChannelBindingRepository.js";
import type { ChannelConnectionRepository } from "../../wemail/channels/ChannelConnectionRepository.js";
import type { ChannelManagementService } from "../../wemail/channels/ChannelManagementService.js";
import type { ChannelDestinationRepository } from "../../wemail/channels/ChannelDestinationRepository.js";
import type { ChannelPairingService } from "../../wemail/channels/ChannelPairingService.js";
import type { IntegrationStatusService } from "../../wemail/channels/IntegrationStatusService.js";
import type { AutomationRuleRepository } from "../../wemail/automation/AutomationRuleRepository.js";
import type { BotChannelConfigurationService } from "../../wemail/channels/BotChannelConfigurationService.js";
import type { ChannelBotOnboardingService } from "../../wemail/channels/ChannelBotOnboardingService.js";

export interface ChannelRoutesDeps {
  connections: ChannelConnectionRepository;
  configurations: BotChannelConfigurationService;
  onboarding: ChannelBotOnboardingService;
  management: ChannelManagementService;
  pairing: ChannelPairingService;
  bindings: ChannelBindingRepository;
  destinations: ChannelDestinationRepository;
  status: IntegrationStatusService;
  automationRules: AutomationRuleRepository;
  getActiveAccountId: () => string | undefined;
}

const platform = (value: unknown): ChannelPlatform => {
  if (value !== "feishu" && value !== "wecom") {
    throw new Error("invalid-channel-platform");
  }
  return value;
};

export function buildChannelRoutes(deps: ChannelRoutesDeps) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!deps.getActiveAccountId()) {
      return c.json({ error: "account-required" }, 401);
    }
    await next();
  });

  app.get("/platform-configurations", (c) =>
    c.json({ configurations: deps.configurations.list() }),
  );
  app.put("/platform-configurations/:platform", async (c) => {
    try {
      const selectedPlatform = platform(c.req.param("platform"));
      const body = await c.req.json();
      return c.json({
        configuration: deps.configurations.save({
          platform: selectedPlatform,
          externalBotId: String(
            selectedPlatform === "feishu"
              ? body.appId ?? ""
              : body.botId ?? "",
          ),
          secret: String(
            selectedPlatform === "feishu"
              ? body.appSecret ?? ""
              : body.botSecret ?? "",
          ).trim() || undefined,
        }),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/platform-configurations/:platform/disable", (c) => {
    try {
      return c.json({
        configuration: deps.configurations.disable(
          platform(c.req.param("platform")),
        ),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/platform-configurations/:platform/setup", async (c) => {
    try {
      return c.json({
        setup: await deps.onboarding.start(platform(c.req.param("platform"))),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/platform-configurations/setup/:id", async (c) => {
    try {
      return c.json({ setup: await deps.onboarding.get(c.req.param("id")) });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete("/platform-configurations/setup/:id", (c) =>
    c.json({ cancelled: deps.onboarding.cancel(c.req.param("id")) }),
  );
  app.get("/profiles", (c) => {
    const value = c.req.query("platform");
    return c.json({
      profiles: deps.connections.listProfiles(
        value ? platform(value) : undefined,
      ),
    });
  });
  app.post("/profiles/:id/pairing", (c) => {
    try {
      const profile = deps.connections.getProfile(c.req.param("id"));
      if (!profile) throw new Error("channel-profile-not-found");
      // A deliberate disconnect disables the persisted Bot Core configuration.
      // Pairing must bring that transport back online before asking the owner to
      // send a command, otherwise the command can never reach WeMail.
      deps.configurations.enable(profile.platform);
      return c.json({ pairing: deps.pairing.createChallenge(profile.id) });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/pairing/cancel", (c) => {
    try {
      return c.json({
        profile: deps.pairing.cancelChallenge(c.req.param("id")),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/detect", async (c) => {
    try {
      return c.json({
        diagnostics: await deps.management.detect(c.req.param("id")),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/test-message", (c) => {
    try {
      return c.json({
        delivery: deps.management.queueTestMessage(c.req.param("id")),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/initialization/retry", (c) => {
    try {
      return c.json({
        delivery: deps.pairing.retryInitialization(c.req.param("id")),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/disconnect", (c) => {
    try {
      const profile = deps.connections.getProfile(c.req.param("id"));
      if (!profile) throw new Error("channel-profile-not-found");
      const disconnected = deps.management.disconnectProfile(profile.id);
      deps.configurations.disable(profile.platform);
      return c.json({
        profile: disconnected,
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/reset", (c) => {
    try {
      return c.json({
        profile: deps.configurations.resetProfile(c.req.param("id")),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/profiles/:id/bindings", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ error: "account-required" }, 401);
    try {
      const body = await c.req.json();
      const binding = deps.management.createBinding({
        profileId: c.req.param("id"),
        accountId,
        chatKind: body.chatKind === "group" ? "group" : "person",
        chatId: String(body.chatId ?? ""),
        senderId: String(body.senderId ?? ""),
        conversationId:
          typeof body.conversationId === "string"
            ? body.conversationId
            : undefined,
        requireMention: body.requireMention !== false,
      });
      return c.json({ binding }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/bindings/:id/revoke", (c) =>
    c.json({ revoked: deps.bindings.revoke(c.req.param("id")) }),
  );
  app.post("/bindings/:id/enable", (c) =>
    c.json({ updated: deps.bindings.setEnabled(c.req.param("id"), true) }),
  );
  app.post("/bindings/:id/disable", (c) =>
    c.json({ updated: deps.bindings.setEnabled(c.req.param("id"), false) }),
  );
  app.get("/profiles/:id/bindings", (c) =>
    c.json({ bindings: deps.bindings.listByProfile(c.req.param("id")) }),
  );
  app.get("/profiles/:id/destinations", (c) =>
    c.json({ destinations: deps.destinations.list(c.req.param("id")) }),
  );
  app.get("/profiles/:id/dependent-rules", (c) => {
    const accountId = deps.getActiveAccountId()!;
    const profileId = c.req.param("id");
    const profile = deps.connections.getProfile(profileId);
    return c.json({
      rules: deps.automationRules
        .list(accountId)
        .flatMap((rule) =>
          rule.actions.flatMap((action) =>
            action.type === "publishBotMessage" &&
            action.botProfileId === profileId
              ? [{
              id: rule.id,
              name: rule.name,
              enabled: rule.enabled,
              ownerBindingVersion:
                action.destination.type === "owner"
                  ? action.destination.ownerBindingVersion
                  : undefined,
              destinationType: action.destination.type,
              needsReauthorization:
                action.destination.type === "owner" &&
                action.destination.ownerBindingVersion !==
                  profile?.owner?.bindingVersion,
                }]
              : [],
          ),
        ),
    });
  });
  app.post("/profiles/:id/destinations", async (c) => {
    try {
      const body = await c.req.json();
      return c.json({
        destination: deps.destinations.save({
          profileId: c.req.param("id"),
          type: body.type === "group" ? "group" : "person",
          externalId: String(body.externalId ?? ""),
          displayName:
            typeof body.displayName === "string" ? body.displayName : undefined,
          verified: body.verified === true,
        }),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete("/profiles/:profileId/destinations/:id", (c) =>
    c.json({
      deleted: deps.destinations.remove(
        c.req.param("id"),
        c.req.param("profileId"),
      ),
    }),
  );

  app.get("/status", (c) => c.json(deps.status.getCached()));
  app.post("/status/detect", async (c) => {
    // Optional `?id=` scopes detection to a single channel (e.g. "wecli") so a
    // WeCom/Feishu detect can never block the WeCLI probe result.
    const raw = c.req.query("id");
    const id =
      raw === "wecli" || raw === "feishu" || raw === "wecom" ? raw : undefined;
    return c.json(await deps.status.refresh(id));
  });
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = deps.status.subscribe((snapshot) => {
        void stream.writeSSE({
          event: "integration-status",
          data: JSON.stringify(snapshot),
        });
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ ts: new Date().toISOString() }),
        });
      }, 15_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      stream.onAbort(cleanup);
      try {
        await new Promise<void>((resolve) =>
          c.req.raw.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      } finally {
        cleanup();
      }
    }),
  );
  return app;
}

function failure(c: any, error: unknown) {
  return c.json(
    {
      error: error instanceof Error ? error.message : "channel-operation-failed",
    },
    400,
  );
}
