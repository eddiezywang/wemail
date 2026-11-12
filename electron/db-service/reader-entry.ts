import { MAIL_DATABASE_SCHEMA_VERSION } from "../../server/wemail/database/Schema.generated.js";
import { BusinessPreferenceService } from "../../server/wemail/settings/BusinessPreferenceService.js";
import { DirectoryRepository } from "../../server/wemail/directory/DirectoryRepository.js";
import { DirectoryReadParamsSchema, type DirectoryReadParams } from "../../shared/wemail/directoryDatabase.js";
import { parentPort, threadId, workerData } from "node:worker_threads";
import type {
  MailDatabaseSearchParams,
  MailDatabaseWorkerData,
  MailDatabaseWorkerEvent,
  MailDatabaseWorkerRequest,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import type { MailCoreListParams } from "../../shared/wemail/mailCoreProtocol.js";
import { openMailDatabase, validateMailDatabase } from "../../server/wemail/database/Database.js";
import { MailDatabaseQueryRepository } from "../../server/wemail/database/MailDatabaseQueryRepository.js";
import { defaultSceneActionContributors } from "../../server/wemail/intelligence/MailSceneActionResolver.js";
import { AgentPendingActionRepository } from "../../server/wemail/agent/AgentPendingActionRepository.js";
import { ActionExecutionRepository } from "../../server/wemail/agent/ActionExecutionRepository.js";
import { ActionExecutionCommandSchema, type ActionExecutionCommand } from "../../shared/wemail/actionExecution.js";
import { MailDatabaseAccountQuerySchema, MailDatabasePendingActionsParamsSchema, type MailDatabasePendingActionsParams } from "../../shared/wemail/mailDatabaseProtocol.js";
import { UserTagRepository } from "../../server/wemail/intelligence/UserTagRepository.js";
import { AiProfileSettingsService } from "../../server/wemail/settings/AiProfileSettingsService.js";

if (!parentPort) throw new Error("DB Service reader must run in a worker thread");
const workerPort = parentPort;
const data = workerData as MailDatabaseWorkerData;
const queries = createQueries();
const heartbeat = setInterval(() => {
  workerPort.postMessage({
    type: "heartbeat",
    label: data.label,
    threadId,
    at: Date.now(),
  } satisfies MailDatabaseWorkerEvent);
}, 5_000);
heartbeat.unref();

workerPort.on("message", (request: MailDatabaseWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: true,
      queueMs: 0,
      handlerMs: 0,
    } satisfies MailDatabaseWorkerEvent);
    shutdown();
    return;
  }
  if (request.type === "health") {
    workerPort.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        schemaVersion: queries.schemaVersion(),
        commitVersion: queries.commitVersion(),
      },
      queueMs: 0,
      handlerMs: 0,
    } satisfies MailDatabaseWorkerEvent);
    return;
  }
  const startedAt = Date.now();
  try {
    const result = handleQuery(request.request.method, request.request.params);
    workerPort.postMessage({
      type: "response",
      requestId: request.request.requestId,
      ok: true,
      result,
      queueMs: Math.max(0, startedAt - request.queuedAt),
      handlerMs: Math.max(0, Date.now() - startedAt),
    } satisfies MailDatabaseWorkerEvent);
  } catch (error) {
    workerPort.postMessage({
      type: "response",
      requestId: request.request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies MailDatabaseWorkerEvent);
  }
});

workerPort.postMessage({
  type: "ready",
  label: data.label,
  threadId,
} satisfies MailDatabaseWorkerEvent);

