import type { AgentEvent } from "../../../shared/wemail/agent.js";

/**
 * A safe, platform-agnostic progress event any streaming session consumes.
 * `text_delta` accumulates into the streamed answer body; `progress` is
 * rendered as one line inside the progress block (WeCom `<think>`, or a Feishu
 * card element).
 */
export type StreamProgressEvent =
  | { type: "text_delta"; text: string }
  | { type: "progress"; text: string };

/**
 * Map an AgentEvent to a safe streaming progress event, applying a strict
 * whitelist. Anything that could leak model reasoning, mail bodies, contacts,
 * local paths, command output, or credentials is dropped (returns `null`).
 *
 * Allowed:
 *  - `text_delta`       → answer body (accumulated; never re-derived from
 *                         `text_end`/`assistant_text`, which feed the final
 *                         text instead, to avoid duplication).
 *  - `progress_update`  → already user-visible copy.
 *  - `tool_call`        → a fixed summary derived from the tool NAME only.
 *  - `tool_result`      → a fixed 成功/失败 line; the raw observation/output
 *                         is never used.
 *  - `retry_*`          → a fixed retry status line.
 *
 * Explicitly excluded: `reasoning_start`/`reasoning_delta`/`reasoning_end`,
 * `thinking`, `tool_update`, raw tool input, raw tool output, raw observation.
 */
export function mapAgentEventToProgress(
  event: AgentEvent,
): StreamProgressEvent | null {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", text: event.text };
    case "progress_update":
      return { type: "progress", text: event.text };
    case "tool_call":
      return { type: "progress", text: toolCallSummary(event.tool) };
    case "tool_result":
      return {
        type: "progress",
        text: event.isError ? "❌ 操作失败" : "✅ 完成",
      };
    case "retry_scheduled":
    case "retry_started":
      return { type: "progress", text: "ℹ️ 正在重试…" };
    case "retry_failed":
      return { type: "progress", text: "❌ 重试失败" };
    default:
      return null;
  }
}

/** Fixed, tool-name-derived summary. Never reflects tool input or output. */
function toolCallSummary(tool: string): string {
  const name = tool.toLowerCase();
  if (name.startsWith("search") || name.includes("find")) return "🔍 搜索邮件";
  if (name.startsWith("read") || name.includes("fetch")) return "📧 读取邮件";
  if (name.startsWith("summar")) return "📝 生成摘要";
  if (name.startsWith("tag")) return "🏷️ 生成标签";
  if (name.startsWith("draft") || name.includes("reply")) return "✍️ 撰写回复";
  if (name.startsWith("propose")) return "🛠️ 准备操作";
  if (name.startsWith("publish") || name.includes("design")) return "📊 生成报告";
  return "⚙️ 处理中";
}
