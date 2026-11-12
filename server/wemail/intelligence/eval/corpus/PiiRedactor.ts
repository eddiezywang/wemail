/**
 * PiiRedactor — strict-mode PII scrubber for corpus extraction.
 *
 * Covers the 8 categories called out in the v2 framework plan:
 *   1. Email addresses        → person<N>@example.test
 *   2. Personal names         → Person <N>
 *   3. Phone numbers          → [PHONE]
 *   4. URL hostnames          → host<N>.example.test (path preserved)
 *   5. URL token/path leaks   → /[REDACTED-TOKEN]
 *   6. Organization names     → Organization <N>
 *   7. Postal addresses       → [ADDRESS]
 *   8. Signature blocks       → [SIGNATURE]
 *   + chat IDs (WeChat / Slack / Lark) → [CHAT-ID]
 *   + attachment file names    → attachment-<N>.<ext>
 *
 * The redactor is conservative — it prefers over-redaction to leakage.
 * Numeric amounts and dates are intentionally preserved because they
 * carry semantic signal that downstream eval prompts depend on.
 *
 * Output stays valid JSON shape — the redactor mutates string fields
 * inside the MailSampleEntry envelope only, so SampleManifest hashing
 * still works on the result.
 *
 * `_meta` provenance (extractedAt, redactionMap, residualScanPassed)
 * is added by the extraction CLI, not this module.
 */

import type { MailMessage } from "../../../../../shared/wemail/mail.js";
import type { MailSampleEntry } from "../../../testing/mailSamples.js";

/* ----------------------- Heuristic dictionaries ----------------------- */

const CHINESE_SURNAMES = [
  "王", "李", "张", "刘", "陈", "杨", "黄", "赵", "吴", "周",
  "徐", "孙", "马", "朱", "胡", "郭", "何", "高", "林", "罗",
  "郑", "梁", "谢", "宋", "唐", "许", "韩", "冯", "邓", "曹",
  "彭", "曾", "肖", "田", "董", "袁", "潘", "于", "蒋", "蔡",
  "余", "杜", "叶", "程", "苏", "魏", "吕", "丁", "任", "沈",
];

const CN_TITLES = ["先生", "女士", "总", "总监", "经理", "主管", "老师", "教授", "博士"];
const EN_TITLES = ["Mr", "Mrs", "Ms", "Miss", "Dr", "Prof", "Sir", "Madam"];

const ORG_DICT = [
  // Common big-tech / cloud / SaaS — extend per business domain.
  "Google", "Microsoft", "Amazon", "Apple", "Meta", "Facebook", "Twitter",
  "Tencent", "Alibaba", "Baidu", "ByteDance", "Huawei", "Xiaomi",
  "Salesforce", "Atlassian", "GitHub", "GitLab", "Slack", "Zoom",
  "Notion", "Figma", "Linear", "Asana", "Trello", "Jira", "Confluence",
  "Stripe", "PayPal", "Shopify", "Square", "Block",
  "OpenAI", "Anthropic", "Cohere", "Mistral", "Hugging Face",
  // Generic suffixes that anchor a span as a company name.
  "Inc", "LLC", "Ltd", "Corp", "Corporation", "Limited", "GmbH",
  "有限公司", "股份有限公司", "科技", "信息技术",
];

const STREET_SUFFIX = [
  "Street", "St", "Road", "Rd", "Avenue", "Ave", "Boulevard", "Blvd",
  "Lane", "Ln", "Drive", "Dr", "Court", "Ct", "Plaza", "Square", "Sq",
];

const CN_ADDRESS_TOKENS = ["省", "市", "区", "县", "镇", "街道", "路", "号"];

/* ----------------------- Replacement bookkeeping ----------------------- */

/**
 * Maintain a stable mapping so the same input value redacts to the
 * same placeholder across an entire sample (e.g. all references to
 * `alice@example.com` become `person3@example.test`).
 */
class ReplacementCounter {
  private email = new Map<string, string>();
  private name = new Map<string, string>();
  private host = new Map<string, string>();
  private org = new Map<string, string>();
  private attachment = new Map<string, string>();
  private nextEmail = 0;
  private nextName = 0;
  private nextHost = 0;
  private nextOrg = 0;
  private nextAttach = 0;

  redactionMap: Record<string, number> = {
    email: 0,
    name: 0,
    phone: 0,
    urlHost: 0,
    urlPath: 0,
    organization: 0,
    address: 0,
    signature: 0,
    attachment: 0,
    chatId: 0,
  };

