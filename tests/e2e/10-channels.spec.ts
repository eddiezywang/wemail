// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Channel hub (WeCLI / 飞书 / 企业微信) E2E: status registry, platform
// configurations, and profiles endpoints answer with the expected shapes
// in a hermetic (unconfigured) environment.
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture, waitFor } from "./helpers/electronApp";

// The channel hub (wecli/feishu/wecom status registry) only mounts when
// explicitly enabled; the packaged/dev app sets this for real users.
process.env.WEMAIL_CHANNELS_ENABLED = "1";

const CHANNEL_IDS = ["wecli", "feishu", "wecom"] as const;

test("channel hub reports WeCLI/Feishu/WeCom integration state", async () => {
  const app = await launchElectron();
  try {
    // /api/* requires an active account (auth middleware).
    await loginWithFixture(app.apiBaseUrl);

    // Status cache fills asynchronously after boot (WeCLI doctor etc.).
    const status = await waitFor(async () => {
      const res = await fetch(`${app.apiBaseUrl}/api/channels/status`);
      const body = (await res.json().catch(() => ({}))) as {
        entries?: Array<{ id?: string; label?: string; state?: string }>;
      };
      if (!Array.isArray(body.entries) || body.entries.length === 0) {
        return null;
      }
      return body;
    }, { label: "channel status entries", timeoutMs: 20_000 });

    const ids = status.entries?.map((entry) => entry.id) ?? [];
    for (const id of CHANNEL_IDS) {
      expect(ids).toContain(id);
    }
    for (const entry of status.entries ?? []) {
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.state).toBe("string");
      expect(entry.state?.length).toBeGreaterThan(0);
    }

    // Platform configuration catalog (feishu/wecom onboarding definitions).
    const configs = await fetch(
      `${app.apiBaseUrl}/api/channels/platform-configurations`,
    );
    expect(configs.ok).toBeTruthy();
    const configBody = (await configs.json()) as {
      configurations?: unknown[];
    };
    expect(Array.isArray(configBody.configurations)).toBe(true);

    // Delivery profiles list answers (empty is valid when unconfigured).
    const profiles = await fetch(`${app.apiBaseUrl}/api/channels/profiles`);
    expect(profiles.ok).toBeTruthy();
  } finally {
    await app.close();
  }
});
