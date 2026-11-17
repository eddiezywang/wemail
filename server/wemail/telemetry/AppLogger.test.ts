import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createAppLogger,
  logFileName,
  redact,
  REDACTED_KEYS,
  REDACTED_PLACEHOLDER,
} from "./AppLogger.js";
import { LOG_FORBIDDEN_KEYS } from "../personalization/PromptBuilder.js";
import { FORBIDDEN_PAYLOAD_KEYS } from "../feedback/AiFeedbackEventRepository.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wemail-applogger-${prefix}-`));
}

test("redact deeply replaces body-ish and credential keys", () => {
  const out = redact({
    mail: {
      subject: "hi",
      bodyText: "secret mail body",
      bodyHtml: "<p>secret</p>",
      attachments: [{ name: "a.pdf", content: "binary" }],
    },
    auth: { password: "p1", token: "t1", apiKey: "k1", secret: "s1" },
    nested: { body: "nope", content: "nope", safe: 1 },
    rfc822: "full raw...",
  }) as Record<string, unknown>;

  const mail = out.mail as Record<string, unknown>;
  assert.equal(mail.subject, "hi");
  assert.equal(mail.bodyText, REDACTED_PLACEHOLDER);
  assert.equal(mail.bodyHtml, REDACTED_PLACEHOLDER);
  const atts = mail.attachments as Record<string, unknown>[];
  assert.equal(atts[0]!.name, "a.pdf");
  assert.equal(atts[0]!.content, REDACTED_PLACEHOLDER);
  const auth = out.auth as Record<string, unknown>;
  assert.equal(auth.password, REDACTED_PLACEHOLDER);
  assert.equal(auth.token, REDACTED_PLACEHOLDER);
  assert.equal(auth.apiKey, REDACTED_PLACEHOLDER);
  assert.equal(auth.secret, REDACTED_PLACEHOLDER);
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.body, REDACTED_PLACEHOLDER);
  assert.equal(nested.content, REDACTED_PLACEHOLDER);
  assert.equal(nested.safe, 1);
  assert.equal(out.rfc822, REDACTED_PLACEHOLDER);
});

test("redact handles cycles, Date and Error", () => {
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = cycle;
  const out = redact({
    when: new Date("2026-01-02T03:04:05Z"),
    err: new Error("boom"),
    cycle,
  }) as Record<string, unknown>;
  assert.equal(out.when, "2026-01-02T03:04:05.000Z");
  const err = out.err as Record<string, unknown>;
  assert.equal(err.message, "boom");
  const c = out.cycle as Record<string, unknown>;
  assert.equal(c.self, "[Circular]");
});

test("createAppLogger writes JSON lines through injected writer and redacts", () => {
  const writes: { line: string; file: string }[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    now: () => new Date("2026-04-24T10:00:00Z"),
    writer: (line, file) => writes.push({ line, file }),
  });

  logger.info("mail.synced", { count: 3, mail: { bodyText: "secret" } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.file, "app-2026-04-24.log");
  const parsed = JSON.parse(writes[0]!.line);
  assert.equal(parsed.event, "mail.synced");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.count, 3);
  assert.equal(parsed.mail.bodyText, REDACTED_PLACEHOLDER);
  assert.equal(parsed.ts, "2026-04-24T10:00:00.000Z");
});

test("createAppLogger filters levels via minLevel", () => {
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    minLevel: "warn",
    now: () => new Date("2026-04-24T10:00:00Z"),
    writer: (line) => writes.push(line),
  });
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  const events = writes.map((l) => (JSON.parse(l) as { event: string }).event);
  assert.deepEqual(events, ["w", "e"]);
});

test("production policy demotes routine events and bounds diagnostic payloads", () => {
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    debugEnabled: true,
    now: () => new Date("2026-04-24T10:00:00Z"),
    writer: (line) => writes.push(line),
  });

  logger.info("retention.run");
  logger.debug("diagnostic.payload", {
    text: "x".repeat(2_000),
    entries: Array.from({ length: 100 }, (_, index) => index),
  });

  const routine = JSON.parse(writes[0]!) as Record<string, unknown>;
  assert.equal(routine.level, "debug");
  const payload = JSON.parse(writes[1]!) as {
    text: string;
    entries: unknown[];
  };
  assert.ok(payload.text.length <= 512);
  assert.equal(payload.entries.length, 65);
});

