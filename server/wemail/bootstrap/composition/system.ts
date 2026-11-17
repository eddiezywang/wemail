import type { MailDatabaseClient } from "../../database/MailDatabaseClient.js";
/**
 * System-domain composition: durable infrastructure that has no concept
 * of an account login (db, secrets, logger, retention, audit) plus the
 * read-only services that only need shared infrastructure (semantic
 * search/QA, personalization). Lifecycle: created at boot, torn down at
 * `stop()`. The DB / SecretStore / AppLogger constructors throw, so this
 * module is the source of `BootError(phase=…)`.
 */

import path from "node:path";
import type { LlmRuntime } from "../../ai/LlmRuntime.js";
import type { MailDatabase } from "../../database/Database.js";
import { openOrCreateMailDatabase } from "../../database/Database.js";
import type { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import { LearningSummaryService } from "../../personalization/LearningSummaryService.js";
import { PromptBuilder } from "../../personalization/PromptBuilder.js";
import { UsageStatsService } from "../../personalization/UsageStatsService.js";
import { MailQaService } from "../../search/MailQaService.js";
import { SemanticIndexRepository } from "../../search/SemanticIndexRepository.js";
import { SemanticSearchService } from "../../search/SemanticSearchService.js";
import { DataRetentionService } from "../../security/DataRetentionService.js";
import type { SecretStore } from "../../security/SecretStore.js";
import {
  type AppLogger,
  createAppLogger,
} from "../../telemetry/AppLogger.js";
import { AuditLogRepository } from "../../telemetry/AuditLogRepository.js";
import { AuditLogService } from "../../telemetry/AuditLogService.js";
import { BootError } from "../BootError.js";

export interface InfrastructureComposition {
  db: MailDatabase;
  secrets: SecretStore;
  logger: AppLogger;
}

/**
 * Open the three pieces every other module depends on. Each phase has
 * its own try/catch so a failure in (e.g.) the logger doesn't leak the
 * already-opened DB handle.
 */
export function composeInfrastructure(opts: {
  dataDir: string;
  logsDir: string;
  database?: MailDatabase;
  secretStore?: SecretStore;
}): InfrastructureComposition {
  const { dataDir, logsDir } = opts;

  let db: MailDatabase;
  try {
    db = opts.database ?? openOrCreateMailDatabase(path.join(dataDir, "wemail.sqlite"));
  } catch (err) {
    throw new BootError({ phase: "db", cause: err });
  }

  let secrets: SecretStore;
  try {
    if (!opts.secretStore) {
      throw new Error(
        "mailbox-credential-broker-required: Electron safeStorage is the only supported credential authority",
      );
    }
    secrets = opts.secretStore;
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort
    }
    throw new BootError({ phase: "secrets", cause: err });
  }

  let logger: AppLogger;
  try {
    logger = createAppLogger({
      baseDir: logsDir,
      debugEnabled: process.env.WEMAIL_DEBUG_MODE === "1",
    });
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort
    }
    throw new BootError({ phase: "logger", cause: err });
  }

  return { db, secrets, logger };
}

export interface SystemComposition {
  auditLog: AuditLogRepository;
  auditLogService: AuditLogService;
  retention: DataRetentionService;
  semanticSearchService: SemanticSearchService;
  mailQaService: MailQaService;
  learningSummary: LearningSummaryService;
  promptBuilder: PromptBuilder;
  usageStats: UsageStatsService;
}

/**
 * Build the long-lived services that only need infra + (optionally) an
 * LLM client. The retention scheduler is started here; the caller is
 * responsible for invoking `retention.stop()` during teardown.
 */
export function composeSystem(opts: {
  db: MailDatabase;
  logger: AppLogger;
  logsDir: string;
  mailRepository: CanonicalMailRepository;
  llmRuntime: LlmRuntime;
  mailDatabase: MailDatabaseClient;
}): SystemComposition {
  const { db, logger, logsDir, mailRepository, llmRuntime } = opts;

  const auditLog = new AuditLogRepository(db);
  const auditLogService = new AuditLogService(db);

  const retention = new DataRetentionService({
    db,
    logsBaseDir: logsDir,
    databaseRetention: opts.mailDatabase.runRetentionBatch?.bind(opts.mailDatabase),
    logger,
  });

  const semanticIndexRepo = new SemanticIndexRepository({ db });
  const semanticSearchService = new SemanticSearchService({
    indexRepo: semanticIndexRepo,
    mailRepo: mailRepository,
    llmRuntime,
  });
  const mailQaService = new MailQaService({
    searchService: semanticSearchService,
    llmRuntime,
  });

  const learningSummary = new LearningSummaryService({ db });
  const promptBuilder = new PromptBuilder({
    logger: (event, meta) => logger.debug(`personalization.${event}`, meta),
  });
  const usageStats = new UsageStatsService({ db });

  return {
    auditLog,
    auditLogService,
    retention,
    semanticSearchService,
    mailQaService,
    learningSummary,
    promptBuilder,
    usageStats,
  };
}