function handleQuery(method: string, params: unknown): unknown {
  switch (method) {
    case "directory.read":
      return queries.readDirectory(DirectoryReadParamsSchema.parse(params));
    case "database.checkIntegrity":
      if (data.label !== "maintenance") throw new Error("integrity-check-requires-maintenance-lane");
      return queries.checkIntegrity();
    case "settings.getBusinessPreferences":
      return queries.getBusinessPreferences();
    case "intelligence.getTodoPrompt":
      return queries.getTodoPrompt();
    case "intelligence.listUserTags":
      return queries.listUserTags(MailDatabaseAccountQuerySchema.parse(params).accountId);
    case "agent.listPendingActions":
      return queries.listPendingActions(MailDatabasePendingActionsParamsSchema.parse(params));
    case "agent.getActionExecution": {
      const command = ActionExecutionCommandSchema.parse(params);
      if (command.op !== "get" && command.op !== "preflight") throw new Error("read-only-action-query-required");
      return queries.getActionExecution(command);
    }
    case "mail.getSnapshot": {
      const id = (params as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("invalid-message-id");
      return queries.getSnapshot(id);
    }
    case "mail.getIntelligence": {
      const id = (params as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("invalid-message-id");
      return queries.getIntelligenceState(id);
    }
    case "mail.getSyncCursor": {
      const input = params as { accountId?: unknown; folder?: unknown };
      if (typeof input?.accountId !== "string" || !input.accountId) {
        throw new Error("invalid-account-id");
      }
      return queries.getSyncCursor(
        input.accountId,
        typeof input.folder === "string" && input.folder ? input.folder : "INBOX",
      );
    }
    case "mail.getSyncStates":
      return queries.getSyncStates(MailDatabaseAccountQuerySchema.parse(params).accountId);
    case "mail.listAccounts":
      return queries.listAccounts();
    case "mail.getDraft": {
      const input = params as { accountId?: unknown; id?: unknown };
      if (typeof input?.accountId !== "string" || !input.accountId || typeof input.id !== "string" || !input.id) {
        throw new Error("invalid-draft-query");
      }
      return queries.getDraft(input.accountId, input.id);
    }
    case "mail.listDrafts": {
      const input = params as { accountId?: unknown; limit?: unknown };
      if (typeof input?.accountId !== "string" || !input.accountId) throw new Error("invalid-account-id");
      return queries.listDrafts(
        input.accountId,
        typeof input.limit === "number" ? input.limit : undefined,
      );
    }
    case "mail.listSnoozed": {
      const input = params as { accountId?: unknown };
      if (typeof input?.accountId !== "string" || !input.accountId) throw new Error("invalid-account-id");
      return queries.listSnoozed(input.accountId);
    }
    case "mail.list":
      return queries.list(params as MailCoreListParams);
    case "mail.listFolders": {
      const accountId = (params as { accountId?: unknown })?.accountId;
      if (typeof accountId !== "string" || !accountId) throw new Error("invalid-account-id");
      return queries.listFolders(accountId);
    }
    case "mail.listCategories": {
      const accountId = (params as { accountId?: unknown })?.accountId;
      if (typeof accountId !== "string" || !accountId) throw new Error("invalid-account-id");
      return queries.listCategories(accountId);
    }
    case "mail.search":
      return queries.search(params as MailDatabaseSearchParams);
    case "mail.listScheduled": {
      const accountId = (params as { accountId?: unknown })?.accountId;
      if (typeof accountId !== "string" || !accountId) throw new Error("invalid-account-id");
      return queries.listScheduled(accountId);
    }
    case "mail.listScheduledPage": {
      const input = params as { accountId?: unknown; page?: unknown; limit?: unknown };
      if (typeof input.accountId !== "string" || !input.accountId) throw new Error("invalid-account-id");
      return queries.listScheduledPage(
        input.accountId,
        typeof input.page === "number" ? input.page : 1,
        typeof input.limit === "number" ? input.limit : 50,
      );
    }
    case "database.changesSince": {
      const input = params as { afterVersion?: unknown; limit?: unknown };
      if (typeof input?.afterVersion !== "number" || input.afterVersion < 0) {
        throw new Error("invalid-change-cursor");
      }
      return queries.changesSince(
        input.afterVersion,
        typeof input.limit === "number" ? input.limit : undefined,
      );
    }
    default:
      throw new Error(`unsupported-reader-method:${method}`);
  }
}

function shutdown(): void {
  clearInterval(heartbeat);
  queries.close();
  workerPort.close();
}

interface ReaderQueries {
  getActionExecution(command: Extract<ActionExecutionCommand, { op: "get" | "preflight" }>): unknown;
  readDirectory(params: DirectoryReadParams): unknown;
  checkIntegrity(): unknown;
  getBusinessPreferences(): unknown;
  getTodoPrompt(): string | undefined;
  listUserTags(accountId: string): unknown;
  listPendingActions(params: MailDatabasePendingActionsParams): unknown;
  listAccounts(): unknown;
  getDraft(accountId: string, id: string): unknown;
  listDrafts(accountId: string, limit?: number): unknown;
  listSnoozed(accountId: string): unknown;
  getSnapshot(id: string): unknown;
  getIntelligenceState(id: string): unknown;
  getSyncCursor(accountId: string, folder?: string): unknown;
  getSyncStates(accountId: string): unknown;
  list(params: MailCoreListParams): unknown;
  listFolders(accountId: string): unknown;
  listCategories(accountId: string): unknown;
  search(params: MailDatabaseSearchParams): unknown;
  listScheduled(accountId: string): unknown;
  listScheduledPage(accountId: string, page?: number, limit?: number): unknown;
  changesSince(afterVersion: number, limit?: number): unknown;
  schemaVersion(): number;
  commitVersion(): number;
  close(): void;
}

function createQueries(): ReaderQueries {
  const db = openMailDatabase(data.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  // The reader lane is a separate worker: composeApp's per-call override
  // never crosses this boundary. Bind the build-time edition registration
  // explicitly so edition scene actions are visible here.
  const repository = new MailDatabaseQueryRepository(db, {
    sceneActionContributors: defaultSceneActionContributors(),
  });
  const pendingActions = new AgentPendingActionRepository({ db });
  const actionExecutions = new ActionExecutionRepository(db);
  const userTags = new UserTagRepository(db);
  const aiProfile = new AiProfileSettingsService(db);
  const preferences = new BusinessPreferenceService(db);
  const directory = new DirectoryRepository(db);
  return {
    getActionExecution: (command) => actionExecutions.dispatch(command),
    readDirectory: (params) => directory.read(params),
    checkIntegrity: () => {
      const result = validateMailDatabase(db);
      return { schemaVersion: result.schemaVersion, valid: result.schemaVersion === MAIL_DATABASE_SCHEMA_VERSION &&
        result.quickCheck.length === 1 && result.quickCheck[0] === "ok" && result.foreignKeyErrors.length === 0 };
    },
    getBusinessPreferences: () => ({ stored: preferences.isStored(), preferences: preferences.get() }),
    getTodoPrompt: () => aiProfile.getProfile()?.todoPrompt,
    listUserTags: (accountId) => userTags.listByAccount(accountId),
    listPendingActions: ({ accountId, conversationId }) => pendingActions.listForAccount(accountId, conversationId),
    listAccounts: () => repository.listAccounts(),
    getDraft: (accountId, id) => repository.getDraft(accountId, id),
    listDrafts: (accountId, limit) => repository.listDrafts(accountId, limit),
    listSnoozed: (accountId) => repository.listSnoozed(accountId),
    getSnapshot: (id) => repository.getSnapshot(id),
    getIntelligenceState: (id) => repository.getIntelligenceState(id),
    getSyncCursor: (accountId, folder) => repository.getSyncCursor(accountId, folder),
    getSyncStates: (accountId) => repository.getSyncStates(accountId),
    list: (params) => repository.list(params),
    listFolders: (accountId) => repository.listFolders(accountId),
    listCategories: (accountId) => repository.listCategories(accountId),
    search: (params) => repository.search(params),
    listScheduled: (accountId) => repository.listScheduled(accountId),
    listScheduledPage: (accountId, page, limit) => repository.listScheduledPage(accountId, page, limit),
    changesSince: (afterVersion, limit) => repository.changesSince(afterVersion, limit),
    schemaVersion: () => repository.schemaVersion(),
    commitVersion: () => repository.commitVersion(),
    close: () => db.close(),
  };
}
