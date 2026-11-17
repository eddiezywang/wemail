import type {
  InlineImageCapture,
  MailAttachment,
  MailFlags,
  MailMessage,
  NormalizeMailFn,
  RawImapMessage,
  WemailAddress,
} from "../../../shared/wemail/mail.js";
import {
  hasDownloadableAttachments,
  isInlineImage,
  normalizeContentId,
} from "../../../shared/wemail/mail.js";
import PostalMime, { decodeWords } from "postal-mime";

const SNIPPET_MAX = 240;
const BODY_CACHE_FOREVER = "9999-12-31T23:59:59.999Z";
// PostalMime holds all attachment content in memory during parse (~8× source).
// Above this threshold, skip it and use the lightweight extractor (only
// extracts text/html, no attachment content → ~3× source).
const POSTAL_MIME_MAX_SOURCE_CHARS = 2 * 1024 * 1024;
// Inline image pre-cache caps: bound the PostalMime heap cost (it materializes
// every attachment's bytes) AND the worker→mail-core structured-clone cost.
// Applied BEFORE bytes are emitted, so over-large images are skipped outright.
const INLINE_IMAGE_MAX_BYTES = 256 * 1024;
const INLINE_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;

interface BodyStructureNode {
  type?: string;
  subtype?: string;
  mimeType?: string;
  disposition?: string | null;
  dispositionParameters?: Record<string, string> | null;
  parameters?: Record<string, string> | null;
  id?: string | null;
  size?: number;
  childNodes?: BodyStructureNode[];
  part?: string;
}

/**
 * Phase-one IMAP → {@link MailMessage} normalizer.
 *
 * Policy:
 *  - Subject, envelope addresses, and dates are parsed defensively;
 *    missing fields become sensible empty defaults so downstream code
 *    can rely on non-null string/array shapes.
 *  - Body is extracted from `source` (raw RFC822). We decode a best-effort
 *    text/plain and text/html. No prompt-injection scrubbing here — see
 *    design.md §Risks: the normalizer preserves raw body and lets
 *    downstream prompt builders handle safety.
 *  - Attachments yield metadata ONLY (filename, mimetype, size). Bytes
 *    are deferred until explicitly requested — phase-one inbox sync does
 *    not hydrate attachment payloads.
 *  - Snippet is the first ~240 chars of text, CJK-safe (we slice on code
 *    units but never trim inside a surrogate pair).
 *  - The id is deterministic: `${accountId}:${folder}:${uidValidity}:${uid}`,
 *    so re-sync produces the same row and upsert is idempotent.
 */
export const normalizeMail: NormalizeMailFn = (
  input: RawImapMessage,
  context: { accountId: string; folder: string; uidValidity: number },
): Promise<MailMessage> => {
  return normalizeMailImpl(input, context);
};

async function normalizeMailImpl(
  input: RawImapMessage,
  context: { accountId: string; folder: string; uidValidity: number },
): Promise<MailMessage> {
  const { envelope } = input;
  const subject = typeof envelope.subject === "string" ? envelope.subject : "";
  const from = mapAddress(envelope.from?.[0]) ?? { email: "" };
  const to = mapList(envelope.to);
  const cc = mapList(envelope.cc);
  const bcc = mapList(envelope.bcc);

  const source = sourceToString(input.source);
  const { bodyText, bodyHtml, inlineImages } = input.source === undefined
    ? { bodyText: "", bodyHtml: "", inlineImages: [] as InlineImageCapture[] }
    : await extractBodies(input.source, source);
  const snippet = buildSnippet(bodyText);
  const attachments = collectAttachments(input.bodyStructure);

  const internalDateIso = toIso(input.internalDate);
  const sentAt = toIso(envelope.date);
  // Canonical receivedAt prefers the server-assigned internalDate (arrival
  // time) over the sender-declared Date header. Falls back to envelope.date
  // then epoch so downstream storage never sees a null timestamp.
  const receivedAt = internalDateIso ?? sentAt ?? new Date(0).toISOString();
  const messageId =
    typeof envelope.messageId === "string" && envelope.messageId.length > 0
      ? envelope.messageId
      : `<generated-${context.uidValidity}-${input.uid}@wemail.local>`;

  const id = `${context.accountId}:${context.folder}:${context.uidValidity}:${input.uid}`;

  const flags = normalizeFlags(input.flags);

  const message: MailMessage = {
    id,
    source: "provider",
    accountId: context.accountId,
    folder: context.folder,
    messageId,
    // threadId is intentionally omitted in phase one — IMAP envelope.inReplyTo
    // points at the parent message, not a thread. We surface it as
    // `parentMessageId` so downstream threading (a later package) can build
    // threads without inheriting a misleading value here.
    parentMessageId:
      typeof envelope.inReplyTo === "string" && envelope.inReplyTo.length > 0
        ? envelope.inReplyTo
        : undefined,
    from,
    to,
    cc,
    bcc,
    subject,
    snippet,
    bodyText,
    bodyHtml: bodyHtml || undefined,
    bodyCachedUntil: input.source === undefined ? null : BODY_CACHE_FOREVER,
    receivedAt,
    sentAt,
    hasAttachments: hasDownloadableAttachments(attachments),
    attachments,
    // Transient: inline image bytes for cache pre-seeding. Only attached when
    // non-empty so legacy messages (and the lightweight >2MB path) stay clean.
    ...(inlineImages.length > 0 ? { inlineImages } : {}),
    flags,
    sync: {
      uid: input.uid,
      uidValidity: context.uidValidity,
      internalDate: internalDateIso ?? receivedAt,
      flagsAuthoritative: input.flags !== undefined && input.flags !== null,
    },
  };

  return message;
}

