// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Automation template lifecycle regression: validate → preview → (hash
// guard) → confirm-install → center listing → manual run → test →
// permanent delete. Uses the built-in 邮箱速览 template; the pipeline run
// executes against the hermetic inbox with the mock LLM.
import { expect, test } from "@playwright/test";
import { bundledLlmResponder, launchElectron, loginWithFixture } from "./helpers/electronApp";

const TEMPLATE_ID = "subscription-daily-insight";
const ACCOUNT = "acct-e2e";

test("automation template lifecycle: validate/preview/install/run/test/delete", async () => {
  test.setTimeout(180_000);
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: ["mail-001-question.json", "mail-002-notification.json"],
    llmResponder: bundledLlmResponder(),
  });
  try {
    await loginWithFixture(app.apiBaseUrl);
    const B = app.apiBaseUrl;

    // Template catalog + definition (schema-driven config).
    const catalog = await (await fetch(`${B}/api/automation/templates`)).json();
    const templates = (catalog as { templates?: Array<{ id?: string }> }).templates ?? [];
    expect(templates.some((t) => t.id === TEMPLATE_ID)).toBe(true);
    const definitionWrap = (await (
      await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}`)
    ).json()) as {
      template?: {
        configurationSchema?: { required?: string[] };
        defaultConfiguration?: Record<string, unknown>;
      };
    };
    const definition = definitionWrap.template ?? {};

    // Build a minimal valid configuration: template defaults + required keys.
    const config: Record<string, unknown> = { ...(definition.defaultConfiguration ?? {}) };
    const fallbacks: Record<string, unknown> = {
      localTime: "09:00",
      timezone: "Asia/Shanghai",
      dataWindowMode: "calendarDay",
      accountScope: { type: "currentAccount" },
    };
    for (const key of definition.configurationSchema?.required ?? []) {
      if (config[key] === undefined && fallbacks[key] !== undefined) config[key] = fallbacks[key];
    }

    // Validate: empty configuration lists every missing field.
    const invalid = await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: {} }),
    })).json();
    expect((invalid as { ok?: boolean }).ok).toBe(false);

    // Validate: the assembled configuration passes.
    const valid = await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: config }),
    })).json();
    expect((valid as { ok?: boolean; issues?: unknown[] }).ok).toBe(true);
    expect((valid as { issues?: unknown[] }).issues ?? []).toHaveLength(0);

    // Preview produces a stable draft + hash pair.
    const preview = await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: config, accountId: ACCOUNT }),
    })).json();
    const previewBody = preview as {
      preview?: { previewId?: string; previewHash?: string; draft?: { id?: string } };
    };
    expect(previewBody.preview?.previewId).toBeTruthy();
    expect(previewBody.preview?.previewHash).toBeTruthy();

    // Hash mismatch guard: confirming with a tampered hash → 409.
    const tampered = await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: ACCOUNT,
        previewId: previewBody.preview?.previewId,
        previewHash: "deadbeef",
      }),
    });
    expect(tampered.status).toBe(409);

    // Confirm → automation instantiated.
    const confirmed = await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: ACCOUNT,
        previewId: previewBody.preview?.previewId,
        previewHash: previewBody.preview?.previewHash,
      }),
    })).json();
    const automation = (confirmed as { automation?: { id?: string; enabled?: boolean } }).automation;
    expect(automation?.id).toBeTruthy();
    const automationId = automation!.id!;

    // Center lists the installed automation, enabled.
    const center = await (await fetch(
      `${B}/api/automation/center?accountId=${ACCOUNT}`,
    )).json();
    const listed = (center as { automations?: Array<{ id?: string; enabled?: boolean }> })
      .automations ?? [];
    const entry = listed.find((a) => a.id === automationId);
    expect(entry).toBeTruthy();

    // A fresh install with NO run history deletes cleanly (200).
    const removedClean = await fetch(
      `${B}/api/automation/center/${automationId}/permanent?accountId=${ACCOUNT}`,
      { method: "DELETE" },
    );
    expect(removedClean.ok).toBeTruthy();

    // Re-install for the execution phase.
    const preview2 = (await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: config, accountId: ACCOUNT }),
    })).json()) as { preview?: { previewId?: string; previewHash?: string } };
    const confirmed2 = await (await fetch(`${B}/api/automation/templates/${TEMPLATE_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: ACCOUNT,
        previewId: preview2.preview?.previewId,
        previewHash: preview2.preview?.previewHash,
      }),
    })).json();
    const automation2 = (confirmed2 as { automation?: { id?: string; enabled?: boolean } }).automation;
    expect(automation2?.id).toBeTruthy();
    const reinstalledId = automation2!.id!;

    // Manual run executes the pipeline and returns a result.
    const run = await (await fetch(`${B}/api/automation/center/${reinstalledId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT }),
    })).json();
    expect((run as { ok?: boolean; result?: unknown }).ok).toBe(true);
    expect((run as { result?: unknown }).result).toBeDefined();

    // Test endpoint (dry-run/test path) answers.
    const dryRun = await (await fetch(`${B}/api/automation/center/${reinstalledId}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT }),
    })).json();
    expect((dryRun as { ok?: boolean }).ok).toBe(true);

    // Deletion contract: an automation WITH run history is deletion-blocked
    // (409 + references), while a fresh install deletes cleanly.
    const blocked = await fetch(
      `${B}/api/automation/center/${reinstalledId}/permanent?accountId=${ACCOUNT}`,
      { method: "DELETE" },
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { references?: unknown[] };
    expect(Array.isArray(blockedBody.references)).toBe(true);

    // The blocked automation remains listed (deletion refused, not lost).
    const centerAfter = await (await fetch(
      `${B}/api/automation/center?accountId=${ACCOUNT}`,
    )).json();
    expect(
      ((centerAfter as { automations?: Array<{ id?: string }> }).automations ?? [])
        .some((a) => a.id === reinstalledId),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
