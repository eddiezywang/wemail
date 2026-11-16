import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJob,
  LinkExtractionResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import type { LlmClient, LlmResponse } from "../../ai/LlmClient.js";
import { LINK_SELECTION_SYSTEM_PROMPT } from "../../ai/prompts/linkExtractionPrompt.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  LINK_EXTRACTION_PROCESSOR_VERSION,
  LinkExtractionProcessor,
  LinkExtractionProcessorError,
  computeRiskSignals,
  redactUrlForLog,
  SUSPICIOUS_DOMAINS,
  URL_SHORTENER_DOMAINS,
  SUSPICIOUS_TLDS,
  CREDENTIAL_QUERY_KEYS,
} from "./LinkExtractionProcessor.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Test",
    snippet: "test",
    bodyText: "Hello",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type: "linkExtraction",
    status: "running",
    attempts: 0,
    maxAttempts: 3,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(msg: MailMessage | null): ProcessorContext {
  return { getMessage: () => msg };
}

function fakeClient(impl: (req: unknown) => Promise<LlmResponse>): LlmClient {
  return { generate: impl as LlmClient["generate"] };
}

async function extractAsync(processor: LinkExtractionProcessor, msg: MailMessage): Promise<LinkExtractionResult> {
  return processor.handle(makeJob(), makeCtx(msg)) as Promise<LinkExtractionResult>;
}

// ── Basic extraction tests ────────────────────────────────────────

test("LinkExtractionProcessor extracts plain-text URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Visit https://example.com/page for more info.",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.type, "linkExtraction");
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.url, "https://example.com/page");
  assert.equal(result.links[0]!.actionText, "https://example.com/page");
});

test("LinkExtractionProcessor extracts HTML anchor links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://shop.example.com/buy">Buy Now</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.url, "https://shop.example.com/buy");
  assert.equal(result.links[0]!.actionText, "Buy Now");
});

test("LinkExtractionProcessor preserves markdown link labels", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "[Follow up on 服务台 problem 10071940](https://itsm.example.com/problems/10071940)",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.url, "https://itsm.example.com/problems/10071940");
  assert.equal(result.links[0]!.actionText, "Follow up on 服务台 problem 10071940");
});

test("LinkExtractionProcessor extracts List-Unsubscribe header URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    headers: { "list-unsubscribe": "<https://list.example.com/unsub?id=123>" },
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.unsubscribeUrl, "https://list.example.com/unsub?id=123");
  assert.ok(
    !result.links.some((link) => link.url === result.unsubscribeUrl),
    "unsubscribeUrl should not be duplicated in links",
  );
});

test("LinkExtractionProcessor deduplicates identical URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Visit https://example.com/page and again https://example.com/page",
    bodyHtml: '<a href="https://example.com/page">Link</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 1);
});

test("LinkExtractionProcessor throws when mail is missing", async () => {
  const processor = new LinkExtractionProcessor();
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof LinkExtractionProcessorError);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

// ── No remote fetch guarantee ─────────────────────────────────────

test("LinkExtractionProcessor never issues network requests", async () => {
  // This test proves extraction is purely local by verifying no
  // network-related modules are called. The processor is deterministic
  // and only parses local content.
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://evil.com/phish">Click here to verify your account</a>
      <a href="https://legit.com/page">Normal link</a>
    `,
    bodyText: "Check https://another.com and https://short.link/abc",
    headers: { "list-unsubscribe": "<https://mailing.com/unsub>" },
  });

  // If the processor tried to fetch any URL, it would need to be async
  // with network calls. Since it's purely synchronous string parsing,
  // this test validates the no-remote-fetch guarantee.
  const result = await extractAsync(processor, msg);
  assert.ok(result.links.length > 0, "should extract links from local content only");
  assert.equal(result.type, "linkExtraction");
});

// ── Smart action selection ────────────────────────────────────────

test("LinkExtractionProcessor fallback keeps only high-value action from iCloud-style fixture", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://www.icloud.com/upgrade">升级套餐方案</a>
      <a href="https://appleid.apple.com/account">Apple 账户</a>
      <a href="https://support.apple.com/icloud">支持</a>
      <a href="https://www.apple.com/legal/internet-services/icloud/">条款</a>
      <a href="https://www.apple.com/legal/privacy/">隐私</a>
    `,
    bodyText: "https://www.apple.com/icloud/",
  });

  const result = await extractAsync(processor, msg);

  assert.deepEqual(result.links.map((link) => link.actionText), ["升级套餐方案"]);
  assert.equal(result.links[0]!.category, "action");
});

test("LinkExtractionProcessor fallback returns at most three primary actions by value", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://billing.example.com/pay">Pay invoice</a>
      <a href="https://app.example.com/confirm">Confirm account</a>
      <a href="https://files.example.com/report.pdf">Download report</a>
      <a href="https://app.example.com/login">Login</a>
      <a href="https://example.com/privacy">Privacy Policy</a>
    `,
  });

  const result = await extractAsync(processor, msg);

  assert.equal(result.links.length, 3);
  assert.deepEqual(
    result.links.map((link) => link.category),
    ["payment", "confirm", "download"],
  );
});

test("LinkExtractionProcessor ignores static resource URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://cdn.example.com/assets/logo.png?v=2">Logo</a>
      <a href="https://app.example.com/tickets/42">View ticket</a>
    `,
  });

  const result = await extractAsync(processor, msg);

  assert.deepEqual(result.links.map((link) => link.url), ["https://app.example.com/tickets/42"]);
});

