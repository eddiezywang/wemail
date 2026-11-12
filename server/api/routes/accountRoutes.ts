import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import { AccountService } from "../../wemail/account/AccountService.js";
import type { AppLogger } from "../../wemail/telemetry/AppLogger.js";
import type { MailSyncErrorLog } from "../../wemail/telemetry/MailSyncErrorLog.js";

export interface AccountRoutesDeps {
  service: AccountService;
  imapVerifier?: (input: {
    config: AccountConfig;
    imapPassword: string;
  }) => Promise<void>;
  imapVerifierTimeoutMs?: number;
  logger?: Pick<AppLogger, "error">;
  syncErrorLog?: Pick<MailSyncErrorLog, "filePath" | "record">;
  errorIdFactory?: () => string;
}

interface LoginBody {
  config: AccountConfig;
  secrets: { imapPassword: string; smtpPassword?: string };
}

// Basic sanity regex — full RFC 5322 is overkill for phase one and would
// reject legitimate addresses. We just need "<something>@<something>".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_IMAP_VERIFIER_TIMEOUT_MS = 10_000;
const DISPLAY_NAME_MAX_LENGTH = 120;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function errorDetail(error: unknown): {
  name: string;
  message: string;
  providerMessage: string;
  stack?: string;
} {
  if (error instanceof Error) {
    const maybe = error as Error & { responseText?: unknown };
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      providerMessage:
        typeof maybe.responseText === "string" && maybe.responseText.length > 0
          ? maybe.responseText
          : extractProviderMessage(error.message || String(error)),
      stack: error.stack,
    };
  }
  const message = String(error);
  return {
    name: "Error",
    message,
    providerMessage: extractProviderMessage(message),
  };
}

function extractProviderMessage(message: string): string {
  const responseMatch = message.match(/response=([^]*?)(?:\s(?:code|status|serverCode|executedCommand)=|$)/);
  if (responseMatch?.[1]?.trim()) return responseMatch[1].trim();
  return message;
}

function isMailboxConnectionFailure(detail: { message: string; providerMessage: string }): boolean {
  const text = `${detail.message} ${detail.providerMessage}`.toLowerCase();
  return [
    "before secure tls connection",
    "client network socket disconnected",
    "socket hang up",
    "econnreset",
    "econnrefused",
    "etimedout",
    "timed out",
    "enotfound",
    "eai_again",
  ].some((needle) => text.includes(needle));
}

function formatImapLoginError(detail: { message: string; providerMessage: string }): string {
  if (isMailboxConnectionFailure(detail)) {
    return `无法建立邮箱安全连接：${detail.providerMessage}`;
  }
  return `邮箱服务器拒绝登录：${detail.providerMessage}`;
}

/**
 * Validate an incoming login payload. Returns a {field, error} pair on
 * the first violation, or null when the payload is acceptable. Checks
 * only structural shape — live IMAP/SMTP reachability is a separate concern.
 */
function validateLoginBody(body: unknown): { field: string; error: string } | null {
  if (!body || typeof body !== "object") {
    return { field: "body", error: "request body must be a JSON object" };
  }
  const b = body as Partial<LoginBody>;
  const config = b.config as Partial<AccountConfig> | undefined;
  const secrets = b.secrets;

  if (!config || typeof config !== "object") {
    return { field: "config", error: "config is required" };
  }
  if (!isNonEmptyString(config.id)) {
    return { field: "config.id", error: "config.id is required" };
  }
  if (!isNonEmptyString(config.emailAddress) || !EMAIL_RE.test(config.emailAddress)) {
    return { field: "config.emailAddress", error: "config.emailAddress must be a valid email" };
  }

  for (const protocol of ["imap", "smtp"] as const) {
    const proto = config[protocol] as Partial<AccountConfig["imap"]> | undefined;
    if (!proto || typeof proto !== "object") {
      return { field: `config.${protocol}`, error: `config.${protocol} is required` };
    }
    if (!isNonEmptyString(proto.host)) {
      return { field: `config.${protocol}.host`, error: `config.${protocol}.host must be a non-empty string` };
    }
    if (!isPort(proto.port)) {
      return { field: `config.${protocol}.port`, error: `config.${protocol}.port must be an integer in [1,65535]` };
    }
    if (!isBool(proto.secure)) {
      return { field: `config.${protocol}.secure`, error: `config.${protocol}.secure must be a boolean` };
    }
    if (!isNonEmptyString(proto.username)) {
      return { field: `config.${protocol}.username`, error: `config.${protocol}.username must be a non-empty string` };
    }
  }

  if (!secrets || typeof secrets !== "object") {
    return { field: "secrets", error: "secrets is required" };
  }
  if (!isNonEmptyString((secrets as LoginBody["secrets"]).imapPassword)) {
    return { field: "secrets.imapPassword", error: "secrets.imapPassword is required" };
  }
  if (!isNonEmptyString((secrets as LoginBody["secrets"]).smtpPassword)) {
    return { field: "secrets.smtpPassword", error: "secrets.smtpPassword is required" };
  }
  return null;
}

