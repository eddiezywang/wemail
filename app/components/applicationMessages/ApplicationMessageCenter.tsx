import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { FileIcon } from "@phosphor-icons/react/File";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { ApplicationMessage, ApplicationMessageContentBlock } from "../../../shared/wemail/applicationMessages";
import { useArchiveApplicationMessage, useInfiniteApplicationMessages, useMarkApplicationMessageRead, useSmartTagTopicAction } from "~/queries/applicationMessages";
import { ArtifactViewer } from "./ArtifactViewer";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { AsyncState } from "~/components/ui/async-state";
import { ConfirmActionDialog } from "~/components/ui/confirm-action-dialog";
import { Input } from "~/components/ui/input";
import { getUserFacingError } from "~/lib/user-facing-error";
import api from "~/services/api";

const PRIMARY_ACTION_CLASS = "rounded-md bg-coral px-3 py-2 text-sm text-paper disabled:opacity-50";
const SECONDARY_ACTION_CLASS = "rounded-md border border-edge px-3 py-2 text-sm text-ink-2 hover:bg-paper-3 disabled:opacity-50";

function sourceTypeLabel(sourceType: ApplicationMessage["sourceType"]): string {
	switch (sourceType) {
		case "automation":
			return "自动化规则";
		case "agent":
			return "智能助手";
		case "system":
			return "系统消息";
		default:
			return "WeMail";
	}
}

