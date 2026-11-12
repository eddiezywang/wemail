import fs from "node:fs/promises";
import path from "node:path";

const [inputArg, summaryArg, htmlArg] = process.argv.slice(2);
if (!inputArg || !summaryArg || !htmlArg) {
  throw new Error("usage: node scripts/analyze-electron-trace.mjs <trace> <summary-json> <html>");
}
const inputPath = path.resolve(inputArg);
const raw = JSON.parse(await fs.readFile(inputPath, "utf8"));
const events = Array.isArray(raw) ? raw : raw.traceEvents ?? [];
const totals = new Map();
const categories = new Map();
let tracedDurationUs = 0;
for (const event of events) {
  if (event?.ph !== "X" || typeof event.dur !== "number" || event.dur < 0) continue;
  const durationUs = event.dur;
  tracedDurationUs += durationUs;
  const name = String(event.name ?? "unknown");
  const category = String(event.cat ?? "uncategorized");
  const key = `${category}\u0000${name}`;
  const current = totals.get(key) ?? { name, category, totalDurationUs: 0, count: 0, maxDurationUs: 0 };
  current.totalDurationUs += durationUs;
  current.count += 1;
  current.maxDurationUs = Math.max(current.maxDurationUs, durationUs);
  totals.set(key, current);
  categories.set(category, (categories.get(category) ?? 0) + durationUs);
}
const topEvents = [...totals.values()]
  .sort((left, right) => right.totalDurationUs - left.totalDurationUs)
  .slice(0, 80)
  .map((item) => ({ ...item, totalDurationMs: item.totalDurationUs / 1000, maxDurationMs: item.maxDurationUs / 1000 }));
const topCategories = [...categories.entries()]
  .map(([category, totalDurationUs]) => ({ category, totalDurationMs: totalDurationUs / 1000 }))
  .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
  .slice(0, 30);
const summary = {
  sourceTrace: inputPath,
  generatedAt: new Date().toISOString(),
  eventCount: events.length,
  completeEventCount: [...totals.values()].reduce((sum, item) => sum + item.count, 0),
  aggregateDurationMs: tracedDurationUs / 1000,
  topCategories,
  topEvents,
};
await fs.mkdir(path.dirname(path.resolve(summaryArg)), { recursive: true });
await fs.writeFile(path.resolve(summaryArg), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
const max = topEvents[0]?.totalDurationMs || 1;
const rows = topEvents.map((item) => `
  <tr><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.name)}</td><td>${item.count}</td><td>${item.totalDurationMs.toFixed(2)}</td><td>${item.maxDurationMs.toFixed(2)}</td><td><div class="bar" style="width:${Math.max(1, item.totalDurationMs / max * 100).toFixed(2)}%"></div></td></tr>`).join("");
const html = `<!doctype html><meta charset="utf-8"><title>WeMail Mail Core Trace Hotspots</title>
<style>body{font:14px system-ui;margin:24px;color:#18212f}h1{font-size:22px}table{border-collapse:collapse;width:100%}th,td{padding:7px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.bar{height:14px;background:#3b82f6;border-radius:3px}code{background:#f3f4f6;padding:2px 4px}</style>
<h1>WeMail Mail Core trace hotspot equivalent</h1><p>Source: <code>${escapeHtml(inputPath)}</code></p><p>This is an aggregate-duration flamegraph equivalent derived from Chromium complete trace events. Wider bars indicate more accumulated traced time.</p>
<table><thead><tr><th>Category</th><th>Event</th><th>Count</th><th>Total ms</th><th>Max ms</th><th>Relative weight</th></tr></thead><tbody>${rows}</tbody></table>`;
await fs.writeFile(path.resolve(htmlArg), html, "utf8");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
