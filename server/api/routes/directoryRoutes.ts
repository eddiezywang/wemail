import { Hono } from "hono";
import type { DirectoryService } from "../../wemail/directory/DirectoryService.js";

export function buildDirectoryRoutes(deps: {
  service: DirectoryService;
  getActiveAccountId: () => string | undefined;
}) {
  const router = new Hono();

  function accountId() {
    return deps.getActiveAccountId();
  }

  router.onError((_error, c) => c.json({ ok: false, error: "directory-unavailable" }, 503));

  router.get("/status", async (c) => {
    const id = accountId();
    if (!id) return c.json({ ok: false, error: "account-required" }, 401);
    return c.json({ ok: true, status: await deps.service.getStatus(id) });
  });

  router.post("/refresh", async (c) => {
    const id = accountId();
    if (!id) return c.json({ ok: false, error: "account-required" }, 401);
    void deps.service.refresh(id).catch(() => undefined);
    return c.json({ ok: true, status: await deps.service.getStatus(id) });
  });

  router.get("/departments", async (c) => {
    const id = accountId();
    if (!id) return c.json({ ok: false, error: "account-required" }, 401);
    const parentId = c.req.query("parentId");
    return c.json({ ok: true, departments: await deps.service.listDepartments(id, parentId) });
  });

  router.get("/contacts", async (c) => {
    const id = accountId();
    if (!id) return c.json({ ok: false, error: "account-required" }, 401);
    const query = c.req.query("q") ?? "";
    const departmentId = c.req.query("departmentId") || undefined;
    const includeDescendants = c.req.query("includeDescendants") === "true";
    const limit = Number(c.req.query("limit") ?? 20);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await deps.service.searchContacts(id, query, {
      departmentId,
      includeDescendants,
      limit: Number.isFinite(limit) ? limit : 20,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return c.json({ ok: true, ...result });
  });

  router.get("/contacts/:id", async (c) => {
    const account = accountId();
    if (!account) return c.json({ ok: false, error: "account-required" }, 401);
    const contact = await deps.service.getContact(account, decodeURIComponent(c.req.param("id")));
    return contact
      ? c.json({ ok: true, contact })
      : c.json({ ok: false, error: "contact-not-found" }, 404);
  });

  router.post("/recipients/resolve", async (c) => {
    const id = accountId();
    if (!id) return c.json({ ok: false, error: "account-required" }, 401);
    const body = await c.req.json().catch(() => null) as { inputs?: unknown } | null;
    if (!Array.isArray(body?.inputs) || !body.inputs.every((item) => typeof item === "string")) {
      return c.json({ ok: false, error: "inputs-required" }, 400);
    }
    return c.json({ ok: true, resolutions: await deps.service.resolveRecipients(id, body.inputs) });
  });

  router.post("/recipients/validate", async (c) => {
    const id = accountId();
    if (!id) return c.json({ ok: false, error: "account-required" }, 401);
    const body = await c.req.json().catch(() => null) as { emails?: unknown } | null;
    if (!Array.isArray(body?.emails) || !body.emails.every((item) => typeof item === "string")) {
      return c.json({ ok: false, error: "emails-required" }, 400);
    }
    return c.json({ ok: true, validations: await deps.service.validateRecipients(id, body.emails) });
  });

  return router;
}
