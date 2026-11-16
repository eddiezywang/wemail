// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// LLM settings boundary regression: invalid payloads are rejected with
// structured 400s, an unreachable endpoint saves gracefully with a failed
// probe (manual-save path), and the saved settings round-trip. Restores
// the harness mock config at the end so other specs are unaffected.
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

const LLM_URL = (base: string) => `${base}/api/settings/llm`;

test("llm settings boundaries: validation, unreachable probe, round-trip", async () => {
  const app = await launchElectron();
  try {
    await loginWithFixture(app.apiBaseUrl);
    const url = LLM_URL(app.apiBaseUrl);
    const put = (body: unknown) =>
      fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    // Missing defaultModel → 400.
    const noModel = await put({ provider: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:9" });
    expect(noModel.status).toBe(400);
    expect(((await noModel.json()) as { field?: string }).field).toBe("defaultModel");

    // Invalid JSON body → 400.
    const badJson = await put("not-json{{{");
    expect(badJson.status).toBe(400);

    // Non-object body → 400.
    const badBody = await put([1, 2]);
    expect(badBody.status).toBe(400);

    // No stored credentials + no apiKey → 400 before any probe.
    const noKey = await put({ provider: "openai", defaultModel: "m", baseUrl: "http://127.0.0.1:9" });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { field?: string }).field).toBe("apiKey");

    // Unreachable endpoint → manual save succeeds, probe reports failure.
    const unreachable = await put({
      provider: "openai",
      apiKey: "k",
      baseUrl: "http://127.0.0.1:9",
      defaultModel: "test-model",
    });
    expect(unreachable.ok).toBeTruthy();
    const unreachableBody = (await unreachable.json()) as {
      ok?: boolean;
      probe?: { ok?: boolean; manualSave?: boolean };
    };
    expect(unreachableBody.ok).toBe(true);
    expect(unreachableBody.probe?.ok).toBe(false);
    expect(unreachableBody.probe?.manualSave).toBe(true);

    // Settings round-trip despite the failed probe.
    const saved = await (await fetch(url)).json();
    expect((saved as { llm?: { baseUrl?: string } }).llm?.baseUrl).toBe(
      "http://127.0.0.1:9",
    );

    // Restore the harness mock config so later saves probe cleanly.
    const restore = await put({
      provider: "openai",
      apiKey: "test-key",
      baseUrl: app.mockLlmUrl,
      defaultModel: "mock-model",
    });
    expect(restore.ok).toBeTruthy();
    const restored = (await restore.json()) as { probe?: { ok?: boolean } };
    expect(restored.probe?.ok).toBe(true);
  } finally {
    await app.close();
  }
});
