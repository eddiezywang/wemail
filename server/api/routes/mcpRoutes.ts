import { Hono } from "hono";
import type { McpListenerController } from "../../wemail/mcp/McpListenerController.js";
import {
  WEMAIL_MCP_MAX_BODY_CHARACTERS,
  WEMAIL_MCP_MAX_BATCH_MESSAGES,
  WEMAIL_MCP_MAX_PAGE_SIZE,
  WEMAIL_MCP_MAX_PENDING_OPERATIONS,
  WEMAIL_MCP_MAX_RECIPIENTS,
  WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS,
  type WemailMcpManagementState,
  type WemailMcpSettingsInput,
} from "../../../shared/wemail/mcp.js";

const integerSettings = {
  port: [1, 65_535],
  defaultBodyCharacters: [1, WEMAIL_MCP_MAX_BODY_CHARACTERS],
  maxBodyCharacters: [1, WEMAIL_MCP_MAX_BODY_CHARACTERS],
  defaultPageSize: [1, WEMAIL_MCP_MAX_PAGE_SIZE],
  maxPageSize: [1, WEMAIL_MCP_MAX_PAGE_SIZE],
  maxRecipients: [1, WEMAIL_MCP_MAX_RECIPIENTS],
  maxBatchMessages: [1, WEMAIL_MCP_MAX_BATCH_MESSAGES],
  maxPendingOperations: [1, WEMAIL_MCP_MAX_PENDING_OPERATIONS],
  toolTimeoutSeconds: [1, WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS],
} as const;

export function buildMcpRoutes(
  controller: McpListenerController,
  onSettingsChanged?: (state: WemailMcpManagementState) => Promise<void>,
): Hono {
  const router = new Hono();
  router.get("/state", (c) => c.json({ ok: true, state: controller.view() }));
  router.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ ok: false, error: "enabled must be a boolean" }, 400);
    }
    const settings: Record<string, number> = {};
    for (const [name, [minimum, maximum]] of Object.entries(integerSettings)) {
      const value = body[name];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        return c.json({ ok: false, error: `${name} must be an integer from ${minimum} to ${maximum}` }, 400);
      }
      settings[name] = Number(value);
    }
    const next = { ...controller.view(), ...settings };
    if (next.defaultBodyCharacters > next.maxBodyCharacters || next.defaultPageSize > next.maxPageSize) {
      return c.json({ ok: false, error: "default values must not exceed their configured maximums" }, 400);
    }
    const state = await controller.configure({
      enabled: body.enabled,
      ...settings,
    } as WemailMcpSettingsInput);
    if (onSettingsChanged) await onSettingsChanged(state);
    return c.json({ ok: true, state });
  });
  router.post("/tokens", (c) => {
    try {
      return c.json({ ok: true, result: controller.createToken() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "token-create-failed";
      return c.json({ ok: false, error: message }, message === "mcp-token-already-exists" ? 409 : 400);
    }
  });
  router.post("/tokens/rotate", (c) => {
    try {
      return c.json({ ok: true, result: controller.rotateToken() });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "token-rotate-failed" }, 400);
    }
  });
  router.delete("/tokens/current", (c) => c.json({ ok: true, revoked: controller.revokeToken() }));
  router.post("/credentials/reset", (c) => {
    try {
      return c.json({ ok: true, state: controller.resetCredential() });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : "credential-reset-failed",
      }, 400);
    }
  });
  router.delete("/sessions/:sessionHash", (c) => {
    const sessionHash = c.req.param("sessionHash");
    if (!/^[a-f0-9]{24}$/.test(sessionHash)) return c.json({ ok: false, error: "invalid session hash" }, 400);
    return c.json({ ok: true, terminated: controller.terminateSession(sessionHash) });
  });
  return router;
}