export function ApplicationMessageCenter({ accountId }: { accountId?: string }) {
	const query = useInfiniteApplicationMessages(accountId);
	const read = useMarkApplicationMessageRead(accountId);
	const archive = useArchiveApplicationMessage(accountId);
	const topicAction = useSmartTagTopicAction(accountId);
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const [selected, setSelected] = useState<ApplicationMessage | null>(null);
	const [artifactMessage, setArtifactMessage] = useState<ApplicationMessage | null>(null);
	const [editTopic, setEditTopic] = useState<{ topicId: string; name: string } | null>(null);
	const [archiveCandidate, setArchiveCandidate] = useState<ApplicationMessage | null>(null);
	const messages = query.data?.pages.flatMap((page) => page.messages) ?? [];
	const closeSelected = () => {
		setSelected(null);
		searchParams.delete("message");
		setSearchParams(searchParams, { replace: true });
	};
	useEffect(() => {
		const messageId = searchParams.get("message");
		if (!messageId || selected || messages.length === 0) return;
		const target = messages.find((message) => message.id === messageId);
		if (!target) return;
		setSelected(target);
		if (searchParams.get("open") === "artifact" && target.artifact) {
			setArtifactMessage(target);
		}
		if (!target.readAt) read.mutate({ id: target.id, value: true });
	}, [messages, read, searchParams, selected]);
	if (!accountId) return <AsyncState kind="empty" title="请先登录邮箱账户" description="连接邮箱后，自动化和智能助手的消息会显示在这里。" />;
	if (query.isLoading) return <AsyncState kind="loading" title="正在加载应用消息" delayed />;
	if (query.isError) return <AsyncState kind="error" title="应用消息加载失败" description="请检查网络后重试。" actionLabel="重试" onAction={() => void query.refetch()} actionPending={query.isFetching} />;
	const selectedArtifactUrl = selected?.artifact ? api.getApplicationMessageArtifactUrl(selected.id, accountId) : undefined;
	return <div className="flex h-full min-h-0 flex-col bg-paper">
		<header className="border-b border-edge px-6 py-5">
			<div className="flex items-center gap-2"><BellIcon size={22} /><h1 className="text-xl font-semibold text-ink">应用消息</h1></div>
			<p className="mt-1 text-sm text-ink-3">自动化规则、定时任务与 Agent 主动交付的信息都会保留在这里。</p>
		</header>
		<div className="min-h-0 flex-1 overflow-y-auto p-3">
			{messages.length === 0 ? <AsyncState kind="empty" title="暂无应用消息" description="新的自动化结果和智能助手通知会保留在这里。" /> : messages.map((message) =>
				message.artifact ? (
					<ReportMessageCard
						key={message.id}
						message={message}
						accountId={accountId}
						onOpenDetail={() => { setSelected(message); if (!message.readAt) read.mutate({ id: message.id, value: true }); }}
						onOpenArtifact={() => { setArtifactMessage(message); if (!message.readAt) read.mutate({ id: message.id, value: true }); }}
					/>
				) : (
				<button key={message.id} type="button" onClick={() => { setSelected(message); if (!message.readAt) read.mutate({ id: message.id, value: true }); }} className="mb-2 flex w-full gap-3 rounded-lg border border-edge bg-paper-2 p-4 text-left transition [content-visibility:auto] [contain-intrinsic-size:112px] hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					<span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${message.readAt ? "bg-transparent" : "bg-accent"}`} />
					<span className="min-w-0 flex-1"><span className="flex justify-between gap-3"><strong className="truncate text-sm text-ink">{message.title}</strong><time className="shrink-0 text-xs text-ink-4">{new Date(message.createdAt).toLocaleString()}</time></span><span className="mt-1 line-clamp-2 text-sm text-ink-3">{message.preview}</span>{message.keyMetrics?.length ? <span className="mt-2 flex flex-wrap gap-2">{message.keyMetrics.slice(0, 4).map((metric) => <span key={metric.label} className="rounded-full bg-paper-3 px-2 py-1 text-xs text-ink-2">{metric.label} · {metric.value}</span>)}</span> : null}{message.delayed ? <span className="mt-2 block text-xs text-amber">延迟补跑结果</span> : null}</span>
				</button>))}
			{query.hasNextPage ? (
				<div className="flex justify-center py-3">
					<Button
						variant="secondary"
						loading={query.isFetchingNextPage}
						onClick={() => void query.fetchNextPage()}
					>
						加载更早的消息
					</Button>
				</div>
			) : null}
		</div>
		<Dialog open={!!selected} onOpenChange={(open) => !open && closeSelected()}>
			{selected ? <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
				<DialogHeader className="border-b border-edge p-5 pr-12"><DialogTitle>{selected.title}</DialogTitle><DialogDescription>{new Date(selected.createdAt).toLocaleString()} · {sourceTypeLabel(selected.sourceType)}</DialogDescription></DialogHeader>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">{selected.content.map((block, index) => <ContentBlock key={index} block={block} />)}</div>
				<footer className="flex flex-wrap justify-end gap-2 border-t border-edge p-4">{selected.interactions.map((interaction, index) => {
					if (interaction.type === "openEmail") return <button key={index} className={PRIMARY_ACTION_CLASS} onClick={() => navigate(`/message/${encodeURIComponent(interaction.emailId)}${interaction.accountId ? `?accountId=${encodeURIComponent(interaction.accountId)}` : ""}`)}>{interaction.label}</button>;
					if ((interaction.type === "openEmails" || interaction.type === "previewSmartTagTopic") && interaction.emailIds[0]) {
						const accountId = interaction.type === "openEmails" ? interaction.references?.[0]?.accountId ?? interaction.accountId : undefined;
						return <button key={index} className={SECONDARY_ACTION_CLASS} onClick={() => navigate(`/message/${encodeURIComponent(interaction.emailIds[0]!)}${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`)}>{interaction.label}</button>;
					}
					if (interaction.type === "openAutomationRule") return <button key={index} className={PRIMARY_ACTION_CLASS} onClick={() => navigate(`/automation?rule=${encodeURIComponent(interaction.ruleId)}`)}>{interaction.label}</button>;
					if (interaction.type === "openArtifact") return <button key={index} className={PRIMARY_ACTION_CLASS} onClick={() => setArtifactMessage(selected)}>应用内打开</button>;
					if (interaction.type === "createSmartTagFromTopic") return <button key={index} disabled={topicAction.isPending} className={PRIMARY_ACTION_CLASS} onClick={() => topicAction.mutate({ topicId: interaction.topicId, action: "create" }, { onSuccess: () => setSelected(null) })}>{interaction.label}</button>;
					if (interaction.type === "editSmartTagFromTopic") return <button key={index} disabled={topicAction.isPending} className={SECONDARY_ACTION_CLASS} onClick={() => setEditTopic({ topicId: interaction.topicId, name: selected.title.match(/「(.+)」/)?.[1] ?? "" })}>{interaction.label}</button>;
					if (interaction.type === "deferSmartTagTopic" || interaction.type === "suppressSmartTagTopic") return <button key={index} disabled={topicAction.isPending} className={SECONDARY_ACTION_CLASS} onClick={() => topicAction.mutate({ topicId: interaction.topicId, action: interaction.type === "deferSmartTagTopic" ? "defer" : "suppress" }, { onSuccess: () => setSelected(null) })}>{interaction.label}</button>;
					return null;
				})}{selected.artifact ? <>
					{!selected.interactions.some((interaction) => interaction.type === "openArtifact") ? <button className={PRIMARY_ACTION_CLASS} onClick={() => setArtifactMessage(selected)}>应用内打开</button> : null}
					{selectedArtifactUrl ? <a className={SECONDARY_ACTION_CLASS} href={selectedArtifactUrl} target="_blank" rel="noopener noreferrer">浏览器中打开</a> : null}
				</> : null}<Button variant="ghost" disabled={read.isPending} onClick={() => read.mutate({ id: selected.id, value: !selected.readAt })}><EnvelopeOpenIcon />{selected.readAt ? "标为未读" : "标为已读"}</Button><Button variant="ghost" disabled={archive.isPending} onClick={() => setArchiveCandidate(selected)}><ArchiveIcon />归档</Button></footer>
			</DialogContent> : null}
		</Dialog>
		<Dialog open={!!editTopic} onOpenChange={(open) => !open && setEditTopic(null)}>
			<DialogContent className="max-w-[420px]">
				<DialogHeader>
					<DialogTitle>编辑智能标签</DialogTitle>
					<DialogDescription>为这个邮件主题填写一个清晰、易识别的标签名称。</DialogDescription>
				</DialogHeader>
				<Input
					autoFocus
					aria-label="智能标签名称"
					value={editTopic?.name ?? ""}
					onChange={(event) => setEditTopic((current) => current ? { ...current, name: event.target.value } : null)}
				/>
				<DialogFooter>
					<Button variant="secondary" onClick={() => setEditTopic(null)}>取消</Button>
					<Button
						disabled={!editTopic?.name.trim() || topicAction.isPending}
						loading={topicAction.isPending}
						onClick={() => {
							if (!editTopic?.name.trim()) return;
							topicAction.mutate(
								{ topicId: editTopic.topicId, action: "create", name: editTopic.name.trim() },
								{ onSuccess: () => { setEditTopic(null); closeSelected(); } },
							);
						}}
					>
						保存标签
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
		<ConfirmActionDialog
			open={!!archiveCandidate}
			onOpenChange={(open) => !open && setArchiveCandidate(null)}
			title="归档这条应用消息？"
			description="归档后，这条消息会从当前列表移除。消息关联的邮件、自动化和产物不会被删除。"
			confirmLabel="确认归档"
			destructive={false}
			pending={archive.isPending}
			onConfirm={() => {
				if (!archiveCandidate) return;
				archive.mutate(
					{ id: archiveCandidate.id, value: true },
					{
						onSuccess: () => {
							setArchiveCandidate(null);
							closeSelected();
							toast.success("应用消息已归档");
						},
						onError: (error) => toast.error(getUserFacingError(error, "归档失败，请稍后重试。")),
					},
				);
			}}
		/>
		{artifactMessage && <ArtifactViewer accountId={accountId} message={artifactMessage} onClose={() => setArtifactMessage(null)} />}
	</div>;
}