function mapAddress(
  addr: { name?: string | null; address?: string | null } | undefined | null,
): WemailAddress | null {
  if (!addr) return null;
  const email = addr.address ?? "";
  const out: WemailAddress = { email };
  if (addr.name) out.name = addr.name;
  return out;
}

function mapList(
  list: Array<{ name?: string | null; address?: string | null }> | null | undefined,
): WemailAddress[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(mapAddress)
    .filter((x): x is WemailAddress => x !== null && x.email.length > 0);
}

function normalizeFlags(input: Iterable<string> | null | undefined): MailFlags {
  const flags = new Set(
    Array.from(input ?? [], (flag) => String(flag).trim().toLowerCase()),
  );
  return {
    seen: flags.has("\\seen"),
    flagged: flags.has("\\flagged"),
    answered: flags.has("\\answered"),
    draft: flags.has("\\draft"),
  };
}

function toIso(v: string | Date | null | undefined): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function sourceToString(source: Buffer | Uint8Array | string | undefined): string {
  if (source === undefined) return "";
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("latin1");
  return String(source);
}

/**
 * Very small RFC 5322 / MIME body extractor. imapflow can also fetch
 * decoded parts directly (and the provider does for complex payloads);
 * this path handles the already-fetched `source` blob that normalizer
 * tests and the live IMAP client both feed us. It intentionally stays
 * self-contained so the normalizer has no network side-effects.
 *
 * Phase-one known limitations (documented intentionally; upgrade path is
 * to swap in `mailparser` when a later package takes on the dependency):
 *   - Multipart boundary handling uses a naive `split("--" + boundary)`
 *     rather than a state machine, so adversarial payloads with the
 *     boundary string inside a part's body can desync.
 *   - Raw JavaScript string fixtures with literal non-ASCII body text
 *     are treated as already-decoded text. Live IMAP sources arrive as
 *     bytes, so charset decoding is applied there before persistence.
 */
async function extractBodies(
  rawSource: NonNullable<RawImapMessage["source"]>,
  source: string,
): Promise<{
  bodyText: string;
  bodyHtml: string;
  inlineImages: InlineImageCapture[];
}> {
  const fallback = extractBodiesLightweight(source);
  // Skip PostalMime for large sources — it allocates all attachment content
  // (even base64 strings) into the parsed result, causing ~8× heap expansion.
  // The lightweight extractor only pulls text/html (no attachment bytes), so
  // inline image pre-caching is not available for >2MB sources (falls back to
  // the on-demand path on first open — acceptable per the no-backfill decision).
  if (source.length > POSTAL_MIME_MAX_SOURCE_CHARS) {
    return { ...fallback, inlineImages: [] };
  }
  try {
    const parsed = await PostalMime.parse(sourceToPostalRaw(rawSource), {
      attachmentEncoding: "base64",
    });
    const parsedText = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const parsedHtml = typeof parsed.html === "string" ? parsed.html.trim() : "";
    if (fallback.bodyText && isCalendarSource(source) && !fallback.bodyHtml) {
      return { bodyText: fallback.bodyText, bodyHtml: parsedHtml, inlineImages: [] };
    }
    if (!parsedText && !parsedHtml) return { ...fallback, inlineImages: [] };
    return {
      bodyText: parsedText || fallback.bodyText,
      bodyHtml: parsedHtml || fallback.bodyHtml,
      inlineImages: collectInlineImages(parsed.attachments),
    };
  } catch {
    return { ...fallback, inlineImages: [] };
  }
}

