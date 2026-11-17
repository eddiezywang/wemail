import { Hono } from "hono";
import type { PipelinePreviewStore } from "../../wemail/workflows/PipelineReviewService.js";
import type { ExecutionPipelineDraftRepository } from "../../wemail/workflows/ExecutionPipelineDraftRepository.js";

export function buildPipelinePreviewRoutes(deps: {
  previews: PipelinePreviewStore;
  drafts: ExecutionPipelineDraftRepository;
  getActiveAccountId: () => string | undefined;
}) {
  const app = new Hono();
  app.get("/:pipelineId/:previewId", (context) => {
    const accountId = deps.getActiveAccountId();
    if (!accountId) return context.json({ error: "account-required" }, 401);
    if (!deps.drafts.get(context.req.param("pipelineId"), accountId)) {
      return context.json({ error: "pipeline-preview-not-found" }, 404);
    }
    try {
      const resource = deps.previews.readResource(
        context.req.param("pipelineId"),
        context.req.param("previewId"),
      );
      context.header("Content-Type", resource.contentType);
      context.header("Cache-Control", "private, max-age=300, immutable");
      context.header("X-Content-Type-Options", "nosniff");
      context.header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
      );
      return context.body(new Uint8Array(resource.body));
    } catch {
      return context.json({ error: "pipeline-preview-not-found" }, 404);
    }
  });
  return app;
}