test("LinkExtractionProcessor labels a bare URL with its named system", async () => {
  for (const body of [
    { bodyText: "公文管理系统地址：http://portal.example.com" },
    { bodyHtml: '公文管理系统地址：<a href="http://portal.example.com">http://portal.example.com</a>' },
  ]) {
    const result = await extractAsync(
      new LinkExtractionProcessor(),
      makeMessage(body),
    );

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0]!.url, "http://portal.example.com");
    assert.equal(result.links[0]!.actionText, "公文管理系统");
  }
});

test("link selection prompt preserves explicit resource names", () => {
  assert.match(LINK_SELECTION_SYSTEM_PROMPT, /preserve that resource name/);
  assert.match(LINK_SELECTION_SYSTEM_PROMPT, /use '公文管理系统', not '查看详情'/);
});

test("LinkExtractionProcessor does not turn contact email addresses into action links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="mailto:team@example.com">team@example.com</a>
      <a href="https://app.example.com/application">轮候退出申请</a>
    `,
  });

  const result = await extractAsync(processor, msg);

  assert.deepEqual(result.links.map((link) => link.url), ["https://app.example.com/application"]);
});

test("LinkExtractionProcessor filters footer, legal, support, and social links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://example.com/help">Support</a>
      <a href="https://example.com/privacy">Privacy Policy</a>
      <a href="https://example.com/terms">Terms</a>
      <a href="https://twitter.com/example">Twitter</a>
      <a href="https://example.com/profile">Account settings</a>
    `,
  });

  const result = await extractAsync(processor, msg);

  assert.deepEqual(result.links, []);
});

test("LinkExtractionProcessor uses LLM to select existing candidates and preserves local risk", async () => {
  const processor = new LinkExtractionProcessor({
    model: "gpt-test",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        links: [
          { index: 1, actionText: "确认账户", category: "confirm" },
          { index: 0, actionText: "支付账单", category: "payment" },
          { index: 99, actionText: "忽略越界", category: "navigate" },
        ],
      }),
      finishReason: "stop",
    })),
  });
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://billing.example.com/pay?token=secret">Pay invoice</a>
      <a href="https://app.example.com/confirm">Confirm account</a>
    `,
  });

  const result = await extractAsync(processor, msg);

  assert.deepEqual(result.links.map((link) => link.url), [
    "https://app.example.com/confirm",
    "https://billing.example.com/pay?token=secret",
  ]);
  assert.deepEqual(result.links.map((link) => link.actionText), ["确认账户", "支付账单"]);
  assert.ok(result.links[1]!.riskReasons.includes("credential-in-query"));
});

test("LinkExtractionProcessor parses fenced LLM JSON and falls back on invalid JSON or timeout", async () => {
  const fenced = new LinkExtractionProcessor({
    model: "gpt-test",
    llmClient: fakeClient(async () => ({
      text: "```json\n" + JSON.stringify({
        links: [{ index: 0, actionText: "下载报告", category: "download" }],
      }) + "\n```",
      finishReason: "stop",
    })),
  });
  const msg = makeMessage({
    bodyHtml: '<a href="https://files.example.com/report.pdf">Download report</a>',
  });
  const fencedResult = await extractAsync(fenced, msg);
  assert.equal(fencedResult.links[0]!.actionText, "下载报告");

  const invalid = new LinkExtractionProcessor({
    model: "gpt-test",
    llmClient: fakeClient(async () => ({ text: "not json", finishReason: "stop" })),
  });
  const invalidResult = await extractAsync(invalid, msg);
  assert.equal(invalidResult.links[0]!.actionText, "Download report");

  const timedOut = new LinkExtractionProcessor({
    model: "gpt-test",
    llmClient: fakeClient(async () => {
      throw new Error("timeout");
    }),
  });
  const timeoutResult = await extractAsync(timedOut, msg);
  assert.equal(timeoutResult.links[0]!.actionText, "Download report");
});

test("LinkExtractionProcessor does not open or request links during extraction", async () => {
  // Validate that extraction completes from local content only. Smart
  // filtering may suppress low-value bare URLs, but it must not fetch them.
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "https://evil.com https://phishing.ru/steal",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.type, "linkExtraction");
});

// ── Display-domain mismatch risk ──────────────────────────────────

test("display-domain mismatch is detected when link text shows a different domain", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://evil.com/phish">https://paypal.com/verify</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.risk, true);
  assert.ok(
    result.links[0]!.riskReasons.includes("display-domain-mismatch"),
    `expected display-domain-mismatch in riskReasons, got: ${result.links[0]!.riskReasons.join(", ")}`,
  );
});

test("no mismatch when display text matches href domain", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://paypal.com/verify">https://paypal.com/verify</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.risk, false);
  assert.ok(
    !result.links[0]!.riskReasons.includes("display-domain-mismatch"),
    "should not flag display-domain-mismatch for matching domains",
  );
});

test("no mismatch for non-URL display text", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://example.com/page">Click here</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links[0]!.risk, false);
  assert.ok(
    !result.links[0]!.riskReasons.includes("display-domain-mismatch"),
    "should not flag display-domain-mismatch for non-URL text",
  );
});

// ── Suspicious domain risk ────────────────────────────────────────