/**
 * Report delivery card (approved design section 13). Messages that carry
 * an artifact render as a finished-delivery card instead of a plain list
 * row: coral report mark, key metrics as stat pairs, artifact version,
 * and a direct 打开报告 action into the in-app ArtifactViewer (artifacts
 * stay in-app — never a file:// link).
 */
function ReportMessageCard({
	message,
	accountId,
	onOpenDetail,
	onOpenArtifact,
}: {
	message: ApplicationMessage;
	accountId: string;
	onOpenDetail: () => void;
	onOpenArtifact: () => void;
}) {
	const artifactUrl = api.getApplicationMessageArtifactUrl(message.id, accountId);
	return (
		<section
			className="mb-2 overflow-hidden rounded-lg border border-edge bg-paper-2 transition [content-visibility:auto] [contain-intrinsic-size:180px] hover:bg-paper-3"
			data-testid="report-delivery-card"
			data-artifact-id={message.artifact?.id}
		>
			<button type="button" onClick={onOpenDetail} className="flex w-full gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
				<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-coral-bg text-coral">
					<FileIcon size={18} weight="duotone" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-center justify-between gap-3">
						<strong className="flex min-w-0 items-center gap-2 text-sm text-ink">
							<span className="truncate">{message.title}</span>
							{!message.readAt ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="未读" /> : null}
						</strong>
						<time className="shrink-0 text-xs text-ink-4">{new Date(message.createdAt).toLocaleString()}</time>
					</span>
					<span className="mt-1 block text-xs text-ink-3">{sourceTypeLabel(message.sourceType)} · 报告第 {message.artifact?.version} 版{message.delayed ? " · 延迟补跑结果" : ""}</span>
					{message.preview ? <span className="mt-2 line-clamp-2 block text-sm text-ink-3">{message.preview}</span> : null}
					{message.keyMetrics?.length ? (
						<span className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
							{message.keyMetrics.slice(0, 4).map((metric) => (
								<span key={metric.label} className="min-w-0">
									<span className="block text-base font-semibold leading-none tabular-nums text-ink">{metric.value}</span>
									<span className="mt-1 block text-xs text-ink-3">{metric.label}</span>
								</span>
							))}
						</span>
					) : null}
				</span>
			</button>
			<div className="flex flex-wrap justify-end gap-2 border-t border-edge px-3 py-2">
				<a
					href={artifactUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex min-h-9 items-center rounded-md border border-edge px-3 text-sm text-ink-2 transition-colors hover:bg-paper-3"
				>
					浏览器中打开
				</a>
				<button
					type="button"
					onClick={onOpenArtifact}
					data-testid="report-delivery-open"
					className="inline-flex min-h-9 items-center rounded-md bg-coral-2 px-3.5 text-sm font-medium text-paper-2 transition-colors hover:bg-coral-strong"
				>
					打开报告
				</button>
			</div>
		</section>
	);
}

function ContentBlock({ block }: { block: ApplicationMessageContentBlock }) {
	if (block.type === "heading") { const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4"; return <Tag className="font-semibold text-ink">{block.text}</Tag>; }
	if (block.type === "paragraph") return <p className="whitespace-pre-wrap text-sm leading-6 text-ink-2">{block.text}</p>;
	if (block.type === "list") return block.ordered ? <ol className="list-decimal space-y-1 pl-5 text-sm">{block.items.map((item, i) => <li key={i}>{item}</li>)}</ol> : <ul className="list-disc space-y-1 pl-5 text-sm">{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
	if (block.type === "status") return <div className="flex justify-between rounded-md bg-paper-2 px-3 py-2 text-sm"><span className="text-ink-3">{block.label}</span><strong>{block.value}</strong></div>;
	if (block.type === "callout") return <aside className="rounded-lg border border-edge bg-paper-2 p-4"><strong className="text-sm">{block.title}</strong><p className="mt-1 text-sm text-ink-2">{block.text}</p></aside>;
	return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{block.headers.map((h) => <th key={h} className="border-b border-edge p-2">{h}</th>)}</tr></thead><tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b border-edge p-2">{cell}</td>)}</tr>)}</tbody></table></div>;
}
