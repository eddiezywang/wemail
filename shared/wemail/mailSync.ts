import { z } from "zod";

export const MailFolderSyncStateSchema = z.object({
  uid: z.number().int().nonnegative(),
  uidValidity: z.number().int().nonnegative(),
  internalDate: z.string(),
  repair: z.object({
    version: z.literal(1),
    since: z.string().datetime(),
    uid: z.number().int().nonnegative(),
    completed: z.boolean(),
  }).optional(),
});

export type MailFolderSyncState = z.infer<typeof MailFolderSyncStateSchema>;
export type MailFolderSyncStates = Record<string, MailFolderSyncState>;

export const MailSyncCheckpointSchema = z.object({
  folder: z.string().min(1).max(2_000),
  previous: MailFolderSyncStateSchema.nullable(),
  next: MailFolderSyncStateSchema,
  mode: z.enum(["incremental", "repair"]),
});

export type MailSyncCheckpoint = z.infer<typeof MailSyncCheckpointSchema>;

export const MailReceiptHealthSchema = z.object({
  observedAt: z.number().optional(),
  runtimeId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  requestedVersion: z.number().int().nonnegative(),
  completedVersion: z.number().int().nonnegative(),
  failedVersion: z.number().int().nonnegative(),
  stage: z.enum(["idle", "queued", "provider", "commit", "recovery", "credential-required"]),
  activeStartedAt: z.number().nullable(),
  lastProgressAt: z.number().nullable(),
  lastSuccessfulCheckAt: z.number().nullable(),
  lastCommittedAt: z.number().nullable(),
  nextCheckAt: z.number().nullable(),
  nextRetryAt: z.number().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});

export type MailReceiptHealth = z.infer<typeof MailReceiptHealthSchema>;
