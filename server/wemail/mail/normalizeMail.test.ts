import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawImapMessage } from "../../../shared/wemail/mail.js";
import { normalizeMail } from "./normalizeMail.js";

const CTX = { accountId: "acct-1", folder: "INBOX", uidValidity: 42 } as const;

function rfc822(
  headers: Record<string, string>,
  body: string,
): string {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return `${headerLines}\r\n\r\n${body}`;
}

function rfc822Buffer(
  headers: Record<string, string>,
  body: Buffer,
): Buffer {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return Buffer.concat([Buffer.from(`${headerLines}\r\n\r\n`, "ascii"), body]);
}

test("normalizeMail parses a simple text/plain envelope", async () => {
  const raw: RawImapMessage = {
    uid: 10,
    flags: new Set(["\\Seen", "\\FLAGGED", "\\Answered", "\\DRAFT"]),
    envelope: {
      date: "2026-04-23T10:00:00.000Z",
      subject: "Hello there",
      messageId: "<m1@example.com>",
      inReplyTo: null,
      from: [{ name: "Alice", address: "alice@example.com" }],
      to: [{ name: "Bob", address: "bob@example.com" }],
      cc: null,
      bcc: null,
    },
    bodyStructure: { type: "text", subtype: "plain", size: 6 },
    source: rfc822(
      { "Content-Type": "text/plain", "Content-Transfer-Encoding": "7bit" },
      "Hello world, this is a test body.",
    ),
  };

  const m = await normalizeMail(raw, CTX);
  assert.equal(m.id, "acct-1:INBOX:42:10");
  assert.equal(m.messageId, "<m1@example.com>");
  assert.equal(m.subject, "Hello there");
  assert.deepEqual(m.from, { name: "Alice", email: "alice@example.com" });
  assert.equal(m.to.length, 1);
  assert.equal(m.to[0]!.email, "bob@example.com");
  assert.equal(m.bodyText, "Hello world, this is a test body.");
  assert.ok(m.snippet.startsWith("Hello world"));
  assert.equal(m.hasAttachments, false);
  assert.equal(m.attachments.length, 0);
  assert.equal(m.sync.uid, 10);
  assert.equal(m.sync.uidValidity, 42);
  assert.equal(m.receivedAt, "2026-04-23T10:00:00.000Z");
  assert.deepEqual(m.flags, {
    seen: true,
    flagged: true,
    answered: true,
    draft: true,
  });
  assert.equal(m.sync.flagsAuthoritative, true);
});

test("normalizeMail defaults omitted IMAP flags without marking them authoritative", async () => {
  const raw: RawImapMessage = {
    uid: 99,
    envelope: { subject: "No flags" },
    bodyStructure: null,
  };

  const message = await normalizeMail(raw, CTX);

  assert.deepEqual(message.flags, {
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
  });
  assert.equal(message.sync.flagsAuthoritative, false);
});
test("normalizeMail handles CJK body via quoted-printable and truncates snippet", async () => {
  const body =
    "=E4=BD=A0=E5=A5=BD=EF=BC=8C=E8=BF=99=E6=98=AF=E4=B8=80=E5=B0=81=E4=B8=AD=E6=96=87=E9=82=AE=E4=BB=B6";
  const raw: RawImapMessage = {
    uid: 11,
    envelope: {
      date: new Date("2026-04-23T11:00:00Z"),
      subject: "中文主题",
      messageId: "<cjk@example.com>",
      from: [{ name: "张三", address: "zhang@example.com" }],
      to: [{ address: "recv@example.com" }],
    },
    bodyStructure: { type: "text", subtype: "plain" },
    source: rfc822(
      {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Transfer-Encoding": "quoted-printable",
      },
      body,
    ),
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.subject, "中文主题");
  assert.ok(m.bodyText?.includes("你好"));
  assert.ok(m.snippet.includes("你好"));
});

test("normalizeMail decodes non-UTF-8 CJK quoted-printable bodies by charset", async () => {
  const raw: RawImapMessage = {
    uid: 17,
    envelope: {
      date: "2026-04-23T11:00:00Z",
      subject: "GB2312",
      messageId: "<gb2312@example.com>",
      from: [{ address: "sender@example.com" }],
      to: [{ address: "recv@example.com" }],
    },
    bodyStructure: { type: "text", subtype: "plain" },
    source: rfc822(
      {
        "Content-Type": "text/plain; charset=gb2312",
        "Content-Transfer-Encoding": "quoted-printable",
      },
      "=B2=E2=CA=D4=D6=D0=CE=C4",
    ),
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.bodyText, "测试中文");
  assert.equal(m.snippet, "测试中文");
});

