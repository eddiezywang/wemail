import { z } from "zod";

export const ActionItemPhaseSchema = z.enum(["queued", "preparing", "submitting", "verifying", "succeeded", "failed", "outcome_unknown"]);
export type ActionItemPhase = z.infer<typeof ActionItemPhaseSchema>;
export interface ActionExecutionItem {
  index: number;
  emailId: string;
  attachmentId: string;
  filename?: string;
  phase: ActionItemPhase;
  sha256?: string;
  error?: string;
  auditId?: string;
  allowNonPdf?: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  alreadyProcessed?: "uploaded" | "associated";
  retryUnverified?: boolean;
}
export interface ActionExecutionSnapshot {
  planVersion: 1;
  id: string;
  actionId: string;
  accountId: string;
  state: "queued" | "running" | "succeeded" | "partially_succeeded" | "failed" | "outcome_unknown";
  revision: number;
  generation: number;
  acceptedAt?: number;
  completedAt?: number;
  items: ActionExecutionItem[];
}
const identity = { accountId: z.string().min(1).max(500), actionId: z.string().min(1).max(500) };
export const ActionUploadSourceSchema = z.object({ emailId: z.string().min(1), attachmentId: z.string().min(1) }).strict();
export interface ActionUploadEligibility {
  emailId: string;
  attachmentId: string;
  reason: "already_processed" | "already_associated" | "pending_verification" | "in_progress" | null;
}
const lease = { id: z.string().min(1), owner: z.string().min(1), generation: z.number().int().positive() };
export const ActionWecliAuditSchema = z.object({
  command: z.string().max(1000), args: z.array(z.string().max(4000)).max(100),
  classification: z.object({ kind: z.enum(["auto-approved", "requires-confirmation"]), command: z.string(), subcommand: z.string(), reason: z.string() }).strict(),
  approvedBy: z.string().max(64).optional(), exitCode: z.number().int().optional(),
  stdout: z.string().max(131072).optional(), stderr: z.string().max(131072).optional(),
  durationMs: z.number().nonnegative(), invokedAt: z.string().optional(),
}).strict();
export type ActionWecliAudit = z.infer<typeof ActionWecliAuditSchema> & { id: string; invokedAt: string };
export const ActionExecutionCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("accept"), ...identity, idempotencyKey: z.string().min(1), parameters: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ op: z.literal("get"), ...identity }).strict(),
  z.object({ op: z.literal("preflight"), accountId: identity.accountId, items: z.array(ActionUploadSourceSchema).min(1).max(20) }).strict(),
  z.object({ op: z.literal("claim"), owner: z.string().min(1) }).strict(),
  z.object({ op: z.literal("renew"), ...lease }).strict(),
  z.object({ op: z.literal("update"), ...lease, index: z.number().int().min(0).max(19), phase: ActionItemPhaseSchema,
    filename: z.string().max(500).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    error: z.string().max(500).optional(), auditId: z.string().max(500).optional(),
    invoiceId: z.string().max(500).optional(), invoiceNumber: z.string().max(100).optional() }).strict(),
  z.object({ op: z.literal("finish"), ...lease }).strict(),
  z.object({ op: z.literal("receipt"), ...lease, auditId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("nextDue") }).strict(),
  z.object({ op: z.literal("audit"), entry: ActionWecliAuditSchema }).strict(),
]);
export type ActionExecutionCommand = z.infer<typeof ActionExecutionCommandSchema>;
export type ActionExecutionReply = ActionExecutionSnapshot | ActionWecliAudit | { eligibility: ActionUploadEligibility[] } | { receipt: Record<string, unknown> | null } | number | boolean | null;
