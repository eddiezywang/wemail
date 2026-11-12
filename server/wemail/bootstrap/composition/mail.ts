/**
 * Mail-domain composition: the singleton mail repository, the drafts /
 * sync error Markdown logs and canonical scheduled-send adapters.
 */

import type { MailDatabase } from "../../database/Database.js";
import type { MailDatabaseClient } from "../../database/MailDatabaseClient.js";
import { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import type { InvoiceStatusPort } from "../../agent/allowancePort.js";
import { ScheduledSendService } from "../../mail/ScheduledSendService.js";
import { SnoozeService } from "../../mail/SnoozeService.js";
import type { AppLogger } from "../../telemetry/AppLogger.js";
import { DraftFeedbackLog } from "../../telemetry/DraftFeedbackLog.js";
import { MailSyncErrorLog } from "../../telemetry/MailSyncErrorLog.js";

/**
 * The mail-domain singletons that the public AppComposition surface
 * exposes. Spread directly into the `composeApp()` return object.
 */
export interface MailPublicComposition {
  mailRepository: CanonicalMailRepository;
  /**
   * P2.6: edition-supplied `invoice_attachment_statuses` store. Undefined in
   * the open edition — the query repository read side and the executor
   * status recording then collapse to their empty/null fallbacks.
   */
  invoiceStatuses: InvoiceStatusPort | undefined;
  draftFeedbackLog: DraftFeedbackLog;
  mailSyncErrorLog: MailSyncErrorLog;
  snoozeService: SnoozeService;
  scheduledSendService: ScheduledSendService;
}

/**
 * Mail-domain services that remain local API adapters.
 */
export interface MailComposition {
  public: MailPublicComposition;
}

export function composeMail(opts: {
  db: MailDatabase;
  mailDatabase: MailDatabaseClient;
  logger: AppLogger;
  logsDir: string;
  /** Edition invoice store (P2.6); absent in the open edition. */
  invoiceStatuses?: InvoiceStatusPort;
}): MailComposition {
  const { db, logger, logsDir, mailDatabase, invoiceStatuses } = opts;

  const mailRepository = new CanonicalMailRepository({ db, mailDatabase });
  const draftFeedbackLog = new DraftFeedbackLog({ baseDir: logsDir });
  const mailSyncErrorLog = new MailSyncErrorLog({ baseDir: logsDir });

  const snoozeService = new SnoozeService({
    repository: mailRepository,
    logger: (msg, fields) => logger.debug(`snooze.${msg}`, fields ?? {}),
  });
  const scheduledSendService = new ScheduledSendService({
    mailDatabase,
  });

  return {
    public: {
      mailRepository,
      invoiceStatuses,
      draftFeedbackLog,
      mailSyncErrorLog,
      snoozeService,
      scheduledSendService,
    },
  };
}
