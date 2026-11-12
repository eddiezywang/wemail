import { Hono } from "hono";
import type { IntelligenceResultRepository } from "../../wemail/intelligence/IntelligenceResultRepository.js";
import type { MailDatabaseClient } from "../../wemail/database/MailDatabaseClient.js";
import {
  INTELLIGENCE_ATTRIBUTE_KINDS,
  type IntelligenceAttributeKind,
  type SummaryRetryMode,
  type SummaryWorkState,
} from "../../../shared/wemail/intelligence.js";

export interface SummaryRoutesDeps {
  results: IntelligenceResultRepository;
  /**
   * Canonical database client. Manual retries MUST route through
   * `requestIntelligence` (not the legacy JobRepository): it enqueues the
   * real `ai.summary` job with the current content fingerprint, revives
   * terminal rows, and records an `ai_job` commit change so the
   * CanonicalAiWorker wakes up and drains promptly.
   */
  mailDatabase: Pick<MailDatabaseClient, "requestIntelligence">;
  getActiveAccountId: () => string | undefined;
}

const STATES = new Set<SummaryWorkState>([
  "missing", "invalid", "pending", "running", "succeeded", "failed", "skipped",
]);
const MODES = new Set<SummaryRetryMode>(["failed", "missing", "all"]);
const KIND_SET = new Set<IntelligenceAttributeKind>(INTELLIGENCE_ATTRIBUTE_KINDS);
const RETRY_BATCH_SIZE = 8;

export function buildSummaryRoutes(deps: SummaryRoutesDeps) {
  const app = new Hono();

  app.get("/summary-health", (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const states = (c.req.queries("state") ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value): value is SummaryWorkState => STATES.has(value as SummaryWorkState));
    const requestedLimit = Number(c.req.query("limit"));
    const requestedOffset = Number(c.req.query("offset"));
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 500;
    const offset = Number.isFinite(requestedOffset)
      ? Math.max(0, Math.trunc(requestedOffset))
      : 0;
    const status = deps.results.getSummaryHealth({
      accountId,
      folder: c.req.query("folder")?.trim() || undefined,
      query: c.req.query("q")?.trim() || undefined,
      states: states.length ? states : undefined,
      limit,
      offset,
      pageOnly: c.req.query("pageOnly") === "true",
    });
    return c.json({ ok: true, status });
  });

  app.post("/summary-retry", async (c) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return c.json({ ok: false, code: "NO_ACTIVE_ACCOUNT" }, 401);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const mode = typeof body.mode === "string" && MODES.has(body.mode as SummaryRetryMode)
      ? body.mode as SummaryRetryMode
      : "all";
    const emailIds = Array.isArray(body.emailIds)
      ? body.emailIds.filter((value): value is string => typeof value === "string" && !!value.trim()).slice(0, 500)
      : undefined;
    const kinds = Array.isArray(body.kinds)
      ? body.kinds.filter((value): value is IntelligenceAttributeKind =>
          KIND_SET.has(value as IntelligenceAttributeKind),
        ).slice(0, 4)
      : undefined;
    // requestIntelligence protocol kinds use "todo" for todoExtraction.
    const resolvedKinds = (
      kinds && kinds.length > 0
        ? kinds.map((kind) => (kind === "todoExtraction" ? "todo" : kind))
        : ["summary"]
    ) as Array<"summary" | "tags" | "replyDecision" | "todo">;
    const parsedLimit = Number.parseInt(
      typeof body.limit === "string" ? body.limit : String(body.limit ?? ""),
      10,
    );
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 2000) : undefined;
    const candidates = deps.results.listSummaryRetryCandidates({
      accountId,
      folder: typeof body.folder === "string" && body.folder.trim() ? body.folder.trim() : undefined,
      mode,
      emailIds,
      // Attribute-scoped candidates use the internal attribute names
      // (todoExtraction), NOT the protocol kind mapping (todo).
      kinds: kinds && kinds.length > 0 ? kinds : undefined,
      includeSucceeded: body.refreshSucceeded === true,
      limit,
    });

    let queued = 0;
    let skipped = 0;
    for (let index = 0; index < candidates.length; index += RETRY_BATCH_SIZE) {
      const results = await Promise.allSettled(
        candidates.slice(index, index + RETRY_BATCH_SIZE).map((candidate) =>
          deps.mailDatabase.requestIntelligence({
            emailId: candidate.emailId,
            kinds: resolvedKinds,
            revive: true,
          })
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled") queued += 1;
        else skipped += 1;
      }
    }
    return c.json({
      ok: true,
      result: { queued, inserted: 0, reset: 0, skipped },
    });
  });

  return app;
}