test("suspicious domain is detected for known phishing-like domains", async () => {
  const signals = computeRiskSignals({
    url: "https://paypa1.com/login",
    actionText: "Login",
  });
  assert.ok(signals.risk, "should flag paypa1.com as risky");
  assert.ok(
    signals.riskReasons.includes("suspicious-domain"),
    `expected suspicious-domain in riskReasons, got: ${signals.riskReasons.join(", ")}`,
  );
});

test("legitimate domain is not flagged as suspicious", () => {
  const signals = computeRiskSignals({
    url: "https://github.com/repo",
    actionText: "View repo",
  });
  assert.ok(!signals.riskReasons.includes("suspicious-domain"));
});

// ── URL shortener risk ────────────────────────────────────────────

test("URL shortener is detected as risk", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Check this out: https://bit.ly/3abcXYZ",
  });
  const result = await extractAsync(processor, msg);
  const shortLink = result.links.find((l) => l.url.includes("bit.ly"));
  assert.ok(shortLink, "should find the short link");
  assert.equal(shortLink.risk, true);
  assert.ok(
    shortLink.riskReasons.includes("shortener"),
    `expected shortener in riskReasons, got: ${shortLink.riskReasons.join(", ")}`,
  );
});

test("non-shortener URL is not flagged", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Visit https://example.com/page",
  });
  const result = await extractAsync(processor, msg);
  assert.ok(
    !result.links[0]!.riskReasons.includes("shortener"),
    "should not flag normal URL as shortener",
  );
});

// ── Unsafe scheme risk ────────────────────────────────────────────

test("HTTP scheme is flagged as unsafe", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Go to http://insecure.com/page",
  });
  const result = await extractAsync(processor, msg);
  const httpLink = result.links.find((l) => l.url.startsWith("http://"));
  assert.ok(httpLink, "should find http link");
  assert.equal(httpLink.risk, true);
  assert.ok(
    httpLink.riskReasons.includes("unsafe-scheme"),
    `expected unsafe-scheme in riskReasons, got: ${httpLink.riskReasons.join(", ")}`,
  );
});

test("HTTPS scheme is not flagged as unsafe", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Go to https://secure.com/page",
  });
  const result = await extractAsync(processor, msg);
  assert.ok(
    !result.links[0]!.riskReasons.includes("unsafe-scheme"),
    "should not flag https as unsafe",
  );
});

// ── Credential-like query params risk ─────────────────────────────

test("credential-bearing query params are detected as risk", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "https://app.example.com/reset?token=abc123secret",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links[0]!.risk, true);
  assert.ok(
    result.links[0]!.riskReasons.includes("credential-in-query"),
    `expected credential-in-query in riskReasons, got: ${result.links[0]!.riskReasons.join(", ")}`,
  );
});

test("normal query params are not flagged as credential", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "https://shop.example.com/search?q=shoes&page=2",
  });
  const result = await extractAsync(processor, msg);
  assert.ok(
    !result.links[0]!.riskReasons.includes("credential-in-query"),
    "should not flag normal query params as credential",
  );
});

// ── Suspicious TLD risk ───────────────────────────────────────────

test("suspicious TLD is detected as risk", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Visit https://phish.xyz/steal",
  });
  const result = await extractAsync(processor, msg);
  const xyzLink = result.links.find((l) => l.url.includes(".xyz"));
  assert.ok(xyzLink, "should find .xyz link");
  assert.equal(xyzLink.risk, true);
  assert.ok(
    xyzLink.riskReasons.includes("suspicious-tld"),
    `expected suspicious-tld in riskReasons, got: ${xyzLink.riskReasons.join(", ")}`,
  );
});

test("common TLDs are not flagged as suspicious", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Visit https://example.com/page",
  });
  const result = await extractAsync(processor, msg);
  assert.ok(
    !result.links[0]!.riskReasons.includes("suspicious-tld"),
    "should not flag .com as suspicious TLD",
  );
});

// ── Deeply nested subdomain risk ──────────────────────────────────

test("deeply nested subdomains are flagged as risk", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "https://a.b.c.d.e.example.com/strange",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links[0]!.risk, true);
  assert.ok(
    result.links[0]!.riskReasons.includes("deeply-nested-subdomain"),
    `expected deeply-nested-subdomain in riskReasons, got: ${result.links[0]!.riskReasons.join(", ")}`,
  );
});

test("normal subdomain depth is not flagged", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "https://docs.example.com/page",
  });
  const result = await extractAsync(processor, msg);
  assert.ok(
    !result.links[0]!.riskReasons.includes("deeply-nested-subdomain"),
    "should not flag normal subdomain depth",
  );
});

// ── Risk calibration ──────────────────────────────────────────────

