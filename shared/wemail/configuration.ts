export type ConfigurationKind =
  | "automation_rule"
  | "mail_account"
  | "external_connection"
  | "agent_provider"
  | "notification"
  | "directory"
  | "integration"
  | (string & {});

export type ConfigurationOperation =
  | "create"
  | "update"
  | "enable"
  | "disable"
  | "delete"
  | "connect"
  | "disconnect"
  | "repair";

export const CONFIGURATION_PHASES = [
  "understand_goal",
  "collect_requirements",
  "resolve_capabilities",
  "check_prerequisites",
  "discover_capabilities",
  "compile_configuration",
  "validate_configuration",
  "generate_preview",
  "review_intermediate_result",
  "await_confirmation",
  "await_final_confirmation",
  "commit_configuration",
  "verify_configuration",
] as const;

export type ConfigurationPhase = (typeof CONFIGURATION_PHASES)[number];

export type ConfigurationTaskStatus =
  | "drafting"
  | "collecting"
  | "needs_input"
  | "checking_prerequisites"
  | "resolving_capabilities"
  | "compiling"
  | "reviewing"
  | "blocked"
  | "preparing_preview"
  | "awaiting_confirmation"
  | "awaiting_final_confirmation"
  | "committing"
  | "verifying"
  | "completed"
  | "completed_with_warnings"
  | "retryable_failure"
  | "failed"
  | "outcome_unknown"
  | "cancelled";

export type ConfigurationStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped"
  | "cancelled";

export type ConfigurationIssueCategory =
  | "missing_information"
  | "dependency_unavailable"
  | "authentication_required"
  | "permission_denied"
  | "provider_unavailable"
  | "capability_unsupported"
  | "resource_unavailable"
  | "validation_failed"
  | "configuration_conflict"
  | "stale_preview"
  | "capability_drift"
  | "confirmation_required"
  | "policy_blocked"
  | "transient_service_failure"
  | "execution_failed"
  | "execution_outcome_unknown";

export type ConfigurationIssueSeverity =
  | "info"
  | "warning"
  | "blocking"
  | "fatal";

export type ConfigurationIssueResponsibility =
  | "user_action"
  | "system_retry"
  | "configuration_change"
  | "administrator"
  | "unsupported";

export type ConfigurationRetryability =
  | "not_retryable"
  | "safe_immediate"
  | "safe_after_recovery"
  | "unknown";

export type ConfigurationPrivacyClass =
  | "public"
  | "account_metadata"
  | "diagnostic";

export type ConfigurationEffectState =
  | "none"
  | "planned"
  | "started"
  | "committed"
  | "completed"
  | "rolled_back"
  | "partial"
  | "unknown";

export type ConfigurationRecoveryType =
  | "provide_input"
  | "open_settings"
  | "authenticate"
  | "request_permission"
  | "install_dependency"
  | "select_resource"
  | "retry_phase"
  | "regenerate_preview"
  | "restart_configuration"
  | "reconcile_outcome"
  | "cancel";

export interface ConfigurationDiagnostic {
  provider?: string;
  capability?: string;
  tool?: string;
  toolCallId?: string;
  command?: string;
  errorCode?: string;
}

export interface ConfigurationIssue {
  id: string;
  category: ConfigurationIssueCategory;
  code: string;
  phase: ConfigurationPhase;
  severity: ConfigurationIssueSeverity;
  userMessage: string;
  responsibility: ConfigurationIssueResponsibility;
  retryability: ConfigurationRetryability;
  privacyClass: ConfigurationPrivacyClass;
  affectedScope: string[];
  unaffectedScope?: string[];
  diagnostic?: ConfigurationDiagnostic;
  createdAt: string;
  resolvedAt?: string;
}

export interface ConfigurationRecoveryAction {
  id: string;
  issueId: string;
  type: ConfigurationRecoveryType;
  label: string;
  description?: string;
  target?: string;
  requiresConfirmation: boolean;
  dangerous: boolean;
  preferred?: boolean;
  resumesFromPhase?: ConfigurationPhase;
  expiresAt?: string;
  resolvedAt?: string;
}

