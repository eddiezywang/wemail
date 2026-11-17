import type {
  AutomationAction,
  AutomationRule,
  AutomationRuleV2,
  AutomationTrigger,
} from "./automation.js";
import type {
  AnalysisRecipe,
  ArtifactRecipe,
  DeliveryPlan,
  ExecutionPipelineDraft,
  WorkflowPipelineStepDraft,
} from "./skillCenter.js";

export type AutomationOwner =
  | { type: "account"; accountId: string }
  | { type: "localProfile"; profileId: "default" };

export type AutomationAccountScope =
  | { type: "currentAccount"; accountId: string }
  | { type: "selectedAccounts"; accountIds: string[] }
  | { type: "allConnectedAccounts" };

export interface AccountQualifiedMailReference {
  type: "email";
  accountId: string;
  emailId: string;
  label?: string;
  subject?: string;
  availability?: "available" | "account_disconnected" | "source_missing";
}

export interface AccountQualifiedAttachmentReference {
  type: "attachment";
  accountId: string;
  emailId: string;
  attachmentId: string;
  label?: string;
  filename?: string;
  availability?: "available" | "account_disconnected" | "source_missing";
}

export type AutomationSourceReference =
  | AccountQualifiedMailReference
  | AccountQualifiedAttachmentReference;

export type JsonSchema = Record<string, unknown>;

export interface LocalizedAutomationTemplateMetadata {
  fallbackLocale: string;
  locales: Record<
    string,
    {
      name: string;
      description: string;
      shortDescription?: string;
      category?: string;
      icon?: string;
    }
  >;
}

export type AutomationTemplateControl =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "multi_select"
  | "time"
  | "timezone"
  | "account_scope"
  | "delivery";

export interface AutomationTemplateUiField {
  path: string;
  control: AutomationTemplateControl;
  label: string;
  description?: string;
  section:
    | "general"
    | "accounts"
    | "trigger"
    | "data"
    | "analysis"
    | "output"
    | "delivery"
    | "advanced";
  order: number;
  options?: Array<{ value: string; label: string }>;
  advanced?: boolean;
}

export interface AutomationTemplateUiSchema {
  version: 1;
  fields: AutomationTemplateUiField[];
}

export type AutomationTemplateBinding =
  | { type: "configuration"; path: string }
  | { type: "literal"; value: unknown }
  | { type: "resolvedAccountScope" }
  | { type: "resolvedTimezone" };

export interface AutomationTemplatePipelineBlueprint {
  version: 1;
  steps: WorkflowPipelineStepDraft[];
  bindings: Record<string, AutomationTemplateBinding>;
  analysis?: AnalysisRecipe;
  artifact?: ArtifactRecipe;
  delivery?: DeliveryPlan;
}

export interface AutomationTemplateDefinition {
  schemaVersion: 1;
  id: string;
  version: string;
  scope: "builtin" | "personal";
  protected?: boolean;
  metadata: LocalizedAutomationTemplateMetadata;
  configurationSchema: JsonSchema;
  uiSchema: AutomationTemplateUiSchema;
  pipelineBlueprint: AutomationTemplatePipelineBlueprint;
  resultSchemaId: string;
  resultSchemaVersion: number;
  rendererId: string;
  rendererVersion: string;
  defaultConfiguration: Record<string, unknown>;
  defaultTrigger?: AutomationTrigger;
  defaultDelivery?: DeliveryPlan;
  contentHash: string;
}

export interface AutomationTemplateBindingSnapshot {
  templateId: string;
  templateVersion: string;
  templateHash: string;
  resultSchemaId: string;
  resultSchemaVersion: number;
  rendererId: string;
  rendererVersion: string;
  configuration: Record<string, unknown>;
}

export interface AutomationTemplateUpgrade {
  available: boolean;
  currentVersion?: string;
  targetVersion?: string;
  targetHash?: string;
  summary?: string[];
  requiresPreview: boolean;
}

export type AutomationHealth =
  | "healthy"
  | "running"
  | "needs_attention"
  | "paused"
  | "disabled"
  | "never_run";

export type AutomationWorkflowStage =
  | "trigger"
  | "data"
  | "analysis"
  | "artifact"
  | "delivery";

export type AutomationWorkflowStageStatus =
  | "configured"
  | "pending"
  | "running"
  | "succeeded"
  | "empty"
  | "partial"
  | "failed"
  | "skipped"
  | "blocked";

