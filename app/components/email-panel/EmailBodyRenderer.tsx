import EmailIframe from "~/components/EmailIframe";
import { rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";
import { memo, useEffect, useState } from "react";
import { markMailOpenStage } from "~/lib/mailOpenTrace";

interface EmailBodyRendererProps {
	email: Email;
	traceId?: string;
	highlightTerms?: string[];
	mailboxId?: string;
	loading?: boolean;
}

function TextBody({ emailId, traceId, children }: { emailId: string; traceId?: string; children: string }) {
	useEffect(() => {
		if (!traceId) return;
		const frame = requestAnimationFrame(() => markMailOpenStage(emailId, "body-paint", traceId));
		return () => cancelAnimationFrame(frame);
	}, [emailId, traceId, children]);
	return (
		<div
			data-testid="email-body-content"
			data-email-id={emailId}
			className="whitespace-pre-wrap break-words text-[14px] leading-6 text-ink select-text"
		>
			{children}
		</div>
	);
}

function meaningful(value: string | null | undefined): string {
	return typeof value === "string" && value.trim().length > 0 ? value : "";
}

function DeferredEmailIframe(props: {
	body: string;
	emailId: string;
	traceId?: string;
	highlightTerms?: string[];
}) {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		setReady(false);
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, [props.body, props.highlightTerms]);
	if (!ready) {
		return (
			<div
				data-testid="email-body-loading"
				data-email-id={props.emailId}
				className="animate-pulse space-y-2 py-2 motion-reduce:animate-none"
			>
				<div className="h-2.5 w-full rounded bg-paper-3" />
				<div className="h-2.5 w-5/6 rounded bg-paper-3" />
				<div className="h-2.5 w-3/5 rounded bg-paper-3" />
			</div>
		);
	}
	return (
		<div data-testid="email-body-content" data-email-id={props.emailId}>
			<EmailIframe
				highlightTerms={props.highlightTerms}
				body={props.body}
				autoSize
				onPaint={() => {
					if (props.traceId) markMailOpenStage(props.emailId, "body-paint", props.traceId);
				}}
			/>
		</div>
	);
}

function EmailBodyRendererBase({
	email,
	traceId,
	highlightTerms,
	mailboxId,
	loading,
}: EmailBodyRendererProps) {
	if (loading) {
		return (
			<div
				data-testid="email-body-loading"
				data-email-id={email.id}
				className="animate-pulse space-y-2 py-2 motion-reduce:animate-none"
			>
				<div className="h-2.5 w-full rounded bg-paper-3" />
				<div className="h-2.5 w-5/6 rounded bg-paper-3" />
				<div className="h-2.5 w-3/5 rounded bg-paper-3" />
			</div>
		);
	}
	const htmlBody = meaningful(email.bodyHtml);
	const textBody = meaningful(email.bodyText);
	const legacyBody = meaningful(email.body);

	if (htmlBody || (!textBody && legacyBody)) {
		const body = htmlBody || legacyBody;
		return (
			<DeferredEmailIframe
				emailId={email.id}
				traceId={traceId}
				highlightTerms={highlightTerms}
				body={rewriteInlineImages(
					body,
					mailboxId || "",
					email.id,
					email.attachments,
				)}
			/>
		);
	}

	if (textBody) {
		return <TextBody emailId={email.id} traceId={traceId}>{textBody}</TextBody>;
	}

	return null;
}

/**
 * Skip re-rendering the body surface when nothing body-relevant changed.
 * EmailPanel re-renders frequently (intelligence / bodyState / secondary
 * queries resolving); as long as the body fields, loading flag, mailbox, and
 * highlight terms are unchanged, the iframe branch does not need to re-run
 * (rewriteInlineImages + the DOMPurify cache key + the deferred mount are all
 * stable for identical inputs).
 */
function emailBodyRendererPropsEqual(
	prev: EmailBodyRendererProps,
	next: EmailBodyRendererProps,
): boolean {
	return (
		prev.traceId === next.traceId &&
		prev.loading === next.loading &&
		prev.mailboxId === next.mailboxId &&
		prev.highlightTerms === next.highlightTerms &&
		prev.email.id === next.email.id &&
		prev.email.bodyHtml === next.email.bodyHtml &&
		prev.email.bodyText === next.email.bodyText &&
		prev.email.body === next.email.body &&
		prev.email.attachments === next.email.attachments
	);
}

const EmailBodyRenderer = memo(EmailBodyRendererBase, emailBodyRendererPropsEqual);
export default EmailBodyRenderer;
