import EmailIframe from "~/components/EmailIframe";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";
import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { getApiEndpointGeneration, subscribeApiEndpointRuntimeState } from "~/services/api";
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
	// Delayed (S1): cached bodies swap within a frame and show nothing;
	// slow (uncached IMAP ensure) bodies get 12px lines under 15px text.
	const skeletonVisible = useDelayedFlag(!ready);
	useEffect(() => {
		setReady(false);
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, [props.body, props.highlightTerms]);
	if (!ready) {
		if (!skeletonVisible) return null;
		return (
			<div
				data-testid="email-body-loading"
				data-email-id={props.emailId}
				className="space-y-2 py-2"
			>
				<div className="skeleton-row-in h-3 w-full rounded-[6px] bg-[var(--color-skeleton)]" />
				<div className="skeleton-row-in h-3 w-5/6 rounded-[6px] bg-[var(--color-skeleton)]" style={{ animationDelay: "40ms" }} />
				<div className="skeleton-row-in h-3 w-3/5 rounded-[6px] bg-[var(--color-skeleton)]" style={{ animationDelay: "80ms" }} />
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
	// Re-run CID URL rewriting even when memoized email props do not change.
	useSyncExternalStore(subscribeApiEndpointRuntimeState, getApiEndpointGeneration, () => 0);
	if (loading) {
		return (
			<div
				data-testid="email-body-loading"
				data-email-id={email.id}
				className="space-y-2 py-2"
			>
				<div className="h-3 w-full rounded-[6px] bg-[var(--color-skeleton)]" />
				<div className="h-3 w-5/6 rounded-[6px] bg-[var(--color-skeleton)]" />
				<div className="h-3 w-3/5 rounded-[6px] bg-[var(--color-skeleton)]" />
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
