import type { AccountService } from "../account/AccountService.js";
import {
  WEMAIL_MCP_PROTOCOL_VERSIONS,
  formatWemailMcpConfiguration,
  type WemailMcpConfigurationTarget,
  type WemailMcpManagementState,
  type WemailMcpOneTimeTokenResult,
  type WemailMcpSettingsInput,
} from "../../../shared/wemail/mcp.js";
import type {
  ManagedMcpCredential,
  ManagedMcpCredentialVault,
} from "./ManagedMcpCredentialVault.js";
import type { McpComposition } from "./McpComposition.js";
import { McpAuthenticator } from "./McpAuthenticator.js";
import { McpHttpTransport, startMcpHttpServer, type McpHttpServer } from "./McpHttpTransport.js";

export class McpListenerController {
  private server?: McpHttpServer;
  private state: WemailMcpManagementState["listenerState"] = "disabled";
  private errorCode?: WemailMcpManagementState["errorCode"];
  private credentialState: WemailMcpManagementState["credentialState"] = "unavailable";
  private readonly emergencyDisabled: boolean;
  private readonly managedCredentials?: ManagedMcpCredentialVault;

  constructor(
    private readonly mcp: McpComposition,
    private readonly accounts: Pick<AccountService, "getCurrentAccount">,
    options: {
      emergencyDisabled?: boolean;
      managedCredentials?: ManagedMcpCredentialVault;
      /** Headless shells start the listener without the desktop's
       *  per-account managed-credential vault; bearer-token auth still
       *  gates every call. Defaults to true (desktop behavior). */
      requireManagedCredential?: boolean;
    } = {},
  ) {
    this.emergencyDisabled = options.emergencyDisabled ?? process.env.WEMAIL_MCP_EMERGENCY_DISABLE === "1";
    this.managedCredentials = options.managedCredentials;
    this.requireManagedCredential = options.requireManagedCredential ?? true;
  }

  private readonly requireManagedCredential: boolean;

  async boot(): Promise<void> {
    if (this.emergencyDisabled) {
      this.state = "disabled";
      this.errorCode = "emergency_disabled";
      this.mcp.sessions.closeAll("emergency-disabled");
      return;
    }
    if (this.mcp.settings.get().enabled && (this.requireManagedCredential ? this.ensureManagedCredential() : true)) {
      await this.start();
    }
  }

  view(): WemailMcpManagementState {
    const settings = this.mcp.settings.get();
    const accountId = this.accounts.getCurrentAccount()?.id;
    const token = accountId ? this.mcp.tokens.getActiveManagedForAccount(accountId) : null;
    const legacyTokens = accountId ? this.mcp.tokens.listActiveLegacyForAccount(accountId) : [];
    return {
      enabled: settings.enabled && !this.emergencyDisabled,
      port: settings.port,
      defaultBodyCharacters: settings.defaultBodyCharacters,
      maxBodyCharacters: settings.maxBodyCharacters,
      defaultPageSize: settings.defaultPageSize,
      maxPageSize: settings.maxPageSize,
      maxRecipients: settings.maxRecipients,
      maxBatchMessages: settings.maxBatchMessages,
      maxPendingOperations: settings.maxPendingOperations,
      toolTimeoutSeconds: settings.toolTimeoutSeconds,
      endpoint: `http://127.0.0.1:${settings.port}/mcp`,
      listenerState: this.state,
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      credentialState: this.credentialState,
      protocols: WEMAIL_MCP_PROTOCOL_VERSIONS,
      tools: this.mcp.registry.list().map(({ name, title, description, domain, risk, maxResponseBytes }) => {
        const available = this.mcp.registry.hasHandler(name);
        return {
          name, title, description, domain, risk, maxResponseBytes, available,
          ...(!available ? { unavailableReason: "not_implemented" as const } : {}),
        };
      }),
      token: token ? {
        id: token.id,
        kind: token.kind,
        fingerprint: token.fingerprint,
        status: token.status,
        createdAt: token.createdAt,
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
        ...(token.revokedAt ? { revokedAt: token.revokedAt } : {}),
      } : null,
      legacyTokens: legacyTokens.map((legacy) => ({
        id: legacy.id,
        kind: legacy.kind,
        fingerprint: legacy.fingerprint,
        status: legacy.status,
        createdAt: legacy.createdAt,
        ...(legacy.lastUsedAt ? { lastUsedAt: legacy.lastUsedAt } : {}),
        ...(legacy.revokedAt ? { revokedAt: legacy.revokedAt } : {}),
      })),
      sessions: this.mcp.sessions.list().map(({ sessionHash, protocolVersion, initialized, createdAt, lastUsedAt, inFlightCalls }) => ({
        sessionHash, protocolVersion, initialized, createdAt, lastUsedAt, inFlightCalls,
      })),
      pendingOperationCount: accountId ? this.mcp.operations.countPending(accountId) : 0,
      operations: accountId ? this.mcp.operations.listRecent(accountId).map((operation) => ({
        id: operation.id,
        type: operation.operationType,
        state: operation.state,
        preview: operation.preview,
        expiresAt: operation.expiresAt,
        updatedAt: operation.updatedAt,
        ...(operation.resultCode ? { resultCode: operation.resultCode } : {}),
      })) : [],
    };
  }