/**
 * Pull inline-image bytes out of PostalMime's parsed attachments so they can
 * pre-seed the disk cache. Image-only (`isInlineImage`), requires a
 * normalizable Content-ID (the renderer rewrites `cid:` by contentId and the
 * seed matches bytes→public-id by contentId), and enforces per-image +
 * per-message byte caps before emitting — PostalMime has already materialized
 * every attachment's content into the worker heap, so the caps only govern
 * what we forward, but they bound the worker→mail-core structured-clone cost.
 *
 * `attachmentEncoding: "base64"` means `content` is a base64 STRING here (not a
 * Buffer); other PostalMime modes return ArrayBuffer. Both are normalized.
 */
function collectInlineImages(attachments: unknown): InlineImageCapture[] {
  const out: InlineImageCapture[] = [];
  if (!Array.isArray(attachments)) return out;
  let total = 0;
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") continue;
    const att = raw as {
      mimeType?: string | null;
      disposition?: string | null;
      contentId?: string | null;
      content?: unknown;
    };
    // postal-mime spells it `mimeType` (camelCase); isInlineImage reads the
    // MailAttachment `mimetype` field, so map explicitly.
    if (
      !isInlineImage({
        mimetype: att.mimeType,
        disposition: att.disposition,
        contentId: att.contentId,
      })
    ) {
      continue;
    }
    const cid = normalizeContentId(att.contentId);
    if (!cid) continue;
    const bytes = bytesFromContent(att.content);
    if (bytes.byteLength === 0 || bytes.byteLength > INLINE_IMAGE_MAX_BYTES) continue;
    if (total + bytes.byteLength > INLINE_MESSAGE_MAX_BYTES) break;
    total += bytes.byteLength;
    out.push({
      contentId: cid,
      mimetype: (att.mimeType ?? "application/octet-stream").toLowerCase(),
      bytes,
    });
  }
  return out;
}

function bytesFromContent(content: unknown): Buffer {
  if (typeof content === "string") return Buffer.from(content, "base64");
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) {
    const view = content as Uint8Array;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return Buffer.alloc(0);
}

function extractBodiesLightweight(source: string): { bodyText: string; bodyHtml: string } {
  if (!source) return { bodyText: "", bodyHtml: "" };

  const headerEnd = findHeaderEnd(source);
  const headers = unfoldHeaders(source.slice(0, headerEnd));
  const body = source.slice(headerEnd);

  if (isAttachmentPart(headers)) {
    return { bodyText: "", bodyHtml: "" };
  }

  const contentType = parseContentType(headers);
  const transferEncoding = (headers.match(/^Content-Transfer-Encoding:\s*([^\r\n]+)/im)?.[1] ?? "").toLowerCase().trim();
  const topMime = contentType.mimeType;
  const boundary = contentType.params.boundary;
  const charset = contentType.params.charset;

  if (topMime.startsWith("multipart/") && boundary) {
    const parts = splitMultipart(body, boundary);
    let bodyText = "";
    let bodyHtml = "";
    for (const part of parts) {
      const sub = extractBodiesLightweight(part);
      if (sub.bodyText && !bodyText) bodyText = sub.bodyText;
      if (sub.bodyHtml && !bodyHtml) bodyHtml = sub.bodyHtml;
    }
    return { bodyText, bodyHtml };
  }

  const decoded = decodeTransfer(body.replace(/^\r?\n/, ""), transferEncoding, charset);
  if (topMime === "text/html") return { bodyText: "", bodyHtml: decoded };
  if (topMime === "text/plain") return { bodyText: decoded, bodyHtml: "" };
  if (isCalendarMime(topMime)) {
    return { bodyText: renderCalendarBody(decoded), bodyHtml: "" };
  }
  // Unknown content-type (e.g. a raw attachment part): leave bodies empty;
  // attachment metadata still flows through `collectAttachments`.
  return { bodyText: "", bodyHtml: "" };
}

