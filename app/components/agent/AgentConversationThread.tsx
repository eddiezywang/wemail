import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { FileIcon } from "@phosphor-icons/react/File";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PaperclipIcon } from "@phosphor-icons/react/Paperclip";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { WrenchIcon } from "@phosphor-icons/react/Wrench";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { ChartPieIcon } from "@phosphor-icons/react/ChartPie";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { PresentationIcon } from "@phosphor-icons/react/Presentation";
import { ScrollIcon } from "@phosphor-icons/react/Scroll";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ConversationMessagePart,
  ConversationMessageState,
  ConversationRunState,
  ConversationState,
  ConversationToolState,
} from "../../../shared/wemail/conversationState";
import type { AgentMessageContext } from "../../../shared/wemail/agent";
import { projectAgentToolPresentation } from "../../../shared/wemail/agentPresentation";
import { AgentMarkdown } from "./AgentMarkdown";
import { GenericToolDetails } from "./AgentToolRendererRegistry";
import { ArtifactViewer } from "~/components/applicationMessages/ArtifactViewer";
import {
  buildAgentMessagePresentation,
  type AgentFinalAnswerPart,
  type AgentMessagePresentationBlock,
  type AgentProgressPart,
  type AgentTimelineAnchorPart,
  type AgentToolPart,
} from "./AgentMessagePresentation";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import type { WemailAgentCitation } from "../../../shared/wemail/agentProtocol";
import { friendlyToolLabel } from "~/lib/agent-display";
import { sanitizeAgentDisplayText } from "~/lib/agent-display";
import { getUserFacingError } from "~/lib/user-facing-error";
import api from "~/services/api";

const VISIBLE_MAIL_CITATION_COUNT = 3;

function completedToolSummary(parts: AgentToolPart[], state: ConversationState): string {
  const tools = parts
    .map((part) => state.tools[part.toolCallId])
    .filter((tool) => !!tool);
  if (tools.length === 0) return "运行了操作";

  if (tools.length === 1) {
    const toolName = tools[0].toolName;
    if (/^(list|search)_?(mail|email)/.test(toolName)) return "查阅了邮件";
    if (/^(read|get)_?(mail|email|thread)/.test(toolName)) return "读取了邮件";
    if (/draft|compose/.test(toolName)) return "准备了邮件草稿";
    return friendlyToolLabel(toolName).label.replace(/^正在/, "");
  }

  const hasMailWork = tools.some((tool) =>
    /mail|email|thread/.test(tool.toolName),
  );
  return hasMailWork
    ? `处理了邮件并运行了 ${tools.length} 个操作`
    : `运行了 ${tools.length} 个操作`;
}

function AssistantMark() {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-3"
      data-testid="agent-assistant-mark"
      aria-hidden="true"
    >
      <SparkleIcon size={18} weight="fill" />
    </span>
  );
}

function NaturalProgress({
  part,
}: {
  part: AgentProgressPart;
}) {
  if (!part.text.trim()) return null;
  return (
    <div
      className="agent-response select-text text-ink-3"
      data-testid="agent-process-progress"
    >
      <AgentMarkdown text={sanitizeAgentDisplayText(part.text)} />
    </div>
  );
}

function isToolActive(tool: ConversationToolState): boolean {
  return (
    tool.state === "receiving_args" ||
    tool.state === "ready" ||
    tool.state === "running"
  );
}

/**
 * Compact chip for one tool call inside the expanded process trace.
 * Glyph-led, label-free: the leading icon identifies the tool kind
 * (search / read / draft / generic wrench), the trailing check marks a
 * completed step. Selecting a chip reveals the full AgentToolCard below
 * the chip row so the audit detail stays one click away.
 */
