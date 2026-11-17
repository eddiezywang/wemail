import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { MailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";

const TOKEN_PREFIX = "wmcp_";
const SECRET_NAMESPACE = "wemail:mcp:token-pepper";

interface TokenRow {
  id: string;
  account_id: string;
  secret_key: string;
  fingerprint: string;
  verifier_salt: string;
  verifier_hash: string;
  credential_kind: "legacy" | "managed";
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
export interface McpAccessTokenMetadata {
  id: string;
  accountId: string;
  kind: "legacy" | "managed";
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface CreatedMcpAccessToken extends McpAccessTokenMetadata {
  token: string;
}

export interface McpAccessTokenServiceOptions {
  db: MailDatabase;
  secrets: SecretStore;
  accountExists?: (accountId: string) => boolean;
  now?: () => Date;
  onTokenRevoked?: (tokenId: string) => void;
}

function toMetadata(row: TokenRow): McpAccessTokenMetadata {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.credential_kind,
    fingerprint: row.fingerprint,
    status: row.status,
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function parseTokenId(token: string): string | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const separator = token.indexOf(".", TOKEN_PREFIX.length);
  if (separator <= TOKEN_PREFIX.length || separator === token.length - 1) {
    return undefined;
  }
  return token.slice(TOKEN_PREFIX.length, separator);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class McpAccessTokenService {
  private readonly db: MailDatabase;
  private readonly secrets: SecretStore;
  private readonly now: () => Date;
  private readonly onTokenRevoked: (tokenId: string) => void;
  private readonly accountExists?: (accountId: string) => boolean;

  constructor(options: McpAccessTokenServiceOptions) {
    this.db = options.db;
    this.secrets = options.secrets;
    this.now = options.now ?? (() => new Date());
    this.onTokenRevoked = options.onTokenRevoked ?? (() => {});
    this.accountExists = options.accountExists;
  }

  create(accountId: string): CreatedMcpAccessToken {
    this.assertAccountExists(accountId);
    const active = this.getActiveForAccount(accountId);
    if (active) throw new Error("mcp-token-already-exists");
    const candidate = this.buildCandidate(accountId, "legacy");
    try {
      this.insertCandidate(candidate);
    } catch (error) {
      this.secrets.deleteSecret(candidate.secretKey);
      throw error;
    }
    return candidate.created;
  }

  rotate(accountId: string): CreatedMcpAccessToken {
    this.assertAccountExists(accountId);
    const priorRows = this.activeRows(accountId);
    const candidate = this.buildCandidate(accountId, "legacy");
    const revokedAt = this.now().toISOString();
    try {
      const rotate = this.db.transaction(() => {
        this.insertCandidate(candidate);
        this.db
          .prepare(
            `UPDATE mcp_access_tokens
                SET status = 'revoked', revoked_at = ?
              WHERE account_id = ? AND id <> ? AND status = 'active'`,
          )
          .run(revokedAt, accountId, candidate.created.id);
      });
      rotate();
    } catch (error) {
      this.secrets.deleteSecret(candidate.secretKey);
      throw error;
    }
    for (const row of priorRows) {
      this.secrets.deleteSecret(row.secret_key);
      this.onTokenRevoked(row.id);
    }
    return candidate.created;
  }

  verify(token: string): McpAccessTokenMetadata | null {
    const id = parseTokenId(token);
    if (!id) return null;
    const row = this.getRow(id);
    if (!row || row.status !== "active") return null;
    const pepper = this.secrets.getSecret(row.secret_key);
    if (!pepper) return null;
    const actual = this.verifier(pepper, row.verifier_salt, token);
    if (!safeEqualHex(actual, row.verifier_hash)) return null;
    const usedAt = this.now().toISOString();
    this.db
      .prepare("UPDATE mcp_access_tokens SET last_used_at = ? WHERE id = ?")
      .run(usedAt, row.id);
    return toMetadata({ ...row, last_used_at: usedAt });
  }

  revoke(tokenId: string): boolean {
    const row = this.getRow(tokenId);
    if (!row || row.status === "revoked") return false;
    const revokedAt = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE mcp_access_tokens
            SET status = 'revoked', revoked_at = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(revokedAt, tokenId);
    this.secrets.deleteSecret(row.secret_key);
    this.onTokenRevoked(tokenId);
    return true;
  }

  revokeForAccount(accountId: string): number {
    const rows = this.activeRows(accountId);
    if (rows.length === 0) return 0;
    const revokedAt = this.now().toISOString();
    const revoke = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE mcp_access_tokens
              SET status = 'revoked', revoked_at = ?
            WHERE account_id = ? AND status = 'active'`,
        )
        .run(revokedAt, accountId);
    });
    revoke();
    for (const row of rows) {
      this.secrets.deleteSecret(row.secret_key);
      this.onTokenRevoked(row.id);
    }
    return rows.length;
  }

  getActiveForAccount(accountId: string): McpAccessTokenMetadata | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mcp_access_tokens
          WHERE account_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(accountId) as TokenRow | undefined;
    return row ? toMetadata(row) : null;
  }

  getActiveManagedForAccount(accountId: string): McpAccessTokenMetadata | null {
    const row = this.db
      .prepare(
        `SELECT * FROM mcp_access_tokens
          WHERE account_id = ? AND credential_kind = 'managed' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(accountId) as TokenRow | undefined;
    return row ? toMetadata(row) : null;
  }

  listActiveLegacyForAccount(accountId: string): McpAccessTokenMetadata[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM mcp_access_tokens
            WHERE account_id = ? AND credential_kind = 'legacy' AND status = 'active'
            ORDER BY created_at DESC`,
        )
        .all(accountId) as TokenRow[]
    ).map(toMetadata);
  }

  prepareManaged(accountId: string): {
    created: CreatedMcpAccessToken;
    commit: () => CreatedMcpAccessToken;
    abort: () => void;
  } {
    this.assertAccountExists(accountId);
    if (this.getActiveManagedForAccount(accountId)) {
      throw new Error("mcp-managed-credential-already-exists");
    }
    const candidate = this.buildCandidate(accountId, "managed");
    let settled = false;
    return {
      created: candidate.created,
      commit: () => {
        if (settled) throw new Error("mcp-managed-candidate-settled");
        try {
          this.insertCandidate(candidate);
          settled = true;
          return candidate.created;
        } catch (error) {
          this.secrets.deleteSecret(candidate.secretKey);
          settled = true;
          throw error;
        }
      },
      abort: () => {
        if (settled) return;
        this.secrets.deleteSecret(candidate.secretKey);
        settled = true;
      },
    };
  }

  listForAccount(accountId: string): McpAccessTokenMetadata[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM mcp_access_tokens
            WHERE account_id = ?
            ORDER BY created_at DESC`,
        )
        .all(accountId) as TokenRow[]
    ).map(toMetadata);
  }

  deleteRevokedBefore(isoTimestamp: string): number {
    return this.db.prepare(
      `DELETE FROM mcp_access_tokens
        WHERE status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ?`,
    ).run(isoTimestamp).changes;
  }

  private assertAccountExists(accountId: string) {
    if (!this.accountExists) throw new Error("canonical-account-directory-required");
    if (!this.accountExists(accountId)) throw new Error("account-not-found");
  }

  private activeRows(accountId: string): TokenRow[] {
    return this.db
      .prepare(
        "SELECT * FROM mcp_access_tokens WHERE account_id = ? AND status = 'active'",
      )
      .all(accountId) as TokenRow[];
  }

  private getRow(id: string): TokenRow | undefined {
    return this.db
      .prepare("SELECT * FROM mcp_access_tokens WHERE id = ?")
      .get(id) as TokenRow | undefined;
  }

  private buildCandidate(accountId: string, kind: "legacy" | "managed") {
    const id = randomUUID();
    const token = `${TOKEN_PREFIX}${id}.${randomBytes(32).toString("base64url")}`;
    const pepper = randomBytes(32).toString("hex");
    const salt = randomBytes(16).toString("hex");
    const secretKey = `${SECRET_NAMESPACE}:${id}`;
    const createdAt = this.now().toISOString();
    const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 16);
    const verifierHash = this.verifier(pepper, salt, token);
    return {
      secretKey,
      pepper,
      salt,
      verifierHash,
      created: {
        id,
        accountId,
        kind,
        fingerprint,
        status: "active" as const,
        createdAt,
        token,
      },
    };
  }

  private insertCandidate(candidate: ReturnType<McpAccessTokenService["buildCandidate"]>) {
    this.secrets.saveSecret(candidate.secretKey, candidate.pepper);
    try {
      this.db
        .prepare(
        `INSERT INTO mcp_access_tokens (
         id, account_id, secret_key, fingerprint, verifier_salt,
           verifier_hash, credential_kind, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
        .run(
          candidate.created.id,
          candidate.created.accountId,
          candidate.secretKey,
          candidate.created.fingerprint,
          candidate.salt,
          candidate.verifierHash,
          candidate.created.kind,
          candidate.created.createdAt,
        );
    } catch (error) {
      this.secrets.deleteSecret(candidate.secretKey);
      throw error;
    }
  }

  private verifier(pepper: string, salt: string, token: string): string {
    return createHmac("sha256", pepper).update(`${salt}:${token}`).digest("hex");
  }
}