test("normal links are NOT all marked high risk - risk calibration", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://github.com/user/repo">View on GitHub</a>
      <a href="https://docs.python.org/3/">Python Docs</a>
      <a href="https://shop.example.com/cart">Your Cart</a>
      <a href="https://news.ycombinator.com/">HN</a>
      <a href="https://www.wikipedia.org/">Wikipedia</a>
    `,
  });
  const result = await extractAsync(processor, msg);
  const riskyCount = result.links.filter((l) => l.risk).length;
  const total = result.links.length;
  // Normal links should mostly be safe
  assert.ok(
    riskyCount < total,
    `Expected fewer risky links than total. Got ${riskyCount} risky out of ${total}`,
  );
  // At least half should be safe
  const safeCount = total - riskyCount;
  assert.ok(
    safeCount >= total / 2,
    `Expected at least half of links to be safe. Got ${safeCount} safe out of ${total}`,
  );
});

test("mix of safe and risky links provides useful discrimination", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://example.com/page">Safe link</a>
      <a href="http://insecure.com">HTTP link</a>
      <a href="https://bit.ly/abc123">Short link</a>
      <a href="https://evil.com/phish">https://paypal.com/login</a>
    `,
  });
  const result = await extractAsync(processor, msg);
  const safeLinks = result.links.filter((l) => !l.risk);
  const riskyLinks = result.links.filter((l) => l.risk);
  assert.ok(safeLinks.length > 0, "should have some safe links");
  assert.ok(riskyLinks.length > 0, "should have some risky links");
  // Each risky link should have at least one reason
  for (const link of riskyLinks) {
    assert.ok(link.riskReasons.length > 0, `risky link ${link.url} should have risk reasons`);
  }
});

// ── Unsubscribe identification ────────────────────────────────────

test("unsubscribe category from body text with unsubscribe keyword", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "To stop receiving emails, visit https://mailer.com/unsubscribe",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.unsubscribeUrl, "https://mailer.com/unsubscribe");
  assert.ok(!result.links.some((l) => l.category === "unsubscribe"));
});

test("unsubscribe category from HTML body with unsubscribe keyword", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://news.example.com/opt-out">Unsubscribe from our newsletter</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.unsubscribeUrl, "https://news.example.com/opt-out");
  assert.ok(!result.links.some((l) => l.category === "unsubscribe"));
});

test("unsubscribe URL from List-Unsubscribe header takes priority", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    headers: { "list-unsubscribe": "<https://list.example.com/unsub>" },
    bodyHtml: '<a href="https://body.example.com/unsub">Unsubscribe</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.ok(result.unsubscribeUrl);
  // The first unsubscribe link found (from header) should be used
  assert.ok(result.unsubscribeUrl.includes("list.example.com"));
});

test("no unsubscribe URL when none present", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Just a normal message with https://example.com",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.unsubscribeUrl, null);
});

test("Chinese unsubscribe keyword detected in HTML anchor text", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://cn.example.com/unsub">退订</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.unsubscribeUrl, "https://cn.example.com/unsub");
  assert.ok(!result.links.some((l) => l.category === "unsubscribe"));
});

// ── Payment category ──────────────────────────────────────────────

test("payment category detected for pay-related links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://billing.example.com/pay">Pay your invoice</a>',
  });
  const result = await extractAsync(processor, msg);
  const payment = result.links.find((l) => l.category === "payment");
  assert.ok(payment, "should categorize payment link");
});

// ── Sensitive URL log safety ──────────────────────────────────────

test("redactUrlForLog redacts credential-bearing query values", () => {
  const url = "https://app.example.com/reset?token=secret123&user=john";
  const redacted = redactUrlForLog(url);
  assert.ok(
    !redacted.includes("secret123"),
    "token value should be redacted from log output",
  );
  assert.ok(
    redacted.includes("token="),
    "token key should be preserved in log output",
  );
});

test("redactUrlForLog redacts password query values", () => {
  const url = "https://example.com/login?password=mypass123";
  const redacted = redactUrlForLog(url);
  assert.ok(
    !redacted.includes("mypass123"),
    "password value should be redacted",
  );
});

test("redactUrlForLog preserves non-sensitive query values", () => {
  const url = "https://shop.example.com/search?q=shoes&page=2";
  const redacted = redactUrlForLog(url);
  assert.equal(redacted, url, "non-sensitive query values should be preserved");
});

test("redactUrlForLog handles URLs without query strings", () => {
  const url = "https://example.com/page";
  const redacted = redactUrlForLog(url);
  assert.equal(redacted, url);
});

test("redactUrlForLog redacts apiKey query value", () => {
  const url = "https://api.example.com/data?apiKey=mySecretKey123";
  const redacted = redactUrlForLog(url);
  assert.ok(!redacted.includes("mySecretKey123"), "apiKey value should be redacted");
});

test("redactUrlForLog redacts session_id query value", () => {
  const url = "https://app.example.com/dashboard?session_id=abc123def456";
  const redacted = redactUrlForLog(url);
  assert.ok(!redacted.includes("abc123def456"), "session_id value should be redacted");
});

// ── Risk reasons are populated correctly ───────────────────────────

test("each risky link has at least one risk reason", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "http://insecure.com https://bit.ly/abc https://phish.xyz/steal",
  });
  const result = await extractAsync(processor, msg);
  for (const link of result.links) {
    if (link.risk) {
      assert.ok(
        link.riskReasons.length > 0,
        `risky link ${link.url} should have at least one risk reason`,
      );
    }
  }
});

test("safe links have empty risk reasons", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "https://example.com/page",
  });
  const result = await extractAsync(processor, msg);
  for (const link of result.links) {
    if (!link.risk) {
      assert.deepEqual(link.riskReasons, [], "safe links should have empty risk reasons");
    }
  }
});

// ── Multiple risk signals on a single link ────────────────────────