function ProcessToolChip({
  tool,
  selected,
  onToggle,
}: {
  tool: ConversationToolState;
  selected: boolean;
  onToggle: () => void;
}) {
  const running = isToolActive(tool);
  const failed = tool.state === "failed";
  const label = friendlyToolLabel(tool.toolName).label.replace(/^正在/, "");
  const statusWord = failed ? "失败" : running ? "进行中" : "已完成";
  const chipClass = failed
    ? "border-red/40 bg-red-bg text-red"
    : running
      ? "border-coral/30 bg-coral-bg text-coral-2"
      : selected
        ? "border-coral/40 bg-coral-bg text-ink"
        : "border-edge bg-paper-2 text-ink-2 hover:bg-paper-3";
  return (
    <button
      type="button"
      className={`inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30 ${chipClass}`}
      aria-pressed={selected}
      aria-label={`${label}，${statusWord}${selected ? "，已展开详情" : ""}`}
      onClick={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      {failed ? (
        <WarningCircleIcon size={12} weight="fill" className="shrink-0" />
      ) : running ? (
        <CircleNotchIcon size={12} weight="bold" className="shrink-0 animate-spin motion-reduce:animate-none" />
      ) : /^(list|search)_?(mail|email)/.test(tool.toolName) ? (
        <MagnifyingGlassIcon size={12} weight="bold" className="shrink-0" />
      ) : /^(read|get)_?(mail|email|thread)/.test(tool.toolName) || tool.toolName === "read_mail_source" ? (
        <EnvelopeOpenIcon size={12} weight="duotone" className="shrink-0" />
      ) : /draft|compose/.test(tool.toolName) ? (
        <PaperclipIcon size={12} className="shrink-0" />
      ) : (
        <WrenchIcon size={12} className="shrink-0" />
      )}
      <span className="truncate">{label}</span>
      {!failed && !running ? (
        <CheckIcon size={11} weight="bold" className="shrink-0 text-green" />
      ) : null}
    </button>
  );
}

export function ProcessDisclosure({
  parts,
  state,
}: {
  parts: AgentToolPart[];
  state: ConversationState;
}) {
  const tools = parts
    .map((part) => state.tools[part.toolCallId])
    .filter((tool) => !!tool);
  const isActive = tools.some(isToolActive);
  const hasFailed = tools.some((tool) => tool.state === "failed");
  const failedTool = [...tools].reverse().find((tool) => tool.state === "failed");
  const [open, setOpen] = useState(isActive || hasFailed);
  const [detailToolCallId, setDetailToolCallId] = useState<string | null>(
    () => failedTool?.toolCallId ?? null,
  );
  useEffect(() => {
    if (isActive || hasFailed) setOpen(true);
  }, [hasFailed, isActive]);
  const activeTool = [...tools].reverse().find(isToolActive);
  const statusLabel = hasFailed
    ? failedTool
      ? projectAgentToolPresentation({ toolName: failedTool.toolName, state: "failed" }).label
      : "操作未能完成"
    : isActive && activeTool
      ? friendlyToolLabel(activeTool.toolName).label
      : tools.length > 1
        ? `${tools.length} 次工具调用`
        : completedToolSummary(parts, state);
  const detailTool = detailToolCallId ? state.tools[detailToolCallId] : undefined;

  return (
    <section
      className="group/process -ml-0.5"
      data-testid="agent-process-disclosure"
    >
      <button
        type="button"
        className="flex max-w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-meta text-ink-3 transition-colors hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {isActive ? (
          <CircleNotchIcon size={13} weight="bold" className="shrink-0 animate-spin text-coral motion-reduce:animate-none" />
        ) : hasFailed ? (
          <WarningCircleIcon size={13} weight="fill" className="shrink-0 text-red" />
        ) : (
          <PaperclipIcon size={13} className="shrink-0" />
        )}
        <span className="truncate">{statusLabel}</span>
        <CaretDownIcon
          size={11}
          className={`shrink-0 text-ink-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          className="ml-1.5 mt-1 border-l border-edge pl-3 text-meta leading-6 text-ink-2"
          data-testid="agent-process-content"
        >
          <div className="flex flex-wrap gap-1.5 py-1">
            {tools.map((tool) => (
              <ProcessToolChip
                key={tool.toolCallId}
                tool={tool}
                selected={detailToolCallId === tool.toolCallId}
                onToggle={() =>
                  setDetailToolCallId((current) =>
                    current === tool.toolCallId ? null : tool.toolCallId,
                  )
                }
              />
            ))}
          </div>
          {detailTool ? (
            <div
              className="mt-1.5 select-text"
              data-testid="agent-process-tool-detail"
            >
              <GenericToolDetails tool={detailTool} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Client-side follow-up candidates for a settled answer, derived from what
 * the answer is grounded on (mail citations / attachments). Static prompts,
 * contextually triggered: they lower the barrier to continuing the
 * conversation without another round-trip.
 */
function answerFollowups(citations: WemailAgentCitation[]): string[] {
  const mailCount = citations.filter((citation) => citation.source.kind === "mail").length;
  const hasAttachment = citations.some((citation) => citation.source.kind === "attachment");
  const followups: string[] = [];
  if (mailCount > 1) followups.push("对比这几封邮件的要点和时间线");
  if (mailCount >= 1) followups.push("逐项列出这些邮件的关键信息");
  if (hasAttachment) followups.push("汇总这些附件的内容");
  return followups.slice(0, 3);
}

function FollowupChips({
  suggestions,
  onFollowup,
}: {
  suggestions: string[];
  onFollowup?: (text: string) => void;
}) {
  if (suggestions.length === 0 || !onFollowup) return null;
  return (
    <div
      className="mt-2.5 flex flex-wrap items-center gap-1.5"
      data-testid="agent-answer-followups"
    >
      <span className="text-caption font-semibold tracking-wide text-ink-4">跟进</span>
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onFollowup(text)}
          className="inline-flex min-h-7 max-w-full items-center rounded-full border border-edge bg-paper-2 px-2.5 text-caption text-ink-2 transition-colors hover:border-coral/40 hover:bg-coral-bg hover:text-coral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30"
        >
          <span className="truncate">{text}</span>
        </button>
      ))}
    </div>
  );
}

function FinalAnswerPart({
  part,
  state,
  accountId,
  onOpenEmail,
  onOpenAttachment,
  onFollowup,
}: {
  part: AgentFinalAnswerPart;
  state: ConversationState;
  accountId: string;
  onOpenEmail?: (emailId: string) => void;
  onOpenAttachment?: (attachmentId: string) => void;
  onFollowup?: (text: string) => void;
}) {
  if (part.type === "artifact") {
    return <AgentArtifactCard artifact={part.artifact} accountId={accountId} />;
  }
  const citations = part.citationIds
    .map((citationId) => state.citations[citationId])
    .filter((citation): citation is WemailAgentCitation => !!citation);
  const followups = part.state === "streaming" ? [] : answerFollowups(citations);
  return (
    <div
      className={`agent-response select-text ${part.state === "streaming" ? "streaming-caret" : ""}`}
      data-testid="agent-final-answer"
    >
      <AgentMarkdown text={part.markdown} isStreaming={part.state === "streaming"} />
      <AnswerCitations
        citationIds={part.citationIds}
        state={state}
        onOpenEmail={onOpenEmail}
        onOpenAttachment={onOpenAttachment}
      />
      <FollowupChips suggestions={followups} onFollowup={onFollowup} />
    </div>
  );
}

type AgentProcessBlock = Exclude<
  AgentMessagePresentationBlock,
  { type: "answer" }
>;

const ACTIVE_RUN_STATES = new Set([
  "queued",
  "running",
  "retrying",
  "stopping",
]);

function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSeconds < 1) return "不到 1 秒";
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}分 ${seconds}秒` : `${totalMinutes} 分钟`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}小时 ${minutes}分` : `${hours} 小时`;
}

function useRunDuration(run: ConversationRunState | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!run?.startedAt) return null;
  const startedAt = Date.parse(run.startedAt);
  const endedAt = run.settledAt ? Date.parse(run.settledAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return formatElapsedDuration(endedAt - startedAt);
}

function processStatusLabel({
  run,
  active,
  hasPendingConfirmation,
}: {
  run?: ConversationRunState;
  active: boolean;
  hasPendingConfirmation: boolean;
}) {
  if (active) {
    if (hasPendingConfirmation) return "等待你的确认";
    if (run?.state === "queued") return "等待处理";
    if (run?.state === "retrying") return "正在重试";
    if (run?.state === "stopping") return "正在停止";
    return "正在处理";
  }
  if (run?.state === "failed") return "未能完成";
  if (run?.state === "stopped") return "已停止";
  if (run?.state === "interrupted") return "处理已中断";
  return "已思考";
}

function RunProcessDisclosure({
  blocks,
  run,
  state,
  renderConfirmationCard,
}: {
  blocks: AgentProcessBlock[];
  run?: ConversationRunState;
  state: ConversationState;
  renderConfirmationCard?: (confirmationId: string) => ReactNode;
}) {
  // A process is active only when its own canonical run is active. The
  // panel-level streaming flag can belong to a later turn and must never
  // revive an older message that has no matching run record.
  const active = run ? ACTIVE_RUN_STATES.has(run.state) : false;
  const hasPendingConfirmation = blocks.some((block) => {
    if (block.type !== "anchor" || block.part.type !== "confirmation") return false;
    return state.confirmations[block.part.confirmationId]?.status === "pending";
  });
  // A live confirmation card (pending / executing) anchors inside this
  // process timeline; keep the timeline open so the card stays visible.
  const hasConfirmationCard = !!renderConfirmationCard && blocks.some((block) => {
    if (block.type !== "anchor" || block.part.type !== "confirmation") return false;
    return renderConfirmationCard(block.part.confirmationId) != null;
  });
  const shouldOpen = active || hasConfirmationCard;
  const [open, setOpen] = useState(shouldOpen);
  const wasActive = useRef(active);
  const duration = useRunDuration(run, active);

  useEffect(() => {
    if (shouldOpen) {
      setOpen(true);
    } else if (wasActive.current) {
      setOpen(false);
    }
    wasActive.current = active;
  }, [shouldOpen, active]);

  const status = processStatusLabel({ run, active, hasPendingConfirmation });
  const summary = duration ? `${status} ${duration}` : status;

  return (
    <section data-testid="agent-run-process" data-run-state={run?.state ?? (active ? "running" : "settled")}>
      <button
        type="button"
        className="flex max-w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-meta text-ink-3 transition-colors hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {active ? (
          <CircleNotchIcon size={13} weight="bold" className="shrink-0 animate-spin text-coral motion-reduce:animate-none" />
        ) : run?.state === "failed" ? (
          <WarningCircleIcon size={13} weight="fill" className="shrink-0 text-red" />
        ) : (
          <ClockIcon size={13} className="shrink-0" />
        )}
        <span className="truncate" aria-live="polite">{summary}</span>
        <CaretDownIcon
          size={11}
          className={`shrink-0 text-ink-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          className="mt-1.5 space-y-2.5 border-l border-edge pl-3"
          data-testid="agent-run-process-content"
        >
          {blocks.map((block) => {
            if (block.type === "anchor") {
              return <TimelineAnchor key={block.id} part={block.part} state={state} renderConfirmationCard={renderConfirmationCard} />;
            }
            if (block.type === "progress") {
              return <NaturalProgress key={block.id} part={block.part} />;
            }
            return <ProcessDisclosure key={block.id} parts={block.parts} state={state} />;
          })}
        </div>
      ) : null}
    </section>
  );
}

