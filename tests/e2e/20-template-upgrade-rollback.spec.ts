// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Automation template upgrade/rollback regression: install a template,
// walk the version surface (template-version), exercise upgrade preview /
// confirm guard rails, and rollback confirmation guards (exact
// confirmation string + version conflict). Cleanup tolerates the
// run-history delete-block contract from spec 16.
import { expect, test } from "@playwright/test";
import { bundledLlmResponder, launchElectron, loginWithFixture } from "./helpers/electronApp";

const TEMPLATE_ID = "subscription-daily-insight";
const ACCOUNT = "acct-e2e";

async function installTemplate(B: string, config: Record<string, unknown>) {
  const preview = (await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ configuration: config, accountId: ACCOUNT }),
  })).json()) as { preview?: { previewId?: string; previewHash?: string } };
  expect(preview.preview?.previewId).toBeTruthy();
  const confirmed = (await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: ACCOUNT,
      previewId: preview.preview?.previewId,
      previewHash: preview.preview?.previewHash,
    }),
  })).json()) as { automation?: { id?: string; version?: number } };
  expect(confirmed.automation?.id).toBeTruthy();
  return confirmed.automation!;
}

test("template upgrade/rollback: version surface + confirmation guards", async () => {
  test.setTimeout(180_000);
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: bundledLlmResponder(),
  });
  try {
    await loginWithFixture(app.apiBaseUrl);
    const B = app.apiBaseUrl;

    // Build a valid configuration from the template schema/defaults.
    const wrap = (await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}`)).json()) as {
      template?: {
        configurationSchema?: { required?: string[] };
        defaultConfiguration?: Record<string, unknown>;
      };
    };
    const def = wrap.template ?? {};
    const config: Record<string, unknown> = { ...(def.defaultConfiguration ?? {}) };
    const fallbacks: Record<string, unknown> = {
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      dataWindowMode: "calendarDay",
      accountScope: { type: "currentAccount" },
    };
    for (const key of def.configurationSchema?.required ?? []) {
      if (config[key] === undefined && fallbacks[key] !== undefined) config[key] = fallbacks[key];
    }

    // Install.
    const automation = await installTemplate(B, config);
    const automationId = automation.id!;
    const installedVersion = automation.version;

    // Version surface endpoint answers for v2 rules.
    const versionRes = await fetch(
      `${B}/api/automation/center/${automationId}/template-version?accountId=${ACCOUNT}`,
    );
    expect(versionRes.ok).toBeTruthy();
    const versionBody = (await versionRes.json()) as { version?: unknown };
    expect(versionBody).toBeTruthy();

    // Rollback guards (BEFORE upgrade preview — preview mutates rule state):     // (a) wrong confirmation string → 409 exact-rollback-confirmation-required
    const wrongConfirmation = await fetch(
      `${B}/api/automation/center/${automationId}/template-rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: ACCOUNT,
          targetVersion: 1,
          expectedCurrentVersion: installedVersion ?? 1,
          confirmation: "随便写写",
        }),
      },
    );
    expect(wrongConfirmation.status).toBe(409);
    // The public error projection redacts raw codes — assert the conflict class.
    const wrongBody = (await wrongConfirmation.json()) as {
      code?: string;
      publicError?: { code?: string };
    };
    expect((wrongBody.publicError?.code ?? wrongBody.code ?? "").toUpperCase()).toBe("CONFLICT");

    // (b) exact confirmation but conflicting expected version → structured 409
    const versionConflict = await fetch(
      `${B}/api/automation/center/${automationId}/template-rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: ACCOUNT,
          targetVersion: 1,
          expectedCurrentVersion: 999,
          confirmation: "回退到版本 1",
        }),
      },
    );
    expect(versionConflict.status).toBe(409);
    const conflictBody = (await versionConflict.json()) as { publicError?: { code?: string } };
    expect((conflictBody.publicError?.code ?? conflictBody.code ?? "").toUpperCase()).toBe("CONFLICT");

    // Upgrade surface: preview + tampered-hash confirm guard (tolerant of
    // already-latest 409s; never a 500).
    const upgradePreview = await fetch(
      `${B}/api/automation/center/${automationId}/template-upgrade/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: ACCOUNT }),
      },
    );
    expect(upgradePreview.status).toBeLessThan(500);
    const upgradeBody = (await upgradePreview.json()) as {
      ok?: boolean;
      preview?: { previewId?: string; previewHash?: string };
    };
    const tampered = await fetch(
      `${B}/api/automation/center/${automationId}/template-upgrade/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: ACCOUNT,
          previewId: upgradeBody.preview?.previewId ?? "preview-x",
          previewHash: "deadbeef",
        }),
      },
    );
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    expect(tampered.status).toBeLessThan(500);

    // Cleanup: fresh-install-without-runs deletes cleanly; run/upgrade
    // history may block with the 409 contract from spec 16.
    const cleanup = await fetch(
      `${B}/api/automation/center/${automationId}/permanent?accountId=${ACCOUNT}`,
      { method: "DELETE" },
    );
    expect([200, 409]).toContain(cleanup.status);
  } finally {
    await app.close();
  }
});
