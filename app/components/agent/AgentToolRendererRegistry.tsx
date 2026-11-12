import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { FileArrowDownIcon } from "@phosphor-icons/react/FileArrowDown";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { ReceiptIcon } from "@phosphor-icons/react/Receipt";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { WrenchIcon } from "@phosphor-icons/react/Wrench";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import type { ConversationToolState } from "../../../shared/wemail/conversationState";
import { projectAgentToolPresentation } from "../../../shared/wemail/agentPresentation";

const SENSITIVE_ARGUMENT = /(?:body|content|html|password|secret|token|api.?key|credential)/i;

function redactToolArgument(value: unknown, key = ""): unknown {
  if (SENSITIVE_ARGUMENT.test(key)) return "[已隐藏]";
  if (Array.isArray(value)) {
    return value.map((item) => redactToolArgument(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactToolArgument(childValue, childKey),
      ]),
    );
  }
  return value;
}

function formatToolArguments(tool: ConversationToolState): string {
  const input = tool.input;
  if (!input || Object.keys(input).length === 0) return tool.toolName;
  const safeInput = redactToolArgument(input);
  return `${tool.toolName} ${JSON.stringify(safeInput)}`;
}

export interface AgentToolRendererProps {
  tool: ConversationToolState;
  /** Edition switch for WeCLI-specific cards (P2.5). Defaults to hidden. */
  wecliEnabled?: boolean;
}

export type AgentToolRenderer = ComponentType<AgentToolRendererProps>;