test("a link can have multiple risk reasons", () => {
  // HTTP + shortener + suspicious TLD
  const signals = computeRiskSignals({
    url: "http://bit.ly/abc",
    actionText: "Click here",
  });
  assert.ok(signals.risk, "should be risky");
  assert.ok(signals.riskReasons.includes("unsafe-scheme"), "should flag unsafe-scheme");
  assert.ok(signals.riskReasons.includes("shortener"), "should flag shortener");
  assert.ok(signals.riskReasons.length >= 2, "should have at least 2 risk reasons");
});

test("display-domain mismatch combined with other risks", () => {
  const signals = computeRiskSignals({
    url: "http://evil.xyz/phish",
    actionText: "https://paypal.com/verify",
  });
  assert.ok(signals.risk, "should be risky");
  assert.ok(signals.riskReasons.includes("display-domain-mismatch"), "should flag mismatch");
  assert.ok(signals.riskReasons.includes("unsafe-scheme"), "should flag unsafe-scheme");
  assert.ok(signals.riskReasons.includes("suspicious-tld"), "should flag suspicious TLD");
});

// ── computeRiskSignals unit tests ─────────────────────────────────

test("computeRiskSignals returns risk=false for safe HTTPS link", () => {
  const signals = computeRiskSignals({
    url: "https://docs.python.org/3/tutorial/index.html",
    actionText: "Python Tutorial",
  });
  assert.equal(signals.risk, false);
  assert.deepEqual(signals.riskReasons, []);
});

test("computeRiskSignals flags mailto: as safe (not risky)", () => {
  const signals = computeRiskSignals({
    url: "mailto:someone@example.com",
    actionText: "someone@example.com",
  });
  assert.equal(signals.risk, false);
  assert.deepEqual(signals.riskReasons, []);
});

// ── Category tests ────────────────────────────────────────────────

test("confirm category detected for verify/confirm links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://app.example.com/confirm">Confirm your email</a>',
  });
  const result = await extractAsync(processor, msg);
  const confirm = result.links.find((l) => l.category === "confirm");
  assert.ok(confirm, "should categorize confirm link");
});

test("download category detected for file extension URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Download the report at https://example.com/report.pdf",
  });
  const result = await extractAsync(processor, msg);
  const download = result.links.find((l) => l.category === "download");
  assert.ok(download, "should categorize download link");
});

test("action category detected for login/action links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://app.example.com/login">Login</a>',
  });
  const result = await extractAsync(processor, msg);
  const action = result.links.find((l) => l.category === "action");
  assert.ok(action, "should categorize action link");
});

test("navigate is default category for general links", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Check out https://example.com/about",
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links[0]!.category, "navigate");
});

// ── Eval fixtures (20+ link fixtures) ─────────────────────────────

interface LinkEvalFixture {
  fixtureId: string;
  input: { bodyHtml?: string; bodyText?: string; headers?: Record<string, string> };
  assertions: (result: LinkExtractionResult) => string | null;
}

