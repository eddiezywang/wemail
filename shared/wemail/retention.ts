import { z } from "zod";

export const DatabaseRetentionBatchParamsSchema = z.object({
  now: z.string().datetime(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();

export type DatabaseRetentionBatchParams = z.input<typeof DatabaseRetentionBatchParamsSchema>;
export interface DatabaseRetentionBatchResult {
  wecliAuditLogsDeleted: number;
  applicationMessagesDeleted: number;
  automationPreviewsDeleted: number;
  automationManifestItemsDeleted: number;
  automationResultsExpired: number;
  automationStepDetailsExpired: number;
  hasMore: boolean;
}
