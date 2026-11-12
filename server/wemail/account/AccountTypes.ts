import type { AccountConfig } from "../../../shared/wemail/account.js";

export type { AccountConfig } from "../../../shared/wemail/account.js";
export type { AccountCredentialsRef } from "../../../shared/wemail/account.js";

/**
 * Server-only row shape for the `accounts` SQLite table. Kept separate
 * from the shared {@link AccountConfig} DTO so storage columns and JSON
 * serialisation concerns do not leak into shared types.
 */
export interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  imap_json: string;
  smtp_json: string;
  created_at: string;
  updated_at: string;
}

export interface SaveAccountInput {
  config: AccountConfig;
  secrets: {
    imapPassword: string;
    smtpPassword?: string;
  };
}

/** Namespace helper so every caller uses the same secret-key shape. */
export function imapPasswordKey(accountId: string): string {
  return `wemail:account:${accountId}:imap-password`;
}

export function smtpPasswordKey(accountId: string): string {
  return `wemail:account:${accountId}:smtp-password`;
}
