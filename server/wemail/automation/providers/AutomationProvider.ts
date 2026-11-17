import type {
  AutomationArtifactReference,
  AutomationAuthorization,
  AutomationDataset,
  AutomationPipelineStep,
  AutomationRisk,
  AutomationSideEffect,
  AutomationValue,
} from "../../../../shared/wemail/automation.js";

export type AutomationCapabilityKind = "source" | "processor" | "action" | "design" | "sink";
export type JsonSchema = Record<string, unknown>;

export interface AutomationCapabilityDescriptor {
  provider: string;
  id: string;
  version: string;
  kind: AutomationCapabilityKind;
  label: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  risk: AutomationRisk;
  sideEffects: AutomationSideEffect[];
  previewSupport: "full" | "plan-only" | "none";
  idempotency: "native" | "keyed" | "none";
  discoveryConfidence: "declared" | "inferred";
  fingerprint: string;
  metadata?: Record<string, unknown>;
}

export interface AutomationRunEnvelope {
  id: string;
  ruleId: string;
  ruleVersion: number;
  accountId: string;
  occurrenceKey: string;
  scheduledAt?: string;
  actualStartedAt: string;
  delayed: boolean;
}

export interface AutomationProviderContext {
  run: AutomationRunEnvelope;
  trigger: Record<string, unknown>;
  collection?: Record<string, unknown>;
  steps: Record<string, { status: "succeeded" | "failed" | "skipped"; output?: AutomationValue }>;
  authorization?: AutomationAuthorization;
  dryRun: boolean;
  owner?: import("../../../../shared/wemail/automationCenter.js").AutomationOwner;
  accountScope?: import("../../../../shared/wemail/automationCenter.js").AutomationAccountScope;
}

export interface CompiledAutomationStep extends AutomationPipelineStep {
  descriptor: AutomationCapabilityDescriptor;
}

export interface AutomationProviderError {
  code:
    | "provider-unavailable"
    | "capability-unavailable"
    | "capability-drift"
    | "invalid-input"
    | "authorization-expired"
    | "resource-unavailable"
    | "authentication-required"
    | "permission-denied"
    | "timeout"
    | "execution-failed";
  message: string;
  retryable: boolean;
  retrySafe: boolean;
  details?: Record<string, unknown>;
}

export interface AutomationStepResult {
  status: "succeeded" | "failed" | "skipped";
  output?: AutomationValue;
  error?: AutomationProviderError;
  warnings: string[];
  sideEffects: Array<{ type: AutomationSideEffect; summary: string }>;
  audit: {
    provider: string;
    capability: string;
    capabilityFingerprint: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    externalAuditId?: string;
  };
}

export interface AutomationStepPreview {
  plannedOperation: string;
  resolvedInputSummary: unknown;
  output?: AutomationValue | AutomationDataset | AutomationArtifactReference;
  warnings: string[];
  sideEffects: AutomationSideEffect[];
}

export type CapabilityCompatibility = "identical" | "compatible" | "breaking" | "risk-increase" | "missing";

export interface AutomationProvider {
  readonly id: string;
  readonly version: string;
  discover(query?: { query?: string; capability?: string }): Promise<AutomationCapabilityDescriptor[]>;
  compile(capability: AutomationCapabilityDescriptor, step: AutomationPipelineStep): Promise<CompiledAutomationStep>;
  validate(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<string[]>;
  preview(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepPreview>;
  execute(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepResult>;
  checkCompatibility(previousFingerprint: string, current: AutomationCapabilityDescriptor): CapabilityCompatibility;
}

export function completedAudit(
  descriptor: AutomationCapabilityDescriptor,
  startedAt: string,
  completedAt: string,
  externalAuditId?: string,
) {
  return {
    provider: descriptor.provider,
    capability: descriptor.id,
    capabilityFingerprint: descriptor.fingerprint,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    externalAuditId,
  };
}
