import type { MailMessage } from "../../../shared/wemail/mail.js";

export type MailCoreSyncOrigin =
  | "bootstrap"
  | "historical"
  | "live-idle"
  | "live-poll"
  | "manual";

export interface MailCoreMetadataBatch {
  accountId: string;
  origin: MailCoreSyncOrigin;
  messages: MailMessage[];
  replaceCursors?: boolean;
  completedAt?: string;
}

export interface MailCoreMetadataPersistResult {
  inserted: MailMessage[];
  updatedCount: number;
  bodiesQueued?: boolean;
  commitVersion?: number;
}
