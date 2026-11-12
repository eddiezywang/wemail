/**
 * Local pre-screener for incoming mail. Runs synchronously before any LLM
 * call to determine whether reply-related intelligence capabilities should
 * be suppressed for obvious non-reply mail (noreply senders, notification
 * domains, bulk mailing lists).
 *
 * Zero cost, no LLM, no external dependencies.
 */

export interface PrescreenResult {
  /** Whether reply-related capabilities should be skipped */
  skipReply: boolean;
  /** Machine-readable reason code */
  skipReason?: "noreply-sender" | "notification-domain" | "bulk-mailing-list";
  /** Which rule matched */
  matchedRule?: string;
}

export interface PrescreenerConfig {
  /** Regex pattern for noreply-style sender local parts */
  noreplyPattern?: RegExp;
  /** Set of known notification/auto-send domains */
  notificationDomains?: string[];
}

const DEFAULT_NOREPLY_PATTERN = /^(noreply|no-reply|notification|donotreply|donot-reply|mailer-daemon|postmaster)@/i;

const DEFAULT_NOTIFICATION_DOMAINS = [
  "github.com",
  "stripe.com",
  "aws.amazon.com",
  "notifications.google.com",
  "mailer.linkedin.com",
];

export class LocalPrescreener {
  private readonly noreplyPattern: RegExp;
  private readonly notificationDomains: Set<string>;

  constructor(config?: PrescreenerConfig) {
    this.noreplyPattern = config?.noreplyPattern ?? DEFAULT_NOREPLY_PATTERN;
    this.notificationDomains = new Set(
      config?.notificationDomains ?? DEFAULT_NOTIFICATION_DOMAINS,
    );
  }

  /**
   * Check whether a mail message should skip reply-related intelligence.
   * Synchronous, fast, no side effects.
   */
  check(mail: {
    from: { email: string };
    headers?: Record<string, string>;
  }): PrescreenResult {
    // Rule 1: noreply sender pattern
    if (this.noreplyPattern.test(mail.from.email)) {
      return {
        skipReply: true,
        skipReason: "noreply-sender",
        matchedRule: "sender-pattern",
      };
    }

    // Rule 2: known notification domain
    const domain = mail.from.email.split("@")[1]?.toLowerCase();
    if (domain && this.notificationDomains.has(domain)) {
      return {
        skipReply: true,
        skipReason: "notification-domain",
        matchedRule: "domain-list",
      };
    }

    // Rule 3: bulk/list headers
    if (mail.headers?.["precedence"]?.toLowerCase() === "bulk") {
      return {
        skipReply: true,
        skipReason: "bulk-mailing-list",
        matchedRule: "header-precedence",
      };
    }
    if (mail.headers?.["list-id"]) {
      return {
        skipReply: true,
        skipReason: "bulk-mailing-list",
        matchedRule: "header-list-id",
      };
    }

    return { skipReply: false };
  }
}
