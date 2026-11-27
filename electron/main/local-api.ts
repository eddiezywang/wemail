import { openValidatedPlatformDatabase } from "../../server/wemail/database/openValidatedPlatformDatabase.js";
import type { EditionRuntimeConfig } from "../../shared/wemail/edition.js";
import path from "node:path";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../server/api/app.js";
import {
  composeApp,
  type AppComposition,
  type ComposeAppOverrides,
} from "../../server/wemail/bootstrap/AppComposition.js";
import type { LlmProviderConfig } from "../../server/wemail/bootstrap/composition/settings.js";
import { enableSystemCertificateAuthorities } from "../../server/wemail/security/SystemCa.js";
import { McpListenerController } from "../../server/wemail/mcp/McpListenerController.js";
import { isWemailDaemonServing } from "../../server/wemail/mcp/daemonProbe.js";
import { WEMAIL_MCP_DEFAULT_PORT } from "../../shared/wemail/mcp.js";
import type { ManagedMcpCredentialVault } from "../../server/wemail/mcp/ManagedMcpCredentialVault.js";
import type { SecretStore } from "../../server/wemail/security/SecretStore.js";
import type { MailDatabaseClient } from "../../server/wemail/database/MailDatabaseClient.js";
import { registerManagedCredentialAccountCleanup } from "./mcp-credential-account-cleanup.js";
import type { DaemonOrchestration } from "./mcp-daemon.js";
import type { MailAttachmentGateway } from "../../server/api/routes/mailAttachmentRoutes.js";
import type { MailRefreshResult } from "../../shared/wemail/mailCoreProtocol.js";
import type { MailReceiptHealth } from "../../shared/wemail/mailSync.js";
import type { AppLoggingDiagnostics } from "../../server/wemail/telemetry/AppLogger.js";

export interface LocalApi extends LocalApiServer {
  composition: AppComposition;
  mcpController: McpListenerController;
  /** Present only when the opt-in MCP listener bound successfully. */
  mcpEndpoint?: string;
  /** Shut down server + composition in order. */
  stop(): Promise<void>;
}

/**
 * Parse the LLM config that the Playwright E2E harness passes via
 * `WEMAIL_LLM_BASE_URL` (+ `WEMAIL_LLM_MODEL`). In non-E2E mode the
 * composition root tolerates an undefined LLM config.
 */
function readE2eLlmConfig(): LlmProviderConfig | undefined {
  const baseUrl = process.env.WEMAIL_LLM_BASE_URL;
  if (!baseUrl) return undefined;
  return {
    provider: "openai",
    apiKey: process.env.WEMAIL_LLM_API_KEY ?? "test-key",
    baseUrl,
    defaultModel: process.env.WEMAIL_LLM_MODEL ?? "mock-model",
  };
}