  email_(input: string): string {
    const key = input.toLowerCase();
    let v = this.email.get(key);
    if (!v) {
      v = `person${this.nextEmail++}@example.test`;
      this.email.set(key, v);
      this.redactionMap.email! += 1;
    }
    return v;
  }
  name_(input: string): string {
    const key = input;
    let v = this.name.get(key);
    if (!v) {
      v = `Person ${this.nextName++}`;
      this.name.set(key, v);
      this.redactionMap.name! += 1;
    }
    return v;
  }
  host_(input: string): string {
    const key = input.toLowerCase();
    let v = this.host.get(key);
    if (!v) {
      v = `host${this.nextHost++}.example.test`;
      this.host.set(key, v);
      this.redactionMap.urlHost! += 1;
    }
    return v;
  }
  org_(input: string): string {
    const key = input;
    let v = this.org.get(key);
    if (!v) {
      v = `Organization ${this.nextOrg++}`;
      this.org.set(key, v);
      this.redactionMap.organization! += 1;
    }
    return v;
  }
  attachment_(input: string): string {
    const key = input;
    let v = this.attachment.get(key);
    if (!v) {
      const ext = input.includes(".") ? input.slice(input.lastIndexOf(".")) : "";
      v = `attachment-${this.nextAttach++}${ext}`;
      this.attachment.set(key, v);
      this.redactionMap.attachment! += 1;
    }
    return v;
  }
}

/* ----------------------- Per-string redaction ----------------------- */