export interface ConfigurationEffect {
  id: string;
  phase: ConfigurationPhase;
  type: string;
  state: ConfigurationEffectState;
  summary: string;
  externalAuditId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigurationStep {
  id: string;
  phase: ConfigurationPhase;
  label: string;
  status: ConfigurationStepStatus;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ConfigurationReference {
  type: "draft" | "preview" | "committed_resource" | "external_audit";
  id: string;
  hash?: string;
  version?: string | number;
  expiresAt?: string;
}

export interface ConfigurationPreviewAuthorization {
  taskId: string;
  taskRevision: number;
  accountId: string;
  kind: ConfigurationKind;
  targetKey: string;
  operation: ConfigurationOperation;
  normalizedDraftHash: string;
  previewId?: string;
  previewHash?: string;
  sourceRevision?: string | number;
  capabilityFingerprints: Array<{
    provider: string;
    capability: string;
    fingerprint: string;
  }>;
  risk: "read" | "local-write" | "external-mutation" | "destructive";
  limits?: Record<string, unknown>;
  expiresAt: string;
}

export type ConfigurationGoalStatus =
  | "in_progress"
  | "needs_input"
  | "reviewing"
  | "blocked"
  | "awaiting_final_confirmation"
  | "committing"
  | "verifying"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export interface ConfigurationInteractionAction {
  id: string;
  type:
    | "provide_input"
    | "open_preview"
    | "accept_preview"
    | "revise_preview"
    | "confirm_final"
    | "retry"
    | "open_settings"
    | "open_automation"
    | "adjust_pipeline"
    | "cancel";
  label: string;
  description?: string;
  target?: string;
  requiresConfirmation?: boolean;
  preferred?: boolean;
}

export interface ConfigurationPreviewLink {
  id: string;
  label: string;
  url: string;
  mediaType: "html" | "image" | "pdf" | "text";
  version: number;
  contentHash: string;
}

export interface ConfigurationInteraction {
  goalStatus: ConfigurationGoalStatus;
  stage: string;
  message: string;
  impact?: string;
  actions: ConfigurationInteractionAction[];
  previewLinks: ConfigurationPreviewLink[];
  technicalDetails?: {
    issueCodes?: string[];
    tool?: string;
    toolCallId?: string;
    provider?: string;
    capability?: string;
  };
}

export interface ConfigurationConfirmationSnapshot {
  id: string;
  taskId: string;
  taskRevision: number;
  accountId: string;
  pipelineDraftId: string;
  pipelineDraftRevision: number;
  ruleHash: string;
  skillSnapshots: import("./skillCenter.js").SkillSnapshot[];
  capabilitySnapshots: import("./skillCenter.js").CapabilitySnapshot[];
  reviewHashes: Array<{
    checkpointId: string;
    target: import("./skillCenter.js").ReviewTarget;
    contentHash: string;
    targetVersion: number;
  }>;
  risk: ConfigurationPreviewAuthorization["risk"];
  configuration?: {
    trigger?: import("./skillCenter.js").ExecutionPipelineDraft["trigger"];
    dataSelection?: import("./skillCenter.js").DataSelectionSpec;
    analysis?: import("./skillCenter.js").AnalysisRecipe;
    artifact?: import("./skillCenter.js").ArtifactRecipe;
    delivery?: import("./skillCenter.js").DeliveryPlan;
    defaults: Record<string, unknown>;
    failurePolicy: Record<string, unknown>;
    authorizationBounds: Record<string, unknown>;
  };
  expiresAt: string;
}

export interface ConfigurationTaskSnapshot {
  id: string;
  accountId: string;
  sessionId?: string;
  kind: ConfigurationKind;
  targetKey: string;
  operation: ConfigurationOperation;
  title: string;
  status: ConfigurationTaskStatus;
  currentPhase: ConfigurationPhase;
  source: {
    surface: "agent" | "settings" | "api" | "recovery";
    sourceId?: string;
  };
  steps: ConfigurationStep[];
  issues: ConfigurationIssue[];
  recoveries: ConfigurationRecoveryAction[];
  effects: ConfigurationEffect[];
  references: ConfigurationReference[];
  authorization?: ConfigurationPreviewAuthorization;
  pipelineDraftId?: string;
  reviewCheckpointIds?: string[];
  confirmationSnapshot?: ConfigurationConfirmationSnapshot;
  interaction?: ConfigurationInteraction;
  revision: number;
  createdAt: string;
  updatedAt: string;
  retentionUntil?: string;
}

export interface ConfigurationOutcome {
  taskId: string;
  revision: number;
  title: string;
  status: ConfigurationTaskStatus;
  currentNeed?: string;
  completed: string[];
  notPerformed: string[];
  impact: string[];
  unaffected: string[];
  actions: ConfigurationRecoveryAction[];
  diagnostics: ConfigurationDiagnostic[];
  goalStatus?: ConfigurationGoalStatus;
  interaction?: ConfigurationInteraction;
}

export type ConfigurationOperationResult<T> =
  | {
      status: "succeeded";
      value: T;
      effectState: ConfigurationEffectState;
      warnings?: ConfigurationIssue[];
    }
  | {
      status: "unavailable";
      issue: ConfigurationIssue;
      effectState: "none";
      partialValue?: T;
    }
  | {
      status: "failed";
      issue: ConfigurationIssue;
      effectState: ConfigurationEffectState;
    };

export type ConfigurationLifecycleEvent =
  | {
      type: "configuration_started";
      taskId: string;
      revision: number;
      snapshot: ConfigurationTaskSnapshot;
    }
  | {
      type:
        | "configuration_phase_changed"
        | "configuration_issue_detected"
        | "configuration_recovery_available"
        | "configuration_preview_ready"
        | "configuration_completed";
      taskId: string;
      revision: number;
      snapshot: ConfigurationTaskSnapshot;
    };

export interface StartConfigurationRequest {
  accountId: string;
  sessionId?: string;
  kind: ConfigurationKind;
  targetKey: string;
  operation: ConfigurationOperation;
  title: string;
  source: ConfigurationTaskSnapshot["source"];
}

export interface ConfigurationMutationRequest {
  accountId: string;
  expectedRevision: number;
}

export interface ConfigurationRecoveryRequest
  extends ConfigurationMutationRequest {
  recoveryActionId: string;
  input?: Record<string, unknown>;
}

export interface ConfigurationConfirmationRequest
  extends ConfigurationMutationRequest {
  authorization: ConfigurationPreviewAuthorization;
}

export interface ConfigurationTaskResponse {
  taskId: string;
  revision: number;
  snapshot: ConfigurationTaskSnapshot;
  actions: ConfigurationRecoveryAction[];
}

export function assertValidConfigurationSnapshot(
  snapshot: ConfigurationTaskSnapshot,
): void {
  if (!snapshot.id || !snapshot.accountId || !snapshot.targetKey) {
    throw new Error("configuration-task-identity-required");
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 1) {
    throw new Error("configuration-task-revision-invalid");
  }
  if (!CONFIGURATION_PHASES.includes(snapshot.currentPhase)) {
    throw new Error("configuration-task-phase-invalid");
  }
  const activeIssues = snapshot.issues.filter((issue) => !issue.resolvedAt);
  const blockingIssues = activeIssues.filter(
    (issue) => issue.severity === "blocking" || issue.severity === "fatal",
  );
  const unknownEffects = snapshot.effects.filter(
    (effect) => effect.state === "unknown",
  );
  if (snapshot.status === "blocked" && blockingIssues.length === 0) {
    throw new Error("blocked-configuration-requires-blocking-issue");
  }
  if (snapshot.status === "outcome_unknown" && unknownEffects.length === 0) {
    throw new Error("unknown-outcome-requires-unknown-effect");
  }
  if (
    (snapshot.status === "completed" ||
      snapshot.status === "completed_with_warnings") &&
    snapshot.steps.some(
      (step) =>
        step.phase === "verify_configuration" &&
        step.status !== "completed" &&
        step.status !== "skipped",
    )
  ) {
    throw new Error("completed-configuration-requires-verification");
  }
  if (
    snapshot.status === "retryable_failure" &&
    !activeIssues.some(
      (issue) =>
        issue.retryability === "safe_immediate" ||
        issue.retryability === "safe_after_recovery",
    )
  ) {
    throw new Error("retryable-configuration-requires-retryable-issue");
  }
  if (
    snapshot.authorization &&
    (snapshot.authorization.taskId !== snapshot.id ||
      snapshot.authorization.accountId !== snapshot.accountId ||
      snapshot.authorization.taskRevision !== snapshot.revision)
  ) {
    throw new Error("configuration-authorization-snapshot-mismatch");
  }
}
