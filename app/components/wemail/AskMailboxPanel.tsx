// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AskMailboxPanel — “问邮箱” surface backed by `POST /api/agent/mail-qa`.
 *
 * Lives inside the right-rail WeMail AI sidebar, above the chat. It's a
 * lightweight Q&A flow distinct from the agent chat: send a single
 * question, receive a grounded answer plus a list of citation cards.
 * Clicking a citation calls `useUIStore().selectEmail(emailId)` so the
 * detail pane jumps to the cited email — same affordance the agent uses
 * for `find_relevant_emails`.
 */

import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { useState } from "react";
import { Textarea } from "~/components/ui/textarea";
import { useImeComposition } from "~/hooks/useImeComposition";
import { useUIStore } from "~/hooks/useUIStore";
import { useCurrentAccount } from "~/queries/currentAccount";
import api from "~/services/api";
import { getUserFacingError } from "~/lib/user-facing-error";

interface AskState {
	loading: boolean;
	answer?: string;
	citations: Array<{ emailId: string; snippet: string }>;
	error?: string;
}

const INITIAL: AskState = { loading: false, citations: [] };

export function AskMailboxPanel() {
	const { data: currentAccount } = useCurrentAccount();
	const accountId = currentAccount?.account?.id;
	const selectEmail = useUIStore((state) => state.selectEmail);
	const [question, setQuestion] = useState("");
	const [state, setState] = useState<AskState>(INITIAL);
	const [open, setOpen] = useState(false);
	const ime = useImeComposition();

	const canSubmit =
		!state.loading && !!accountId && question.trim().length > 0;

	const submit = async () => {
		if (!canSubmit || !accountId) return;
		const q = question.trim();
		setState({ loading: true, citations: [] });
		try {
			const res = await api.askMailbox(q, accountId);
			setState({
				loading: false,
				answer: res.answer,
				citations: res.citations,
			});
		} catch (err) {
			setState({
				loading: false,
				citations: [],
				error: getUserFacingError(err, "邮箱检索失败，请稍后重试。"),
			});
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter") return;
		if (e.shiftKey) return;
		if (ime.isComposingRef.current) return;
		e.preventDefault();
		void submit();
	};

	return (
		<div
			data-testid="ask-mailbox-panel"
			className="border-b border-edge bg-paper-2"
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="w-full flex items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-paper-3 transition-colors"
				aria-expanded={open}
				data-testid="ask-mailbox-toggle"
			>
				{open ? (
					<CaretDownIcon size={12} weight="bold" />
				) : (
					<CaretRightIcon size={12} weight="bold" />
				)}
				<SparkleIcon size={12} weight="bold" className="text-coral" />
				<span>问邮箱</span>
				<span className="ml-auto text-xs font-normal text-ink-3">
					基于全部邮件回答
				</span>
			</button>
			{open ? (
				<div className="px-3 pb-3 space-y-2">
					<div className="rounded-xl border border-edge bg-paper px-2 py-1.5 focus-within:border-coral">
						<Textarea
							data-testid="ask-mailbox-input"
							value={question}
							onChange={(e) => setQuestion(e.target.value)}
							onKeyDown={handleKeyDown}
							onCompositionStart={ime.onCompositionStart}
							onCompositionEnd={ime.onCompositionEnd}
							placeholder="例如：上周我和张三聊到了什么？"
							rows={2}
							aria-label="询问邮箱中的内容"
							disabled={state.loading || !accountId}
							className="min-h-[36px] max-h-32 text-xs border-0 bg-transparent shadow-none focus-visible:ring-0 px-1 py-1 resize-none"
						/>
						<div className="flex items-center justify-between gap-2 pt-1">
							{accountId ? null : <span className="text-xs text-ink-3">请先登录账号</span>}
							<button
								type="button"
								onClick={() => void submit()}
								disabled={!canSubmit}
								data-testid="ask-mailbox-submit"
								className="inline-flex items-center gap-1 rounded-full bg-coral px-3 py-1 text-xs font-medium text-paper-2 hover:bg-coral-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
							>
								<PaperPlaneTiltIcon size={11} weight="bold" />
								问邮箱
							</button>
						</div>
					</div>

					{state.loading ? (
						<div className="text-xs text-ink-3 px-1">正在检索…</div>
					) : null}

					{state.error ? (
						<div className="rounded-md border border-red/40 bg-red-bg/40 px-2.5 py-1.5 text-xs text-red">
							{state.error}
						</div>
					) : null}

					{state.answer ? (
						<div
							data-testid="ask-mailbox-answer"
							className="rounded-md border border-edge bg-paper px-2.5 py-2 text-xs text-ink whitespace-pre-wrap"
						>
							{state.answer}
						</div>
					) : null}

					{state.citations.length > 0 ? (
						<div className="space-y-1">
							<div className="text-xs font-medium text-ink-3 px-1">
								引用邮件
							</div>
							<ul className="space-y-1">
								{state.citations.map((c) => (
									<li key={c.emailId}>
										<button
											type="button"
											onClick={() => selectEmail(c.emailId)}
											data-testid="ask-mailbox-citation"
											className="w-full text-left rounded-md border border-edge bg-paper px-2.5 py-1.5 hover:bg-paper-3 transition-colors"
										>
											<div className="flex items-center gap-1.5">
												<EnvelopeSimpleIcon
													size={11}
													weight="bold"
													className="text-ink-3 shrink-0"
												/>
												<span className="text-xs font-medium text-ink truncate">
													{c.emailId}
												</span>
											</div>
											{c.snippet ? (
												<div className="text-xs text-ink-3 line-clamp-2 mt-0.5">
													{c.snippet}
												</div>
											) : null}
										</button>
									</li>
								))}
							</ul>
						</div>
					) : null}

					{!state.loading &&
					!state.error &&
					!state.answer &&
					state.citations.length === 0 ? (
						<div className="text-xs text-ink-3 px-1">
							输入一个问题，系统会基于你的邮件给出引用回答。
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export default AskMailboxPanel;
