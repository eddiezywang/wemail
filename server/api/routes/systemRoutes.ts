import { Hono } from "hono";
import type {
  WecliHealthPort,
  WecliInstallerPort,
  WecliSetupPort,
} from "../../wemail/skills/wecliPort.js";
import type { LlmRuntimeHealth } from "../../wemail/ai/LlmRuntime.js";
import {
  OPEN_EDITION_DEFAULT,
  toPublicEditionInfo,
  type PublicEditionInfo,
} from "../../../shared/wemail/edition.js";

export interface SystemRoutesDeps {
  getLlmStatus?: () => {
    configured: boolean;
    provider?: string;
    model?: string;
    health?: LlmRuntimeHealth;
  };
  /** Edition whitelist view for the renderer. Absent = open defaults. */
  getEditionInfo?: () => PublicEditionInfo;
  /**
   * Edition-supplied ports (P2.5). When absent — the open default — none of
   * the `/wecli/*` routes are mounted, so they return 404 rather than 503.
   * An edition build wires all three from `EditionModules.wecli`.
   */
  wecliHealth?: WecliHealthPort;
  wecliInstaller?: WecliInstallerPort;
  /** Full install pipeline (CLI + skill) + update check/perform. */
  wecliSetup?: Pick<WecliSetupPort, "setup" | "checkForUpdate" | "performUpdate">;
  /**
   * Request a graceful app shutdown (closes the WeCom long-connection cleanly
   * via the standard before-quit → stopDesktopServices chain before exiting).
   * Used by `desktop:restart` so a restart doesn't leave a stale connection
   * that WeCom's server hasn't reaped. Localhost-only, same trust level as
   * the other local endpoints.
   */
  quitApp?: () => void;
}

export function createSystemApp(deps: SystemRoutesDeps = {}) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: "wemail-local-api",
      now: new Date().toISOString(),
    }),
  );

  // Edition info consumed by the renderer (onboarding presets, signature
  // brand link). Whitelist only — never the full runtime config.
  app.get("/edition", (c) =>
    c.json(deps.getEditionInfo ? deps.getEditionInfo() : toPublicEditionInfo(OPEN_EDITION_DEFAULT)),
  );

  if (deps.getLlmStatus) {
    app.get("/llm-status", async (c) => {
      const status = deps.getLlmStatus!();
      return c.json(status);
    });
  }

  if (deps.wecliHealth) {
    app.get("/wecli/status", async (c) => {
      const status = await deps.wecliHealth!.check();
      return c.json({
        ok: true,
        status: {
          state: status.state,
          installed: status.installed,
          connected: status.connected,
          ...(status.version ? { version: status.version } : {}),
          checkedAt: status.checkedAt,
          doctor: {
            ok: status.connected,
            ...(status.doctor.durationMs !== undefined
              ? { durationMs: status.doctor.durationMs }
              : {}),
            timedOut: status.doctor.timedOut === true,
          },
        },
      });
    });
  }

  if (deps.wecliInstaller) {
    app.post("/wecli/install", async (c) => {
      let body: { confirmed?: unknown } = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "invalid JSON body" }, 400);
      }
      if (body.confirmed !== true) {
        return c.json({ ok: false, error: "explicit confirmation required" }, 400);
      }
      try {
        const result = await deps.wecliInstaller!.install();
        const ok = result.exitCode === 0 && !result.timedOut;
        return c.json(
          {
            ok,
            result: {
              succeeded: ok,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
            },
            message: ok
              ? "WeCLI 安装完成。"
              : result.timedOut
                ? "WeCLI 安装超时。"
                : "WeCLI 安装失败，请稍后重试。",
          },
          ok ? 200 : 500,
        );
      } catch {
        return c.json(
          {
            ok: false,
            error: "wecli-install-failed",
          },
          500,
        );
      }
    });
  }

  if (deps.quitApp) {
    app.post("/shutdown", (c) => {
      deps.quitApp!();
      return c.json({ ok: true });
    });
  }

  if (deps.wecliSetup) {
    app.post("/wecli/setup", async (c) => {
      try {
        const result = await deps.wecliSetup!.setup();
        return c.json({ ok: true, result });
      } catch (error) {
        return c.json(
          { ok: false, error: (error as Error).message ?? "setup failed" },
          500,
        );
      }
    });
    app.get("/wecli/update/check", async (c) => {
      try {
        const result = await deps.wecliSetup!.checkForUpdate();
        return c.json({ ok: true, result });
      } catch (error) {
        return c.json(
          { ok: false, error: (error as Error).message ?? "update check failed" },
          500,
        );
      }
    });
    app.post("/wecli/update", async (c) => {
      try {
        const result = await deps.wecliSetup!.performUpdate();
        return c.json({ ok: true, result });
      } catch (error) {
        return c.json(
          { ok: false, error: (error as Error).message ?? "update failed" },
          500,
        );
      }
    });
  }

  return app;
}

/**
 * Default system routes instance for boots without an LLM runtime.
 * Only exposes /health.
 */
export const systemRoutes = new Hono();

systemRoutes.get("/health", (c) =>
  c.json({
    ok: true,
    name: "wemail-local-api",
    now: new Date().toISOString(),
  }),
);
