import type { ConversationToolState } from "../../../shared/wemail/conversationState";
import { projectAgentToolPresentation } from "../../../shared/wemail/agentPresentation";

const SENSITIVE_ARGUMENT = /(?:body|content|html|password|secret|token|api.?key|credential)/i;

function redactToolArgument(value: unknown, key = ""): unknown {
  if (SENSITIVE_ARGUMENT.test(key)) return "[已隐藏]";
  if (Array.isArray(value)) return value.map((item) => redactToolArgument(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactToolArgument(childValue, childKey)]),
    );
  }
  return value;
}

function formatToolArguments(tool: ConversationToolState): string {
  if (!tool.input || Object.keys(tool.input).length === 0) return tool.toolName;
  return `${tool.toolName} ${JSON.stringify(redactToolArgument(tool.input))}`;
}

export function GenericToolDetails({ tool }: { tool: ConversationToolState }) {
  const presentation = projectAgentToolPresentation({ toolName: tool.toolName, state: tool.state });
  return (
    <div className="min-w-0 space-y-1">
      <div className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-x-1.5">
        <span className="text-ink-3">命令</span>
        <code className="min-w-0 break-all font-mono text-xs text-ink-2">
          {formatToolArguments(tool)}
        </code>
      </div>
      <div className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-x-1.5">
        <span className="text-ink-3">结果</span>
        <span className="min-w-0 break-words">
          {tool.state === "failed" ? tool.error?.message ?? presentation.resultSummary : tool.summary ?? presentation.resultSummary}
        </span>
      </div>
      {tool.state === "failed" && tool.error?.code ? (
        <p className="pl-10 font-mono text-xs text-ink-3">错误码：{tool.error.code}</p>
      ) : null}
    </div>
  );
}
