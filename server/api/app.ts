import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppComposition } from "../wemail/bootstrap/AppComposition.js";
import type { AppLoggingDiagnostics } from "../wemail/telemetry/AppLogger.js";
import { verifyImapLogin } from "../wemail/mail/ImapLoginVerifier.js";
import { buildAccountRoutes } from "./routes/accountRoutes.js";
import { agentRoutes, buildAgentRoutes } from "./routes/agentRoutes.js";
import { buildAutomationRoutes } from "./routes/automationRoutes.js";
import { buildApplicationMessageRoutes } from "./routes/applicationMessageRoutes.js";
import { buildInsightReportRoutes } from "./routes/insightReportRoutes.js";
import { buildDigestRoutes } from "./routes/digestRoutes.js";
import { buildDirectoryRoutes } from "./routes/directoryRoutes.js";
import staticRoutes from "./routes/staticRoutes.js";
import { buildSearchRoutes, searchRoutes } from "./routes/searchRoutes.js";
import { createSettingsApp, type LlmProbe } from "./routes/settingsRoutes.js";
import { createSystemApp, systemRoutes } from "./routes/systemRoutes.js";
import { buildWorkspaceRoutes } from "./routes/workspaceRoutes.js";
import { toPublicEditionInfo } from "../../shared/wemail/edition.js";
import { buildActionCenterRoutes } from "./routes/actionCenterRoutes.js";
import { createDiagnosticsApp } from "./routes/diagnosticsRoutes.js";
import type { AccountRoutesDeps } from "./routes/accountRoutes.js";
import type { McpListenerController } from "../wemail/mcp/McpListenerController.js";
import type { WemailMcpManagementState } from "../../shared/wemail/mcp.js";
import { buildMcpRoutes } from "./routes/mcpRoutes.js";
import { buildChannelRoutes } from "./routes/channelRoutes.js";
import { buildConfigurationRoutes } from "./routes/configurationRoutes.js";
import { buildSkillCenterRoutes } from "./routes/skillCenterRoutes.js";
import { buildPipelinePreviewRoutes } from "./routes/pipelinePreviewRoutes.js";
import {
  buildMailAttachmentRoutes,
  type MailAttachmentGateway,
} from "./routes/mailAttachmentRoutes.js";
import { projectPublicErrorResponse } from "./presentation/publicError.js";
import { buildComposeRoutes } from "./routes/composeRoutes.js";
import { buildTodoRoutes } from "./routes/todoRoutes.js";
import { buildSmartTagRoutes } from "./routes/smartTagRoutes.js";
import { buildSummaryRoutes } from "./routes/summaryRoutes.js";
import { buildRemoteImageRoutes } from "./routes/remoteImageRoutes.js";
import { RemoteImageProxy } from "../wemail/mail/RemoteImageProxy.js";
import { closeNodeHttpServer } from "./close-node-http-server.js";

export interface LocalApiServer {
  port: number;
  /** Bound interface address (loopback-only for the desktop API). */
  address?: string;
  setRendererOrigin: (origin: string) => void;
  close: () => Promise<void>;
}

export interface CreateLocalApiAppOptions {
  /** Browser origin currently loaded by the desktop renderer. */
  rendererOrigin?: () => string | undefined;
  /** Canonical listener authority; when set, reject unrecognised Host values. */
  listenerAuthority?: () => string | undefined;
  /**
   * Full Package L composition. When present, all routers are mounted
   * with real dependencies — mail routes get the repository + provider,
   * intelligence routes get the result repo + feedback rules, etc.
   */
  composition?: AppComposition;
  llmProbe?: LlmProbe;
  imapVerifier?: AccountRoutesDeps["imapVerifier"];
  mcpController?: McpListenerController;
  mailAttachmentGateway?: MailAttachmentGateway;
  quitApp?: () => void;
  onDebugModeChanged?: (diagnostics: AppLoggingDiagnostics) => void;
  /** GUI-side daemon orchestration hook (electron only): after
   *  PUT /mcp/settings, restart (enabled) or stop (disabled) the persistent
   *  daemon so it picks up the new settings from the shared database. */
  onMcpSettingsChanged?: (state: WemailMcpManagementState) => Promise<void>;
}

