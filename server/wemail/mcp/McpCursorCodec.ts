import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "../security/SecretStore.js";
import type { WemailMcpV1ToolName } from "../../../shared/wemail/mcp.js";
import { McpDomainError } from "./McpErrorMapper.js";

const SECRET_KEY = "wemail:mcp:cursor-signing-key";

interface CursorPayload<T> {
  version: 1;
  accountId: string;
  tool: WemailMcpV1ToolName;
  scope: string;
  order: string;
  expiresAt: number;
  position: T;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class McpCursorCodec {
  private readonly key: string;
  constructor(
    secrets: SecretStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 30 * 60 * 1000,
  ) {
    const existing = secrets.getSecret(SECRET_KEY);
    this.key = existing ?? randomBytes(32).toString("base64url");
    if (!existing) secrets.saveSecret(SECRET_KEY, this.key);
  }

  encode<T>(input: {
    accountId: string;
    tool: WemailMcpV1ToolName;
    filters: unknown;
    order: string;
    position: T;
  }): string {
    const payload: CursorPayload<T> = {
      version: 1,
      accountId: input.accountId,
      tool: input.tool,
      scope: this.scope(input.filters),
      order: input.order,
      expiresAt: this.now().getTime() + this.ttlMs,
      position: input.position,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  decode<T>(cursor: string, expected: {
    accountId: string;
    tool: WemailMcpV1ToolName;
    filters: unknown;
    order: string;
  }): T {
    try {
      const [encoded, signature, extra] = cursor.split(".");
      if (!encoded || !signature || extra) throw new Error("shape");
      const actual = Buffer.from(signature, "base64url");
      const wanted = Buffer.from(this.sign(encoded), "base64url");
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error("signature");
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorPayload<T>;
      if (payload.version !== 1 || payload.accountId !== expected.accountId || payload.tool !== expected.tool || payload.scope !== this.scope(expected.filters) || payload.order !== expected.order || payload.expiresAt <= this.now().getTime()) throw new Error("binding");
      return payload.position;
    } catch {
      throw new McpDomainError("invalid_cursor", "Invalid cursor.");
    }
  }

  private scope(filters: unknown): string {
    return createHmac("sha256", this.key).update(stable(filters)).digest("base64url").slice(0, 24);
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.key).update(encoded).digest("base64url");
  }
}
