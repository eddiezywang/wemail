// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { WemailAddress, WemailDeliveryResult } from "../../shared/wemail/mail";

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	toAddresses?: WemailAddress[];
	ccAddresses?: WemailAddress[];
	bccAddresses?: WemailAddress[];
	delivery?: WemailDeliveryResult;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	bodyHtml?: string | null;
	bodyText?: string | null;
	bodyPending?: boolean;
	bodyState?: "ready" | "missing" | "fetching" | "failed";
	bodyErrorCode?: string;
	bodyAttempts?: number;
	bodyNextRetryAt?: string;
	bodyRetryable?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	hasAttachments?: boolean;
	snippet?: string | null;
	invoiceDetected?: boolean;
	invoiceStatusTag?: string | null;
	invoiceStatusState?: import("../../shared/wemail/invoice").InvoiceMailState | null;
	invoiceStatus?: import("../../shared/wemail/invoice").InvoiceMailStatusSummary | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	contentId?: string;
	content_id?: string;
	disposition?: string;
	dataBase64?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
	totalCount?: number;
	delimiter?: string;
}
