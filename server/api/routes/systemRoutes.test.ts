import assert from "node:assert/strict";
import test from "node:test";
import { createSystemApp } from "./systemRoutes.js";

test("GET /edition serves open defaults when no edition deps are wired", async () => {
  const app = createSystemApp({});

  const response = await app.request("/edition");
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body.providerPresets, []);
  assert.equal(body.bootToCredentials, false);
  assert.equal(body.signatureBrandUrl, "");
  // Features always serialize as a complete all-off object so the renderer
  // can consume them without branch handling.
  assert.deepEqual(body.features, {
    wecli: false,
    allowanceInvoice: false,
    enterpriseDirectory: false,
    officeSceneDetection: false,
  });
  // Whitelist only — the runtime config (profile, enterpriseDirectory)
  // must never leak to the renderer.
  assert.equal("profile" in body, false);
  assert.equal("enterpriseDirectory" in body, false);
});

test("GET /edition serves the edition whitelist from deps", async () => {
  const app = createSystemApp({
    getEditionInfo: () => ({
      providerPresets: [
        {
          id: "internal-corp",
          label: "企业邮箱",
          domains: ["corp.example"],
          imap: { host: "imap.corp.example", port: 993, secure: true },
          smtp: { host: "smtp.corp.example", port: 465, secure: true },
        },
      ],
      preferredPresetId: "internal-corp",
      bootToCredentials: true,
      signatureBrandUrl: "https://brand.corp.example",
      features: {
        wecli: true,
        allowanceInvoice: true,
        enterpriseDirectory: false,
        officeSceneDetection: true,
      },
    }),
  });

  const response = await app.request("/edition");
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal((body.providerPresets as { id: string }[])[0].id, "internal-corp");
  assert.equal(body.preferredPresetId, "internal-corp");
  assert.equal(body.bootToCredentials, true);
  assert.equal(body.signatureBrandUrl, "https://brand.corp.example");
  // The features whitelist passes through exactly what the edition serves.
  assert.deepEqual(body.features, {
    wecli: true,
    allowanceInvoice: true,
    enterpriseDirectory: false,
    officeSceneDetection: true,
  });
});

test("GET /wecli/status returns the fixed doctor health result", async () => {
  let checks = 0;
  const app = createSystemApp({
    wecliHealth: {
      async check() {
        checks += 1;
        return {
          state: "ready" as const,
          installed: true,
          connected: true,
          binary: "C:\\tools\\wecli.cmd",
          version: "2.4.1",
          checkedAt: "2026-07-21T00:00:00.000Z",
          doctor: {
            command: "wecli doctor" as const,
            exitCode: 0,
            durationMs: 10,
            timedOut: false,
          },
        };
      },
    },
  });

  const response = await app.request("/wecli/status");
  const body = await response.json() as {
    ok: boolean;
    status: Record<string, unknown> & {
      state: string;
      doctor: Record<string, unknown>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status.state, "ready");
  assert.equal(body.status.doctor.ok, true);
  assert.equal("binary" in body.status, false);
  assert.equal("command" in body.status.doctor, false);
  assert.equal("exitCode" in body.status.doctor, false);
  assert.equal(checks, 1);
});

test("POST /wecli/install requires explicit confirmation", async () => {
  let installs = 0;
  const app = createSystemApp({
    wecliInstaller: {
      async install() {
        installs += 1;
        return {
          command: "fixed",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        };
      },
    },
  });

  const response = await app.request("/wecli/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmed: false }),
  });

  assert.equal(response.status, 400);
  assert.equal(installs, 0);
});

test("POST /wecli/install returns only a public installer result", async () => {
  const app = createSystemApp({
    wecliInstaller: {
      async install() {
        return {
          command: "npm install fixed",
          exitCode: 1,
          stdout: "",
          stderr: "registry unavailable",
          durationMs: 20,
          timedOut: false,
        };
      },
    },
  });

  const response = await app.request("/wecli/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmed: true }),
  });
  const body = await response.json() as {
    ok: boolean;
    message: string;
    result: Record<string, unknown> & { succeeded: boolean };
  };

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.message, "WeCLI 安装失败，请稍后重试。");
  assert.equal(body.result.succeeded, false);
  assert.equal("command" in body.result, false);
  assert.equal("stdout" in body.result, false);
  assert.equal("stderr" in body.result, false);
  assert.equal("exitCode" in body.result, false);
});