function ToolCardShell({
  tool,
  title,
  summary,
  icon,
  accent = "neutral",
  details,
  expandable = true,
}: {
  tool: ConversationToolState;
  title: string;
  summary: string;
  icon: ReactNode;
  accent?: "neutral" | "mail" | "draft" | "attention";
  details?: ReactNode;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(expandable && tool.state === "failed");
  const presentation = projectAgentToolPresentation({
    toolName: tool.toolName,
    state: tool.state,
  });
  const isRunning =
    tool.state === "receiving_args" || tool.state === "ready" || tool.state === "running";
  const tone =
    tool.state === "failed"
      ? "text-red"
      : accent === "draft"
        ? "text-amber"
        : accent === "mail"
          ? "text-green"
          : accent === "attention"
            ? "text-amber"
            : "text-ink-3";
  const iconTone =
    tool.state === "failed"
      ? "bg-red"
      : isRunning
        ? "bg-coral"
        : accent === "mail"
          ? "bg-green"
          : accent === "draft"
            ? "bg-amber"
            : "bg-ink-4";
  const displaySummary = tool.state === "failed"
    ? tool.error?.message ?? presentation.resultSummary
    : isRunning
      ? presentation.resultSummary
      : summary || presentation.resultSummary;

  return (
    <section
      className="relative min-w-0"
      data-tool-state={tool.state}
    >
      <div
        className={`flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md py-1 text-left ${
          expandable
            ? "cursor-pointer transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30"
            : ""
        }`}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        onKeyDown={expandable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen((value) => !value);
              }
            }
          : undefined}
      >
        <span
          className={`absolute -left-[19px] top-[13px] h-1.5 w-1.5 rounded-full ring-[3px] ring-paper ${iconTone}`}
          aria-hidden="true"
        />
        <span className={`flex h-5 w-5 items-center justify-center ${tone}`}>
          {tool.state === "failed" ? (
            <WarningCircleIcon size={13} weight="fill" />
          ) : isRunning ? (
            <WrenchIcon size={13} weight="duotone" />
          ) : (
            icon
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-meta font-medium text-ink-2">
            {title || presentation.label}
          </span>
          <span className="truncate text-caption text-ink-3" title={displaySummary}>
            {displaySummary}
          </span>
        </span>
        {expandable ? (
          <CaretRightIcon
            size={11}
            className={`mr-1 text-ink-3 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          />
        ) : null}
      </div>
      {expandable && open ? (
        <div className="mb-1 ml-6 min-w-0 border-l border-edge pl-2.5 text-caption leading-5 text-ink-2 select-text">
          {details ?? <GenericToolDetails tool={tool} />}
        </div>
      ) : null}
    </section>
  );
}

function SkillLifecycleToolCard({ tool }: AgentToolRendererProps) {
  const copy = tool.toolName === "create_skill_draft_from_pipeline"
    ? { title: "生成 Skill 草稿", summary: "草稿已生成，尚未安装" }
    : tool.toolName === "validate_skill_draft"
      ? { title: "校验 Skill 草稿", summary: "校验完成，等待确认" }
      : { title: "安装 Skill", summary: "Skill 已安装" };

  return (
    <ToolCardShell
      tool={tool}
      title={copy.title}
      summary={tool.summary ?? copy.summary}
      icon={<FileTextIcon size={13} weight="duotone" />}
      accent={tool.toolName === "install_skill_draft" ? "attention" : "draft"}
      expandable={false}
    />
  );
}

function SkillReadToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="读取 Skill"
      summary={tool.summary ?? "已按需读取 Skill 资源"}
      icon={<FileTextIcon size={13} weight="duotone" />}
      accent="neutral"
      expandable={false}
    />
  );
}

export function GenericToolDetails({ tool }: AgentToolRendererProps) {
  const presentation = projectAgentToolPresentation({
    toolName: tool.toolName,
    state: tool.state,
  });
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

export function GenericToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title={projectAgentToolPresentation({ toolName: tool.toolName, state: tool.state }).label}
      summary={projectAgentToolPresentation({ toolName: tool.toolName, state: tool.state }).resultSummary}
      icon={<CheckCircleIcon size={13} weight="fill" />}
    />
  );
}

function SearchMailToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="搜索邮件"
      summary="搜索已完成"
      icon={<MagnifyingGlassIcon size={13} weight="bold" />}
      accent="mail"
    />
  );
}

function ReadMailToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="读取邮件"
      summary="邮件内容已读取"
      icon={<EnvelopeOpenIcon size={13} weight="duotone" />}
      accent="mail"
    />
  );
}

function DraftToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="准备邮件草稿"
      summary="草稿已生成，尚未发送"
      icon={<PaperPlaneTiltIcon size={13} weight="duotone" />}
      accent="draft"
    />
  );
}

function ConfirmationToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="准备确认操作"
      summary="等待用户确认"
      icon={<CheckCircleIcon size={13} weight="duotone" />}
      accent="attention"
    />
  );
}

function AttachmentToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="处理附件"
      summary="附件处理完成"
      icon={<FileArrowDownIcon size={13} weight="duotone" />}
    />
  );
}

function AutomationToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="企业工具"
      summary="执行已完成"
      icon={<FileTextIcon size={13} weight="duotone" />}
      accent="attention"
    />
  );
}

function InvoiceToolCard({ tool }: AgentToolRendererProps) {
  return (
    <ToolCardShell
      tool={tool}
      title="报销发票"
      summary="发票步骤已完成"
      icon={<ReceiptIcon size={13} weight="duotone" />}
      accent="attention"
    />
  );
}

export const agentToolRenderers: Readonly<Record<string, AgentToolRenderer>> = {
  read: SkillReadToolCard,
  list_mail: SearchMailToolCard,
  list_emails: SearchMailToolCard,
  search_mail: SearchMailToolCard,
  search_emails: SearchMailToolCard,
  read_mail: ReadMailToolCard,
  read_mail_source: ReadMailToolCard,
  get_email: ReadMailToolCard,
  compose_mail: DraftToolCard,
  get_reply_draft: DraftToolCard,
  draft_email: DraftToolCard,
  propose_action: ConfirmationToolCard,
  find_invoice_attachments: AttachmentToolCard,
  propose_allowance_invoice_upload: InvoiceToolCard,
  propose_allowance_invoice_delete: InvoiceToolCard,
  create_skill_draft_from_pipeline: SkillLifecycleToolCard,
  validate_skill_draft: SkillLifecycleToolCard,
  install_skill_draft: SkillLifecycleToolCard,
};

/**
 * WeCLI-specific cards live outside the open default map (P2.5). They are
 * merged only when the caller passes wecliEnabled=true, which an edition
 * build derives from useEditionFeatures().wecli. The open build registers
 * no wecli_* agent tools at all, so these cards can never be reached there.
 */
export const wecliToolRenderers: Readonly<Record<string, AgentToolRenderer>> = {
  propose_wecli_command: ConfirmationToolCard,
  wecli_query: AutomationToolCard,
  wecli_run: AutomationToolCard,
};

export function getAgentToolRenderer(
  toolName: string,
  wecliEnabled = false,
): AgentToolRenderer {
  if (wecliEnabled) {
    const editionRenderer = wecliToolRenderers[toolName];
    if (editionRenderer) return editionRenderer;
  }
  return agentToolRenderers[toolName] ?? GenericToolCard;
}

export function AgentToolCard({ tool, wecliEnabled = false }: AgentToolRendererProps) {
  const Renderer = getAgentToolRenderer(tool.toolName, wecliEnabled);
  return <Renderer tool={tool} />;
}
