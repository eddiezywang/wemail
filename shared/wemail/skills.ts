export type WecliApprovalStatus =
  | "auto-approved"
  | "requires-confirmation"
  | "approved"
  | "rejected";

export interface WecliInvocationRequest {
  command: string;
  args: string[];
  formatJson: boolean;
}

export interface WecliInvocationResult {
  ok: boolean;
  approvalStatus: WecliApprovalStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
}