export async function startLocalApi(options: {
  managedMcpCredentials?: ManagedMcpCredentialVault;
  /** Persistent-daemon orchestration (dbx-style). Absent in E2E/dev-api:
   *  attach-or-boot then behaves exactly as before the daemon existed. */
  daemon?: DaemonOrchestration;
  secretStore?: SecretStore;
  /** Edition overlay (loaded by app.ts); absent = open-source defaults. */
  edition?: EditionRuntimeConfig;
  mailDatabase: MailDatabaseClient;
  mailAttachmentGateway?: MailAttachmentGateway;
  /** Trigger an immediate mail metadata sync via the Mail Core worker (MCP sync tool). */
  refreshMail?: (accountId: string) => Promise<MailRefreshResult>;
  getMailReceipt?: (accountId: string) => MailReceiptHealth | null;
  quitApp?: () => void;
  onDebugModeChanged?: (diagnostics: AppLoggingDiagnostics) => void;
}): Promise<LocalApi> {
  enableSystemCertificateAuthorities();
  const dataDir =
    process.env.WEMAIL_DATA_DIR ?? path.join(process.cwd(), ".wemail");
  const logsDir = path.join(dataDir, "logs");

  let overrides: ComposeAppOverrides | undefined;
  let llmConfig: LlmProviderConfig | undefined;
  if (process.env.WEMAIL_E2E_MODE === "1") {
    // Hermetic test harness — wire the file-backed provider so the
    // Playwright suite can drop fixtures into <dataDir>/mock-inbox/ and
    // route the LLM traffic at a local hono mock.
    overrides = {};
    llmConfig = readE2eLlmConfig();
  }

  console.info(JSON.stringify({ phase: "local-api-integrity-begin" }));
  const database = options.mailDatabase.checkIntegrity
    ? await openValidatedPlatformDatabase(path.join(dataDir, "wemail.sqlite"), {
        checkIntegrity: options.mailDatabase.checkIntegrity.bind(options.mailDatabase),
      })
    : undefined;
  console.info(JSON.stringify({ phase: "local-api-integrity-done" }));
  let composition: AppComposition;
  try {
    composition = await composeApp({
      database,
      dataDir,
      logsDir,
      mailDatabase: options.mailDatabase,
      llmConfig,
      edition: options.edition,
      overrides: {
        ...overrides,
        secretStore: options.secretStore,
        channels: { enabled: true },
      },
      refreshMail: options.refreshMail,
      getMailReceipt: options.getMailReceipt,
      fetchAttachment: options.mailAttachmentGateway?.fetchAttachment,
    });
    console.info(JSON.stringify({ phase: "local-api-composition-done" }));
  } catch (error) {
    if (database?.open) database.close();
    throw error;
  }
  const mcpController = new McpListenerController(
    composition.mcp,
    composition.accountService,
    { managedCredentials: options.managedMcpCredentials },
  );
  const unsubscribeManagedCredentialCleanup =
    registerManagedCredentialAccountCleanup({
      accounts: composition.accountService,
      vault: options.managedMcpCredentials,
    });
  if (process.env.WEMAIL_MCP_ENABLED === "1") {
    const configuredPort = Number.parseInt(
      process.env.WEMAIL_MCP_PORT ?? String(WEMAIL_MCP_DEFAULT_PORT),
      10,
    );
    composition.mcp.settings.save({
      enabled: true,
      port: Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
        ? configuredPort
        : WEMAIL_MCP_DEFAULT_PORT,
    });
  }
  // Attach-or-boot (dbx-style): when a persistent daemon already serves this
  // database's endpoint, attach to it instead of owning a second listener —
  // the endpoint (and the copied configuration) then outlives this process.
  const mcpAccountId = composition.accountService.getCurrentAccount()?.id;
  const mcpActiveToken = mcpAccountId
    ? composition.mcp.tokens.getActiveManagedForAccount(mcpAccountId)
    : null;
  const mcpCredential = mcpAccountId
    ? options.managedMcpCredentials?.read(mcpAccountId)
    : undefined;
  const daemonServing =
    mcpActiveToken != null &&
    mcpCredential != null &&
    mcpCredential.tokenId === mcpActiveToken.id &&
    (await isWemailDaemonServing({
      port: composition.mcp.settings.get().port,
      fetchToken: () => mcpCredential.token,
    }));
  if (daemonServing) {
    await mcpController.bootAttached();
  } else if (options.daemon && process.env.WEMAIL_E2E_MODE !== "1") {
    // Daemon missing — spawn it (detached, outlives the GUI) and attach so
    // the endpoint outlives this process; fall back to self-hosting only
    // if the daemon couldn't start.
    if (await options.daemon.ensure()) {
      await mcpController.bootAttached();
    } else {
      await mcpController.boot();
    }
  } else {
    await mcpController.boot();
  }
  const server = await startLocalApiServer({
    port: 0,
    composition,
    mcpController,
    // E2E accounts use reserved example domains and the file-backed mail
    // provider, so no real IMAP socket must be opened during login.
    imapVerifier:
      process.env.WEMAIL_E2E_MODE === "1" ? async () => {} : undefined,
    mailAttachmentGateway: options.mailAttachmentGateway,
    quitApp: options.quitApp,
    onDebugModeChanged: options.onDebugModeChanged,
    onMcpSettingsChanged: options.daemon
      ? async (state) => {
          // Q4 semantics: settings changed → daemon reloads (covers port
          // changes); MCP disabled → daemon dies with it.
          if (state.enabled) await options.daemon!.restart();
          else options.daemon!.stop();
        }
      : undefined,
  });

  // Curator periodic ticker (Route C / WP J.8). The 24h cooldown lives
  // inside CuratorScheduler, so an hourly external tick is safe — it's
  // a no-op for accounts still in cooldown. Skipped in E2E mode so the
  // hermetic harness doesn't observe an ambient ticker.
  if (process.env.WEMAIL_E2E_MODE !== "1") {
    composition.startCuratorTicker();
  }

  return {
    port: server.port,
    close: server.close,
    setRendererOrigin: server.setRendererOrigin,
    composition,
    mcpController,
    ...(mcpController.view().listenerState === "listening" || mcpController.view().listenerState === "attached"
      ? { mcpEndpoint: mcpController.view().endpoint }
      : {}),
    stop: async () => {
      unsubscribeManagedCredentialCleanup();
      await mcpController.close();
      await server.close();
      await composition.stop();
    },
  };
}