export interface AutomationRecoveryAction {
  id: string;
  type:
    | "retry_step"
    | "retry_delivery"
    | "new_run"
    | "revise_rule"
    | "open_settings"
    | "reconnect_account"
    | "open_output";
  label: string;
  description?: string;
  runId?: string;
  stepId?: string;
  requiresConfirmation?: boolean;
}

export interface AutomationWorkflowStageSummary {
  stage: AutomationWorkflowStage;
  label: string;
  summary: string;
  status: AutomationWorkflowStageStatus;
  impact?: string;
  outputAvailable?: boolean;
  recoveryActions?: AutomationRecoveryAction[];
}

export interface AutomationLatestOutput {
  type: "application_message" | "artifact" | "none";
  id?: string;
  title?: string;
  preview?: string;
  artifactId?: string;
  artifactVersion?: number;
  availability?: "available" | "expired" | "unsupported" | "missing";
}

export type AutomationRunOutcome =
  | "running"
  | "succeeded"
  | "empty"
  | "partial"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export interface AutomationDeliveryOutcome {
  destination:
    | "conversation"
    | "message_center"
    | "feishu_bot"
    | "wecom_bot"
    | "connected_bot"
    | "desktop_notification";
  destinationId?: string;
  status: "pending" | "succeeded" | "failed" | "skipped" | "unknown";
  outputId?: string;
  errorCode?: string;
  retrySafe?: boolean;
}

export interface AutomationRunUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  currency?: string;
}

export interface AutomationRunSummary {
  id: string;
  ruleId: string;
  ruleVersion: number;
  owner: AutomationOwner;
  dryRun: boolean;
  outcome: AutomationRunOutcome;
  plannedAt?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  delayed?: boolean;
  inputCount: number;
  resultCount: number;
  truncated: boolean;
  detailsExpired?: boolean;
  deliveries: AutomationDeliveryOutcome[];
  usage?: AutomationRunUsage;
  revision: number;
}

export interface AutomationTemplateSummary {
  id: string;
  version: string;
  name: string;
  description: string;
  icon?: string;
  category?: string;
  defaultTiming?: string;
  readiness: "ready" | "needs_setup" | "incompatible";
  readinessMessage?: string;
  installed: boolean;
}

