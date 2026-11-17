import { Hono } from "hono";
import type { Context } from "hono";
import type { InsightReportRepository } from "../../wemail/design/InsightReportRepository.js";

export interface InsightReportRoutesDeps {
  reports: InsightReportRepository;
  getActiveAccountId?: () => string | undefined;
}

export function buildInsightReportRoutes(deps: InsightReportRoutesDeps): Hono {
  const app = new Hono();

  app.get("/by-email", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    const emailId = c.req.query("emailId")?.trim();
    const accountError = validateAccount(c, deps, accountId);
    if (accountError) return accountError;
    if (!emailId) return c.json({ ok: false, error: "emailId is required" }, 400);
    return c.json({ ok: true, report: deps.reports.findCurrentByEmail(accountId!, emailId) });
  });

  app.get("/:id/versions", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    const accountError = validateAccount(c, deps, accountId);
    if (accountError) return accountError;
    const reportId = c.req.param("id").trim();
    const report = deps.reports.get(accountId!, reportId);
    if (!report) return c.json({ ok: false, error: "report-not-found" }, 404);
    return c.json({ ok: true, report, versions: deps.reports.listVersions(accountId!, reportId) });
  });

  app.get("/:id", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    const accountError = validateAccount(c, deps, accountId);
    if (accountError) return accountError;
    const report = deps.reports.get(accountId!, c.req.param("id").trim());
    return report
      ? c.json({ ok: true, report })
      : c.json({ ok: false, error: "report-not-found" }, 404);
  });

  return app;
}

function validateAccount(
  c: Context,
  deps: InsightReportRoutesDeps,
  accountId: string | undefined,
) {
  if (!accountId) return c.json({ ok: false, error: "accountId is required" }, 400);
  if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) {
    return c.json({ ok: false, error: "cross-account-request" }, 403);
  }
  return null;
}
