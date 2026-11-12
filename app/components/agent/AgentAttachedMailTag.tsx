import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import type { AgentAttachedMail } from "shared/wemail/agent";

interface AgentAttachedMailTagProps {
	mail: AgentAttachedMail;
	onClick?: () => void;
}

function formatReceivedAt(value: string | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(date);
}

export function AgentAttachedMailTag({
	mail,
	onClick,
}: AgentAttachedMailTagProps) {
	const subject = mail.subject.trim() || "当前邮件";
	const receivedAt = formatReceivedAt(mail.receivedAt);
	const detail = [mail.sender?.trim(), receivedAt].filter(Boolean).join(" · ");
	const content = (
		<>
			<EnvelopeSimpleIcon size={13} weight="bold" className="shrink-0 text-coral-2" />
			<span className="truncate text-meta text-ink" title={subject}>
				{subject}
			</span>
			{detail ? <span className="hidden truncate text-caption text-ink-3 sm:inline">{detail}</span> : null}
		</>
	);

	if (!onClick) {
		return (
			<div
				className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge bg-paper-2 px-2.5 py-1.5"
				data-testid="agent-attached-mail-tag"
			>
				{content}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-edge bg-paper-2 px-2.5 py-1.5 text-left transition-colors hover:border-edge-2 hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			data-testid="agent-attached-mail-tag"
			aria-label={`打开关联邮件：${subject}`}
		>
			{content}
		</button>
	);
}
