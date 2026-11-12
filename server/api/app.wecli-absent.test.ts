/**
 * P2.5 regression pins: the open edition mounts NO WeCLI surface.
 *
 * The WeCLI runtime / installer / setup service / skill routes moved to the
 * private edition overlay. `server/api/app.ts` assembles them only from
 * `EditionModules.wecli`, which the open `editionModules.noop.ts` leaves
 * undefined — so every wecli path must answer 404 (not 503, not a stub).
 *
 * The composition-branch case (codex round 7) drives the REAL
 * `createLocalApiApp({ composition })` path — the branch that replaces
 * `/api/system` with the wired `createSystemApp` and would mount
 * `wecliModules.buildSkillRoutes` at `/api/skills` if the module existed —
 * using a minimal composition stub whose editionModules carries no wecli
 * slot. `POST /api/skills/wecli/classify` is pinned too: the real edition
 * router serves it with POST, so a GET-only sweep would miss it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createLocalApiApp } from "./app.js";
import { createSystemApp } from "./routes/systemRoutes.js";
import { EDITION_MODULES as openEditionModules } from "../wemail/bootstrap/editionModules.noop.js";
import type { AppComposition } from "../wemail/bootstrap/AppCompositionTypes.js";

test("the open edition module bundle has no wecli slot", () => {
  assert.equal(openEditionModules.wecli, undefined);
});

test("GET /api/system/wecli/status is 404 without a composition", async () => {
  const app = createLocalApiApp({});
  const response = await app.request("/api/system/wecli/status");
  assert.equal(response.status, 404);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, "ROUTE_NOT_FOUND");
});

test("every /api/system/wecli/* and /api/skills/wecli/* path is 404", async () => {
  const app = createLocalApiApp({});
  for (const path of [
    "/api/system/wecli/status",
    "/api/system/wecli/install",
    "/api/system/wecli/setup",
    "/api/system/wecli/update/check",
    "/api/system/wecli/update",
    "/api/skills/wecli/catalog",
    "/api/skills/wecli/run",
    "/api/skills/wecli/audit",
    "/api/skills/wecli/classify",
  ]) {
    const response = await app.request(path, {
      method: path.endsWith("/install") || path.endsWith("/setup") || path.endsWith("/update") || path.endsWith("/run")
        ? "POST"
        : "GET",
      ...(path.endsWith("/install") ? { body: JSON.stringify({ confirmed: true }) } : {}),
    });
    assert.equal(response.status, 404, `${path} must be 404 in the open edition`);
  }
});

/**
 * Minimal composition exercising the composed branch of
 * `createLocalApiApp`: `composition.editionModules` exists (the open noop
 * bundle, `wecli` undefined) but nothing else is wired — every remaining
 * field is consumed lazily inside route handlers, so the stub only needs
 * the values the mounted builders or the exercised endpoints touch.
 */
function absentWecliComposition(): AppComposition {
  return {
    editionModules: { ...openEditionModules },
    edition: {
      providerPresets: [],
      onboarding: { preferredPresetId: "open-default", bootToCredentials: false },
      signature: {},
      features: {},
    },
    getLlmSnapshot: () => ({
      configured: false,
      provider: "stub",
      settings: {},
      modelFor: () => "stub",
    }),
    getLlmHealth: async () => ({ ok: true }),
    // Eagerly dereferenced at mount time (app.ts buildAgentRoutes and the
    // settings router's LlmSettingsService legacy-key migration).
    curator: { scheduler: {} },
    secrets: {
      getSecret: async () => null,
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
  } as unknown as AppComposition;
}

test("a real composition without an edition wecli slot still mounts no wecli route", async () => {
  const app = createLocalApiApp({ composition: absentWecliComposition() });

  // The composition branch replaced /api/system with the wired app — the
  // generic surface must answer, proving we exercised the composed branch.
  const health = await app.request("/api/system/health");
  assert.equal(health.status, 200);
  const edition = await app.request("/api/system/edition");
  assert.equal(edition.status, 200);
  const editionBody = await edition.json() as { features: Record<string, boolean> };
  assert.equal(editionBody.features.wecli, false);
  const llmStatus = await app.request("/api/system/llm-status");
  assert.equal(llmStatus.status, 200);
  const llmBody = await llmStatus.json() as { configured: boolean };
  assert.equal(llmBody.configured, false);

  // ...and yet every wecli path stays absent: no /api/system/wecli/* route
  // is registered (wecliHealth/wecliInstaller/wecliSetup are undefined) and
  // /api/skills is never mounted (wecliModules is falsy).
  for (const path of [
    "/api/system/wecli/status",
    "/api/system/wecli/install",
    "/api/system/wecli/setup",
    "/api/system/wecli/update/check",
    "/api/system/wecli/update",
    "/api/skills/wecli/catalog",
    "/api/skills/wecli/audit",
  ]) {
    const response = await app.request(path, {
      method: path.endsWith("/install") || path.endsWith("/setup") || path.endsWith("/update")
        ? "POST"
        : "GET",
      ...(path.endsWith("/install") ? { body: JSON.stringify({ confirmed: true }) } : {}),
    });
    assert.equal(response.status, 404, `${path} must be 404 in the composed open edition`);
  }
});

test("POST /api/skills/wecli/classify is 404 in the open edition (GET and POST)", async () => {
  // Without a composition: the skeleton never mounts /api/skills at all.
  const skeleton = createLocalApiApp({});
  const skeletonGet = await skeleton.request("/api/skills/wecli/classify");
  assert.equal(skeletonGet.status, 404);
  const skeletonPost = await skeleton.request("/api/skills/wecli/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "allowance ls" }),
  });
  assert.equal(skeletonPost.status, 404, "POST classify must not leak a stub answer");
  const skeletonPostBody = await skeletonPost.json() as Record<string, unknown>;
  assert.equal(skeletonPostBody.code, "ROUTE_NOT_FOUND");

  // With the real composition branch (editionModules.wecli absent):
  const composed = createLocalApiApp({ composition: absentWecliComposition() });
  const composedPost = await composed.request("/api/skills/wecli/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "allowance ls" }),
  });
  assert.equal(composedPost.status, 404, "POST classify must be 404 in the composed open edition");
});

test("createSystemApp mounts no wecli route when no edition port is wired", async () => {
  const app = createSystemApp({});
  const status = await app.request("/wecli/status");
  assert.equal(status.status, 404);
  const install = await app.request("/wecli/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(install.status, 404);
  // The generic surface stays intact.
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  const edition = await app.request("/edition");
  assert.equal(edition.status, 200);
  const editionBody = await edition.json() as { features: Record<string, boolean> };
  assert.equal(editionBody.features.wecli, false);
});