  async configure(input: WemailMcpSettingsInput): Promise<WemailMcpManagementState> {
    if (input.enabled && this.emergencyDisabled) {
      this.errorCode = "emergency_disabled";
      throw new Error("mcp-emergency-disabled");
    }
    const previous = this.mcp.settings.get();
    this.mcp.settings.save(input);
    if (!input.enabled) {
      await this.stop();
    } else if (!this.requireManagedCredential || this.ensureManagedCredential()) {
      const credentialError = this.errorCode;
      await this.stop();
      this.state = "error";
      this.errorCode = credentialError;
    } else if (!this.server ||
      (input.port !== undefined && input.port !== previous.port) ||
      (input.toolTimeoutSeconds !== undefined && input.toolTimeoutSeconds !== previous.toolTimeoutSeconds)) {
      await this.stop();
      await this.start();
    }
    return this.view();
  }

  createToken(): WemailMcpOneTimeTokenResult {
    const account = this.accounts.getCurrentAccount();
    if (!account) throw new Error("account-not-found");
    const created = this.mcp.tokens.create(account.id);
    return this.tokenResult(created);
  }

  rotateToken(): WemailMcpOneTimeTokenResult {
    const account = this.accounts.getCurrentAccount();
    if (!account) throw new Error("account-not-found");
    return this.tokenResult(this.mcp.tokens.rotate(account.id));
  }

  revokeToken(): boolean {
    const accountId = this.accounts.getCurrentAccount()?.id;
    const token = accountId ? this.mcp.tokens.getActiveForAccount(accountId) : null;
    if (!token) return false;
    const revoked = this.mcp.tokens.revoke(token.id);
    if (revoked && token.kind === "managed" && accountId) {
      this.managedCredentials?.delete(accountId);
      this.credentialState = "unavailable";
    }
    return revoked;
  }

  resetCredential(): WemailMcpManagementState {
    const account = this.accounts.getCurrentAccount();
    if (!account) throw new Error("account-not-found");
    this.mcp.tokens.revokeForAccount(account.id);
    this.managedCredentials?.delete(account.id);
    this.credentialState = "unavailable";
    if (this.mcp.settings.get().enabled) this.ensureManagedCredential();
    return this.view();
  }

  configuration(target: WemailMcpConfigurationTarget): string {
    if (
      !this.mcp.settings.get().enabled ||
      (this.state !== "listening" && this.state !== "attached") ||
      this.credentialState !== "ready"
    ) {
      throw new Error("mcp-not-ready");
    }
    const account = this.accounts.getCurrentAccount();
    if (!account || !this.managedCredentials) {
      throw new Error("mcp-credential-unavailable");
    }
    const credential = this.managedCredentials.read(account.id);
    const active = this.mcp.tokens.getActiveManagedForAccount(account.id);
    if (!credential || !active || credential.tokenId !== active.id) {
      throw new Error("mcp-credential-corrupt");
    }
    const verified = this.mcp.tokens.verify(credential.token);
    if (!verified || verified.id !== active.id) {
      throw new Error("mcp-credential-corrupt");
    }
    return formatWemailMcpConfiguration({
      target,
      endpoint: this.view().endpoint,
      token: credential.token,
    });
  }