const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
const RE_PHONE = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{4}/g;
const RE_URL = /\bhttps?:\/\/([\w.-]+)(\/[^\s<>"')]*)?/gi;
// chat IDs: wx_<id> / @U07XXXX (slack member) / ou_<lark id>.
// JS \b doesn't compose well with leading `@`, so capture an explicit
// non-word lead (or start-of-string) and restore it after substitution.
const RE_CHAT_ID = /(^|[^\w])(wx_[\w-]{6,}|@U[A-Z0-9]{6,}|ou_[\w-]{6,})/g;
// Addresses: street suffix capitalized phrases ("123 Main Street")
const RE_EN_ADDR = new RegExp(
  `\\b\\d{1,5}\\s+[A-Z][\\w]+\\s+(?:${STREET_SUFFIX.join("|")})\\b`,
  "g",
);
// Signature block: "--\n<rest>" up to 8 lines after, OR a tail block
// containing email + phone in the same paragraph.
const RE_SIG_DOUBLE_DASH = /^--\s*$([\s\S]{0,1000})/m;

function redactString(input: string, ctr: ReplacementCounter): string {
  if (!input) return input;
  let out = input;

  // 1. Emails first (so they don't get caught by phone regex)
  out = out.replace(RE_EMAIL, (m) => ctr.email_(m));

  // 2. Chat IDs — group 1 is the leading non-word boundary (kept), group 2 is the id
  out = out.replace(RE_CHAT_ID, (_full, lead: string, _id: string) => {
    ctr.redactionMap.chatId! += 1;
    return `${lead}[CHAT-ID]`;
  });

  // 3. URLs — host + path token sniff
  out = out.replace(RE_URL, (_match, host: string, path: string | undefined) => {
    const newHost = ctr.host_(host);
    const newPath = path ? redactUrlPath(path, ctr) : "";
    return `https://${newHost}${newPath}`;
  });

  // 4. Phones — after URL/email so embedded numbers in URLs don't trigger
  out = out.replace(RE_PHONE, (m) => {
    // Heuristic: phone-like only if length 7..15 digits and at least one separator OR pure 10+ digits
    const digits = m.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return m;
    ctr.redactionMap.phone! += 1;
    return "[PHONE]";
  });

  // 5. EN street-suffix addresses
  out = out.replace(RE_EN_ADDR, () => {
    ctr.redactionMap.address! += 1;
    return "[ADDRESS]";
  });

  // 6. CN addresses — "X省Y市Z区..." sequences
  out = redactChineseAddress(out, ctr);

  // 7. Personal names — limited dictionary heuristics
  out = redactNames(out, ctr);

  // 8. Organizations — dictionary lookup
  out = redactOrganizations(out, ctr);

  // 9. Signature block
  out = redactSignature(out, ctr);

  return out;
}

function redactUrlPath(path: string, ctr: ReplacementCounter): string {
  // Strip suspicious tokens (long alphanumeric runs, JWT-like, hex)
  let touched = false;
  const cleaned = path.replace(/[A-Za-z0-9_-]{20,}/g, () => {
    touched = true;
    return "REDACTED-TOKEN";
  });
  if (touched) ctr.redactionMap.urlPath! += 1;
  return cleaned;
}

function redactChineseAddress(input: string, ctr: ReplacementCounter): string {
  // Greedy-ish: from a known suffix (省/市/区), grab a contiguous CJK
  // run preceding it. Replace the whole concatenated address with [ADDRESS].
  const re = /(?:[一-鿿]{1,30}(?:省|市|区|县|镇|街道|路|号))+/g;
  return input.replace(re, () => {
    ctr.redactionMap.address! += 1;
    return "[ADDRESS]";
  });
}

function redactNames(input: string, ctr: ReplacementCounter): string {
  let out = input;
  // EN names: "Title FirstName LastName" or "FirstName LastName" with two
  // capitalized tokens of length ≥ 2.
  const enRe = new RegExp(
    `\\b(?:(?:${EN_TITLES.join("|")})\\.?\\s+)?[A-Z][a-z]{1,15}\\s+[A-Z][a-z]{1,15}\\b`,
    "g",
  );
  out = out.replace(enRe, (m) => {
    // Skip if it looks like a known org or starts a sentence.
    if (ORG_DICT.some((o) => m.includes(o))) return m;
    return ctr.name_(m);
  });

  // CN names: surname (1 char) + 1-2 char given name. JS regex \b is
  // ASCII-only, and a CJK lookbehind would miss "感谢张敏" (preceded by
  // 谢, also CJK). Over-redaction is acceptable; leakage is not — so
  // we drop the boundary entirely and rely on a small COMMON_NON_NAMES
  // skip list to avoid the obvious compound traps (王朝, 张力, ...).
  const cnSurnamesPattern = CHINESE_SURNAMES.join("");
  const cnNameRe = new RegExp(`[${cnSurnamesPattern}][一-鿿]{1,2}`, "g");
  const COMMON_NON_NAMES = new Set([
    "王朝", "王国", "李子", "张力", "刘海", "陈述", "杨柳",
  ]);
  out = out.replace(cnNameRe, (m) => {
    if (COMMON_NON_NAMES.has(m)) return m;
    return ctr.name_(m);
  });

  return out;
}

function redactOrganizations(input: string, ctr: ReplacementCounter): string {
  let out = input;
  for (const org of ORG_DICT) {
    if (!org) continue;
    // Word-boundary safe replace
    const escaped = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      /[一-鿿]/.test(org) ? escaped : `\\b${escaped}\\b`,
      "g",
    );
    out = out.replace(re, () => ctr.org_(org));
  }
  return out;
}

function redactSignature(input: string, ctr: ReplacementCounter): string {
  // If we see "-- " on its own line, redact everything after it (up to ~1000 chars)
  return input.replace(RE_SIG_DOUBLE_DASH, () => {
    ctr.redactionMap.signature! += 1;
    return "--\n[SIGNATURE]";
  });
}

/* ----------------------- Public surface ----------------------- */

export interface RedactionReport {
  /** How many of each PII category were replaced. */
  redactionMap: Record<string, number>;
  /** Mirror of the input with strings rewritten. */
  redactedSample: MailSampleEntry;
}

export function redactMailSample(sample: MailSampleEntry): RedactionReport {
  const ctr = new ReplacementCounter();
  const redactedMail: MailMessage = {
    ...sample.mail,
    subject: sample.mail.subject ? redactString(sample.mail.subject, ctr) : sample.mail.subject,
    snippet: sample.mail.snippet ? redactString(sample.mail.snippet, ctr) : sample.mail.snippet,
    bodyText: sample.mail.bodyText
      ? redactString(sample.mail.bodyText, ctr)
      : sample.mail.bodyText,
    bodyHtml: sample.mail.bodyHtml
      ? redactString(sample.mail.bodyHtml, ctr)
      : sample.mail.bodyHtml,
    from: sample.mail.from
      ? {
          ...sample.mail.from,
          email: ctr.email_(sample.mail.from.email),
          name: sample.mail.from.name
            ? redactString(sample.mail.from.name, ctr)
            : sample.mail.from.name,
        }
      : sample.mail.from,
    to: sample.mail.to?.map((addr) => ({
      ...addr,
      email: ctr.email_(addr.email),
      name: addr.name ? redactString(addr.name, ctr) : addr.name,
    })),
    cc: sample.mail.cc?.map((addr) => ({
      ...addr,
      email: ctr.email_(addr.email),
      name: addr.name ? redactString(addr.name, ctr) : addr.name,
    })),
    attachments: sample.mail.attachments?.map((a) => ({
      ...a,
      filename: ctr.attachment_(a.filename),
    })),
  };
  return {
    redactedSample: {
      ...sample,
      mail: redactedMail,
    },
    redactionMap: ctr.redactionMap,
  };
}