test("normalizeMail decodes non-UTF-8 CJK base64 bodies by charset", async () => {
  const raw: RawImapMessage = {
    uid: 18,
    envelope: {
      date: "2026-04-23T11:00:00Z",
      subject: "GBK",
      messageId: "<gbk@example.com>",
      from: [{ address: "sender@example.com" }],
      to: [{ address: "recv@example.com" }],
    },
    bodyStructure: { type: "text", subtype: "plain" },
    source: rfc822(
      {
        "Content-Type": "text/plain; charset=gbk",
        "Content-Transfer-Encoding": "base64",
      },
      Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd6, 0xd0, 0xce, 0xc4]).toString("base64"),
    ),
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.bodyText, "测试中文");
});

test("normalizeMail decodes gb18030 body bytes using the declared charset", async () => {
  const raw: RawImapMessage = {
    uid: 19,
    envelope: {
      date: new Date("2026-04-23T11:00:00Z"),
      subject: "中文主题",
      messageId: "<gb18030@example.com>",
      from: [{ name: "张三", address: "zhang@example.com" }],
      to: [{ address: "recv@example.com" }],
    },
    bodyStructure: { type: "text", subtype: "html" },
    source: rfc822Buffer(
      {
        "Content-Type": "text/html; charset=gb18030",
        "Content-Transfer-Encoding": "8bit",
      },
      Buffer.from(
        "3c68746d6c3e3c626f64793e3c703ed7f0beb4b5c4d3c3bba7a3bac4fabac3a3a1d5e2cac7d2bbb7e2d6d0cec43c2f703e3c2f626f64793e3c2f68746d6c3e",
        "hex",
      ),
    ),
  };

  const m = await normalizeMail(raw, CTX);

  assert.ok(m.bodyHtml?.includes("尊敬的用户：您好！这是一封中文"));
  assert.ok(!m.bodyHtml?.includes("�"));
});

test("normalizeMail parses multipart/alternative with text + html", async () => {
  const boundary = "BOUNDARY123";
  const body =
    `--${boundary}\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `plain version\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html\r\n\r\n` +
    `<p>html version</p>\r\n` +
    `--${boundary}--\r\n`;
  const raw: RawImapMessage = {
    uid: 12,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "mp",
      messageId: "<mp@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: { type: "multipart", subtype: "alternative" },
    source: rfc822(
      { "Content-Type": `multipart/alternative; boundary="${boundary}"` },
      body,
    ),
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.bodyText, "plain version");
  assert.ok(m.bodyHtml?.includes("html version"));
});

test("normalizeMail extracts nested multipart related alternative bodies", async () => {
  const outer = "outer-boundary";
  const alt = "alt-boundary";
  const source = rfc822(
    { "Content-Type": `multipart/related; boundary="${outer}"` },
    `--${outer}\r\n` +
      `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
      "Plain nested body\r\n" +
      `--${alt}\r\n` +
      "Content-Type: text/html; charset=utf-8\r\n\r\n" +
      '<html><body><style>.title{color:red}</style><p class="title">HTML nested body</p><img src="cid:img-1"></body></html>\r\n' +
      `--${alt}--\r\n` +
      `--${outer}\r\n` +
      "Content-Type: image/png\r\n" +
      "Content-Disposition: inline; filename=\"chart.png\"\r\n" +
      "Content-ID: <img-1>\r\n\r\n" +
      "PNGDATA\r\n" +
      `--${outer}--\r\n`,
  );
  const raw: RawImapMessage = {
    uid: 30,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "nested",
      messageId: "<nested@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: { type: "multipart", subtype: "related" },
    source,
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.bodyText, "Plain nested body");
  assert.ok(m.bodyHtml?.includes("HTML nested body"));
  assert.ok(m.bodyHtml?.includes("<style>"));
});