test("legacy intelligence success is debug while failures remain visible", () => {
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    debugEnabled: true,
    now: () => new Date("2026-04-24T10:00:00Z"),
    writer: (line) => writes.push(line),
  });
  const sink = logger.asMessageSink("intel.summary");
  sink("summary-ok");
  sink("summary failed");

  assert.equal(JSON.parse(writes[0]!).level, "debug");
  assert.equal(JSON.parse(writes[1]!).level, "warn");
});

test("debug mode temporarily enables debug logs and expires", () => {
  let current = new Date("2026-04-24T10:00:00Z");
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    now: () => current,
    writer: (line) => writes.push(line),
  });

  logger.debug("before");
  const enabled = logger.setDebugMode(true, 1_000);
  logger.debug("during");
  current = new Date("2026-04-24T10:00:02Z");
  logger.debug("after");

  assert.equal(enabled.debugEnabled, true);
  assert.deepEqual(writes.map((line) => JSON.parse(line).event), ["during"]);
  assert.equal(logger.getDiagnostics().debugEnabled, false);
});

test("startup debug mode keeps debug logs enabled for the process lifetime", () => {
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    debugEnabled: true,
    now: () => new Date("2026-04-24T10:00:00Z"),
    writer: (line) => writes.push(line),
  });

  logger.debug("startup.debug");

  assert.equal(writes.length, 1);
  assert.equal(logger.getDiagnostics().debugEnabled, true);
  assert.equal(logger.getDiagnostics().expiresAt, null);
});

test("repeated errors are suppressed and report the suppressed count", () => {
  let current = new Date("2026-04-24T10:00:00Z");
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    now: () => current,
    writer: (line) => writes.push(line),
  });
  logger.warn("mail.failed", { accountId: "acct-1", error: "offline" });
  logger.warn("mail.failed", { accountId: "acct-1", error: "offline" });
  current = new Date("2026-04-24T10:01:01Z");
  logger.warn("mail.failed", { accountId: "acct-1", error: "offline" });

  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1]!).suppressedCount, 1);
});

test("createAppLogger rotates by day: different files on different dates", () => {
  let current = new Date("2026-04-24T23:00:00Z");
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    now: () => current,
    writer: (_line, file) => writes.push(file),
  });
  logger.info("a");
  current = new Date("2026-04-25T00:30:00Z");
  logger.info("b");
  current = new Date("2026-04-26T12:00:00Z");
  logger.info("c");
  assert.deepEqual(writes, [
    "app-2026-04-24.log",
    "app-2026-04-25.log",
    "app-2026-04-26.log",
  ]);
});