export interface AutomationListItem {
  id: string;
  schemaVersion: 1 | 2;
  version: number;
  owner: AutomationOwner;
  accountScope: AutomationAccountScope;
  name: string;
  description?: string;
  enabled: boolean;
  archivedAt?: string;
  template?: AutomationTemplateBindingSnapshot;
  triggerSummary: string;
  workflowSummary: string;
  deliverySummary: string;
  health: AutomationHealth;
  pauseMessage?: string;
  canResumeSchedule?: boolean;
  schedulePauseToken?: string;
  stages: AutomationWorkflowStageSummary[];
  nextRunAt?: string;
  latestRun?: AutomationRunSummary;
  latestOutput?: AutomationLatestOutput;
  upgrade?: AutomationTemplateUpgrade;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationDetail extends AutomationListItem {
  trigger: AutomationTrigger;
  configuration: {
    data?: unknown;
    analysis?: unknown;
    artifact?: unknown;
    delivery?: unknown;
    advanced?: Record<string, unknown>;
  };
  sourceRule: AutomationRule | AutomationRuleV2;
  recentRuns: AutomationRunSummary[];
  uncertainRuns?: AutomationRunSummary[];
}

export interface AutomationInputManifestItem {
  accountId: string;
  emailId: string;
  messageId?: string;
  receivedAt: string;
  contentHash: string;
  selectedReasons: string[];
}

export interface AutomationInputManifest {
  version: 1;
  items: AutomationInputManifestItem[];
  accountCounts: Record<
    string,
    { scanned: number; selected: number; excluded: number }
  >;
  globalLimit: number;
  perAccountLimit: number;
  truncated: boolean;
  frozenAt: string;
  expiresAt?: string;
}

export interface AutomationProvenance {
  outputPath: string;
  sources: AutomationSourceReference[];
  operation?: string;
  confidence?: number;
}

interface AutomationActionCandidateBase {
  id: string;
  reason: string;
  sources: AccountQualifiedMailReference[];
  status: "available" | "requires_confirmation" | "unavailable" | "completed";
  pendingActionId?: string;
}

export type AutomationActionCandidate =
  | (AutomationActionCandidateBase & {
      type: "unsubscribe";
      accountId: string;
      emailId: string;
      unsubscribeMethodId: string;
    })
  | (AutomationActionCandidateBase & {
      type: "mute_sender";
      accountId: string;
      senderAddress: string;
      sourceEmailIds: string[];
    })
  | (AutomationActionCandidateBase & {
      type: "verify_security_notice";
      accountId: string;
      emailId: string;
    })
  | (AutomationActionCandidateBase & {
      type: "merge_duplicate_delivery";
      groupId: string;
      accountIds: string[];
    })
  | (AutomationActionCandidateBase & {
      type: "keep_subscription";
      accountId: string;
      senderAddress: string;
    });

export interface AutomationRunResultEnvelope<T = unknown> {
  resultType: string;
  schemaVersion: number;
  rendererId: string;
  rendererVersion: string;
  data: T;
  provenance: AutomationProvenance[];
  actionCandidates: AutomationActionCandidate[];
}

export interface AutomationStepDetail {
  id: string;
  stepId: string;
  stage: AutomationWorkflowStage;
  capabilityId: string;
  capabilityFingerprint?: string;
  status: AutomationWorkflowStageStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  outputReference?: AutomationLatestOutput;
  warnings: string[];
  sideEffects: string[];
  retrySafe: boolean;
  error?: { code: string; message: string };
  delivery?: AutomationDeliveryOutcome;
  retention?: {
    class: "summary" | "detail" | "artifact";
    expiresAt?: string;
    status: "available" | "expired";
  };
}

export interface AutomationRunDetail extends AutomationRunSummary {
  accountScope: AutomationAccountScope;
  resolvedAccountIds: string[];
  occurrenceKey?: string;
  window?: { start: string; end: string; timezone: string };
  template?: AutomationTemplateBindingSnapshot;
  pipelineHash?: string;
  recipeHashes?: Record<string, string>;
  capabilityFingerprints: string[];
  renderer?: { id: string; version: string };
  manifest?: AutomationInputManifest;
  manifestAvailability: "available" | "expired" | "missing";
  result?: AutomationRunResultEnvelope;
  resultAvailability: "available" | "expired" | "unsupported" | "missing";
  output?: AutomationLatestOutput;
  steps: AutomationStepDetail[];
  recoveryActions: AutomationRecoveryAction[];
  warnings: string[];
}

export interface SubscriptionInsightHighlight {
  id: string;
  kind: "content" | "action" | "risk" | "noise";
  text: string;
  sourceEmails: AccountQualifiedMailReference[];
}

export interface SubscriptionInsightCategory {
  id: string;
  kind:
    | "industry"
    | "product"
    | "security"
    | "account"
    | "promotion"
    | "social"
    | "custom";
  label?: string;
  items: Array<{
    id: string;
    takeaway: string;
    whyItMatters?: string;
    sourceEmails: AccountQualifiedMailReference[];
  }>;
}

export interface SubscriptionInsightKeepRecommendation {
  id: string;
  sourceName: string;
  reason: string;
  sourceEmails: AccountQualifiedMailReference[];
}

export interface SubscriptionInsightResult {
  type: "subscriptionDailyInsight";
  schemaVersion: 1;
  window: { start: string; end: string; timezone: string };
  accountCount: number;
  topHighlights: SubscriptionInsightHighlight[];
  curatedCategories: SubscriptionInsightCategory[];
  recommendedActions: AutomationActionCandidate[];
  keepSubscriptions: SubscriptionInsightKeepRecommendation[];
  stats: {
    scanned: number;
    selected: number;
    excluded: number;
    groups: number;
    truncated: boolean;
    perAccount: Record<
      string,
      { scanned: number; selected: number; excluded: number }
    >;
  };
  emptyReason?: "noCandidates" | "noUsefulItems";
}

export interface AutomationDraftPatch {
  expectedRevision: number;
  owner?: AutomationOwner;
  accountScope?: AutomationAccountScope;
  name?: string;
  description?: string;
  trigger?: ExecutionPipelineDraft["trigger"];
  dataSelection?: ExecutionPipelineDraft["dataSelection"];
  analysis?: ExecutionPipelineDraft["analysis"] | null;
  artifact?: ExecutionPipelineDraft["artifact"] | null;
  delivery?: ExecutionPipelineDraft["delivery"];
  templateConfiguration?: Record<string, unknown>;
  advancedPolicy?: Record<string, unknown>;
  steps?: WorkflowPipelineStepDraft[];
}

export interface UnifiedAutomationListResponse {
  automations: AutomationListItem[];
  recommendedTemplates: AutomationTemplateSummary[];
}

export interface UnifiedAutomationDetailResponse {
  automation: AutomationDetail;
}

export type LegacyAutomationAction = AutomationAction;
