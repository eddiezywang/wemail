/**
 * Invoice wire-contract type shell (P2.6).
 *
 * Everything invoice-*semantic* (the platform rejection parsing, the
 * expense-binding judgment, the status label / filter constants and the
 * display-tag mapping) moved to the private edition overlay
 * (`wemail-int/internal/src/allowance`). This file keeps only the wire
 * shapes that survive in the open tree so both editions can read each
 * other's data directories:
 *
 *   - `mailCoreProtocol` / `MailDatabaseQueryRepository` type positions
 *   - the retained `invoice_attachment_statuses` columns (schema v19)
 *   - the renderer type re-exports (`app/types/wemail.ts`)
 *
 * The action literals (`upload_allowance_invoices` /
 * `delete_allowance_invoices` in `shared/wemail/intelligence.ts`) stay in
 * the shared intelligence contract for the same legacy-row reason.
 */

export type InvoiceStatusTag =
  | "已处理发票"
  | "未处理发票"
  | "未知状态发票";

export type InvoiceMailState =
  | "uploaded"
  | "not_uploaded"
  | "upload_failed"
  | "unknown"
  | "associated_self"
  | "associated_other";

export type InvoiceAttachmentStatusValue =
  | "not_started"
  | "not_uploaded"
  | "upload_failed"
  | "uploaded"
  | "associated_self"
  | "associated_other";

export interface InvoiceAttachmentStatus {
  accountId: string;
  emailId: string;
  attachmentId: string;
  filename?: string;
  status: InvoiceAttachmentStatusValue;
  invoiceId?: string;
  invoiceNumber?: string;
  invoiceSeller?: string;
  invoiceTotal?: string;
  invoiceExpenseType?: string;
  lastCommand?: string;
  lastStdout?: string;
  lastStderr?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceMailStatusSummary {
  tag: InvoiceStatusTag | null;
  state: InvoiceMailState | null;
  statuses: InvoiceAttachmentStatus[];
}
