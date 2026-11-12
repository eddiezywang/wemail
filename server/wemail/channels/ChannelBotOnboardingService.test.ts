import assert from "node:assert/strict";
import test from "node:test";
import type { BotChannelConfigurationService } from "./BotChannelConfigurationService.js";
import { ChannelBotOnboardingService } from "./ChannelBotOnboardingService.js";

test("Feishu onboarding returns the official setup link and securely applies scanned credentials", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const saves: unknown[] = [];
  const responses = [
    { supported_auth_methods: ["client_secret"] },
    {
      device_code: "device-1",
      verification_uri_complete: "https://accounts.feishu.cn/qr/scan?code=1",
      interval: 2,
      expire_in: 600,
    },
    { client_id: "cli_wemail", client_secret: "secret-value" },
  ];
  let now = new Date("2026-07-31T10:00:00.000Z");
  const service = new ChannelBotOnboardingService(
    {
      save: (input: unknown) => {
        saves.push(input);
        return { profileId: "profile-feishu" };
      },
    } as unknown as BotChannelConfigurationService,
    (async (input, init) => {
      requests.push({
        url: String(input),
        body: String(init?.body ?? ""),
      });
      return Response.json(responses.shift()!);
    }) as typeof fetch,
    () => now,
  );

  const setup = await service.start("feishu");
  assert.equal(setup.status, "waiting");
  assert.equal(setup.qrPayload, setup.configurationUrl);
  assert.match(setup.configurationUrl, /from=wemail/);
  assert.match(setup.configurationUrl, /tp=wemail/);
  assert.match(requests[1].body, /archetype=PersonalAgent/);

  now = new Date(now.getTime() + 2_000);
  const completed = await service.get(setup.id);
  assert.equal(completed.status, "connected");
  assert.equal(completed.profileId, "profile-feishu");
  assert.deepEqual(saves, [
    {
      platform: "feishu",
      externalBotId: "cli_wemail",
      secret: "secret-value",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(completed), /secret-value/);
});

test("WeCom onboarding exposes the browser link, encodes the auth URL, and applies bot credentials", async () => {
  const saves: unknown[] = [];
  const responses = [
    {
      data: {
        scode: "scan-code",
        auth_url: "wework://auth/scan-code",
      },
    },
    {
      data: {
        status: "success",
        bot_info: { botid: "wecom-bot", secret: "wecom-secret" },
      },
    },
  ];
  let now = new Date("2026-07-31T10:00:00.000Z");
  const service = new ChannelBotOnboardingService(
    {
      save: (input: unknown) => {
        saves.push(input);
        return { profileId: "profile-wecom" };
      },
    } as unknown as BotChannelConfigurationService,
    (async () => Response.json(responses.shift()!)) as typeof fetch,
    () => now,
  );

  const setup = await service.start("wecom");
  assert.equal(setup.qrPayload, "wework://auth/scan-code");
  assert.match(setup.configurationUrl, /work\.weixin\.qq\.com\/ai\/qc\/gen/);
  assert.match(setup.configurationUrl, /scode=scan-code/);

  now = new Date(now.getTime() + 3_000);
  const completed = await service.get(setup.id);
  assert.equal(completed.status, "connected");
  assert.deepEqual(saves, [
    {
      platform: "wecom",
      externalBotId: "wecom-bot",
      secret: "wecom-secret",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(completed), /wecom-secret/);
});
