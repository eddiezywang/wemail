/**
 * Remove known internal agent citation fragments from user-facing prose.
 * Structured citation fields stay available on AgentEvent for internal use;
 * this helper only protects ordinary rendered text.
 */
export function sanitizeAgentDisplayText(
  text: string,
  options: { trim?: boolean; preserveWhitespace?: boolean } = {},
): string {
  const citationPattern =
    /(?:\([^()\n]*\b(?:emailId|threadId|actionId|toolCallId|tool|path)\s*[:=][^()\n]*\)|（[^（）\n]*\b(?:emailId|threadId|actionId|toolCallId|tool|path)\s*[:=][^（）\n]*）|\[[^\[\]\n]*\b(?:emailId|threadId|actionId|toolCallId|tool|path)\s*[:=][^\[\]\n]*\]|【[^【】\n]*\b(?:emailId|threadId|actionId|toolCallId|tool|path)\s*[:=][^【】\n]*】)/gi;
  const fieldPattern =
    /\s*(?:emailId|threadId|actionId|toolCallId|tool|path)\s*[:=]\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^,\n)\]】}]+)\s*,?/gi;
  const redacted = text
    .replace(/[ \t]*[\[【]证据[:：][^\r\n]*(?:[\]】])?/g, "")
    .replace(citationPattern, "")
    .replace(fieldPattern, "")
    .replace(/\b(?:acct|msg|email)[-_][A-Za-z0-9:_-]+/gi, "")
    .replace(/[（(]\s*[）)]/g, "");
  const sanitized = options.preserveWhitespace
    ? redacted
    : redacted
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([，。！？；：、])/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
  return options.trim === false ? sanitized : sanitized.trim();
}

export type AgentToolPresentationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface AgentToolPresentation {
  label: string;
  status: AgentToolPresentationStatus;
  resultSummary: string;
}

const TOOL_PRESENTATIONS: Record<string, { active: string; completed: string }> = {
  list_mail: { active: "正在查找邮件", completed: "查找了邮件" },
  list_emails: { active: "正在查找邮件", completed: "查找了邮件" },
  search_mail: { active: "正在搜索邮件", completed: "搜索了邮件" },
  search_emails: { active: "正在搜索邮件", completed: "搜索了邮件" },
  read_mail: { active: "正在读取邮件", completed: "读取了邮件" },
  read_mail_source: { active: "正在读取邮件", completed: "读取了邮件" },
  get_email: { active: "正在读取邮件", completed: "读取了邮件" },
  get_thread: { active: "正在加载邮件会话", completed: "加载了邮件会话" },
  list_recent_emails: { active: "正在关联相似邮件", completed: "关联了相似邮件" },
  extract_email_tables: { active: "正在解析邮件数据", completed: "解析了邮件数据" },
  aggregate_email_datasets: { active: "正在汇总邮件数据", completed: "汇总了邮件数据" },
  publish_design_artifact: { active: "正在生成洞察报告", completed: "生成了洞察报告" },
  compose_mail: { active: "正在准备邮件草稿", completed: "准备了邮件草稿" },
  draft_email: { active: "正在准备邮件草稿", completed: "准备了邮件草稿" },
  get_reply_draft: { active: "正在准备回复", completed: "准备了回复" },
  find_invoice_attachments: { active: "正在查找发票附件", completed: "查找了发票附件" },
  propose_action: { active: "正在准备确认操作", completed: "准备了待确认操作" },
  propose_wecli_command: { active: "正在准备确认操作", completed: "准备了待确认操作" },
};

/** Projects runtime tool state into an allowlisted user/audit presentation.
 * Deliberately accepts no input/output/IDs so callers cannot accidentally
 * render raw tool payloads. */
export function projectAgentToolPresentation(input: {
  toolName: string;
  state: string;
}): AgentToolPresentation {
  const copy = TOOL_PRESENTATIONS[input.toolName] ?? {
    active: "正在执行一项操作",
    completed: "执行了一项操作",
  };
  const status: AgentToolPresentationStatus = input.state === "failed"
    ? "failed"
    : input.state === "completed"
      ? "completed"
      : input.state === "ready" || input.state === "receiving_args"
        ? "queued"
        : "running";
  return {
    label: status === "completed"
      ? copy.completed
      : status === "failed"
        ? `${copy.completed}失败`
        : copy.active,
    status,
    resultSummary: status === "failed"
      ? "操作未能完成，请重试或调整要求。"
      : status === "completed" ? copy.completed : copy.active,
  };
}
