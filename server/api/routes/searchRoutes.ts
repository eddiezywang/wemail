/**
 * HTTP surface for semantic search and mail QA (ai-semantic-search-qa).
 *
 * Endpoints:
 *   - GET/POST /api/mail/semantic-search — search email chunks by query
 *   - POST /api/agent/mail-qa           — answer a question with citations
 */

import { Hono } from "hono";
import type {
  MailQaRequest,
  MailQaResult,
  SemanticSearchRequest,
  SemanticSearchResult,
} from "../../../shared/wemail/intelligence.js";
import type { MailQaService } from "../../wemail/search/MailQaService.js";
import type { SemanticSearchService } from "../../wemail/search/SemanticSearchService.js";

export interface SearchRoutesDeps {
  searchService?: SemanticSearchService;
  qaService?: MailQaService;
}

export function buildSearchRoutes(deps: SearchRoutesDeps = {}) {
  const app = new Hono();

  /**
   * GET /api/mail/semantic-search
   *
   * Query params: accountId (required), query (required), limit, offset.
   * Returns: { ok, result: SemanticSearchResult }
   */
  app.get("/semantic-search", async (c) => {
    if (!deps.searchService) {
      return c.json({ ok: false, error: "search service not configured" }, 503);
    }

    const accountId = c.req.query("accountId");
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }

    const query = c.req.query("query");
    if (!query || !query.trim()) {
      return c.json({ ok: false, error: "query is required" }, 400);
    }

    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const parsedLimit = limitParam ? Number(limitParam) : undefined;
    const parsedOffset = offsetParam ? Number(offsetParam) : undefined;

    if (limitParam && (!Number.isFinite(parsedLimit) || parsedLimit! < 1)) {
      return c.json({ ok: false, error: "limit must be a positive integer" }, 400);
    }
    if (offsetParam && (!Number.isFinite(parsedOffset) || parsedOffset! < 0)) {
      return c.json({ ok: false, error: "offset must be a non-negative integer" }, 400);
    }

    const limit = parsedLimit;
    const offset = parsedOffset;

    try {
      const result: SemanticSearchResult = await deps.searchService.search({
        accountId,
        query: query.trim(),
        limit,
        offset,
      });
      return c.json({ ok: true, result });
    } catch (error) {
      return c.json(
        { ok: false, error: String((error as Error).message ?? error) },
        500,
      );
    }
  });

  /**
   * POST /api/mail/semantic-search
   *
   * Body: SemanticSearchRequest
   * Returns: { ok, result: SemanticSearchResult }
   */
  app.post("/semantic-search", async (c) => {
    if (!deps.searchService) {
      return c.json({ ok: false, error: "search service not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ ok: false, error: "body must be a JSON object" }, 400);
    }

    const b = body as Partial<SemanticSearchRequest>;
    if (!b.accountId || typeof b.accountId !== "string") {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    if (!b.query || typeof b.query !== "string" || !b.query.trim()) {
      return c.json({ ok: false, error: "query is required" }, 400);
    }

    try {
      const result: SemanticSearchResult = await deps.searchService.search({
        accountId: b.accountId,
        query: b.query.trim(),
        limit: b.limit,
        offset: b.offset,
      });
      return c.json({ ok: true, result });
    } catch (error) {
      return c.json(
        { ok: false, error: String((error as Error).message ?? error) },
        500,
      );
    }
  });

  /**
   * POST /api/agent/mail-qa
   *
   * Body: MailQaRequest
   * Returns: { ok, result: MailQaResult }
   */
  app.post("/mail-qa", async (c) => {
    if (!deps.qaService) {
      return c.json({ ok: false, error: "QA service not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ ok: false, error: "body must be a JSON object" }, 400);
    }

    const b = body as Partial<MailQaRequest>;
    if (!b.accountId || typeof b.accountId !== "string") {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    if (!b.question || typeof b.question !== "string" || !b.question.trim()) {
      return c.json({ ok: false, error: "question is required" }, 400);
    }

    try {
      const result: MailQaResult = await deps.qaService.answer({
        accountId: b.accountId,
        question: b.question.trim(),
        maxChunks: b.maxChunks,
      });
      return c.json({ ok: true, result });
    } catch (error) {
      return c.json(
        { ok: false, error: String((error as Error).message ?? error) },
        500,
      );
    }
  });

  return app;
}

/**
 * Skeleton router used when no search/QA deps are wired.
 */
export const searchRoutes = buildSearchRoutes();
