/**
 * PiiResidualScanner — fail-closed gatekeeper for redacted corpus.
 *
 * Runs after `PiiRedactor` and looks for things the redactor *should*
 * have caught: real-looking emails, phone-looking digit clusters,
 * non-replaced public hostnames, high-entropy tokens that look like
 * OAuth codes, etc.
 *
 * Any hit means the corpus file fails the fail-closed check — the
 * extraction CLI quarantines it and refuses to write the output.
 * The eval harness also re-runs this on every corpus sample at the
 * start of a run with an external judge: a failure cancels the run
 * to keep real PII out of the third-party API.
 */

import type { MailSampleEntry } from "../../../testing/mailSamples.js";

export type ResidualKind =
  | "email"
  | "phone"
  | "real-host"
  | "high-entropy-token"
  | "chat-id"
  | "cn-name-suspect";

export interface ResidualHit {
  kind: ResidualKind;
  sample: string; // ≤80 chars context
  field: string; // which field was flagged
}

export interface ResidualScanResult {
  ok: boolean;
  hits: ResidualHit[];
}

const RE_REAL_EMAIL = /[\w.+-]+@(?!example\.test\b)[\w-]+\.[\w.-]{2,}/gi;
const RE_PHONE = /(?<!REDACTED-?TOKEN[\w-]*)\b\d{3}[-.\s]\d{3,4}[-.\s]\d{4}\b/g;
const RE_LONG_DIGIT_RUN = /\b\d{11,}\b/g;
const RE_REAL_HOST =
  /\bhttps?:\/\/(?!host\d+\.example\.test\b)[\w-]+(?:\.[\w-]+)+\b/gi;
const RE_HIGH_ENTROPY = /\b[a-zA-Z0-9_-]{32,}\b/g;
const RE_CHAT_ID = /\b(?:wx_[\w-]{6,}|@U[A-Z0-9]{6,}|ou_[\w-]{6,})\b/g;
// Match surname + 1-2 char given. We accept trailing CJK because
// JavaScript \b is ASCII-only; over-flagging is preferable to a
// missed leak. The redactor's COMMON_NON_NAMES list keeps obvious
// compounds (王朝, 张力, ...) from spuriously tripping the gate.
const RE_CHINESE_NAME = /(?<![一-鿿])([王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈][一-鿿]{1,2})/g;
const COMMON_NON_NAMES = new Set(["王朝", "王国", "李子", "张力", "刘海"]);

const TRUNC = 80;

function pushHit(
  out: ResidualHit[],
  kind: ResidualKind,
  field: string,
  match: string,
  haystack: string,
): void {
  const idx = haystack.indexOf(match);
  const start = Math.max(0, idx - 20);
  const end = Math.min(haystack.length, idx + match.length + 20);
  out.push({ kind, field, sample: haystack.slice(start, end).slice(0, TRUNC) });
}

export function scanString(field: string, value: string): ResidualHit[] {
  const out: ResidualHit[] = [];
  if (!value) return out;
  for (const m of value.matchAll(RE_REAL_EMAIL)) {
    pushHit(out, "email", field, m[0], value);
  }
  for (const m of value.matchAll(RE_PHONE)) {
    pushHit(out, "phone", field, m[0], value);
  }
  for (const m of value.matchAll(RE_LONG_DIGIT_RUN)) {
    // Skip if it looks like a number embedded in a redaction-safe path
    // (e.g. attachment-12345.png — the redactor uses small N).
    if (m[0].length < 11) continue;
    pushHit(out, "phone", field, m[0], value);
  }
  for (const m of value.matchAll(RE_REAL_HOST)) {
    pushHit(out, "real-host", field, m[0], value);
  }
  for (const m of value.matchAll(RE_HIGH_ENTROPY)) {
    // Allow placeholders we know are safe.
    if (m[0] === "REDACTED-TOKEN") continue;
    pushHit(out, "high-entropy-token", field, m[0], value);
  }
  for (const m of value.matchAll(RE_CHAT_ID)) {
    pushHit(out, "chat-id", field, m[0], value);
  }
  for (const m of value.matchAll(RE_CHINESE_NAME)) {
    if (COMMON_NON_NAMES.has(m[0])) continue;
    pushHit(out, "cn-name-suspect", field, m[0], value);
  }
  return out;
}

export function scanSample(sample: MailSampleEntry): ResidualScanResult {
  const hits: ResidualHit[] = [];
  const m = sample.mail;
  if (m.subject) hits.push(...scanString("subject", m.subject));
  if (m.snippet) hits.push(...scanString("snippet", m.snippet));
  if (m.bodyText) hits.push(...scanString("bodyText", m.bodyText));
  if (m.bodyHtml) hits.push(...scanString("bodyHtml", m.bodyHtml));
  if (m.from?.email) hits.push(...scanString("from.email", m.from.email));
  if (m.from?.name) hits.push(...scanString("from.name", m.from.name));
  for (const addr of m.to ?? []) {
    if (addr.email) hits.push(...scanString("to.email", addr.email));
    if (addr.name) hits.push(...scanString("to.name", addr.name));
  }
  for (const addr of m.cc ?? []) {
    if (addr.email) hits.push(...scanString("cc.email", addr.email));
    if (addr.name) hits.push(...scanString("cc.name", addr.name));
  }
  for (const a of m.attachments ?? []) {
    if (a.filename) hits.push(...scanString("attachment.filename", a.filename));
  }
  return { ok: hits.length === 0, hits };
}

/* ----------------------- Quarantine report ----------------------- */

export function renderQuarantineMarkdown(args: {
  filePath: string;
  sampleId: string;
  result: ResidualScanResult;
}): string {
  const lines: string[] = [];
  lines.push(`# PII residual scan failed — ${args.sampleId}`);
  lines.push("");
  lines.push(`**Source**: \`${args.filePath}\``);
  lines.push(`**Hits**: ${args.result.hits.length}`);
  lines.push("");
  lines.push("## Suspect spans");
  lines.push("");
  lines.push(`| Kind | Field | Sample (truncated) |`);
  lines.push(`|---|---|---|`);
  for (const h of args.result.hits.slice(0, 50)) {
    lines.push(
      `| \`${h.kind}\` | ${h.field} | ${h.sample.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    );
  }
  lines.push("");
  lines.push(
    "**Action**: extend `PiiRedactor` rules to cover these spans, then re-run extraction. The corpus file was NOT written.",
  );
  return lines.join("\n");
}
