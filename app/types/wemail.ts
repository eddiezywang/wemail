// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Renderer-scoped re-exports of the canonical Wave 0 intelligence types so
// components never reach into `server/wemail/*` directly.
export type {
	CallerContext,
	EmailIntelligenceState,
	IntelligenceJob,
	IntelligenceJobType,
	IntelligenceResult,
	IntelligenceStatus,
	IntelligenceProcessorName,
	ReplyDecisionResult,
	ReplyDraftResult,
	ReplyDraftVariant,
	SummaryResult,
	TagResult,
} from "../../shared/wemail/intelligence";
export type {
	InvoiceAttachmentStatus,
	InvoiceAttachmentStatusValue,
	InvoiceMailStatusSummary,
	InvoiceMailState,
	InvoiceStatusTag,
} from "../../shared/wemail/invoice";

import type { EmailIntelligenceState as EmailIntelligenceStateBase } from "../../shared/wemail/intelligence";

export type { WemailAddress } from "../../shared/wemail/mail";

/**
 * @deprecated Use {@link EmailIntelligenceState} instead. Kept as a type alias
 * for backward compatibility during the Package M cutover.
 */
export type IntelligenceMessagePayload = EmailIntelligenceStateBase;
