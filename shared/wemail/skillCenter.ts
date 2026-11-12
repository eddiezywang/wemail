export type SkillScope = "builtin" | "personal";

export type SkillCompatibility =
  | "compatible"
  | "partially_compatible"
  | "incompatible"
  | "tampered";

export type SkillReviewPolicy = "none" | "recommended" | "required";

export type WorkflowValueKind =
  | "mail-reference"
  | "mail-collection"
  | "attachment-reference"
  | "attachment-collection"
  | "data-selection"
  | "dataset"
  | "analysis-recipe"
  | "analysis-result"
  | "artifact-recipe"
  | "artifact-reference"
  | "delivery-plan"
  | "delivery-receipt"
  | "pipeline-draft"
  | "automation-rule-preview"
  | "skill-draft";

export interface SkillDependency {
  skillId: string;
  version?: string;
  optional?: boolean;
}

export interface SkillPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  scope: SkillScope;
  entry: "SKILL.md";
  displayName?: string;
  description?: string;
  protected?: boolean;
  inputKinds: WorkflowValueKind[];
  outputKinds: WorkflowValueKind[];
  dependencies: SkillDependency[];
  toolAllowlist: string[];
  requestedPermissions: string[];
  reviewPolicy: SkillReviewPolicy;
  contentHash: string;
}

export interface SkillPackageVersion {
  skillId: string;
  version: string;
  scope: SkillScope;
  packagePath: string;
  manifest: SkillPackageManifest;
  compatibility: SkillCompatibility;
  compatibilityIssues: string[];
  enabled: boolean;
  active: boolean;
  installedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  scope: SkillScope;
  displayName: string;
  description: string;
  activeVersion: string;
  enabled: boolean;
  protected: boolean;
  compatibility: SkillCompatibility;
  requestedPermissions: string[];
  toolAllowlist: string[];
  versions: string[];
  usageCount: number;
  source: "application" | "import" | "agent" | "manual";
}

export interface SkillContentEntry {
  path: string;
  kind: "file" | "directory";
}

export interface SkillContentResponse {
  skillId: string;
  version: string;
  contentHash: string;
  markdown: string;
  entries: SkillContentEntry[];
}

export interface SkillUsageReference {
  id: string;
  skillId: string;
  skillVersion: string;
  referenceType:
    | "automation_rule"
    | "configuration_task"
    | "agent_session"
    | "pipeline_draft";
  referenceId: string;
  createdAt: string;
}

export interface SkillSnapshot {
  skillId: string;
  version: string;
  contentHash: string;
  scope: SkillScope;
}

