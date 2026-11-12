/**
 * Layer 1 (data-analysis skill): a GENERIC HTML-table extractor. Works for ANY HTML
 * email with tables — not specific to any sender (IDAS, monitoring, reports…).
 * Tolerant of malformed tags (`<td>…</th>` mismatches common in enterprise HTML email).
 * Returns each table as { columns, rows } for downstream analysis / rendering.
 */
export interface RawTable {
  columns: string[];
  rows: Array<Record<string, string>>;
}

import type { AutomationDataset } from "../../../shared/wemail/automation.js";
import { normalizeTabularDataset } from "./normalizeTabularDataset.js";

export function extractHtmlTables(html: string): RawTable[] {
  const tables: RawTable[] = [];
  const tableMatches = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  for (const tm of tableMatches) {
    const tableHtml = tm[1];
    const trs = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((t) => t[1].replace(/<[^>]+>/g, "").trim()))
      .filter((r) => r.length);
    if (!trs.length) continue;
    const columns = trs[0];
    const rows = trs.slice(1)
      .map((tr) => {
        const obj: Record<string, string> = {};
        columns.forEach((h, i) => { obj[h] = tr[i] ?? ""; });
        return obj;
      })
      .filter((r) => Object.values(r).some((v) => v));
    if (rows.length) tables.push({ columns, rows });
  }
  return tables;
}

/**
 * When merging multiple emails, each row is tagged with its source email's date under
 * this field so a trend pivot can group rows by day. The field name contains "date" so
 * inferDimensions classifies it as temporal; it is only injected when >1 email is merged
 * (a single-email snapshot must NOT get a synthetic date axis — that would fabricate a
 * trend from one point).
 */
export const SOURCE_DATE_FIELD = "_source_date";

function toDay(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/**
 * Product-ready: take an array of email messages (with body_html), extract ALL HTML
 * tables, and produce an AutomationDataset with inferred schema + rawTables preserved.
 * The dataset is autoPivot-ready (inferDimensions → generatePivots → render).
 *
 * When given >1 message, a synthetic _source_date field (the source email's day) is
 * injected into every row + schema, giving merged multi-day data a temporal axis.
 */
export function htmlTableDataset(messages: Array<{
  id: string; subject?: string; receivedAt: string;
  body_html?: string; bodyText?: string;
  from?: { name?: string; email?: string };
}>): AutomationDataset {
  const rawTables: RawTable[] = [];
  const tableSources: number[] = []; // rawTables[i] came from messages[tableSources[i]]
  const sourceEmails: Array<{ id: string; subject?: string; from?: string; date?: string }> = [];
  messages.forEach((msg, mi) => {
    const tables = extractHtmlTables(msg.body_html || msg.bodyText || "");
    for (const t of tables) {
      rawTables.push(t);
      tableSources.push(mi);
    }
    sourceEmails.push({ id: msg.id, subject: msg.subject, from: msg.from?.name ?? msg.from?.email, date: msg.receivedAt });
  });
  if (!rawTables.length) {
    return { type: "dataset", schema: { fields: [] }, rows: [], provenance: [], sourceEmails, rawTables: [] };
  }
  const first = rawTables[0];
  const primaryColumns = JSON.stringify(first.columns);
  const compatibleTableIndexes = rawTables
    .map((table, index) => JSON.stringify(table.columns) === primaryColumns ? index : -1)
    .filter((index) => index >= 0);
  const multiDay = messages.length > 1;
  const baseFields = first.columns.map((col) => {
    const populated = compatibleTableIndexes
      .flatMap((index) => rawTables[index].rows.map((row) => row[col]))
      .filter((value) => !isMissingTableValue(value));
    const isNum = populated.length > 0 && populated.every((value) => parseTableNumber(value) !== undefined);
    return { name: col, type: (isNum ? "number" : "string") as "number" | "string", label: col };
  });
  const sourceFields = multiDay
    ? [{ name: SOURCE_DATE_FIELD, type: "date" as const, label: "统计日期", semanticRole: "time" as const, semanticId: "source_date" }, ...baseFields]
    : baseFields;
  // Only structurally compatible tables belong in one analytical dataset.
  // Heterogeneous tables remain available in rawTables for faithful detail
  // rendering, but their unrelated rows and units must never be aggregated.
  const sourceRows = compatibleTableIndexes.flatMap((ti) => {
    const t = rawTables[ti];
    const msgIdx = tableSources[ti];
    return t.rows.map((r) => {
      const row: Record<string, unknown> = {};
      if (multiDay) row[SOURCE_DATE_FIELD] = toDay(messages[msgIdx].receivedAt);
      for (const col of first.columns) {
        const raw = r[col] ?? "";
        const field = baseFields.find((f) => f.name === col);
        row[col] = field?.type === "number" ? parseTableNumber(raw) : raw;
      }
      return row;
    });
  });
  const normalized = normalizeTabularDataset(sourceFields, sourceRows);
  return {
    type: "dataset",
    schema: { fields: normalized.fields },
    rows: normalized.rows,
    provenance: [{ outputPath: "rows", sourceType: "mail", emailIds: sourceEmails.map((s) => s.id) }],
    sourceEmails,
    rawTables,
  };
}

function parseTableNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  let normalized = value
    .trim()
    .replace(/[，,\s\u00a0]/g, "")
    .replace(/^(?:人民币|RMB|CNY|USD|EUR|[$¥￥€])/i, "");
  let sign = 1;
  if (/^\(.+\)$/.test(normalized)) {
    sign = -1;
    normalized = normalized.slice(1, -1);
  }
  const percent = /[%％]$/.test(normalized);
  normalized = normalized.replace(/[%％]$/, "");
  const suffix = /(万|亿|[kKmM])$/.exec(normalized)?.[1];
  if (suffix) normalized = normalized.slice(0, -suffix.length);
  // Common business units are preserved by the source column label; stripping them
  // here lets values such as "42 ms" and "300 次" participate in distributions.
  normalized = normalized.replace(/(?:毫秒|ms|秒|分钟|小时|天|元|人|次|封|件)$/i, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const scale = suffix === "万" ? 10_000
    : suffix === "亿" ? 100_000_000
      : suffix?.toLowerCase() === "k" ? 1_000
        : suffix?.toLowerCase() === "m" ? 1_000_000
          : 1;
  const parsed = Number(normalized) * sign * scale * (percent ? 0.01 : 1);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isMissingTableValue(value: string | undefined): boolean {
  return value === undefined || /^(?:\s*|—|-|n\/?a|null)$/i.test(value.trim());
}