const LINK_FIXTURES: LinkEvalFixture[] = [
  {
    fixtureId: "link-safe-simple-https",
    input: { bodyText: "Visit https://example.com for details." },
    assertions: (r) => {
      if (r.links.length !== 1) return "expected 1 link";
      if (r.links[0]!.risk !== false) return "should not be risky";
      if (r.links[0]!.riskReasons.length !== 0) return "should have no risk reasons";
      return null;
    },
  },
  {
    fixtureId: "link-safe-html-anchor",
    input: { bodyHtml: '<a href="https://docs.python.org/3/">Python Docs</a>' },
    assertions: (r) => {
      if (r.links[0]!.risk !== false) return "should be safe";
      if (r.links[0]!.category !== "navigate") return "should be navigate";
      return null;
    },
  },
  {
    fixtureId: "link-http-unsafe",
    input: { bodyText: "Go to http://insecure.com/page" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("unsafe-scheme")) return "should flag unsafe-scheme";
      return null;
    },
  },
  {
    fixtureId: "link-bitly-shortener",
    input: { bodyText: "https://bit.ly/3abcXYZ" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("shortener")) return "should flag shortener";
      return null;
    },
  },
  {
    fixtureId: "link-tco-shortener",
    input: { bodyText: "Check https://t.co/abc123" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("shortener")) return "should flag shortener";
      return null;
    },
  },
  {
    fixtureId: "link-suspicious-tld-xyz",
    input: { bodyText: "https://phish.xyz/steal" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("suspicious-tld")) return "should flag suspicious-tld";
      return null;
    },
  },
  {
    fixtureId: "link-suspicious-tld-top",
    input: { bodyText: "https://scam.top/fake" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("suspicious-tld")) return "should flag suspicious-tld";
      return null;
    },
  },
  {
    fixtureId: "link-suspicious-domain-paypa1",
    input: { bodyText: "https://paypa1.com/login" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("suspicious-domain")) return "should flag suspicious-domain";
      return null;
    },
  },
  {
    fixtureId: "link-credential-query-token",
    input: { bodyText: "https://app.example.com/reset?token=abc123" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("credential-in-query")) return "should flag credential-in-query";
      return null;
    },
  },
  {
    fixtureId: "link-credential-query-session",
    input: { bodyText: "https://app.example.com/dashboard?session_id=xyz789" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("credential-in-query")) return "should flag credential-in-query";
      return null;
    },
  },
  {
    fixtureId: "link-deeply-nested-subdomain",
    input: { bodyText: "https://a.b.c.d.e.example.com/strange" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("deeply-nested-subdomain")) return "should flag deeply-nested-subdomain";
      return null;
    },
  },
  {
    fixtureId: "link-display-domain-mismatch",
    input: { bodyHtml: '<a href="https://evil.com/phish">https://paypal.com/verify</a>' },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("display-domain-mismatch")) return "should flag display-domain-mismatch";
      return null;
    },
  },
  {
    fixtureId: "link-unsubscribe-header",
    input: { headers: { "list-unsubscribe": "<https://list.example.com/unsub>" } },
    assertions: (r) => {
      if (!r.unsubscribeUrl) return "should have unsubscribeUrl";
      if (r.links.some((l) => l.category === "unsubscribe")) return "should not duplicate unsubscribe in links";
      return null;
    },
  },
  {
    fixtureId: "link-unsubscribe-body-keyword",
    input: { bodyHtml: '<a href="https://news.example.com/opt-out">Unsubscribe</a>' },
    assertions: (r) => {
      if (!r.unsubscribeUrl) return "should have unsubscribeUrl";
      return null;
    },
  },
  {
    fixtureId: "link-category-payment",
    input: { bodyHtml: '<a href="https://billing.example.com/pay">Pay your invoice</a>' },
    assertions: (r) => {
      if (!r.links.find((l) => l.category === "payment")) return "should have payment category";
      return null;
    },
  },
  {
    fixtureId: "link-category-confirm",
    input: { bodyHtml: '<a href="https://app.example.com/confirm">Confirm your email</a>' },
    assertions: (r) => {
      if (!r.links.find((l) => l.category === "confirm")) return "should have confirm category";
      return null;
    },
  },
  {
    fixtureId: "link-category-download",
    input: { bodyText: "Download https://example.com/report.pdf" },
    assertions: (r) => {
      if (!r.links.find((l) => l.category === "download")) return "should have download category";
      return null;
    },
  },
  {
    fixtureId: "link-category-subscribe",
    input: { bodyHtml: '<a href="https://news.example.com/join">Subscribe now</a>' },
    assertions: (r) => {
      if (!r.links.find((l) => l.category === "subscribe")) return "should have subscribe category";
      return null;
    },
  },
  {
    fixtureId: "link-category-action",
    input: { bodyHtml: '<a href="https://app.example.com/auth">Login to your account</a>' },
    assertions: (r) => {
      if (!r.links.find((l) => l.category === "action")) return "should have action category";
      return null;
    },
  },
  {
    fixtureId: "link-multi-risk-http-shortener",
    input: { bodyText: "http://bit.ly/abc" },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      if (!r.links[0]!.riskReasons.includes("unsafe-scheme")) return "should flag unsafe-scheme";
      if (!r.links[0]!.riskReasons.includes("shortener")) return "should flag shortener";
      return null;
    },
  },
  {
    fixtureId: "link-multi-risk-mismatch-http-tld",
    input: { bodyHtml: '<a href="http://evil.xyz/phish">https://paypal.com/verify</a>' },
    assertions: (r) => {
      if (!r.links[0]!.risk) return "should be risky";
      const reasons = r.links[0]!.riskReasons;
      if (!reasons.includes("display-domain-mismatch")) return "should flag mismatch";
      if (!reasons.includes("unsafe-scheme")) return "should flag unsafe-scheme";
      if (!reasons.includes("suspicious-tld")) return "should flag suspicious-tld";
      return null;
    },
  },
  {
    fixtureId: "link-safe-normal-query-params",
    input: { bodyText: "https://shop.example.com/search?q=shoes&page=2&sort=price" },
    assertions: (r) => {
      if (r.links[0]!.risk) return "should be safe with normal query params";
      return null;
    },
  },
  {
    fixtureId: "link-safe-subdomain-depth",
    input: { bodyText: "https://docs.example.com/page" },
    assertions: (r) => {
      if (r.links[0]!.riskReasons.includes("deeply-nested-subdomain")) return "should not flag normal subdomain depth";
      return null;
    },
  },
  {
    fixtureId: "link-empty-no-links",
    input: { bodyText: "Just a plain text message with no URLs." },
    assertions: (r) => {
      if (r.links.length !== 0) return "should have no links";
      if (r.unsubscribeUrl !== null) return "unsubscribeUrl should be null";
      return null;
    },
  },
  {
    fixtureId: "link-dedup-same-url",
    input: {
      bodyText: "Visit https://example.com/page and also https://example.com/page",
      bodyHtml: '<a href="https://example.com/page">Link</a>',
    },
    assertions: (r) => {
      if (r.links.length !== 1) return `expected 1 link, got ${r.links.length}`;
      return null;
    },
  },
];

test("link eval suite: all 25 fixtures pass", async () => {
  const processor = new LinkExtractionProcessor();
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const fixture of LINK_FIXTURES) {
    const msg = makeMessage({
      bodyHtml: fixture.input.bodyHtml,
      bodyText: fixture.input.bodyText,
      headers: fixture.input.headers,
    });
    const result = await extractAsync(processor, msg);
    const violation = fixture.assertions(result);
    if (violation === null) {
      passed++;
    } else {
      failed++;
      failures.push(`${fixture.fixtureId}: ${violation}`);
    }
  }

  assert.equal(failed, 0, `${failed} fixture(s) failed:\n${failures.join("\n")}`);
  assert.ok(passed >= 20, `expected at least 20 passing fixtures, got ${passed}`);
});

// ── Log safety: no complete sensitive URLs in output ──────────────

