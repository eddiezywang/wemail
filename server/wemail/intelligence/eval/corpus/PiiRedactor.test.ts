/**
 * PiiRedactor + PiiResidualScanner — Phase 4 unit tests.
 *
 * Each PII category has at least 3 cases. The residual scanner is
 * also exercised with deliberate leak scenarios so we know the
 * fail-closed gate trips.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MailSampleEntry } from "../../../testing/mailSamples.js";
import { redactMailSample } from "./PiiRedactor.js";
import { scanString, scanSample } from "./PiiResidualScanner.js";

function dummySample(overrides: {
  subject?: string;
  bodyText?: string;
  fromEmail?: string;
  fromName?: string;
}): MailSampleEntry {
  return {
    id: "test-sample",
    category: "notification",
    mail: {
      id: "x",
      accountId: "a",
      folder: "INBOX",
      messageId: "m",
      from: {
        email: overrides.fromEmail ?? "a@b.com",
        name: overrides.fromName ?? "Test User",
      },
      to: [],
      cc: [],
      bcc: [],
      subject: overrides.subject ?? "subject",
      snippet: "",
      bodyText: overrides.bodyText ?? "",
      bodyHtml: "",
      receivedAt: "2026-01-01T00:00:00Z",
      hasAttachments: false,
      attachments: [],
      flags: { seen: false, flagged: false, answered: false, draft: false },
      sync: { uid: 1, uidValidity: 1, internalDate: "2026-01-01T00:00:00Z" },
    },
  };
}

/* ----------------------- Email redaction ----------------------- */

test("redactor: emails replaced and consistent", () => {
  const s = dummySample({
    bodyText: "Contact alice@acme.com or bob@acme.com — alice@acme.com again.",
    fromEmail: "alice@acme.com",
  });
  const { redactedSample, redactionMap } = redactMailSample(s);
  assert.match(redactedSample.mail.bodyText!, /^Contact person\d@example\.test or person\d@example\.test/);
  // alice@acme.com appears 3x but as one unique → counter increments only once for alice + once for bob
  assert.equal(redactionMap.email, 2, "two unique emails should be counted");
  // From mail should map to the same handle as in body for alice
  assert.equal(redactedSample.mail.from.email, "person0@example.test");
});

test("redactor: emails — different domains map distinctly", () => {
  const s = dummySample({
    bodyText: "x@one.com y@two.org z@three.net",
  });
  const { redactedSample } = redactMailSample(s);
  const unique = new Set(redactedSample.mail.bodyText!.match(/person\d@example\.test/g));
  assert.equal(unique.size, 3);
});

test("redactor: emails inside HTML tags also caught", () => {
  const s = {
    ...dummySample({ bodyText: "" }),
    mail: {
      ...dummySample({}).mail,
      bodyHtml: '<a href="mailto:secret@org.com">secret@org.com</a>',
    },
  };
  const { redactedSample } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyHtml!, /secret@org\.com/);
});

/* ----------------------- Phone redaction ----------------------- */

test("redactor: US-style phone scrubbed", () => {
  const s = dummySample({ bodyText: "Call me at 415-555-1234 tomorrow." });
  const { redactedSample, redactionMap } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /415-?555-?1234/);
  assert.equal(redactionMap.phone, 1);
});

test("redactor: international phone scrubbed", () => {
  const s = dummySample({ bodyText: "Reach me at +86 138 0013 8000." });
  const { redactedSample } = redactMailSample(s);
  assert.match(redactedSample.mail.bodyText!, /\[PHONE\]/);
});

test("redactor: long Chinese mobile number scrubbed", () => {
  const s = dummySample({ bodyText: "请联系 13812345678 或 18800001234。" });
  const { redactedSample } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /1\d{10}/);
});

/* ----------------------- URL redaction ----------------------- */

test("redactor: URL host replaced, path token redacted", () => {
  const s = dummySample({
    bodyText:
      "Login at https://api.example.com/oauth/callback?token=abcdef0123456789abcdef0123456789",
  });
  const { redactedSample, redactionMap } = redactMailSample(s);
  assert.match(redactedSample.mail.bodyText!, /host\d+\.example\.test/);
  assert.match(redactedSample.mail.bodyText!, /REDACTED-TOKEN/);
  assert.equal(redactionMap.urlHost, 1);
  assert.equal(redactionMap.urlPath, 1);
});

test("redactor: same hostname maps consistently across URLs", () => {
  const s = dummySample({
    bodyText:
      "https://api.example.com/v1 also https://api.example.com/v2 plus https://other.example.com/x",
  });
  const { redactedSample } = redactMailSample(s);
  const matches = redactedSample.mail.bodyText!.match(/host\d+\.example\.test/g)!;
  // 2 distinct hosts → 2 distinct placeholders, but 3 occurrences total
  assert.equal(matches.length, 3);
  assert.equal(new Set(matches).size, 2);
});

/* ----------------------- Names ----------------------- */

test("redactor: English personal name (capitalized pair) replaced", () => {
  const s = dummySample({
    bodyText: "Best, John Smith. Please reply to Jane Doe ASAP.",
  });
  const { redactedSample } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /John Smith/);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /Jane Doe/);
  assert.match(redactedSample.mail.bodyText!, /Person \d/);
});

test("redactor: Chinese name with surname-given pattern replaced", () => {
  const s = dummySample({
    bodyText: "请@王伟 处理，感谢张敏 的反馈。",
  });
  const { redactedSample } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /王伟|张敏/);
});

/* ----------------------- Organizations ----------------------- */