/**
 * Build the `/api/account` router. Tests use {@link buildAccountRoutes}
 * directly with a service harness; the server bootstrap uses
 * {@link createAccountApp} which constructs the service from db+secrets.
 *
 * Plaintext passwords from the login payload NEVER appear in responses
 * and MUST NOT be logged by any caller — the route handler strips the
 * payload before returning.
 */
export function buildAccountRoutes(deps: AccountRoutesDeps) {
  const router = new Hono();
  const {
    service,
    imapVerifier,
    imapVerifierTimeoutMs = DEFAULT_IMAP_VERIFIER_TIMEOUT_MS,
    logger,
    syncErrorLog,
    errorIdFactory = randomUUID,
  } = deps;

  router.get("/current", (c) => {
    const account = service.getCurrentAccount();
    return c.json({ account });
  });

  router.patch("/current", async (c) => {
    const body = await c.req.json().catch(() => null) as { displayName?: unknown } | null;
    if (!body || typeof body.displayName !== "string") {
      return c.json({ ok: false, error: "displayName must be a string", field: "displayName" }, 400);
    }
    const displayName = body.displayName.trim();
    if (!displayName) {
      return c.json({ ok: false, error: "displayName is required", field: "displayName" }, 400);
    }
    if (/[\r\n]/.test(displayName)) {
      return c.json({ ok: false, error: "displayName must be a single line", field: "displayName" }, 400);
    }
    if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      return c.json({
        ok: false,
        error: `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
        field: "displayName",
      }, 400);
    }
    const account = await service.updateAccount({ displayName });
    if (!account) {
      return c.json({ ok: false, error: "no active account" }, 404);
    }
    return c.json({ ok: true, account });
  });

  router.post("/login", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json body", field: "body" }, 400);
    }

    const violation = validateLoginBody(body);
    if (violation) {
      return c.json({ ok: false, error: violation.error, field: violation.field }, 400);
    }

    const typed = body as LoginBody;
    if (imapVerifier) {
      try {
        await withTimeout(
          imapVerifier({
            config: typed.config,
            imapPassword: typed.secrets.imapPassword,
          }),
          imapVerifierTimeoutMs,
        );
      } catch (error) {
        const errorId = errorIdFactory();
        const detail = errorDetail(error);
        logger?.error("account.imap.verify.failed", {
          errorId,
          stage: "imap.login",
          name: detail.name,
          message: detail.message,
          providerMessage: detail.providerMessage,
          host: typed.config.imap.host,
          port: typed.config.imap.port,
          secure: typed.config.imap.secure,
          username: typed.config.imap.username,
          stack: detail.stack,
        });
        syncErrorLog?.record({
          errorId,
          stage: "imap.login",
          name: detail.name,
          message: detail.message,
          detail: detail.message,
          stack: detail.stack,
          context: {
            providerMessage: detail.providerMessage,
            host: typed.config.imap.host,
            port: typed.config.imap.port,
            secure: typed.config.imap.secure,
            username: typed.config.imap.username,
          },
        });
        const connectionFailure = isMailboxConnectionFailure(detail);
        return c.json(
          {
            ok: false,
            error: formatImapLoginError(detail),
            ...(!connectionFailure ? { code: "MAIL_CREDENTIAL_INVALID" } : {}),
            errorId,
            stage: "imap.login",
            detail: detail.message,
            providerMessage: detail.providerMessage,
            logFile: syncErrorLog?.filePath,
          },
          connectionFailure ? 503 : 401,
        );
      }
    }
    const account = await service.saveAccount({
      config: typed.config,
      secrets: typed.secrets,
    });
    return c.json({ ok: true, account });
  });

  router.post("/logout", (c) => {
    service.logout();
    return c.json({ ok: true });
  });

  return router;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `imap.login: 登录校验超时（${timeoutMs}ms） code=ETIMEDOUT`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

