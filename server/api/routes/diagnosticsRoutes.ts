import path from "node:path";
import { Hono } from "hono";
import type {
  AppLogger,
  AppLoggingDiagnostics,
} from "../../wemail/telemetry/AppLogger.js";

export function createDiagnosticsApp(
  logger: AppLogger,
  options: { onDebugModeChanged?: (diagnostics: AppLoggingDiagnostics) => void } = {},
) {
  const app = new Hono();

  app.get("/logging", (c) => c.json({ ok: true, ...logger.getDiagnostics() }));

  app.put("/logging", async (c) => {
    let body: { debugEnabled?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.debugEnabled !== "boolean") {
      return c.json({ ok: false, error: "debugEnabled must be boolean" }, 400);
    }
    const diagnostics = logger.setDebugMode(body.debugEnabled);
    options.onDebugModeChanged?.(diagnostics);
    logger.info("diagnostics.logging.mode-changed", {
      debugEnabled: diagnostics.debugEnabled,
      expiresAt: diagnostics.expiresAt,
    });
    return c.json({ ok: true, ...diagnostics });
  });

  app.post("/export", (c) => {
    if (!logger.exportDiagnosticPackage) {
      return c.json({ ok: false, error: "diagnostic-export-unavailable" }, 503);
    }
    const diagnosticPackage = logger.exportDiagnosticPackage();
    logger.info("diagnostics.package.exported", {
      expiresAt: diagnosticPackage.expiresAt,
    });
    return c.json({
      ok: true,
      package: {
        fileName: path.basename(diagnosticPackage.filePath),
        expiresAt: diagnosticPackage.expiresAt,
      },
      uploaded: false,
    });
  });

  return app;
}