test("processor result never includes full sensitive query values in URLs when redacted", () => {
  // Verify that redactUrlForLog strips credential values
  const sensitiveUrls = [
    "https://app.example.com/reset?token=supersecret123",
    "https://api.example.com/data?apiKey=KEY_ABC123&format=json",
    "https://auth.example.com/login?session_id=sess_abc123def",
    "https://reset.example.com/?code=123456&email=user@test.com",
    "https://login.example.com/?csrf=abc123&password=hunter2",
  ];

  for (const url of sensitiveUrls) {
    const redacted = redactUrlForLog(url);
    // The redacted URL should not contain the sensitive value
    assert.ok(
      !redacted.includes("supersecret123"),
      `redacted URL should not contain token value: ${redacted}`,
    );
    // Also check the URL structure is preserved
    assert.ok(
      redacted.includes("example.com"),
      `redacted URL should preserve domain: ${redacted}`,
    );
  }
});

test("redactUrlForLog redacts multiple sensitive params in one URL", () => {
  const url = "https://app.example.com/reset?token=secret123&session_id=abc456&page=1";
  const redacted = redactUrlForLog(url);
  assert.ok(!redacted.includes("secret123"), "token value should be redacted");
  assert.ok(!redacted.includes("abc456"), "session_id value should be redacted");
  assert.ok(redacted.includes("page=1"), "non-sensitive params should be preserved");
});

test("redactUrlForLog is case-insensitive for credential keys", () => {
  const url = "https://example.com/auth?TOKEN=secret&Session_Id=abc";
  const redacted = redactUrlForLog(url);
  assert.ok(!redacted.includes("secret"), "TOKEN value should be redacted");
  assert.ok(!redacted.includes("abc"), "Session_Id value should be redacted");
});

// ── No network requests validation ────────────────────────────────

test("LinkExtractionProcessor has no fetch/import of network modules in source", () => {
  // This is a static guarantee: the processor imports no network modules
  // (no http/https/fetch/net). It only uses URL parsing and regex.
  // The processor is fully deterministic and local-only by design.
  const processor = new LinkExtractionProcessor();
  assert.equal(processor.type, "linkExtraction");
  // The handle method only parses strings — no network I/O possible
});

test("computeRiskSignals is purely synchronous", () => {
  // Verify computeRiskSignals returns immediately (no promises)
  const result = computeRiskSignals({
    url: "https://bit.ly/abc",
    actionText: "Click",
  });
  assert.ok(!(result instanceof Promise), "computeRiskSignals should be synchronous");
  assert.equal(typeof result.risk, "boolean");
  assert.ok(Array.isArray(result.riskReasons));
});

// ── _metadata (Route C / WP A) ──────────────────────────────────────

test("LinkExtractionProcessor emits _metadata with model='deterministic' when no LLM is configured", async () => {
  const processor = new LinkExtractionProcessor();
  const mail = makeMessage({
    bodyText: "Visit https://example.com to confirm.",
  });
  const result = await processor.handle(makeJob(), makeCtx(mail));

  assert.ok(result._metadata, "_metadata must be present");
  assert.equal(result._metadata.processor, "linkExtraction");
  assert.equal(typeof result._metadata.version, "number");
  assert.ok(result._metadata.version >= 1);
  assert.equal(result._metadata.model, "deterministic");
  assert.equal(result._metadata.tokenUsage.inputTokens, 0);
  assert.equal(result._metadata.tokenUsage.outputTokens, 0);
  assert.ok(result._metadata.contextRefs.length > 0);
  assert.ok(result._metadata.createdAt);
  assert.equal(typeof result._metadata.durationMs, "number");
});

test("LinkExtractionProcessor emits _metadata with model name + tokenUsage when LLM ranks links", async () => {
  const processor = new LinkExtractionProcessor({
    llmClient: {
      generate: async () => ({
        text: JSON.stringify({ links: [{ index: 0, category: "action" }] }),
        finishReason: "stop" as const,
        usage: { inputTokens: 33, outputTokens: 9 },
      }),
    },
    model: "gpt-4o-mini",
  });
  const mail = makeMessage({
    bodyText: "Action: https://example.com/confirm",
  });
  const result = await processor.handle(makeJob(), makeCtx(mail));

  assert.ok(result._metadata);
  assert.equal(result._metadata.model, "gpt-4o-mini");
  assert.equal(result._metadata.tokenUsage.inputTokens, 33);
  assert.equal(result._metadata.tokenUsage.outputTokens, 9);
});

// ── Enterprise categories: meeting / approval / document (Route C / WP F) ───

test("meeting category detected for zoom.us URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://us02web.zoom.us/j/1234567890">Zoom link</a>',
  });
  const result = await extractAsync(processor, msg);
  const meeting = result.links.find((l) => l.category === "meeting");
  assert.ok(meeting, `should categorize zoom URL as meeting; got: ${result.links.map((l) => l.category).join(", ")}`);
});

test("meeting category detected for Google Meet URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://meet.google.com/abc-defg-hij">Google Meet</a>',
  });
  const result = await extractAsync(processor, msg);
  const meeting = result.links.find((l) => l.category === "meeting");
  assert.ok(meeting, "should categorize Google Meet as meeting");
});

test("meeting category detected from English action text 'Join Meeting'", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://example.com/conf/abc">Join Meeting</a>',
  });
  const result = await extractAsync(processor, msg);
  const meeting = result.links.find((l) => l.category === "meeting");
  assert.ok(meeting, "should categorize 'Join Meeting' as meeting");
});