export interface SkillDraft {
  id: string;
  skillId: string;
  version: string;
  status: "draft" | "validated" | "awaiting_confirmation" | "installed" | "rejected";
  displayName: string;
  description: string;
  skillMarkdown: string;
  manifest: Omit<SkillPackageManifest, "contentHash">;
  validationIssues: string[];
  contentHash: string;
  sourceSessionId?: string;
  sourcePipelineId?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type CapabilityCategory =
  | "trigger"
  | "timing"
  | "data"
  | "analysis"
  | "output"
  | "delivery";

export type CapabilityAvailabilityState =
  | "ready"
  | "not_installed"
  | "not_connected"
  | "authentication_required"
  | "permission_required"
  | "temporarily_unavailable"
  | "unknown";

export interface CapabilityRecoveryAction {
  id: string;
  type:
    | "retry"
    | "open_settings"
    | "connect"
    | "authenticate"
    | "install"
    | "adjust_pipeline"
    | "cancel";
  label: string;
  description?: string;
  target?: string;
  requiresConfirmation?: boolean;
}

export interface CapabilityAvailability {
  state: CapabilityAvailabilityState;
  reason?: string;
  recoveryActions?: CapabilityRecoveryAction[];
}

export interface AgentCapabilityDescriptor {
  id: string;
  category: CapabilityCategory;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  inputKinds: WorkflowValueKind[];
  outputKinds: WorkflowValueKind[];
  availability: CapabilityAvailability;
  risk: "read" | "local_write" | "external_side_effect" | "destructive";
  previewSupport: "full" | "plan_only" | "none";
  idempotency: "native" | "keyed" | "none";
  version: string;
  fingerprint: string;
  executorKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CapabilitySnapshot {
  capabilityId: string;
  version: string;
  fingerprint: string;
  availabilityAtPreview: CapabilityAvailabilityState;
  risk: AgentCapabilityDescriptor["risk"];
}

export interface DataSelectionSpec {
  version: number;
  source: "mail" | "attachment";
  scope:
    | { type: "current_mail"; emailId: string }
    | { type: "current_thread"; threadId: string }
    | { type: "calendar_day"; timezone: string; date?: string }
    | { type: "rolling_window"; amount: number; unit: "hour" | "day" }
    | {
        type: "previous_schedule_window";
        maxLookback?: { amount: number; unit: "hour" | "day" };
      };
  filters: Array<{
    field: string;
    operator: string;
    value?: unknown;
  }>;
  relation?: {
    currentEmailId?: string;
    sameSender?: boolean;
    sameThread?: boolean;
    sameSystem?: boolean;
  };
  limits: {
    maxMessages: number;
    maxAttachments?: number;
    maxBytes?: number;
  };
}

export interface AnalysisMetricSpec {
  id: string;
  label: string;
  aggregation: "count" | "sum" | "avg" | "min" | "max" | "p95" | "ratio";
  field?: string;
  numeratorField?: string;
  denominatorField?: string;
}

export interface AnalysisRecipe {
  version: number;
  inputKinds: WorkflowValueKind[];
  dimensions: Array<{ id: string; field: string; label?: string }>;
  metrics: AnalysisMetricSpec[];
  modelTasks: Array<{
    id: string;
    instruction: string;
    outputFields: string[];
    maxInputItems: number;
  }>;
  conclusions: Array<{
    id: string;
    instruction: string;
  }>;
  outputSchema: Record<string, unknown>;
}

export interface ArtifactComponentSpec {
  id: string;
  type:
    | "heading"
    | "paragraph"
    | "metric"
    | "metric_grid"
    | "line_chart"
    | "bar_chart"
    | "pie_chart"
    | "table"
    | "callout"
    | "timeline"
    | "divider";
  title?: string;
  binding?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface ArtifactRecipe {
  version: number;
  format: "text" | "image" | "html" | "pdf";
  title: string;
  components: ArtifactComponentSpec[];
  layout: {
    structure: string;
    sections: string[];
  };
  theme: {
    name: string;
    tokens?: Record<string, string | number>;
  };
  accessibility: {
    includeTextSummary: boolean;
    chartDescriptions: boolean;
  };
  emptyState: string;
  errorState: string;
  outputSchema: Record<string, unknown>;
}

export interface DeliveryDestination {
  type: "conversation" | "message_center" | "feishu_bot" | "wecom_bot" | "connected_bot";
  destinationId?: string;
  enabled: boolean;
}

export interface DeliveryPlan {
  version: number;
  destinations: DeliveryDestination[];
  content: {
    includeSummary: boolean;
    includeImage: boolean;
    includeArtifactLink: boolean;
    includeFullArtifact?: boolean;
  };
  fallbackPolicy: {
    type: "stop" | "continue" | "first_available" | "all_available";
    priority?: Array<"feishu_bot" | "wecom_bot">;
    messageCenterRequired?: boolean;
  };
}

export interface WorkflowPipelineStepDraft {
  id: string;
  capabilityId: string;
  name?: string;
  input: Record<string, unknown>;
  outputKind?: WorkflowValueKind;
  onError: {
    policy: "stop" | "continue";
    retries: number;
  };
}

export type ReviewTarget = "data" | "analysis" | "artifact" | "delivery";
export type ReviewStatus = "pending" | "accepted" | "rejected" | "stale";

export interface ReviewCheckpoint {
  id: string;
  target: ReviewTarget;
  policy: SkillReviewPolicy;
  status: ReviewStatus;
  draftRevision: number;
  targetVersion: number;
  contentHash: string;
  previewId?: string;
  previewUrl?: string;
  dependsOn: ReviewTarget[];
  feedback?: string;
  acceptedAt?: string;
}

export interface PipelineValidationState {
  status: "not_validated" | "valid" | "invalid";
  issues: Array<{
    path: string;
    code: string;
    message: string;
  }>;
  validatedAt?: string;
}

export interface ExecutionPipelineDraft {
  id: string;
  accountId: string;
  owner?: import("./automationCenter.js").AutomationOwner;
  accountScope?: import("./automationCenter.js").AutomationAccountScope;
  sourceRuleId?: string;
  sourceRuleVersion?: number;
  templateBinding?: import("./automationCenter.js").AutomationTemplateBindingSnapshot;
  templateConfiguration?: Record<string, unknown>;
  advancedPolicy?: Record<string, unknown>;
  sessionId?: string;
  revision: number;
  mode: "one_shot" | "automation";
  trigger?: {
    event: "manual" | "schedule" | "mail.received";
    match?: Record<string, unknown>;
    timing: Record<string, unknown>;
  };
  dataSelection?: DataSelectionSpec;
  analysis?: AnalysisRecipe;
  artifact?: ArtifactRecipe;
  delivery?: DeliveryPlan;
  steps: WorkflowPipelineStepDraft[];
  skillSnapshots: SkillSnapshot[];
  capabilitySnapshots: CapabilitySnapshot[];
  reviews: ReviewCheckpoint[];
  validation: PipelineValidationState;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCenterListResponse {
  skills: SkillSummary[];
}