test("createAppLogger default writer appends to baseDir file", () => {
  const dir = tmpDir("write");
  const logger = createAppLogger({
    baseDir: dir,
    now: () => new Date("2026-04-24T10:00:00Z"),
  });
  logger.info("hello", { n: 1 });
  logger.warn("uh", { body: "should not appear" });
  const file = path.join(dir, "app-2026-04-24.log");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]!).body, REDACTED_PLACEHOLDER);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createAppLogger removes app logs older than the retention window", () => {
  const dir = tmpDir("retention");
  const now = new Date("2026-04-24T10:00:00Z");
  const expired = path.join(dir, "app-2026-04-16.log");
  const retained = path.join(dir, "app-2026-04-18.log");
  try {
    fs.writeFileSync(expired, "expired\n", "utf8");
    fs.writeFileSync(retained, "retained\n", "utf8");
    fs.utimesSync(expired, now, new Date(now.getTime() - 8 * 86_400_000));
    fs.utimesSync(retained, now, new Date(now.getTime() - 6 * 86_400_000));

    createAppLogger({ baseDir: dir, now: () => now, writer: () => {} });

    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(retained), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createAppLogger rotates a file when the size limit is reached", () => {
  const dir = tmpDir("size-rotation");
  const logger = createAppLogger({
    baseDir: dir,
    maxFileBytes: 120,
    now: () => new Date("2026-04-24T10:00:00Z"),
  });
  logger.info("first", { value: "a".repeat(40) });
  logger.info("second", { value: "b".repeat(40) });
  assert.equal(fs.existsSync(path.join(dir, "app-2026-04-24.log")), true);
  assert.equal(fs.existsSync(path.join(dir, "app-2026-04-24.1.log")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("asMessageSink emits info with message field", () => {
  const writes: string[] = [];
  const logger = createAppLogger({
    baseDir: "/unused",
    now: () => new Date("2026-04-24T10:00:00Z"),
    writer: (l) => writes.push(l),
  });
  const sink = logger.asMessageSink("mail.bus");
  sink("processed 3 jobs");
  const rec = JSON.parse(writes[0]!);
  assert.equal(rec.level, "info");
  assert.equal(rec.event, "mail.bus");
  assert.equal(rec.message, "processed 3 jobs");
});

test("logFileName format is stable", () => {
  assert.equal(logFileName(new Date("2026-04-24T00:00:00Z")), "app-2026-04-24.log");
  assert.equal(logFileName(new Date("2026-01-02T23:59:59Z")), "app-2026-01-02.log");
});

test("normal logs reject Agent content and absolute paths", () => {
  const redacted = redact({
    prompt: "private prompt",
    assistantOutput: "private answer",
    toolInput: { emailId: "mail-1" },
    attachmentText: "private attachment",
    Authorization: "Bearer secret",
    path: "C:\\Users\\alice\\mail.txt",
  }) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("private prompt"), false);
  assert.equal(serialized.includes("private answer"), false);
  assert.equal(serialized.includes("private attachment"), false);
  assert.equal(serialized.includes("Bearer secret"), false);
  assert.equal(serialized.includes("alice"), false);
});

// Round-8 suggestion 7: the generic redact() walks every log record, so
// REDACTED_KEYS must cover the UNION of the two never-log key sets
// (PromptBuilder.LOG_FORBIDDEN_KEYS + AiFeedbackEventRepository
// .FORBIDDEN_PAYLOAD_KEYS). feedbackText / originalText / editedText were
// previously missing and passed through verbatim.
test("redact covers every sensitive key from both never-log sets (parameterized)", () => {
  const neverLogKeys = [...new Set([...LOG_FORBIDDEN_KEYS, ...FORBIDDEN_PAYLOAD_KEYS])];
  assert.ok(neverLogKeys.length >= 14, "both sets contribute keys");
  for (const key of neverLogKeys) {
    assert.ok(REDACTED_KEYS.has(key), `REDACTED_KEYS must contain "${key}"`);
  }
  for (const key of neverLogKeys) {
    const out = redact({ [key]: "sensitive value" }) as Record<string, unknown>;
    assert.equal(out[key], REDACTED_PLACEHOLDER, `"${key}" must redact to the placeholder`);
  }
  // Case-insensitive matching (as documented in redact).
  const mixed = redact({ FeedbackText: "sensitive value" }) as Record<string, unknown>;
  assert.equal(mixed.FeedbackText, REDACTED_PLACEHOLDER);
});

test("diagnostic mode is capped at 24 hours and export remains local and redacted", () => {
  const dir = tmpDir("diagnostics");
  const now = new Date("2026-08-02T00:00:00.000Z");
  try {
    const logger = createAppLogger({ baseDir: dir, now: () => now });
    const diagnostics = logger.setDebugMode(true, 72 * 60 * 60_000);
    assert.equal(diagnostics.expiresAt, "2026-08-03T00:00:00.000Z");
    logger.info("agent.test", { prompt: "private", accountId: "account-a" });
    const exported = logger.exportDiagnosticPackage!();
    const payload = fs.readFileSync(exported.filePath, "utf8");
    assert.equal(payload.includes("private"), false);
    assert.equal(payload.includes('"uploaded": false'), true);
    assert.equal(exported.expiresAt, "2026-08-09T00:00:00.000Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