  terminateSession(sessionHash: string): boolean {
    return this.mcp.sessions.terminateByHash(sessionHash);
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private async start(): Promise<void> {
    this.state = "starting";
    this.errorCode = undefined;
    const { port, toolTimeoutSeconds } = this.mcp.settings.get();
    try {
      this.server = await startMcpHttpServer({
        transport: new McpHttpTransport({
          authenticator: new McpAuthenticator(this.mcp.tokens),
          sessions: this.mcp.sessions,
          registry: this.mcp.registry,
          audit: this.mcp.audit,
          limits: { toolTimeoutMs: toolTimeoutSeconds * 1_000 },
        }),
        port,
        host: "127.0.0.1",
      });
      this.state = "listening";
    } catch (error) {
      this.server = undefined;
      this.state = "error";
      const code = (error as NodeJS.ErrnoException).code;
      this.errorCode = code === "EADDRINUSE" ? "port_conflict" : "listener_failed";
    }
  }

  /** GUI attaches to an already-running daemon serving this same database's
   *  endpoint (dbx-style): credentials are verified so "copy configuration"
   *  keeps working, but this process never owns a listener socket. */
  async bootAttached(): Promise<void> {
    if (this.emergencyDisabled) {
      this.state = "disabled";
      this.errorCode = "emergency_disabled";
      return;
    }
    if (this.requireManagedCredential) this.ensureManagedCredential();
    this.state = "attached";
    this.errorCode = undefined;
  }

  private async stop(): Promise<void> {
    this.mcp.sessions.closeAll("mcp-disabled");
    const server = this.server;
    this.server = undefined;
    if (server) await server.close();
    this.state = "disabled";
    this.errorCode = undefined;
  }

  private ensureManagedCredential(): boolean {
    const account = this.accounts.getCurrentAccount();
    const vault = this.managedCredentials;
    if (!account || !vault || !vault.isAvailable()) {
      this.credentialState = "error";
      this.errorCode = "credential_unavailable";
      this.state = "error";
      return false;
    }
    this.credentialState = "provisioning";
    try {
      const active = this.mcp.tokens.getActiveManagedForAccount(account.id);
      const stored = vault.read(account.id);
      if (active) {
        if (!stored || stored.tokenId !== active.id) {
          throw new Error("mcp-credential-corrupt");
        }
        const verified = this.mcp.tokens.verify(stored.token);
        if (!verified || verified.id !== active.id) {
          throw new Error("mcp-credential-corrupt");
        }
        this.credentialState = "ready";
        this.errorCode = undefined;
        return true;
      }
      if (stored) vault.delete(account.id);
      const candidate = this.mcp.tokens.prepareManaged(account.id);
      const credential: ManagedMcpCredential = {
        version: 1,
        accountId: account.id,
        tokenId: candidate.created.id,
        token: candidate.created.token,
      };
      try {
        vault.save(credential);
        candidate.commit();
      } catch (error) {
        vault.delete(account.id);
        candidate.abort();
        throw error;
      }
      this.credentialState = "ready";
      this.errorCode = undefined;
      return true;
    } catch (error) {
      this.credentialState = "error";
      this.errorCode =
        error instanceof Error && error.message === "mcp-credential-corrupt"
          ? "credential_corrupt"
          : "credential_unavailable";
      this.state = "error";
      return false;
    }
  }

  private tokenResult(created: ReturnType<McpComposition["tokens"]["create"]>): WemailMcpOneTimeTokenResult {
    const endpoint = this.view().endpoint;
    return {
      token: created.token,
      metadata: {
        id: created.id,
        kind: created.kind,
        fingerprint: created.fingerprint,
        status: created.status,
        createdAt: created.createdAt,
      },
      configuration: {
        type: "streamablehttp",
        url: endpoint,
        headers: { Authorization: `Bearer ${created.token}` },
      },
    };
  }
}
