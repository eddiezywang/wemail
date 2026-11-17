import * as NodeHtmlMarkdownNamespace from "node-html-markdown";
import type { TranslatorConfigObject } from "node-html-markdown";
import * as NodeHtmlParserNamespace from "node-html-parser";
import type { HTMLElement } from "node-html-parser";

// Both packages are CommonJS. Their synthetic named exports work in Node but
// disappear in Vite's browser runtime, so read both APIs from the shared
// default module to keep renderer previews identical to server AI input.
type NodeHtmlMarkdownExports = typeof import("node-html-markdown");
type NodeHtmlParserExports = typeof import("node-html-parser");
const nodeHtmlMarkdownExports = NodeHtmlMarkdownNamespace as NodeHtmlMarkdownExports & {
  default?: NodeHtmlMarkdownExports;
};
const nodeHtmlParserExports = NodeHtmlParserNamespace as NodeHtmlParserExports & {
  default?: NodeHtmlParserExports;
};
const { NodeHtmlMarkdown } = nodeHtmlMarkdownExports.default ?? nodeHtmlMarkdownExports;
const { parse } = nodeHtmlParserExports.default ?? nodeHtmlParserExports;

const HTML_ELEMENTS_IGNORED_BY_AI = new Set([
  "HEAD",
  "SCRIPT",
  "STYLE",
  "SVG",
  "IMG",
  "PICTURE",
  "SOURCE",
  "VIDEO",
  "AUDIO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "TEMPLATE",
  "NOSCRIPT",
  "FORM",
  "INPUT",
  "SELECT",
  "TEXTAREA",
]);

// Preserve row/column relationships without GFM separator and padding overhead.
const COMPACT_TABLE_TRANSLATORS = {
  table: ({ visitor }) => ({
    surroundingNewlines: 2,
    childTranslators: visitor.instance.tableTranslators,
    postprocess: ({ content, node, nodeMetadata }) => {
      const rows = content
        .split(/\r?\n/)
        .map((row) => row.replace(/^(?:\|)?(.+)\s*\|\s*$/, "$1"))
        .filter((row) => row.trim())
        .map((row) => row
          .split(" |")
          .map((cell) => cell.trim().replace(/\s+/g, " "))
          .join("\t"));
      const caption = nodeMetadata.get(node)?.tableMeta?.caption;
      return [caption, ...rows].filter(Boolean).join("\n");
    },
  }),
} satisfies TranslatorConfigObject;

const htmlToMarkdown = new NodeHtmlMarkdown(
  {
    ignore: [...HTML_ELEMENTS_IGNORED_BY_AI],
    bulletMarker: "-",
    maxConsecutiveNewlines: 2,
    useInlineLinks: true,
  },
  COMPACT_TABLE_TRANSLATORS,
);

function translateHtml(html: string): string {
  // node-html-markdown 2.0 reads process.env.LOG_PERF even in its browser
  // build. Provide that one runtime shape only for the synchronous call.
  const runtimeGlobal = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  const previousProcess = runtimeGlobal.process;
  if (!previousProcess?.env) runtimeGlobal.process = { env: {} };
  try {
    return htmlToMarkdown.translate(html);
  } finally {
    if (previousProcess) runtimeGlobal.process = previousProcess;
    else delete runtimeGlobal.process;
  }
}

function isHidden(element: HTMLElement): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden")?.toLowerCase() === "true") return true;
  const style = element.getAttribute("style") ?? "";
  return /(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i.test(style)
    || (/max-height\s*:\s*0(?:px)?/i.test(style) && /overflow\s*:\s*hidden/i.test(style));
}

function belongsToTable(element: HTMLElement, table: HTMLElement): boolean {
  return element.closest("table") === table;
}

function isLayoutTable(table: HTMLElement): boolean {
  if (table.getAttribute("role")?.toLowerCase() === "presentation") return true;
  if (table.querySelector("table")) return true;
  const rows = table.querySelectorAll("tr").filter((row) => belongsToTable(row, table));
  const hasHeader = table.querySelectorAll("th").some((cell) => belongsToTable(cell, table));
  const maximumColumns = Math.max(
    0,
    ...rows.map((row) => row.querySelectorAll("td,th").filter((cell) => belongsToTable(cell, table)).length),
  );
  // ponytail: one-column tables are layout; widen only if real mail shows
  // multi-column layout tables materially bloating AI context.
  return !hasHeader && maximumColumns <= 1;
}

function unwrap(element: HTMLElement): void {
  element.replaceWith(...element.childNodes);
}

function flattenLayoutTable(table: HTMLElement): void {
  for (const selector of ["thead", "tbody", "tfoot", "tr", "td", "th"]) {
    const elements = table
      .querySelectorAll(selector)
      .filter((element) => belongsToTable(element, table));
    for (const element of elements.reverse()) unwrap(element);
  }
  unwrap(table);
}

function fallbackStripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Convert untrusted mail HTML into compact, image-free Markdown for AI input. */
export function htmlToAiMarkdown(html: string): string {
  if (!html.trim()) return "";
  const contentHtml = html.replace(/<!doctype[^>]*>/gi, "");
  try {
    const root = parse(contentHtml, { comment: false });
    for (const element of root.querySelectorAll("*").reverse()) {
      const tagName = element.tagName.toUpperCase();
      if (
        HTML_ELEMENTS_IGNORED_BY_AI.has(tagName)
        || /^(?:V|O):/.test(tagName)
        || isHidden(element)
      ) {
        element.remove();
      }
    }
    const layoutTables = root.querySelectorAll("table").filter(isLayoutTable);
    for (const table of layoutTables.reverse()) flattenLayoutTable(table);
    return translateHtml(root.toString()).trim();
  } catch {
    return fallbackStripHtml(contentHtml);
  }
}

export function resolveAiBodyText(input: {
  bodyText?: string | null;
  bodyHtml?: string | null;
}): { text: string; sectionId: string } {
  if (input.bodyText?.trim()) {
    return { text: input.bodyText, sectionId: "body-text" };
  }
  if (input.bodyHtml?.trim()) {
    return { text: htmlToAiMarkdown(input.bodyHtml), sectionId: "body-html-stripped" };
  }
  return { text: "", sectionId: "body-text" };
}