export function createLocalApiApp(options: CreateLocalApiAppOptions = {}) {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const listener = options.listenerAuthority?.();
    if (options.listenerAuthority) {
      const host = c.req.header("host")?.toLowerCase();
      const rendererOrigin = options.rendererOrigin?.();
      const rendererHost = rendererOrigin ? new URL(rendererOrigin).host.toLowerCase() : undefined;
      if (!listener || !host || (host !== listener && host !== rendererHost)) {
        return c.json({ ok: false, error: "host-not-allowed" }, 403);
      }
    }
    const origin = c.req.header("origin");
    if (origin && origin !== options.rendererOrigin?.()) {
      return c.json({ ok: false, error: "origin-not-allowed" }, 403);
    }
    await next();
  });
  app.use(
    "/api/*",
    cors({
      origin: (origin) => {
        return origin && origin === options.rendererOrigin?.() ? origin : null;
      },
    }),
  );
  app.use("/api/*", async (c, next) => {
    await next();
    if (c.res.status < 400) return;
    const contentType = c.res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return;
    let body: unknown;
    try {
      body = await c.res.clone().json();
    } catch {
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(
      JSON.stringify(projectPublicErrorResponse(
        c.res.status,
        body as Record<string, unknown>,
      )),
      { status: c.res.status, headers },
    );
  });
  const remoteImageModules = options.composition?.editionModules?.remoteImage;
  app.route(
    "/api/mail",
    buildRemoteImageRoutes(
      new RemoteImageProxy({
        allowInsecureTLS: remoteImageModules?.allowInsecureTLS,
        trustedHostSuffixes: remoteImageModules?.trustedHostSuffixes,
        fetcher: remoteImageModules?.fetcher,
      }),
    ),
  );
  app.route("/api/system", systemRoutes);
  app.notFound((c) => c.json({ ok: false, code: "ROUTE_NOT_FOUND" }, 404));

  const { composition } = options;
  if (composition) {
    // P2.5: the WeCLI runtime/installer/health/setup pieces are edition
    // modules. The open bundle has no `wecli` slot, so none of the
    // `/api/system/wecli/*` or `/api/skills/wecli/*` routes are mounted.
    const wecliModules = composition.edition?.features?.wecli ? composition.editionModules.wecli : undefined;
    const wecliHealth = wecliModules?.createHealth();
    const wecliInstaller = wecliModules?.createInstaller();
    const wecliSetup = wecliModules && wecliHealth && wecliInstaller
      ? wecliModules.createSetup({
          installer: wecliInstaller,
          health: wecliHealth,
          skillCenter: composition.skillCenter,
        })
      : undefined;
    if (wecliModules && wecliSetup) {
      // When the connection center detects WeCLI is installed, best-effortly
      // download the usage skill so the Skill Center picks it up without the
      // user having to click the installer.
      composition.channels.status.setWecliUsageEnsurer(async () => {
        await wecliSetup.ensureUsageSkill();
      });
    }
    // Replace the skeleton system routes with the wired version.
    app.route(
      "/api/system",
      createSystemApp({
        getEditionInfo: () => toPublicEditionInfo(composition.edition),
        getLlmStatus: () => {
          const llm = composition.getLlmSnapshot();
          return {
            configured: llm.configured,
            provider: llm.provider,
            model: llm.modelFor("default"),
            health: composition.getLlmHealth(),
          };
        },
        wecliHealth,
        wecliInstaller,
        wecliSetup,
        quitApp: options.quitApp,
      }),
    );
    app.route(
      "/api/diagnostics",
      createDiagnosticsApp(composition.logger, {
        onDebugModeChanged: options.onDebugModeChanged,
      }),
    );
    app.route(
      "/api/account",
      buildAccountRoutes({
        service: composition.accountService,
        imapVerifier: options.imapVerifier ?? verifyImapLogin,
        logger: composition.logger,
        syncErrorLog: composition.mailSyncErrorLog,
      }),
    );
    app.route(
      "/api/agent",
      buildAgentRoutes({
        runtime: composition.agent,
        conversations: composition.agentConversations,
        runs: composition.agentRuns,
        eventPersistence: composition.agentEventPersistence,
        runCoordinator: composition.agentRunCoordinator,
        pendingActions: composition.pendingActions,
        learning: composition.agentLearning,
        mcpOperations: composition.mcp?.operations,
        titleGenerator: composition.agentTitleGenerator,
        homeSuggestions: composition.agentHomeSuggestions,
        mailDatabase: composition.mailDatabase,
        actionExecutor: composition.mailActionExecutor,
        actionExecutions: composition.actionExecutions,
        curator: composition.curator.scheduler,
        getActiveAccountId: () =>
          composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/automation",
      buildAutomationRoutes({
        rules: composition.automationRules,
        mail: composition.mailRepository,
        suggester: composition.ruleSuggester,
        dryRunner: composition.ruleDryRunner,
        executionService: composition.automationExecutionService,
        ruleService: composition.automationRuleService,
        providers: composition.automationProviders,
        pipelineRuleService: composition.pipelineAutomationRuleService,
        unified: composition.featureFlags?.unifiedAutomationCenter !== false
          ? composition.unifiedAutomationQuery
          : undefined,
        runObservability: composition.automationRunObservability,
        canonicalDrafts:
          composition.featureFlags?.structuredAutomationEditing !== false
          ? composition.canonicalAutomationDrafts
          : undefined,
        automationAuthoring: composition.automationAuthoring,
        templates: composition.featureFlags?.automationTemplateCatalog !== false
          ? composition.automationTemplates
          : undefined,
        featureFlags: {
          crossAccountAutomation:
            composition.featureFlags?.crossAccountAutomation !== false,
          subscriptionInsight:
            composition.featureFlags?.subscriptionInsight !== false,
        },
        messageHasTag: (emailId, tagName) => composition.intelligenceResults.messageHasTag(emailId, tagName),
      }),
    );
    app.route(
      "/api/configuration-tasks",
      buildConfigurationRoutes({
        workflow: composition.configurationWorkflow,
        getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/skill-center",
      buildSkillCenterRoutes({
        center: composition.skillCenter,
        imports: composition.skillImports,
        packages: composition.skillPackages,
        drafts: composition.skillDrafts,
        automationAuthoring: composition.automationAuthoring,
      }),
    );
    app.route(
      "/api/artifacts/pipeline-preview",
      buildPipelinePreviewRoutes({
        previews: composition.pipelinePreviews,
        drafts: composition.pipelineDrafts,
        getActiveAccountId: () =>
          composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/workspace",
      buildWorkspaceRoutes({
        workspace: composition.workspace,
        getActiveAccountId: () =>
          composition.accountService.getCurrentAccount()?.id ?? null,
      }),
    );
    app.route(
      "/api/action-center",
      buildActionCenterRoutes({
        pendingActions: composition.pendingActions,
        todos: composition.todos,
        workspace: composition.workspace,
        smartTagActions: composition.smartTagActions,
        smartTagPromptRevisions: composition.smartTagPromptRevisions,
        smartTagLearningRuns: composition.smartTagLearningRuns,
        getActiveAccountId: () =>
          composition.accountService.getCurrentAccount()?.id ?? null,
      }),
    );
    app.route(
      "/api/digests",
      buildDigestRoutes({
        service: composition.mailDigestService,
      }),
    );
    app.route(
      "/api/digests",
      buildSummaryRoutes({
        results: composition.intelligenceResults,
        mailDatabase: composition.mailDatabase,
        getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/compose",
      buildComposeRoutes({
        service: composition.intelligenceService,
        getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/todos",
      buildTodoRoutes({
        todos: composition.todos,
        service: composition.intelligenceService,
        getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
        messageBelongsToAccount: (messageId, accountId) =>
          composition.mailRepository.getMessageById(messageId, accountId) !== null,
      }),
    );
    app.route(
      "/api/smart-tags",
      buildSmartTagRoutes({
        tags: composition.userTags,
        relations: composition.emailSmartTags,
        actions: composition.smartTagActions,
        backfills: composition.smartTagBackfills,
        learningRuns: composition.smartTagLearningRuns,
        revisions: composition.smartTagPromptRevisions,
        results: composition.intelligenceResults,
        mail: composition.mailRepository,
        promptCompiler: composition.smartTagPromptCompiler,
        promotions: composition.smartTagPromotions,
        topics: composition.topicCandidates,
        getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/directory",
      buildDirectoryRoutes({
        service: composition.directoryService,
        getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
      }),
    );
    app.route(
      "/api/mail",
      buildMailAttachmentRoutes({
        repository: composition.mailRepository,
        cache: composition.mailAttachmentCache,
        gateway: options.mailAttachmentGateway,
        getCurrentAccountId: () => composition.accountService.getCurrentAccount()?.id,
        logger: composition.logger,
      }),
    );
    // P2.6: the invoice-status refresh route is an edition module. The
    // open edition has neither the factory nor the store, so the endpoint
    // does not exist (the renderer entry hides behind the feature flag).
    if (wecliModules && composition.allowanceInvoiceRoutes && composition.invoiceStatuses) {
      app.route(
        "/api/mail",
        composition.allowanceInvoiceRoutes({
          app: new Hono(),
          mail: composition.mailRepository,
          statuses: composition.invoiceStatuses,
          wecli: composition.wecli,
          getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id,
        }),
      );
    }
    app.route(
      "/api/mail",
      buildSearchRoutes({
        searchService: composition.semanticSearchService,
        qaService: composition.mailQaService,
      }),
    );
    app.route(
      "/api/agent",
      buildSearchRoutes({
        searchService: composition.semanticSearchService,
        qaService: composition.mailQaService,
      }),
    );
    // P2.5: `/api/skills/wecli/catalog` (and the rest of the WeCLI HTTP
    // surface) comes from the edition module bundle. Without it the open
    // build serves 404 for every `/api/skills/*` path.
    if (wecliModules) {
      app.route(
        "/api/skills",
        wecliModules.buildSkillRoutes({
          app: new Hono(),
          runtime: composition.wecli,
          audit: composition.auditLog,
        }),
      );
    }
    app.route(
      "/api/settings",
      createSettingsApp({
        db: composition.db,
        mailDatabase: composition.mailDatabase,
        secrets: composition.secrets,
        llmProbe: options.llmProbe,
        getLlmRuntimeSettings: () => composition.getLlmSnapshot().settings,
        onLlmSettingsSaved: async (settings) => {
          await composition.reloadLlmSettings(settings);
        },
        onAiWorkerConcurrencyChanged: (concurrency) => {
          composition.notifyAiWorkerConcurrencyChanged(concurrency);
        },
      }),
    );
    if (composition.channels) {
      app.route(
        "/api/channels",
        buildChannelRoutes({
          connections: composition.channels.connections,
          configurations: composition.channels.configurations,
          onboarding: composition.channels.onboarding,
          management: composition.channels.management,
          pairing: composition.channels.pairing,
          bindings: composition.channels.bindings,
          destinations: composition.channels.destinations,
          status: composition.channels.status,
          automationRules: composition.automationRules,
          getActiveAccountId: () =>
            composition.accountService.getCurrentAccount()?.id,
        }),
      );
    }
    app.route(
      "/api/application-messages",
      buildApplicationMessageRoutes({ messages: composition.applicationMessages, artifacts: composition.messageArtifacts, smartTagSuggestions: composition.smartTagSuggestions, getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id }),
    );
    app.route(
      "/api/insight-reports",
      buildInsightReportRoutes({ reports: composition.insightReports, getActiveAccountId: () => composition.accountService.getCurrentAccount()?.id }),
    );
    if (options.mcpController)
      app.route("/api/mcp", buildMcpRoutes(options.mcpController, options.onMcpSettingsChanged));
    return app;
  }

  // Non-composed API instances expose only stateless route modules. Mail and
  // account access never construct an inline database fallback.
  app.route("/api/agent", agentRoutes);
  app.route("/api/agent", searchRoutes);
  app.route("/api", staticRoutes);
  return app;
}

function getServerPort(server: ServerType, fallbackPort: number) {
  const address = server.address();
  if (typeof address === "object" && address?.port) return address.port;
  return fallbackPort;
}

export async function startLocalApiServer(options: {
  port: number;
  composition?: AppComposition;
  imapVerifier?: CreateLocalApiAppOptions["imapVerifier"];
  mcpController?: McpListenerController;
  mailAttachmentGateway?: MailAttachmentGateway;
  quitApp?: () => void;
  onDebugModeChanged?: (diagnostics: AppLoggingDiagnostics) => void;
  onMcpSettingsChanged?: CreateLocalApiAppOptions["onMcpSettingsChanged"];
}): Promise<LocalApiServer> {
  let rendererOrigin: string | undefined;
  let listenerAuthority: string | undefined;
  const app = createLocalApiApp({
    rendererOrigin: () => rendererOrigin,
    listenerAuthority: () => listenerAuthority,
    composition: options.composition,
    imapVerifier: options.imapVerifier,
    mcpController: options.mcpController,
    mailAttachmentGateway: options.mailAttachmentGateway,
    quitApp: options.quitApp,
    onDebugModeChanged: options.onDebugModeChanged,
    onMcpSettingsChanged: options.onMcpSettingsChanged,
  });
  // Bind explicitly to loopback: without a hostname, Node listens on the
  // unspecified address (:: / 0.0.0.0), exposing the local mail API on every
  // interface. The renderer and desktop bridge only ever use 127.0.0.1.
  const server = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" });
  // serve() kicks off listen asynchronously; wait for the bound socket so
  // port 0 resolves to the real port and the bound address is observable.
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
  }
  const listenerAddress = server.address();
  const port = getServerPort(server, options.port);
  listenerAuthority = `127.0.0.1:${port}`;
  const address =
    typeof listenerAddress === "object" && listenerAddress
      ? listenerAddress.address
      : undefined;

  return {
    port,
    address,
    setRendererOrigin: (origin) => {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Renderer origin must use HTTP or HTTPS");
      }
      rendererOrigin = parsed.origin;
    },
    close: () => closeNodeHttpServer(server),
  };
}