function AgentArtifactCard({
  artifact,
  accountId,
}: {
  artifact: Extract<ConversationMessagePart, { type: "artifact" }>["artifact"];
  accountId: string;
}) {
  const [open, setOpen] = useState(false);
  const kindMeta = {
    brief: { label: "摘要", Icon: ScrollIcon },
    report: { label: "报表", Icon: FileTextIcon },
    dashboard: { label: "图表看板", Icon: ChartPieIcon },
    deck: { label: "演示文稿", Icon: PresentationIcon },
  }[artifact.kind];
  const KindIcon = kindMeta.Icon;
  const browserUrl = api.getApplicationMessageArtifactUrl(
    artifact.applicationMessageId,
    accountId,
  );
  return (
    <>
      <section
        className="@container overflow-hidden rounded-xl border border-edge bg-paper-2 shadow-sm transition-colors hover:border-edge-2"
        data-testid="agent-artifact-card"
      >
        <div className="flex items-start gap-3 p-3.5 pb-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-coral-bg text-coral-2 @[230px]:h-10 @[230px]:w-10">
            <KindIcon size={17} weight="duotone" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-control font-semibold text-ink" title={artifact.title}>
                {artifact.title}
              </p>
              <span className="shrink-0 rounded-full border border-edge bg-paper px-1.5 py-px font-mono-meta text-meta text-ink-3">
                v{artifact.version}
              </span>
            </div>
            <p className="mt-1 truncate text-meta text-ink-3">
              {kindMeta.label}
              {artifact.dataSummary
                ? ` · 来源 ${artifact.dataSummary.sourceEmailCount} 封邮件 · ${artifact.dataSummary.timePointCount} 个时间点`
                : ""}
            </p>
            {artifact.preview ? (
              <p className="mt-2 border-l-2 border-coral/30 pl-2.5 text-meta leading-5 text-ink-2 line-clamp-2">
                {artifact.preview}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-edge bg-paper-3/50 px-3.5 py-2">
          <span className="inline-flex min-w-0 items-center gap-1 text-meta text-ink-3">
            <CheckIcon size={11} weight="bold" className="shrink-0 text-green" aria-hidden />
            <span className="hidden @[240px]:inline">已保存到应用消息</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={browserUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="浏览器打开"
              aria-label="浏览器打开"
              className="inline-flex min-h-8 min-w-8 items-center justify-center gap-1 rounded-full px-2.5 text-meta font-medium text-ink-2 transition-colors hover:bg-paper-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowSquareOutIcon size={11} />
              <span className="hidden @[240px]:inline">浏览器打开</span>
            </a>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-coral-2 px-3.5 text-meta font-medium text-paper-2 transition-colors hover:bg-coral-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              打开报告
              <CaretDownIcon size={10} weight="bold" className="-rotate-90" aria-hidden />
            </button>
          </div>
        </div>
      </section>
      {open ? (
        <ArtifactViewer
          accountId={accountId}
          message={{
            id: artifact.applicationMessageId,
            title: artifact.title,
            artifact: {
              id: artifact.artifactId,
              version: artifact.version,
              kind: artifact.kind,
              contentHash: artifact.contentHash,
            },
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AnswerCitations({
  citationIds,
  state,
  onOpenEmail,
  onOpenAttachment,
}: {
  citationIds: string[];
  state: ConversationState;
  onOpenEmail?: (emailId: string) => void;
  onOpenAttachment?: (attachmentId: string) => void;
}) {
  const [showAllMail, setShowAllMail] = useState(false);
  // Chips stay mounted one beat past collapse so the pop-out animation can
  // play before the extras actually unmount (Kinetics "Tag Input").
  const [renderAllMail, setRenderAllMail] = useState(false);
  const collapseTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    };
  }, []);
  const toggleAllMail = () => {
    if (showAllMail) {
      setShowAllMail(false);
      if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = window.setTimeout(() => setRenderAllMail(false), 260);
    } else {
      setRenderAllMail(true);
      setShowAllMail(true);
    }
  };
  const seenMailIds = new Set<string>();
  const citations = citationIds.flatMap((citationId) => {
    const citation = state.citations[citationId];
    if (!citation) return [];
    if (citation.source.kind === "mail") {
      if (seenMailIds.has(citation.source.emailId)) return [];
      seenMailIds.add(citation.source.emailId);
    }
    return [{ citationId, citation }];
  });
  const mailCitations = citations.filter(({ citation }) => citation.source.kind === "mail");
  const visibleMailIds = new Set(
    (showAllMail || renderAllMail ? mailCitations : mailCitations.slice(0, VISIBLE_MAIL_CITATION_COUNT))
      .map(({ citationId }) => citationId),
  );
  const visibleCitations = citations.filter(({ citationId, citation }) =>
    citation.source.kind !== "mail" || visibleMailIds.has(citationId),
  );
  const hiddenMailCount = Math.max(0, mailCitations.length - VISIBLE_MAIL_CITATION_COUNT);

  if (citations.length === 0) return null;
  return (
    <div className="mt-3 border-t border-edge pt-2.5" data-testid="agent-answer-citations">
      <div className={`flex flex-wrap gap-1.5 ${(showAllMail || renderAllMail) && hiddenMailCount > 0 ? "max-h-36 overflow-y-auto pr-1" : ""}`}>
        {visibleCitations.map(({ citationId, citation }) => {
          const mailIndex = mailCitations.findIndex((item) => item.citationId === citationId);
          const isExtra = citation.source.kind === "mail" && mailIndex >= VISIBLE_MAIL_CITATION_COUNT;
          const exiting = isExtra && !showAllMail && renderAllMail;
          return (
            <CitationChip
              key={citationId}
              citation={citation}
              index={citations.findIndex((item) => item.citationId === citationId)}
              entrance={isExtra && showAllMail ? "pop" : exiting ? "exit" : undefined}
              entranceDelay={isExtra ? Math.max(0, mailIndex - VISIBLE_MAIL_CITATION_COUNT) * 40 : 0}
              state={state}
              onOpenEmail={onOpenEmail}
              onOpenAttachment={onOpenAttachment}
            />
          );
        })}
      </div>
      {hiddenMailCount > 0 ? (
        <button
          type="button"
          className="mt-2 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={showAllMail}
          onClick={toggleAllMail}
        >
          {showAllMail ? "收起关联邮件" : `其余 ${hiddenMailCount} 封邮件`}
          <CaretDownIcon
            size={11}
            className={`transition-transform ${showAllMail ? "rotate-180" : ""}`}
          />
        </button>
      ) : null}
    </div>
  );
}

function TimelineAnchor({
  part,
  state,
  renderConfirmationCard,
}: {
  part: AgentTimelineAnchorPart;
  state: ConversationState;
  renderConfirmationCard?: (confirmationId: string) => ReactNode;
}) {
  if (part.type === "confirmation") {
    const confirmation = state.confirmations[part.confirmationId];
    if (!confirmation) return null;
    const card = renderConfirmationCard?.(part.confirmationId);
    if (card) {
      return <div data-confirmation-id={confirmation.id}>{card}</div>;
    }
    const statusLabel = {
      pending: "等待确认",
      confirmed: "已确认执行",
      rejected: "已拒绝",
      expired: "已过期，请重新生成",
      failed: "执行失败",
    }[confirmation.status];
    return (
      <div className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-meta select-text ${confirmation.status === "pending" ? "border-amber bg-amber-bg text-ink-2" : "border-edge bg-paper-3 text-ink-2"}`} data-confirmation-id={confirmation.id}>
        <ClockIcon size={14} weight="duotone" />
        <span className="min-w-0 flex-1 truncate">{statusLabel}：{confirmation.description}</span>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-red/40 bg-red-bg px-3 py-2.5 text-meta leading-5 text-red select-text">
      {getUserFacingError(part.message, "Agent 操作未能完成，请重试或调整要求。")}
    </div>
  );
}

function CitationChip({
  citation,
  index,
  entrance,
  entranceDelay = 0,
  state,
  onOpenEmail,
  onOpenAttachment,
}: {
  citation: WemailAgentCitation;
  index: number;
  /** Pop-in/out token motion for the "其余 N 封邮件" extras (.chip-pop-* in index.css). */
  entrance?: "pop" | "exit";
  entranceDelay?: number;
  state: ConversationState;
  onOpenEmail?: (emailId: string) => void;
  onOpenAttachment?: (attachmentId: string) => void;
}) {
  const source = citation.source;
  const attachment = source.kind === "attachment" ? state.attachments[source.attachmentId] : undefined;
  const available = source.kind === "mail" || (source.kind === "attachment" && attachment?.state === "ready");
  const label = source.label ?? (source.kind === "mail" ? "邮件" : source.kind === "attachment" ? "附件" : source.recordType);
  const openSource = () => {
    if (source.kind === "mail") onOpenEmail?.(source.emailId);
    if (source.kind === "attachment" && attachment?.state === "ready") onOpenAttachment?.(source.attachmentId);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-caption transition-colors ${available ? "bg-paper-3 text-ink-2 hover:bg-paper-4" : "bg-red-bg text-red"} ${entrance === "pop" ? "chip-pop-in" : entrance === "exit" ? "chip-pop-out" : ""}`}
          style={entrance && entranceDelay > 0 ? { animationDelay: `${entranceDelay}ms` } : undefined}
          aria-label={`引用 ${index + 1}: ${label}`}
        >
          {source.kind === "mail" ? <EnvelopeSimpleIcon size={10} /> : source.kind === "attachment" ? <FileIcon size={10} /> : <WarningCircleIcon size={10} />}
          [{index + 1}] {label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-3">
        <div className="space-y-2">
          <div className="text-xs font-semibold text-ink">{label}</div>
          {"excerpt" in source && source.excerpt ? <p className="text-meta leading-5 text-ink-2">{source.excerpt}</p> : null}
          {source.kind === "attachment" && source.page ? <p className="text-caption text-ink-3">第 {source.page} 页</p> : null}
          {available && (source.kind === "mail" || onOpenAttachment) ? (
            <button type="button" onClick={openSource} className="min-h-8 text-meta font-medium text-coral-2 hover:underline">
              {source.kind === "mail" ? "打开邮件" : "打开附件"}
            </button>
          ) : (
            <p className="text-caption text-red">来源当前不可用，请重新检索后再试。</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UserMessageContextTags({
  context,
  onOpenEmail,
}: {
  context?: AgentMessageContext;
  onOpenEmail?: (emailId: string) => void;
}) {
  const actionTags = context?.actionTags ?? [];
  // Multi-attach (@ mentions) takes precedence; fall back to the singular
  // legacy field so replayed history keeps rendering.
  const attachedMails = context?.attachedMails
    ?? (context?.attachedMail ? [context.attachedMail] : []);
  if (actionTags.length === 0 && attachedMails.length === 0) return null;
  return (
    <div
      className="flex max-w-full flex-wrap justify-end gap-1.5"
      data-testid="agent-user-message-context"
    >
      {actionTags.map((tag) => (
        <span
          key={tag}
          className="inline-flex min-h-7 max-w-full items-center rounded-full border border-coral/20 bg-coral-bg px-2.5 py-1 text-caption font-medium text-coral-2"
        >
          【{tag}】
        </span>
      ))}
      {attachedMails.map((mail, index) => {
        const subject = mail.subject.trim() || "当前邮件";
        const mailContent = (
          <>
            <EnvelopeSimpleIcon size={12} weight="bold" className="shrink-0 text-ink-3" />
            <span className="max-w-[220px] truncate" title={subject}>【{subject}】</span>
          </>
        );
        return mail.emailId && onOpenEmail ? (
          <button
            key={mail.emailId ?? index}
            type="button"
            onClick={() => onOpenEmail(mail.emailId!)}
            className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-edge bg-paper-2 px-2.5 py-1 text-caption text-ink-2 transition-colors hover:border-edge-2 hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`打开邮件：${subject}`}
          >
            {mailContent}
          </button>
        ) : (
          <span
            key={mail.emailId ?? index}
            className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-edge bg-paper-2 px-2.5 py-1 text-caption text-ink-2"
          >
            {mailContent}
          </span>
        );
      })}
    </div>
  );
}

export function UserMessage({
  message,
  onOpenEmail,
}: {
  message: ConversationMessageState;
  onOpenEmail?: (emailId: string) => void;
}) {
  const text = message.parts
    .filter((part): part is Extract<ConversationMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.markdown)
    .join("");
  return (
    <article className="agent-message-row flex justify-end pl-8" data-message-id={message.id}>
      <div className="flex max-w-[88%] flex-col items-end gap-1.5">
        <div className="rounded-xl rounded-br-sm bg-coral-2 px-3.5 py-2.5 text-control leading-5 text-paper-2 shadow-sm select-text">
          {text}
        </div>
        <UserMessageContextTags
          context={message.messageContext}
          onOpenEmail={onOpenEmail}
        />
      </div>
    </article>
  );
}

export function AssistantMessage({
  message,
  state,
  accountId,
  onOpenEmail,
  onOpenAttachment,
  onFollowup,
  renderConfirmationCard,
}: {
  message: ConversationMessageState;
  state: ConversationState;
  accountId: string;
  onOpenEmail?: (emailId: string) => void;
  onOpenAttachment?: (attachmentId: string) => void;
  onFollowup?: (text: string) => void;
  renderConfirmationCard?: (confirmationId: string) => ReactNode;
}) {
  const blocks = buildAgentMessagePresentation(message.parts);
  const processBlocks = blocks.filter(
    (block): block is AgentProcessBlock => block.type !== "answer",
  );
  const answerBlocks = blocks.filter(
    (block): block is Extract<AgentMessagePresentationBlock, { type: "answer" }> =>
      block.type === "answer",
  );
  const run = message.runId ? state.runs[message.runId] : undefined;
  return (
    <article
      className="agent-message-row flex gap-2.5"
      data-message-id={message.id}
      data-run-id={message.runId}
    >
      <AssistantMark />
      <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
        {processBlocks.length > 0 ? (
          <RunProcessDisclosure
            blocks={processBlocks}
            run={run}
            state={state}
            renderConfirmationCard={renderConfirmationCard}
          />
        ) : null}
        {answerBlocks.map((block) => (
            <FinalAnswerPart
              key={block.id}
              part={block.part}
              state={state}
              accountId={accountId}
              onOpenEmail={onOpenEmail}
              onOpenAttachment={onOpenAttachment}
              onFollowup={onFollowup}
            />
        ))}
      </div>
    </article>
  );
}

export function RunStatus({ startedAt }: { startedAt?: string }) {
  // Client-side elapsed so the wait is measurable; anchors on the run's
  // first message timestamp when provided, else on mount.
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0);
  useEffect(() => {
    const startedAtMs = startedAt ? new Date(startedAt).getTime() : Date.now();
    const timer = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <div className="flex items-center gap-2.5" role="status" aria-label="WeMail AI 正在思考">
      <AssistantMark />
      <span className="inline-flex items-center gap-2.5 rounded-full border border-edge bg-paper-2 px-3 py-2 shadow-sm">
        <span className="px-grid" aria-hidden>
          {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
        </span>
        <span className="text-caption text-ink-2">正在思考</span>
        <span className="text-caption tabular-nums text-ink-3" data-testid="agent-run-elapsed">
          {(elapsedMs / 1000).toFixed(0)}s
        </span>
      </span>
    </div>
  );
}

export function AgentConversationThread({
  state,
  isStreaming,
  accountId = "default",
  onOpenEmail,
  onOpenAttachment,
  onFollowup,
  renderConfirmationCard,
}: {
  state: ConversationState;
  isStreaming: boolean;
  accountId?: string;
  onOpenEmail?: (emailId: string) => void;
  onOpenAttachment?: (attachmentId: string) => void;
  onFollowup?: (text: string) => void;
  renderConfirmationCard?: (confirmationId: string) => ReactNode;
}) {
	const PAGE_SIZE = 80;
	const conversationHeadId = state.messageOrder[0] ?? "";
	const [windowState, setWindowState] = useState({
		headId: conversationHeadId,
		count: PAGE_SIZE,
	});
	const visibleCount = windowState.headId === conversationHeadId
		? windowState.count
		: PAGE_SIZE;
  const messages = state.messageOrder
    .map((messageId) => state.messages[messageId])
    .filter((message): message is ConversationMessageState => !!message);
  const lastMessage = messages.at(-1);
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const awaitingFirstPart =
    isStreaming && (!lastMessage || lastMessage.role !== "assistant" || lastMessage.parts.length === 0);
	const hiddenCount = Math.max(0, messages.length - visibleCount);
	const visibleMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  return (
    <div className="flex flex-col gap-4" data-testid="agent-conversation-v2">
	  {hiddenCount > 0 ? (
		<button
			type="button"
			className="mx-auto min-h-9 rounded-full border border-edge bg-paper-2 px-4 text-xs font-medium text-ink-2 hover:bg-paper-3"
			onClick={() => setWindowState({
				headId: conversationHeadId,
				count: visibleCount + PAGE_SIZE,
			})}
		>
			加载更早的对话（还有 {hiddenCount} 条）
		</button>
	  ) : null}
      {visibleMessages.map((message) => (
        message.role === "user"
          ? <UserMessage key={message.id} message={message} onOpenEmail={onOpenEmail} />
          : <AssistantMessage
              key={message.id}
              message={message}
              state={state}
              accountId={accountId}
              onOpenEmail={onOpenEmail}
              onOpenAttachment={onOpenAttachment}
              onFollowup={onFollowup}
              renderConfirmationCard={renderConfirmationCard}
            />
      ))}
      {awaitingFirstPart ? (
        <RunStatus startedAt={lastUserMessage?.createdAt} />
      ) : null}
    </div>
  );
}
