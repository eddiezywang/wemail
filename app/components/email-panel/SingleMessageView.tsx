// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailBodyRenderer from "~/components/email-panel/EmailBodyRenderer";
import type { Email } from "~/types";

export interface SingleMessageViewActions {
	onReply?: () => void;
	onReplyAll?: () => void;
	onForward?: () => void;
}

type MailActionIconName = "reply" | "reply-all" | "forward";

const MATERIAL_MAIL_ACTION_PATHS: Record<MailActionIconName, string> = {
	reply: "M760-200v-160q0-50-35-85t-85-35H273l144 144-57 56-240-240 240-240 57 56-144 144h367q83 0 141.5 58.5T840-360v160h-80Z",
	"reply-all": "M320-280 80-520l240-240 57 56-184 184 184 184-57 56Zm480 80v-160q0-50-35-85t-85-35H433l144 144-57 56-240-240 240-240 57 56-144 144h247q83 0 141.5 58.5T880-360v160h-80Z",
	forward: "m640-280-57-56 184-184-184-184 57-56 240 240-240 240ZM80-200v-160q0-83 58.5-141.5T280-560h247L383-704l57-56 240 240-240 240-57-56 144-144H280q-50 0-85 35t-35 85v160H80Z",
};

// Google Material Symbols Sharp: reply, reply_all, and forward (Apache-2.0).
function MailActionIcon({ name }: { name: MailActionIconName }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 -960 960 960"
			className="size-3.5 shrink-0 fill-current"
		>
			<path d={MATERIAL_MAIL_ACTION_PATHS[name]} />
		</svg>
	);
}

interface SingleMessageViewProps {
	email: Email;
	traceId?: string;
	highlightTerms?: string[];
	mailboxId?: string;
	onPreviewImage: (url: string, filename: string) => void;
	onRefreshInvoiceStatus?: () => void;
	isRefreshingInvoiceStatus?: boolean;
	invoiceRefreshMessage?: string;
	isBodyLoading?: boolean;
	bodyLoadFailed?: boolean;
	bodyTooLarge?: boolean;
	onRetryBody?: () => void;
	onLoadBody?: () => void;
	bodyRetryable?: boolean;
}

export function SingleMessageActions({
	onReply,
	onReplyAll,
	onForward,
}: SingleMessageViewActions) {
	if (!onReply && !onReplyAll && !onForward) return null;
	const buttonClassName = "wemail-pill inline-flex h-7 items-center gap-1.5 px-2.5 font-sans text-xs font-normal leading-none text-ink-2 hover:text-ink";

	return (
		<div className="flex items-center gap-1.5 px-4 py-2 md:px-6">
			{onReply ? (
				<button
					type="button"
					onClick={onReply}
					className={buttonClassName}
				>
					<MailActionIcon name="reply" />
					回复
				</button>
			) : null}
			{onReplyAll ? (
				<button
					type="button"
					onClick={onReplyAll}
					className={buttonClassName}
				>
					<MailActionIcon name="reply-all" />
					回复所有人
				</button>
			) : null}
			{onForward ? (
				<button
					type="button"
					onClick={onForward}
					className={buttonClassName}
				>
					<MailActionIcon name="forward" />
					转发
				</button>
			) : null}
		</div>
	);
}

export default function SingleMessageView({
	email,
	traceId,
	highlightTerms,
	mailboxId,
	onPreviewImage,
	onRefreshInvoiceStatus,
	isRefreshingInvoiceStatus,
	invoiceRefreshMessage,
	isBodyLoading,
	bodyLoadFailed,
	bodyTooLarge = false,
	onRetryBody,
	onLoadBody,
	bodyRetryable = true,
}: SingleMessageViewProps) {
	return (
		<div data-testid="single-message-view" data-body-loading={isBodyLoading ? "true" : "false"}>
			<EmailAttachmentList
				mailboxId={mailboxId}
				emailId={email.id}
				attachments={email.attachments}
				invoiceStatus={email.invoiceStatus}
				onRefreshInvoiceStatus={onRefreshInvoiceStatus}
				isRefreshingInvoiceStatus={isRefreshingInvoiceStatus}
				invoiceRefreshMessage={invoiceRefreshMessage}
				onPreviewImage={onPreviewImage}
				className="px-4 pb-3 md:px-6"
				showHeading
			/>

			<div className="px-4 md:px-6">
				{bodyLoadFailed ? (
					<div className="rounded-xl border border-edge bg-paper-2 px-5 py-8 text-center">
						{bodyTooLarge ? (
							<>
								<p className="text-sm font-medium text-ink">邮件正文较大（超过 5MB）</p>
								<p className="mt-1 text-xs text-ink-3">为避免卡顿未自动加载，邮件标题和基本信息仍可正常查看。如需查看正文，请手动加载。</p>
								<button type="button" onClick={onLoadBody} disabled={!bodyRetryable} className="mt-4 rounded-full border border-edge bg-white px-4 py-2 text-sm text-ink hover:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-50">
									加载正文
								</button>
							</>
						) : (
							<>
								<p className="text-sm font-medium text-ink">邮件正文暂时无法加载</p>
								<p className="mt-1 text-xs text-ink-3">可以稍后重试，邮件标题和基本信息仍可正常查看。</p>
								<button type="button" onClick={onRetryBody} disabled={!bodyRetryable} className="mt-4 rounded-full border border-edge bg-white px-4 py-2 text-sm text-ink hover:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-50">
									重新加载
								</button>
							</>
						)}
					</div>
				) : (
					<EmailBodyRenderer
						email={email}
						traceId={traceId}
						highlightTerms={highlightTerms}
						mailboxId={mailboxId}
						loading={isBodyLoading}
					/>
				)}
			</div>
		</div>
	);
}