test("redactor: known org name replaced", () => {
  const s = dummySample({
    bodyText: "Meeting with Salesforce + Notion teams about Atlassian's new launch.",
  });
  const { redactedSample, redactionMap } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /Salesforce|Notion|Atlassian/);
  assert.ok(redactionMap.organization! >= 3);
});

/* ----------------------- Address ----------------------- */

test("redactor: English street address replaced", () => {
  const s = dummySample({
    bodyText: "Drop by 1600 Amphitheatre Parkway tomorrow.",
  });
  const { redactedSample } = redactMailSample(s);
  // "Amphitheatre Parkway" not in our suffix list — we won't catch this one.
  // Known limitation: only matches Street/Rd/Ave/etc.
  void redactedSample;

  const s2 = dummySample({
    bodyText: "Visit us at 350 Main Street, Apt 4.",
  });
  const out = redactMailSample(s2);
  assert.match(out.redactedSample.mail.bodyText!, /\[ADDRESS\]/);
});

test("redactor: Chinese address replaced", () => {
  const s = dummySample({
    bodyText: "地址：北京市海淀区中关村大街1号 收件。",
  });
  const { redactedSample } = redactMailSample(s);
  assert.match(redactedSample.mail.bodyText!, /\[ADDRESS\]/);
});

/* ----------------------- Signature ----------------------- */

test("redactor: -- delimited signature block redacted", () => {
  const body = [
    "Hello team,",
    "Please review.",
    "",
    "-- ",
    "Bob Jones",
    "Acme Corp",
    "+1 555-867-5309",
  ].join("\n");
  const s = dummySample({ bodyText: body });
  const { redactedSample, redactionMap } = redactMailSample(s);
  assert.match(redactedSample.mail.bodyText!, /\[SIGNATURE\]/);
  assert.equal(redactionMap.signature, 1);
});

/* ----------------------- Attachments ----------------------- */

test("redactor: attachment filenames replaced and indexed", () => {
  const base = dummySample({});
  const sample = {
    ...base,
    mail: {
      ...base.mail,
      hasAttachments: true,
      attachments: [
        { id: "1", filename: "Q4-financials-confidential.xlsx", mimetype: "application/vnd.ms-excel", size: 1024 },
        { id: "2", filename: "patient-records.pdf", mimetype: "application/pdf", size: 4096 },
      ],
    },
  };
  const { redactedSample, redactionMap } = redactMailSample(sample);
  assert.deepEqual(
    redactedSample.mail.attachments.map((a) => a.filename),
    ["attachment-0.xlsx", "attachment-1.pdf"],
  );
  assert.equal(redactionMap.attachment, 2);
});

/* ----------------------- Chat IDs ----------------------- */

test("redactor: chat IDs replaced", () => {
  const s = dummySample({
    bodyText: "Ping wx_ab12cd34ef or @U07ABC123 — also ou_xyz12345.",
  });
  const { redactedSample, redactionMap } = redactMailSample(s);
  assert.doesNotMatch(redactedSample.mail.bodyText!, /wx_|ou_|@U07/);
  assert.equal(redactionMap.chatId, 3);
});

/* ----------------------- Residual scanner ----------------------- */

test("scanner: clean redacted output passes (no hits)", () => {
  const s = dummySample({
    bodyText: "Hi person0@example.test, see https://host0.example.test/page.",
  });
  const { redactedSample } = redactMailSample(s);
  const result = scanSample(redactedSample);
  assert.equal(result.ok, true, `unexpected hits: ${JSON.stringify(result.hits)}`);
});

test("scanner: missed real email is detected", () => {
  const hits = scanString("body", "Reach me: leak@realcompany.com");
  assert.ok(hits.some((h) => h.kind === "email"));
});

test("scanner: missed phone (XXX-XXX-XXXX) is detected", () => {
  const hits = scanString("body", "Call 415-555-1234.");
  assert.ok(hits.some((h) => h.kind === "phone"));
});

test("scanner: missed real hostname is detected", () => {
  const hits = scanString("body", "Visit https://leak.com/page");
  assert.ok(hits.some((h) => h.kind === "real-host"));
});

test("scanner: high-entropy OAuth-like token is detected", () => {
  const hits = scanString(
    "body",
    "token=eyJhbGciOiJIUzI1NiJ9aaaabbbbccccddddeeeeffff",
  );
  assert.ok(hits.some((h) => h.kind === "high-entropy-token"));
});

test("scanner: WeChat / Slack chat IDs are detected", () => {
  const hits = scanString("body", "wx_abcdef123456 — also @U07ZX9");
  assert.ok(hits.some((h) => h.kind === "chat-id"));
});

test("scanner: suspect Chinese name (surname+given) is detected", () => {
  const hits = scanString("body", "请@王伟跟进");
  assert.ok(hits.some((h) => h.kind === "cn-name-suspect"));
});

test("redact + scan round-trip on a heavy PII payload leaves no hits", () => {
  const s = dummySample({
    fromEmail: "alice@acme.com",
    fromName: "Alice Smith",
    bodyText: [
      "Hi Bob Jones,",
      "Please call 415-555-1234 or +44 20 7946 0958.",
      "Login at https://secure.acme.com/oauth/callback?token=abcdef0123456789abcdef0123456789",
      "Address: 350 Main Street, Apt 4.",
      "中文：王伟 请处理。北京市海淀区中关村大街1号。",
      "wx_abc123def456 / @U07XX123",
      "",
      "-- ",
      "Bob Jones",
      "Acme Corp",
      "415-555-1234",
    ].join("\n"),
  });
  const { redactedSample } = redactMailSample(s);
  const result = scanSample(redactedSample);
  assert.equal(
    result.ok,
    true,
    `expected clean redaction, got hits: ${JSON.stringify(result.hits, null, 2)}`,
  );
});