function sourceToPostalRaw(source: NonNullable<RawImapMessage["source"]>): string | Uint8Array {
  return typeof source === "string" ? source : source;
}

function isCalendarSource(source: string): boolean {
  return /Content-Type:\s*(?:text\/calendar|text\/x-vcalendar|application\/ics)/i.test(source);
}

function isCalendarMime(mimeType: string): boolean {
  return mimeType === "text/calendar" || mimeType === "text/x-vcalendar" || mimeType === "application/ics";
}

function renderCalendarBody(body: string): string {
  const props = parseCalendarProperties(body);
  const summary = firstCalendarValue(props, "SUMMARY");
  const startsAt = firstCalendarValue(props, "DTSTART");
  const endsAt = firstCalendarValue(props, "DTEND");
  const location = firstCalendarValue(props, "LOCATION");
  const organizer = firstCalendarValue(props, "ORGANIZER");
  const description = firstCalendarValue(props, "DESCRIPTION");
  const url = firstCalendarValue(props, "URL");
  const attendees = allCalendarValues(props, "ATTENDEE");

  const lines: string[] = [];
  if (summary) lines.push(`会议主题：${summary.value}`);
  if (startsAt) {
    const startZone = calendarTimezoneSuffix(startsAt.value, startsAt.params);
    const endZone = endsAt ? calendarTimezoneSuffix(endsAt.value, endsAt.params) : "";
    const sameZone = Boolean(endsAt && startZone && startZone === endZone);
    const startText = formatCalendarDate(startsAt.value, startsAt.params, !sameZone);
    const endText = endsAt ? formatCalendarDate(endsAt.value, endsAt.params, !sameZone) : "";
    const zoneText = sameZone ? startZone : "";
    lines.push(endText ? `会议时间：${startText} 至 ${endText}` : `会议时间：${startText}`);
    if (zoneText) lines[lines.length - 1] += zoneText;
  }
  if (location) lines.push(`会议地点：${location.value}`);
  if (organizer) lines.push(`组织者：${formatCalendarPerson(organizer)}`);
  if (attendees.length > 0) {
    lines.push(`参会人：${attendees.map(formatCalendarPerson).join("；")}`);
  }
  if (description) lines.push(`会议说明：${description.value}`);
  if (url) lines.push(`会议链接：${url.value}`);

  return lines.join("\n");
}

interface CalendarProperty {
  key: string;
  params: Record<string, string>;
  value: string;
}

function parseCalendarProperties(body: string): CalendarProperty[] {
  const unfolded = body.replace(/\r?\n[ \t]/g, "");
  const out: CalendarProperty[] = [];
  for (const rawLine of unfolded.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const nameAndParams = line.slice(0, colon);
    const [rawKey = "", ...rawParams] = nameAndParams.split(";");
    const key = rawKey.toUpperCase();
    if (!key) continue;
    const params: Record<string, string> = {};
    for (const rawParam of rawParams) {
      const eq = rawParam.indexOf("=");
      if (eq < 0) continue;
      const paramKey = rawParam.slice(0, eq).trim().toUpperCase();
      let paramValue = rawParam.slice(eq + 1).trim();
      if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
        paramValue = paramValue.slice(1, -1);
      }
      if (paramKey && paramValue) params[paramKey] = unescapeCalendarValue(paramValue);
    }
    out.push({
      key,
      params,
      value: unescapeCalendarValue(line.slice(colon + 1)),
    });
  }
  return out;
}

function firstCalendarValue(
  props: CalendarProperty[],
  key: string,
): CalendarProperty | undefined {
  return props.find((prop) => prop.key === key);
}

function allCalendarValues(props: CalendarProperty[], key: string): CalendarProperty[] {
  return props.filter((prop) => prop.key === key);
}

