export interface WemailAccountConfig {
  id: string;
  email: string;
  displayName?: string;
  imap: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
  };
}

/**
 * Cross-package canonical account config (Wave 0).
 *
 * Locked shape consumed by Packages A, B, C, D, J. The legacy
 * {@link WemailAccountConfig} is retained for the existing skeleton code;
 * new code SHOULD prefer `AccountConfig`.
 *
 * NO password/secret material is stored here — credentials are referenced
 * via {@link AccountCredentialsRef} and resolved through SecretStore
 * (Package A).
 */
export interface AccountConfig {
  id: string;
  /** Omitted (undefined) when not set — callers MUST handle missing value. */
  displayName?: string;
  emailAddress: string;
  imap: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Typed handle to a secret owned by SecretStore. Callers never see the
 * plaintext password — they resolve this ref through SecretStore at
 * call-time. `key` is the namespaced identifier (e.g.
 * `wemail:account:<id>:imap-password`); `kind` discriminates the
 * credential category so future OAuth tokens/API keys can be added
 * without a breaking change.
 */
export interface AccountCredentialsRef {
  key: string;
  kind: "imap-password" | "smtp-password" | "oauth-refresh-token" | "api-key";
  accountId: string;
}
