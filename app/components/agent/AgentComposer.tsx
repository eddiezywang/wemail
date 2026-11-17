import { ArrowDownIcon } from "@phosphor-icons/react/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CompassIcon } from "@phosphor-icons/react/Compass";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { ScrollIcon } from "@phosphor-icons/react/Scroll";
import { StopIcon } from "@phosphor-icons/react/Stop";
import { TranslateIcon } from "@phosphor-icons/react/Translate";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { XIcon } from "@phosphor-icons/react/X";
import type { Icon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import api from "~/services/api";
import type { Email } from "~/types";
import { useSearchEmails } from "~/queries/search";
import type { AgentAttachedMail } from "../../../shared/wemail/agent";
import type { ConversationFollowupState } from "../../../shared/wemail/conversationState";

export type AgentMailScope = "focused" | "mailbox";

/**
 * Slash commands for the agent composer (approved design section 08).
 * Prompts reuse the SuggestionBuilder copy so home suggestions and the
 * "/" menu stay one voice. Picking a command inserts the prompt for
 * review — the user still presses Enter to send.
 */
const SLASH_COMMANDS: ReadonlyArray<{ command: string; label: string; hint: string; prompt: string; icon: Icon }> = [
	{ command: "总结", label: "总结当前邮件", hint: "列出重点和风险", prompt: "总结这封邮件，列出重点和风险。", icon: ScrollIcon },
	{ command: "待办", label: "提取待办", hint: "提取需要跟进的事项", prompt: "从当前邮件中提取需要跟进的待办事项。", icon: ListChecksIcon },
	{ command: "回复", label: "起草回复", hint: "起草简洁回复，确认后发送", prompt: "基于当前邮件帮我起草一封简洁回复，等待我确认后再发送。", icon: PaperPlaneRightIcon },
	{ command: "翻译", label: "翻译邮件", hint: "翻译成首选语言", prompt: "把当前邮件翻译成我的首选语言。", icon: TranslateIcon },
	{ command: "下一步", label: "下一步建议", hint: "给出最值得执行的下一步", prompt: "分析当前邮件内容，从帮助我推进工作的角度给出最值得执行的下一步。", icon: CompassIcon },
];

/**
 * One attached-mail token in the prompt bar — the focused mail and every
 * @-picked mail render identically. Chips pop in on mount (staggered) and
 * the ✕ pops the chip out (0.24s scale-down, Kinetics "Tag Input") before
 * the removal commits.
 */
function MailChip({
	mail,
	onRemove,
	delayMs = 0,
	testId,
}: {
	mail: AgentAttachedMail;
	onRemove: () => void;
	delayMs?: number;
	testId?: string;
}) {
	const [exiting, setExiting] = useState(false);
	const timerRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, []);
	const remove = () => {
		if (exiting) return;
		setExiting(true);
		timerRef.current = window.setTimeout(onRemove, 240);
	};
	return (
		<span
			data-testid={testId}
			className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge bg-paper px-2.5 py-1 text-caption text-ink-2 chip-pop-in ${exiting ? "chip-pop-out" : ""}`}
			style={!exiting && delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined}
		>
			<EnvelopeSimpleIcon size={12} weight="bold" className="shrink-0 text-coral-2" />
			<span className="max-w-[180px] truncate" title={mail.subject}>
				{mail.subject}
			</span>
			<button
				type="button"
				aria-label={`取消关联：${mail.subject}`}
				onClick={remove}
				className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<XIcon size={10} weight="bold" />
			</button>
		</span>
	);
}

export interface AgentComposerProps {
  accountId: string;
  conversationId: string;
  isStreaming: boolean;
  followups: ConversationFollowupState[];
  onSubmit: (text: string) => void;
  onStop: () => void;
  onUpdateFollowup: (id: string, text: string) => void;
  onRemoveFollowup: (id: string) => void;
  onMoveFollowup: (id: string, direction: -1 | 1) => void;
  onResumeFollowups: () => void;
  onInteraction?: () => void;
  inputRequest?: { id: number; text: string };
  /** The mail whose detail is open — shown as the default @-attached chip. */
  focusedMail?: AgentAttachedMail;
  onDismissFocusedMail?: () => void;
  /** Extra mails the user @-attached to the next message. */
  attachedMails?: AgentAttachedMail[];
  onAttachMail?: (mail: AgentAttachedMail) => void;
  onRemoveAttachedMail?: (key: string) => void;
}

export function AgentComposer({
  accountId,
  conversationId,
  isStreaming,
  followups,
  onSubmit,
  onStop,
  onUpdateFollowup,
  onRemoveFollowup,
  onMoveFollowup,
  onResumeFollowups,
  onInteraction,
  inputRequest,
  focusedMail,
  onDismissFocusedMail,
  attachedMails = [],
  onAttachMail,
  onRemoveAttachedMail,
}: AgentComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const slashQuery = value.startsWith("/") && !value.includes("\n") ? value.slice(1) : null;
  const slashMatches = slashQuery === null
    ? []
    : SLASH_COMMANDS.filter((command) =>
        command.command.startsWith(slashQuery) || command.label.includes(slashQuery));
  const slashOpen = !slashDismissed && slashQuery !== null && slashMatches.length > 0;
  const clampedSlashIndex = Math.min(slashActiveIndex, Math.max(slashMatches.length - 1, 0));
  const pickSlashCommand = (index: number) => {
    const command = slashMatches[index];
    if (!command) return;
    setValue(command.prompt);
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(command.prompt.length, command.prompt.length);
    });
  };

  // ── @ mail attach ──────────────────────────────────────────────────────
  // Typing "@" (at start or after whitespace) opens a mail picker. Picking
  // a mail adds an attachment chip and removes the trigger text; the next
  // message carries the whole chip list plus the focused mail by default.
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const atMatch = /(?:^|\s)@([^\s@]*)$/.exec(value);
  const atQuery = atMatch ? atMatch[1] : null;
  // Default candidates come from the global search endpoint (no folder
  // scope → every folder except Trash/Spam/Drafts), not the INBOX-only
  // list query, so @ can reach any mail. Keyword typing narrows via the
  // same live search the workbench uses.
  const recentEmailsQuery = useQuery({
    queryKey: ["agent-at-recent-mails", accountId],
    enabled: !!accountId && atMatch !== null,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api.searchEmails(accountId!, { page: "1", limit: "50" }, { signal }),
  });
  const liveSearchQuery = useSearchEmails(accountId, atQuery ?? "");
  const atCandidates = useMemo(() => {
    let source: Email[] = [];
    if (atQuery) {
      source = liveSearchQuery.data?.pages[0]?.results ?? [];
    } else {
      const data = recentEmailsQuery.data;
      source = Array.isArray(data) ? data : data?.emails ?? [];
    }
    const attachedKeys = new Set(
      attachedMails.map((mail) => mail.emailId ?? mail.subject),
    );
    return source
      .filter((email) => !attachedKeys.has(email.id))
      .slice(0, 10);
  }, [atQuery, attachedMails, liveSearchQuery.data, recentEmailsQuery.data]);
  const atOpen = !atDismissed && atMatch !== null && !!onAttachMail && atCandidates.length > 0;
  const clampedAtIndex = Math.min(atActiveIndex, Math.max(atCandidates.length - 1, 0));
  const pickAtEmail = (index: number) => {
    const email = atCandidates[index];
    if (!email || !onAttachMail) return;
    onAttachMail({
      emailId: email.id,
      subject: email.subject,
      sender: email.sender,
      receivedAt: email.date,
    });
    setValue(value.replace(/@[^@\n]*$/, ""));
    setAtDismissed(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  useEffect(() => {
    setAtActiveIndex(0);
  }, [atQuery]);

  useEffect(() => {
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("wemail.agent-composer-draft:")) {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      // Storage can be unavailable in hardened renderer contexts.
    }
  }, []);

  useEffect(() => {
    let active = true;
    setValue("");
    setEditingId(null);
    void window.wemailDesktop?.agentDrafts
      ?.get(accountId, conversationId)
      .then((draft) => {
        if (active && typeof draft?.text === "string") setValue(draft.text);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [accountId, conversationId]);

  useEffect(() => {
    if (!inputRequest) return;
    setValue(inputRequest.text);
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(
      inputRequest.text.length,
      inputRequest.text.length,
    );
  }, [inputRequest]);

  useEffect(() => {
    const drafts = window.wemailDesktop?.agentDrafts;
    if (!drafts) return;
    if (value) {
      void drafts.save(accountId, conversationId, value).catch(() => undefined);
    } else {
      void drafts.delete(accountId, conversationId).catch(() => undefined);
    }
  }, [accountId, conversationId, value]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  };
  const paused = followups.some((item) => item.state === "paused");

  return (
    <div className="space-y-2.5">
      {followups.length > 0 ? (
        <section
          className="overflow-hidden rounded-xl border border-edge bg-paper-3"
          aria-label="后续消息队列"
          data-testid="agent-followup-queue"
        >
          <div className="flex items-center justify-between border-b border-edge px-3 py-2">
            <span className="text-meta font-semibold text-ink-2">
              {paused ? "后续消息已暂停" : `后续消息 · ${followups.length}`}
            </span>
            {paused ? (
              <button
                type="button"
                onClick={onResumeFollowups}
                className="min-h-9 rounded-full bg-coral-2 px-3 text-meta font-medium text-paper-2 hover:bg-coral-strong"
              >
                确认继续
              </button>
            ) : null}
          </div>
          <ol className="divide-y divide-edge">
            {followups.map((item, index) => (
              <li key={item.id} className="flex items-center gap-2 px-3 py-2" data-followup-id={item.id}>
                <span className="text-meta tabular-nums text-ink-2">{index + 1}</span>
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={editingText}
                    onChange={(event) => setEditingText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && editingText.trim()) {
                        onUpdateFollowup(item.id, editingText.trim());
                        setEditingId(null);
                      }
                    }}
                    className="min-w-0 flex-1 rounded-md border border-edge-2 bg-paper-2 px-2 py-1.5 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`编辑后续消息 ${index + 1}`}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-meta text-ink-2">{item.text}</span>
                )}
                <div className="flex shrink-0 items-center gap-0.5 text-ink-3">
                  {editingId === item.id ? (
                    <button
                      type="button"
                      aria-label="保存后续消息"
                      onClick={() => {
                        if (!editingText.trim()) return;
                        onUpdateFollowup(item.id, editingText.trim());
                        setEditingId(null);
                      }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    ><CheckIcon size={11} /></button>
                  ) : (
                    <button
                      type="button"
                      aria-label="编辑后续消息"
                      onClick={() => { setEditingId(item.id); setEditingText(item.text); }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    ><PencilSimpleIcon size={11} /></button>
                  )}
                  <button type="button" aria-label="上移后续消息" disabled={index === 0} onClick={() => onMoveFollowup(item.id, -1)} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-paper-2 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowUpIcon size={13} /></button>
                  <button type="button" aria-label="下移后续消息" disabled={index === followups.length - 1} onClick={() => onMoveFollowup(item.id, 1)} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-paper-2 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowDownIcon size={13} /></button>
                  <button type="button" aria-label="移除后续消息" onClick={() => onRemoveFollowup(item.id)} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-paper-2 hover:text-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><TrashIcon size={13} /></button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="relative rounded-xl border border-edge-2 bg-paper-2 px-3.5 pb-2 pt-2.5 transition-colors focus-within:border-coral focus-within:ring-1 focus-within:ring-ring">
        {slashOpen ? (
          <div
            role="listbox"
            aria-label="斜杠命令"
            data-testid="agent-slash-commands"
            className="absolute bottom-full left-0 z-20 mb-2 w-[300px] overflow-hidden rounded-xl border border-edge bg-paper-2 p-1.5 shadow-[var(--shadow-3)]"
          >
            <div className="px-2 pb-1 pt-1 text-caption font-semibold tracking-wide text-ink-4">
              命令
            </div>
            {slashMatches.map((command, index) => {
              const CommandIcon = command.icon;
              const selected = index === clampedSlashIndex;
              return (
                <button
                  key={command.command}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickSlashCommand(index)}
                  onMouseEnter={() => setSlashActiveIndex(index)}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    selected ? "bg-paper-3" : "hover:bg-paper-3"
                  }`}
                >
                  <CommandIcon size={15} weight="bold" className="mt-[3px] shrink-0 text-coral-2" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-ui font-medium text-ink">{command.label}</span>
                      <span className="font-mono-meta text-meta text-coral-2">/{command.command}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-caption text-ink-3">{command.hint}</span>
                  </span>
                  {selected ? (
                    <CheckIcon size={13} weight="bold" className="mt-[3px] shrink-0 text-coral-2" />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {atOpen ? (
          <div
            role="listbox"
            aria-label="关联邮件"
            data-testid="agent-at-candidates"
            className="absolute bottom-full left-0 z-20 mb-2 w-[340px] overflow-hidden rounded-xl border border-edge bg-paper-2 p-1.5 shadow-[var(--shadow-3)]"
          >
            <div className="px-2 pb-1 pt-1 text-caption font-semibold tracking-wide text-ink-4">
              关联邮件
            </div>
            {atCandidates.map((email, index) => {
              const selected = index === clampedAtIndex;
              const detail = [email.sender, email.date].filter(Boolean).join(" · ");
              return (
                <button
                  key={email.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickAtEmail(index)}
                  onMouseEnter={() => setAtActiveIndex(index)}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    selected ? "bg-paper-3" : "hover:bg-paper-3"
                  }`}
                >
                  <EnvelopeSimpleIcon size={15} weight="bold" className="mt-[3px] shrink-0 text-coral-2" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-ink" title={email.subject}>
                      {email.subject || "（无主题）"}
                    </span>
                    {detail ? (
                      <span className="mt-0.5 block truncate text-caption text-ink-3">{detail}</span>
                    ) : null}
                  </span>
                  {selected ? (
                    <CheckIcon size={13} weight="bold" className="mt-[3px] shrink-0 text-coral-2" />
                  ) : null}
                </button>
              );
            })}
            <div className="mt-1 border-t border-edge px-2 pb-1 pt-1.5 text-caption text-ink-4">
              {atQuery ? "已搜索整个邮箱 · 继续输入可缩小范围" : "最近邮件 · 输入关键词搜索整个邮箱"}
            </div>
          </div>
        ) : null}
        {focusedMail || attachedMails.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pb-1.5" data-testid="agent-attached-mails">
            {focusedMail && !attachedMails.some((mail) => mail.emailId && mail.emailId === focusedMail.emailId) ? (
              <MailChip
                key="focused"
                mail={focusedMail}
                testId="agent-focused-mail-chip"
                onRemove={() => onDismissFocusedMail?.()}
              />
            ) : null}
            {attachedMails.map((mail, index) => (
              <MailChip
                key={mail.emailId ?? mail.subject}
                mail={mail}
                delayMs={index * 40}
                onRemove={() => onRemoveAttachedMail?.(mail.emailId ?? mail.subject)}
              />
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          id="agent-chat-input"
          name="agent-chat-input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (!event.target.value.startsWith("/")) setSlashDismissed(false);
            if (/(?:^|\s)@[^\s@]*$/.test(event.target.value)) setAtDismissed(false);
            if (event.target.value.length > 0) onInteraction?.();
          }}
          onKeyDown={(event) => {
            if (slashOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashActiveIndex((current) => (current + 1) % slashMatches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashActiveIndex((current) => (current - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                pickSlashCommand(clampedSlashIndex);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSlashDismissed(true);
                return;
              }
            }
            if (atOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setAtActiveIndex((current) => (current + 1) % atCandidates.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setAtActiveIndex((current) => (current - 1 + atCandidates.length) % atCandidates.length);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                pickAtEmail(clampedAtIndex);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setAtDismissed(true);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={isStreaming ? "输入后续要求，将在本轮完成后执行" : "搜索、写作或询问任何内容… / 命令 · @ 邮件"}
          rows={1}
          aria-label="向 WeMail AI 发送消息"
          className="min-h-[64px] max-h-[180px] w-full resize-none bg-transparent px-1 pb-2 pt-2 text-ui leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none"
          style={{ height: "auto", overflow: "hidden" }}
          onInput={(event) => {
            const target = event.target as HTMLTextAreaElement;
            target.style.height = "auto";
            target.style.height = `${Math.min(target.scrollHeight, 180)}px`;
            target.style.overflow = target.scrollHeight > 180 ? "auto" : "hidden";
          }}
        />
        <div className="flex items-center justify-end px-0.5">
          <div className="flex items-center gap-2.5">
            {isStreaming ? <span className="text-caption text-ink-3">发送将加入队列</span> : null}
            {isStreaming ? (
              <button type="button" onClick={onStop} className="inline-flex h-10 w-10 shrink-0 aspect-square items-center justify-center rounded-full bg-coral-2 text-paper-2 hover:bg-coral-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="停止生成" data-testid="agent-stop">
                <StopIcon size={14} weight="fill" />
              </button>
            ) : null}
            <button type="button" onClick={submit} disabled={!value.trim()} className="inline-flex h-10 w-10 shrink-0 aspect-square items-center justify-center rounded-full bg-coral-2 text-paper-2 hover:bg-coral-strong disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={isStreaming ? "加入后续消息队列" : "发送消息"} data-testid="agent-send">
              <ArrowUpIcon size={14} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
