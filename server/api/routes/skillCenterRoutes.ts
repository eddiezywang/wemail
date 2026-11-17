import { Hono, type Context } from "hono";
import type { SkillCenterService } from "../../wemail/skill-center/SkillCenterService.js";
import type { SkillDraftService } from "../../wemail/skill-center/SkillDraftService.js";
import type { SkillPackageImportService } from "../../wemail/skill-center/SkillPackageImportService.js";
import type { SkillPackageRepository } from "../../wemail/skill-center/SkillPackageRepository.js";
import type { AutomationAuthoringAgentService } from "../../wemail/configuration/AutomationAuthoringAgentService.js";

export function buildSkillCenterRoutes(deps: {
  center: SkillCenterService;
  imports: SkillPackageImportService;
  packages: SkillPackageRepository;
  drafts: SkillDraftService;
  automationAuthoring?: AutomationAuthoringAgentService;
}) {
  const app = new Hono();

  app.get("/", (context) => context.json({ skills: deps.center.list() }));
  app.get("/:skillId", (context) =>
    respond(context, () =>
      deps.center.inspect(
        context.req.param("skillId"),
        context.req.query("version"),
      ),
    ),
  );
  app.get("/:skillId/content", (context) =>
    respond(context, () =>
      deps.center.readSkillMarkdown(
        context.req.param("skillId"),
        context.req.query("version"),
      ),
    ),
  );
  app.post("/import", async (context) => {
    const body = await bodyObject(context);
    if (typeof body.path !== "string") {
      return context.json({ error: "skill-import-path-required" }, 400);
    }
    return respond(context, () => deps.imports.importPath(body.path as string), 201);
  });
  app.post("/import/preview", async (context) => {
    const body = await bodyObject(context);
    if (typeof body.path !== "string") {
      return context.json({ error: "skill-import-path-required" }, 400);
    }
    return respond(context, () => deps.imports.previewPath(body.path as string));
  });
  app.post("/import/confirm", async (context) => {
    const body = await bodyObject(context);
    if (
      typeof body.path !== "string" ||
      typeof body.contentHash !== "string"
    ) {
      return context.json({ error: "skill-import-confirmation-required" }, 400);
    }
    return respond(
      context,
      () =>
        deps.imports.importConfirmed(
          body.path as string,
          body.contentHash as string,
        ),
      201,
    );
  });
  app.post("/:skillId/export", async (context) => {
    const body = await bodyObject(context);
    if (
      typeof body.version !== "string" ||
      typeof body.destinationDirectory !== "string"
    ) {
      return context.json({ error: "skill-export-input-invalid" }, 400);
    }
    return respond(context, () => ({
      path: deps.center.exportPersonalVersion(
        context.req.param("skillId"),
        body.version as string,
        body.destinationDirectory as string,
      ),
    }));
  });
  app.post("/:skillId/enabled", async (context) => {
    const body = await bodyObject(context);
    if (typeof body.enabled !== "boolean") {
      return context.json({ error: "skill-enabled-input-invalid" }, 400);
    }
    return respond(context, () =>
      deps.center.setEnabled(context.req.param("skillId"), body.enabled as boolean),
    );
  });
  app.post("/:skillId/activate", async (context) => {
    const body = await bodyObject(context);
    if (typeof body.version !== "string") {
      return context.json({ error: "skill-version-required" }, 400);
    }
    return respond(context, () =>
      deps.center.activateVersion(
        context.req.param("skillId"),
        body.version as string,
      ),
    );
  });
  app.get("/:skillId/usage", (context) =>
    context.json({
      references: deps.packages.listUsage(
        context.req.param("skillId"),
        context.req.query("version"),
      ),
    }),
  );
  app.delete("/:skillId/versions/:version", (context) =>
    respond(context, () => {
      deps.center.deletePersonalVersion(
        context.req.param("skillId"),
        context.req.param("version"),
      );
      return { deleted: true };
    }),
  );

  app.post("/drafts/from-pipeline", async (context) => {
    if (!deps.automationAuthoring) {
      return context.json({ error: "skill-draft-pipeline-unavailable" }, 503);
    }
    const body = await bodyObject(context);
    const required = [
      "accountId",
      "pipelineDraftId",
      "skillId",
      "version",
      "displayName",
      "description",
    ];
    if (required.some((key) => typeof body[key] !== "string" || !(body[key] as string).trim())) {
      return context.json({ error: "skill-draft-pipeline-input-invalid" }, 400);
    }
    return respond(
      context,
      () =>
        deps.automationAuthoring!.createSkillDraftFromPipeline({
          accountId: body.accountId as string,
          pipelineDraftId: body.pipelineDraftId as string,
          skillId: body.skillId as string,
          version: body.version as string,
          displayName: body.displayName as string,
          description: body.description as string,
        }),
      201,
    );
  });

  app.post("/drafts", async (context) => {
    const body = await bodyObject(context);
    if (
      typeof body.skillId !== "string" ||
      typeof body.version !== "string" ||
      typeof body.displayName !== "string" ||
      typeof body.description !== "string" ||
      typeof body.skillMarkdown !== "string"
    ) {
      return context.json({ error: "skill-draft-input-invalid" }, 400);
    }
    return respond(
      context,
      () =>
        deps.drafts.create({
          skillId: body.skillId as string,
          version: body.version as string,
          displayName: body.displayName as string,
          description: body.description as string,
          skillMarkdown: body.skillMarkdown as string,
          ...(body.manifest && typeof body.manifest === "object"
            ? { manifest: body.manifest as never }
            : {}),
        }),
      201,
    );
  });
  app.post("/drafts/:draftId/validate", (context) =>
    respond(context, () => deps.drafts.validate(context.req.param("draftId"))),
  );
  app.post("/drafts/:draftId/install", async (context) => {
    const body = await bodyObject(context);
    if (typeof body.contentHash !== "string") {
      return context.json({ error: "skill-draft-hash-required" }, 400);
    }
    return respond(context, () =>
      deps.drafts.install({
        draftId: context.req.param("draftId"),
        contentHash: body.contentHash as string,
      }),
    );
  });

  return app;
}

async function bodyObject(context: Context): Promise<Record<string, unknown>> {
  try {
    const value = await context.req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function respond(
  context: Context,
  operation: () => unknown | Promise<unknown>,
  successStatus: 200 | 201 = 200,
) {
  try {
    return context.json(await operation(), successStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not-found/.test(message)
      ? 404
      : /referenced|conflict|mismatch|tampered|expired/.test(message)
        ? 409
        : 400;
    return context.json({ error: message }, status);
  }
}