test("normalizeMail does not truncate html when boundary text appears in content", async () => {
  const boundary = "BODY-BOUNDARY";
  const source = rfc822(
    { "Content-Type": `multipart/alternative; boundary="${boundary}"` },
    `--${boundary}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
      "Plain body\r\n" +
      `--${boundary}\r\n` +
      "Content-Type: text/html; charset=utf-8\r\n\r\n" +
      `<p>before --${boundary} after</p>\r\n` +
      `--${boundary}--\r\n`,
  );
  const raw: RawImapMessage = {
    uid: 31,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "boundary text",
      messageId: "<boundary-text@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: { type: "multipart", subtype: "alternative" },
    source,
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.bodyText, "Plain body");
  assert.equal(m.bodyHtml, `<p>before --${boundary} after</p>`);
});

test("normalizeMail renders text/calendar invites as readable body text", async () => {
  const calendarBody =
    "BEGIN:VCALENDAR\r\n" +
    "METHOD:REQUEST\r\n" +
    "BEGIN:VEVENT\r\n" +
    "SUMMARY:wemail功能演示\r\n" +
    "DTSTART;TZID=Asia/Shanghai:20260629T160000\r\n" +
    "DTEND;TZID=Asia/Shanghai:20260629T170000\r\n" +
    "LOCATION:腾讯会议\r\n" +
    "ORGANIZER;CN=eddiewang:mailto:eddiewang@example.com\r\n" +
    "DESCRIPTION:会议ID: 261696667\\n入会链接: https://meeting.tencent.com/dm/QE0LyU5OUjuk\r\n" +
    "END:VEVENT\r\n" +
    "END:VCALENDAR\r\n";
  const raw: RawImapMessage = {
    uid: 20,
    envelope: {
      date: "2026-06-29T03:09:23Z",
      subject: "wemail功能演示",
      messageId: "<calendar@example.com>",
      from: [{ address: "jiyaojun_01@example.com" }],
      to: [{ address: "eddiewang@example.com" }],
    },
    bodyStructure: { type: "text", subtype: "calendar" },
    source: rfc822(
      {
        "Content-Type": "text/calendar; method=REQUEST; charset=utf-8",
        "Content-Transfer-Encoding": "7bit",
      },
      calendarBody,
    ),
  };

  const m = await normalizeMail(raw, CTX);

  assert.match(m.bodyText ?? "", /会议主题：wemail功能演示/);
  assert.match(m.bodyText ?? "", /会议时间：2026-06-29 16:00 至 2026-06-29 17:00 Asia\/Shanghai/);
  assert.match(m.bodyText ?? "", /会议地点：腾讯会议/);
  assert.match(m.bodyText ?? "", /组织者：eddiewang <eddiewang@example.com>/);
  assert.match(m.bodyText ?? "", /会议ID: 261696667/);
  assert.match(m.snippet, /会议主题：wemail功能演示/);
});

test("normalizeMail uses calendar part when multipart message has no plain or html body", async () => {
  const boundary = "CALENDAR-ONLY";
  const body =
    `--${boundary}\r\n` +
    "Content-Type: text/calendar; charset=utf-8\r\n" +
    "\r\n" +
    "BEGIN:VCALENDAR\r\n" +
    "BEGIN:VEVENT\r\n" +
    "SUMMARY:只含日历正文的会议\r\n" +
    "DTSTART:20260629T080000Z\r\n" +
    "DTEND:20260629T090000Z\r\n" +
    "END:VEVENT\r\n" +
    "END:VCALENDAR\r\n" +
    `--${boundary}--\r\n`;
  const raw: RawImapMessage = {
    uid: 21,
    envelope: {
      date: "2026-06-29T03:09:23Z",
      subject: "只含日历正文的会议",
      messageId: "<calendar-only@example.com>",
      from: [{ address: "sender@example.com" }],
      to: [{ address: "recv@example.com" }],
    },
    bodyStructure: { type: "multipart", subtype: "mixed" },
    source: rfc822(
      { "Content-Type": `multipart/mixed; boundary="${boundary}"` },
      body,
    ),
  };

  const m = await normalizeMail(raw, CTX);

  assert.match(m.bodyText ?? "", /会议主题：只含日历正文的会议/);
  assert.match(m.bodyText ?? "", /会议时间：2026-06-29 08:00 至 2026-06-29 09:00 UTC/);
});

test("normalizeMail extracts attachment metadata without body bytes", async () => {
  const raw: RawImapMessage = {
    uid: 13,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "file",
      messageId: "<att@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: {
      type: "multipart",
      subtype: "mixed",
      childNodes: [
        { type: "text", subtype: "plain", size: 10, part: "1" },
        {
          type: "application",
          subtype: "pdf",
          size: 2048,
          disposition: "attachment",
          dispositionParameters: { filename: "report.pdf" },
          part: "2",
        },
      ],
    },
    source: rfc822({ "Content-Type": "text/plain" }, "see attached"),
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.hasAttachments, true);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!.filename, "report.pdf");
  assert.equal(m.attachments[0]!.mimetype, "application/pdf");
  assert.equal(m.attachments[0]!.size, 2048);
  assert.equal(m.attachments[0]!.disposition, "attachment");
});

test("normalizeMail decodes RFC 2047 attachment filenames", async () => {
  const raw: RawImapMessage = {
    uid: 43,
    envelope: {},
    bodyStructure: {
      type: "multipart",
      subtype: "mixed",
      childNodes: [{
        type: "application",
        subtype: "pdf",
        disposition: "attachment",
        dispositionParameters: {
          filename: "=?UTF-8?Q?=E6=8E=8C=E9=93=B6=E7=A5=A8=E8=AF=81=E7=94=B5?= =?UTF-8?Q?=E5=AD=90=E5=8F=91=E7=A5=A8-1?= =?UTF-8?Q?95.00=E5=85=83.pdf?=",
        },
        size: 2048,
        part: "2",
      }],
    },
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.attachments[0]?.filename, "掌银票证电子发票-195.00元.pdf");
});

test("normalizeMail ignores text attachment parts when extracting bodies", async () => {
  const boundary = "MIXED-PDF";
  const body =
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` +
    `<!doctype html><p>电子发票正文</p>\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; name="invoice.pdf"\r\n` +
    `Content-Disposition: attachment; filename="invoice.pdf"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    `%PDF-1.7\r\n%����\r\n1 0 obj\r\n` +
    `--${boundary}--\r\n`;
  const raw: RawImapMessage = {
    uid: 17,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "invoice",
      messageId: "<invoice@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: {
      type: "multipart",
      subtype: "mixed",
      childNodes: [
        { type: "text", subtype: "html", size: 32, part: "1" },
        {
          type: "text",
          subtype: "plain",
          size: 2048,
          disposition: "attachment",
          dispositionParameters: { filename: "invoice.pdf" },
          part: "2",
        },
      ],
    },
    source: rfc822(
      { "Content-Type": `multipart/mixed; boundary="${boundary}"` },
      body,
    ),
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.bodyText, "");
  assert.equal(m.snippet, "");
  assert.ok(m.bodyHtml?.includes("电子发票正文"));
  assert.ok(!m.bodyText?.includes("%PDF"));
});

test("normalizeMail handles a folded Content-Type header without crashing", async () => {
  const source =
    "Subject: folded\r\n" +
    "Content-Type: text/plain;\r\n" +
    " charset=gb2312\r\n" +
    "Content-Transfer-Encoding: quoted-printable\r\n" +
    "\r\n" +
    "=B2=E2=CA=D4=D6=D0=CE=C4";
  const raw: RawImapMessage = {
    uid: 15,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "folded",
      messageId: "<folded@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: { type: "text", subtype: "plain" },
    source,
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.bodyText, "测试中文");
});

test("normalizeMail extracts multipart body with a folded boundary parameter", async () => {
  const boundary = "folded-boundary";
  const source =
    "Subject: folded multipart\r\n" +
    "Content-Type: multipart/alternative;\r\n" +
    ` boundary="${boundary}"\r\n` +
    "\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: text/plain;\r\n" +
    " charset=gb2312\r\n" +
    "Content-Transfer-Encoding: quoted-printable\r\n" +
    "\r\n" +
    "=B2=E2=CA=D4=D6=D0=CE=C4\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: text/html; charset=utf-8\r\n" +
    "\r\n" +
    "<p>html body</p>\r\n" +
    `--${boundary}--\r\n`;
  const raw: RawImapMessage = {
    uid: 19,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "folded multipart",
      messageId: "<folded-multipart@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: { type: "multipart", subtype: "alternative" },
    source,
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.bodyText, "测试中文");
  assert.ok(m.bodyHtml?.includes("html body"));
});

test("normalizeMail prefers IMAP internalDate over envelope.date for receivedAt", async () => {
  const raw: RawImapMessage = {
    uid: 16,
    internalDate: "2026-04-23T15:30:00.000Z",
    envelope: {
      date: "2026-04-23T10:00:00.000Z",
      subject: "dates",
      messageId: "<dates@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: null,
    source: "Content-Type: text/plain\r\n\r\nbody",
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.receivedAt, "2026-04-23T15:30:00.000Z");
  assert.equal(m.sentAt, "2026-04-23T10:00:00.000Z");
  assert.equal(m.sync.internalDate, "2026-04-23T15:30:00.000Z");
});

test("normalizeMail tolerates missing envelope fields and empty body", async () => {
  const raw: RawImapMessage = {
    uid: 14,
    envelope: {
      date: null,
      subject: null,
      messageId: null,
      from: null,
      to: null,
      cc: null,
      bcc: null,
    },
    bodyStructure: null,
    source: "",
  };
  const m = await normalizeMail(raw, CTX);
  assert.equal(m.subject, "");
  assert.equal(m.from.email, "");
  assert.deepEqual(m.to, []);
  assert.equal(m.bodyText, "");
  assert.equal(m.snippet, "");
  assert.equal(m.hasAttachments, false);
  assert.ok(m.messageId.startsWith("<generated-"));
});

test("normalizeMail captures inline image bytes (base64) with normalized contentId", async () => {
  const outer = "rel-inline";
  const alt = "alt-inline";
  // A real 1x1 PNG, carried base64-encoded as an inline image/png part.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const source = rfc822(
    { "Content-Type": `multipart/related; boundary="${outer}"` },
    `--${outer}\r\n` +
      `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\n` +
      "Content-Type: text/html; charset=utf-8\r\n\r\n" +
      '<p>hi <img src="cid:IMG-1@x"></p>\r\n' +
      `--${alt}--\r\n` +
      `--${outer}\r\n` +
      "Content-Type: image/png\r\n" +
      'Content-Disposition: inline; filename="logo.png"\r\n' +
      "Content-ID: <IMG-1@x>\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      `${pngBase64}\r\n` +
      `--${outer}--\r\n`,
  );
  const raw: RawImapMessage = {
    uid: 77,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "inline",
      messageId: "<inline@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: {
      type: "multipart",
      subtype: "related",
      childNodes: [
        {
          type: "image",
          subtype: "png",
          disposition: "inline",
          dispositionParameters: { filename: "logo.png" },
          id: "<IMG-1@x>",
          part: "2",
        },
      ],
    },
    source,
  };

  const m = await normalizeMail(raw, CTX);

  assert.equal(m.hasAttachments, false);
  assert.ok(m.inlineImages && m.inlineImages.length === 1, "captures the one inline image");
  const img = m.inlineImages![0]!;
  // Content-ID is normalized: angle brackets stripped + lowercased.
  assert.equal(img.contentId, "img-1@x");
  assert.equal(img.mimetype, "image/png");
  // Bytes are the base64-decoded PNG (string content → Buffer.from base64).
  assert.equal(Buffer.compare(Buffer.from(img.bytes), Buffer.from(pngBase64, "base64")), 0);
});

test("normalizeMail skips non-image inline parts when capturing inline images", async () => {
  const outer = "rel-pdf";
  const source = rfc822(
    { "Content-Type": `multipart/related; boundary="${outer}"` },
    `--${outer}\r\n` +
      "Content-Type: text/html; charset=utf-8\r\n\r\n" +
      '<p>see <img src="cid:doc-1"></p>\r\n' +
      `--${outer}\r\n` +
      "Content-Type: application/pdf\r\n" +
      "Content-Disposition: inline\r\n" +
      "Content-ID: <doc-1>\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      Buffer.from("%PDF-1.7 inline-pdf-bytes").toString("base64") +
      "\r\n" +
      `--${outer}--\r\n`,
  );
  const raw: RawImapMessage = {
    uid: 78,
    envelope: {
      date: "2026-04-23T12:00:00Z",
      subject: "inline-pdf",
      messageId: "<inline-pdf@example.com>",
      from: [{ address: "a@x.com" }],
      to: [{ address: "b@x.com" }],
    },
    bodyStructure: { type: "multipart", subtype: "related" },
    source,
  };

  const m = await normalizeMail(raw, CTX);

  // image/* filter excludes the inline PDF: nothing captured for pre-seeding.
  assert.equal(m.inlineImages?.length ?? 0, 0);
});