function unescapeCalendarValue(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function formatCalendarPerson(prop: CalendarProperty): string {
  const email = prop.value.replace(/^mailto:/i, "");
  const name = prop.params.CN;
  if (name && email && name !== email) return `${name} <${email}>`;
  return email || name || prop.value;
}

function formatCalendarDate(
  value: string,
  params: Record<string, string>,
  includeTimezone = true,
): string {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return value;
  const [, year, month, day, hour, minute, , utcMarker] = match;
  if (!hour || !minute) return `${year}-${month}-${day}`;
  const suffix = includeTimezone ? calendarTimezoneSuffix(value, params) : "";
  return `${year}-${month}-${day} ${hour}:${minute}${suffix}`;
}

function calendarTimezoneSuffix(value: string, params: Record<string, string>): string {
  if (value.endsWith("Z")) return " UTC";
  return params.TZID ? ` ${params.TZID}` : "";
}

function unfoldHeaders(headers: string): string {
  return headers.replace(/\r?\n[ \t]+/g, " ");
}

function isAttachmentPart(headers: string): boolean {
  const disposition = headers
    .match(/^Content-Disposition:\s*([^\r\n]+)/im)?.[1]
    ?.toLowerCase() ?? "";
  if (disposition.includes("attachment")) return true;
  return disposition.includes("filename=");
}

function parseContentType(headers: string): {
  mimeType: string;
  params: Record<string, string>;
} {
  const raw = headers.match(/^Content-Type:\s*([^\r\n]+)/im)?.[1] ?? "text/plain";
  const parts = raw.split(";");
  const mimeType = (parts.shift() ?? "text/plain").toLowerCase().trim();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (key && value) params[key] = value;
  }
  return { mimeType, params };
}

function findHeaderEnd(source: string): number {
  const crlf = source.indexOf("\r\n\r\n");
  if (crlf >= 0) return crlf + 4;
  const lf = source.indexOf("\n\n");
  if (lf >= 0) return lf + 2;
  return 0;
}

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const segments = body.split(marker);
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg.startsWith("--")) continue; // prologue, epilogue, final "--"
    out.push(seg.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }
  return out;
}

function decodeTransfer(body: string, encoding: string, charset?: string): string {
  if (!body) return "";
  if (encoding === "base64") {
    try {
      return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return decodeBytes(decodeQuotedPrintable(body), charset);
  }
  return decodeBytes(stringToBytes(body), charset);
}

function decodeQuotedPrintable(body: string): Buffer {
  // Join soft line breaks, then decode =XX hex escapes.
  const joined = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i);
    if (ch === 0x3d /* = */ && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (ch > 0xff) {
      bytes.push(...Buffer.from(joined[i]!, "utf8"));
    } else {
      bytes.push(ch);
    }
  }
  return Buffer.from(bytes);
}

function stringToBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0xff) {
      return Buffer.from(value, "utf8");
    }
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

function decodeBytes(bytes: Buffer, charset = "utf-8"): string {
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function normalizeCharset(charset: string): string {
  const label = charset.trim().toLowerCase();
  if (label === "gb2312" || label === "gbk" || label === "cp936") {
    return "gb18030";
  }
  if (label === "utf8") return "utf-8";
  return label || "utf-8";
}

function buildSnippet(bodyText: string): string {
  if (!bodyText) return "";
  const flat = bodyText.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  // Avoid splitting a surrogate pair by walking back one code unit if
  // the slice ends on a high surrogate.
  let end = SNIPPET_MAX;
  const code = flat.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return flat.slice(0, end);
}

function collectAttachments(bodyStructure: unknown): MailAttachment[] {
  const out: MailAttachment[] = [];
  walk(bodyStructure as BodyStructureNode | null | undefined, out);
  return out;
}

function walk(node: BodyStructureNode | null | undefined, out: MailAttachment[]): void {
  if (!node || typeof node !== "object") return;
  const children = node.childNodes;
  if (Array.isArray(children) && children.length > 0) {
    for (const c of children) walk(c, out);
    return;
  }
  const disposition = (node.disposition ?? "").toLowerCase();
  const filenameParam =
    node.dispositionParameters?.["filename"] ?? node.parameters?.["name"] ?? null;
  const isAttachment =
    disposition === "attachment" ||
    disposition === "inline" ||
    (typeof filenameParam === "string" && filenameParam.length > 0);
  if (!isAttachment) return;
  const mimetype = node.mimeType
    ? node.mimeType
    : `${node.type ?? "application"}/${node.subtype ?? "octet-stream"}`.toLowerCase();
  out.push({
    id: node.part ?? `${out.length + 1}`,
    filename: typeof filenameParam === "string" ? decodeWords(filenameParam) : "attachment",
    mimetype,
    size: typeof node.size === "number" ? node.size : 0,
    contentId: node.id ?? null,
    disposition: disposition === "inline"
      ? "inline"
      : disposition === "attachment"
        ? "attachment"
        : null,
  });
}

export type { MailMessage, RawImapMessage, NormalizeMailFn };