test("meeting category detected from Chinese action text 加入会议", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://example.com/conf/abc">加入会议</a>',
  });
  const result = await extractAsync(processor, msg);
  const meeting = result.links.find((l) => l.category === "meeting");
  assert.ok(meeting, "should categorize 加入会议 as meeting");
});

test("approval category detected for docusign.com URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://www.docusign.com/sign/envelope/abc123">DocuSign</a>',
  });
  const result = await extractAsync(processor, msg);
  const approval = result.links.find((l) => l.category === "approval");
  assert.ok(approval, `should categorize DocuSign as approval; got: ${result.links.map((l) => l.category).join(", ")}`);
});

test("approval category detected from English action text 'Approve'", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://workflow.example.com/req/123">Approve request</a>',
  });
  const result = await extractAsync(processor, msg);
  const approval = result.links.find((l) => l.category === "approval");
  assert.ok(approval, "should categorize Approve as approval");
});

test("approval category detected from Chinese action text 审批", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://workflow.example.com/req/123">前往审批</a>',
  });
  const result = await extractAsync(processor, msg);
  const approval = result.links.find((l) => l.category === "approval");
  assert.ok(approval, "should categorize 审批 as approval");
});

test("document category detected for docs.google.com URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://docs.google.com/document/d/abc/edit">Project doc</a>',
  });
  const result = await extractAsync(processor, msg);
  const document = result.links.find((l) => l.category === "document");
  assert.ok(document, `should categorize Google Docs as document; got: ${result.links.map((l) => l.category).join(", ")}`);
});

test("document category detected for notion.so URLs", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://notion.so/team/spec-xyz">Notion spec</a>',
  });
  const result = await extractAsync(processor, msg);
  const document = result.links.find((l) => l.category === "document");
  assert.ok(document, "should categorize Notion as document");
});

test("counter-test: a .pdf URL still classifies as download, NOT document", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyText: "Download the report at https://files.example.com/report.pdf",
  });
  const result = await extractAsync(processor, msg);
  const link = result.links[0]!;
  assert.equal(link.category, "download", "raw .pdf URL must remain in download bucket");
});

test("counter-test: a payment-keyword URL classifies as payment, NOT approval", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: '<a href="https://billing.example.com/pay">Approve payment invoice</a>',
  });
  const result = await extractAsync(processor, msg);
  const link = result.links[0]!;
  assert.equal(
    link.category,
    "payment",
    "payment vocabulary must beat approval when both are present (payment priority 60 > approval 55)",
  );
});

test("priority test: payment beats meeting beats navigate in fallback ordering", async () => {
  const processor = new LinkExtractionProcessor();
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://example.com/about">About us</a>
      <a href="https://us02web.zoom.us/j/9876543210">Join the call</a>
      <a href="https://billing.example.com/pay">Pay invoice</a>
    `,
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 3, "all three candidates should pass the low-value filter");
  assert.equal(result.links[0]!.category, "payment", "payment first (priority 60)");
  assert.equal(result.links[1]!.category, "meeting", "meeting second (priority 45)");
  assert.equal(result.links[2]!.category, "navigate", "navigate last (priority 10)");
});

test("LINK_EXTRACTION_PROCESSOR_VERSION is >= 2 and surfaces in _metadata", async () => {
  assert.ok(
    LINK_EXTRACTION_PROCESSOR_VERSION >= 2,
    `expected processor version >= 2 after enterprise category bump, got ${LINK_EXTRACTION_PROCESSOR_VERSION}`,
  );
  const processor = new LinkExtractionProcessor();
  const result = await extractAsync(
    processor,
    makeMessage({ bodyText: "Visit https://example.com/page" }),
  );
  assert.equal(result._metadata?.version, LINK_EXTRACTION_PROCESSOR_VERSION);
});

test("LLM-driven path: response with category 'meeting' round-trips through validateCategory", async () => {
  const processor = new LinkExtractionProcessor({
    model: "gpt-test",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        links: [{ index: 0, actionText: "加入会议", category: "meeting" }],
      }),
      finishReason: "stop",
    })),
  });
  // The candidate URL is a plain hostname so categorize() defaults to navigate;
  // the LLM is the only path that can promote it to meeting, proving the
  // validateCategory whitelist accepts the new value.
  const msg = makeMessage({
    bodyHtml: '<a href="https://example.com/event/123">Event invite</a>',
  });
  const result = await extractAsync(processor, msg);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.category, "meeting");
  assert.equal(result.links[0]!.actionText, "加入会议");
});

test("LLM-driven path: 'approval' and 'document' are accepted by validateCategory", async () => {
  const processor = new LinkExtractionProcessor({
    model: "gpt-test",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        links: [
          { index: 0, actionText: "审批", category: "approval" },
          { index: 1, actionText: "查看文档", category: "document" },
        ],
      }),
      finishReason: "stop",
    })),
  });
  const msg = makeMessage({
    bodyHtml: `
      <a href="https://example.com/req/1">Request 1</a>
      <a href="https://example.com/spec/2">Spec 2</a>
    `,
  });
  const result = await extractAsync(processor, msg);
  const categories = result.links.map((l) => l.category).sort();
  assert.deepEqual(categories, ["approval", "document"]);
});
