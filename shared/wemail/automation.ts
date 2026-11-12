export interface AutomationConditions {
  sender?: string;
  recipient?: string;
  cc?: string;
  subjectKeyword?: string;
  bodyKeyword?: string;
  hasAttachment?: boolean;
  olderThanDays?: number;
  newerThanDays?: number;
  aiTag?: string;
}

export type AutomationConditionMode = "all" | "any";

export type AutomationConditionField =
  | "sender"
  | "recipient"
  | "cc"
  | "subject"
  | "body"
  | "hasAttachment"
  | "aiTag";

export type AutomationConditionOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "exists"
  | "notExists";

export interface AutomationConditionRule {
  id: string;
  field: AutomationConditionField;
  operator: AutomationConditionOperator;
  value?: string | boolean;
}

export type AutomationTemporalValueType = "date" | "datetime";
export type AutomationTemporalCardinality = "one" | "many";

export interface AutomationFieldDefinition {
  path: string;
  label: string;
  description: string;
  valueType: AutomationTemporalValueType;
  cardinality: AutomationTemporalCardinality;
  scope: "mail" | "attachment";
  availability: "immediate" | "enriched";
}

export type TemporalExpression =
  | { type: "field"; path: string; scope?: "mail" | "matchingAttachments" }
  | {
      type: "aggregate";
      operator: "max" | "min";
      values: TemporalExpression;
    }
  | { type: "coalesce"; values: TemporalExpression[] }
  | {
      type: "addDuration";
      base: TemporalExpression;
      duration: {
        amount: number;
        unit: "minute" | "hour" | "day";
      };
    };

export interface AtExpressionExecution {
  type: "atExpression";
  expression: TemporalExpression;
  timezone: string;
}

export type MailReceivedExecutionTiming =
  | { type: "immediate" }
  | { type: "delay"; amount: number; unit: "minute" | "hour" | "day" }
  | { type: "nextDayAt"; localTime: string; timezone: string }
  | AtExpressionExecution;

export type AutomationTrigger =
  | { type: "manual" }
  | { type: "mailReceived"; execution?: MailReceivedExecutionTiming }
  | {
      type: "scheduled";
      intervalMinutes?: number;
      schedule?: AutomationSchedule;
      timezone?: string;
      nextRunAt?: string;
    };

export type AutomationSchedule =
  | { type: "interval"; intervalMinutes: number }
  | { type: "daily"; localTime: string; timezone: string };

export type AutomationCollectionScope =
  | {
      type: "calendarDay";
      timezone: string;
      folder?: string;
      limit?: number;
    }
  | {
      type: "rollingWindow";
      amount: number;
      unit: "hour" | "day";
      folder?: string;
      limit?: number;
    }
  | {
      type: "previousScheduleWindow";
      maxLookback?: { amount: number; unit: "hour" | "day" };
      folder?: string;
      limit?: number;
    };

export type AutomationProcessor =
  | {
      type: "mailDigest";
      instructions?: string;
    }
  | {
      type: "invoiceReadinessAnalysis";
      instructions?: string;
    };

export interface AutomationProcessing {
  mode: "perMessage" | "collection";
  scope?: AutomationCollectionScope;
  processors?: AutomationProcessor[];
}

export type AutomationRisk = "read" | "local-write" | "external-mutation" | "destructive";

export type AutomationSideEffect =
  | "read-mail"
  | "modify-mail"
  | "read-attachment"
  | "materialize-file"
  | "write-local-artifact"
  | "publish-message"
  | "desktop-notification"
  | "external-upload"
  | "external-request"
  | "delete-data";

export type AutomationValueType =
  | "scalar"
  | "mail-reference"
  | "mail-collection"
  | "attachment-reference"
  | "attachment-collection"
  | "dataset"
  | "artifact-reference"
  | "external-operation";

export interface AutomationMailReference {
  type: "mail-reference";
  accountId: string;
  emailId: string;
  subject?: string;
}

export interface AutomationAttachmentReference {
  type: "attachment-reference";
  accountId: string;
  emailId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256?: string;
}

export interface AutomationDataset {
  type: "dataset";
  schema: {
    fields: Array<{
      name: string;
      type: "string" | "number" | "boolean" | "date" | "datetime" | "reference";
      label?: string;
      /** Optional deterministic role assigned by the dataset normalizer. */
      semanticRole?: "dimension" | "measure" | "time" | "time_window" | "status" | "unit";
      /** Stable business-neutral identity used by guided analysis plans. */
      semanticId?: string;
    }>;
  };
  rows: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  provenance?: Array<{
    outputPath: string;
    sourceType: "mail" | "attachment" | "processor";
    emailIds?: string[];
    attachmentIds?: string[];
    processorStepId?: string;
    operation?: string;
  }>;
  /** Source emails with display metadata for the report's clickable provenance popup. */
  sourceEmails?: Array<{ id: string; subject?: string; from?: string; date?: string }>;
  /** Original tables extracted from source emails, preserved for the raw detail section (no re-aggregation). */
  rawTables?: Array<{ columns: string[]; rows: Array<Record<string, string>> }>;
}

export interface AutomationArtifactReference {
  type: "artifact-reference";
  artifactId: string;
  version: number;
  contentHash: string;
  kind: "brief" | "report" | "dashboard" | "deck";
}

export type AutomationValue =
  | { type: "scalar"; value: unknown }
  | AutomationMailReference
  | { type: "mail-collection"; messages: AutomationMailReference[] }
  | AutomationAttachmentReference
  | { type: "attachment-collection"; attachments: AutomationAttachmentReference[] }
  | AutomationDataset
  | AutomationArtifactReference
  | { type: "external-operation"; operationId?: string; result: unknown };

export type AutomationBindingExpression =
  | { type: "literal"; value: unknown }
  | {
      type: "path";
      from: "trigger" | "collection" | "step" | "run";
      stepId?: string;
      path: string;
    }
  | { type: "coalesce"; values: AutomationBindingExpression[] };

export interface AutomationPipelineStep {
  id: string;
  name?: string;
  provider: string;
  capability: string;
  capabilityFingerprint?: string;
  input: Record<string, AutomationBindingExpression>;
  config?: Record<string, unknown>;
  expansion?: "single" | "all" | "each";
  onError?: {
    policy: "stop" | "continue";
    retries?: number;
  };
}

export interface AutomationCapabilitySnapshot {
  provider: string;
  capability: string;
  fingerprint: string;
  risk: AutomationRisk;
  inputSchemaHash: string;
}

export interface AutomationAuthorization {
  authorizedAt?: string;
  authorizedBy?: string;
  capabilities: Array<{
    provider: string;
    capability: string;
    fingerprint: string;
    risk: AutomationRisk;
    limits?: {
      maxItems?: number;
      maxBytes?: number;
      allowedAccountId?: string;
      allowedCommandPath?: string[];
    };
  }>;
}

export interface AutomationRuleV2 {
  schemaVersion: 2;
  id: string;
  version: number;
  accountId: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  naturalLanguageCondition?: string;
  conditions: AutomationConditions;
  conditionMode?: AutomationConditionMode;
  conditionRules?: AutomationConditionRule[];
  collection?: AutomationProcessing;
  pipeline: AutomationPipelineStep[];
  authorization: AutomationAuthorization;
  capabilitySnapshots: AutomationCapabilitySnapshot[];
  skillSnapshots?: import("./skillCenter.js").SkillSnapshot[];
  dataSelectionRecipe?: import("./skillCenter.js").DataSelectionSpec;
  analysisRecipe?: import("./skillCenter.js").AnalysisRecipe;
  artifactRecipe?: import("./skillCenter.js").ArtifactRecipe;
  deliveryPlan?: import("./skillCenter.js").DeliveryPlan;
  acceptedReviews?: Array<{
    checkpointId: string;
    target: import("./skillCenter.js").ReviewTarget;
    targetVersion: number;
    contentHash: string;
  }>;
  compiledPipelineHash?: string;
  owner?: import("./automationCenter.js").AutomationOwner;
  accountScope?: import("./automationCenter.js").AutomationAccountScope;
  templateBinding?: import("./automationCenter.js").AutomationTemplateBindingSnapshot;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type AutomationRuleAny = AutomationRule | AutomationRuleV2;

/**
 * When adding or changing action types, follow
 * `docs/automation-action-standards.md` so API validation, execution,
 * dangerous-action confirmation, UI labels, and tests stay aligned.
 */
export type AutomationAction =
  | { type: "applyLabel"; label: string }
  | { type: "star" }
  | { type: "archive" }
  | { type: "trash" }
  | { type: "spam" }
  | { type: "notSpam" }
  | { type: "markImportant" }
  | { type: "markNotImportant" }
  | { type: "markRead" }
  | { type: "markUnread" }
  | { type: "suppressTodoCreation" }
  | {
      type: "publishApplicationMessage";
      title: string;
      messageType?: "digest" | "analysis" | "execution-result" | "warning" | "custom";
      desktopNotification?: boolean;
    }
  | import("./channels.js").PublishBotMessageAction
  | {
      type: "external";
      adapter: "wecli.allowance.upload" | "wecli.operation" | string;
      input: {
        attachmentPolicy?: "pdf" | "invoice" | "all";
        [key: string]: unknown;
      };
    };

export interface AutomationRule {
  id: string;
  accountId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  naturalLanguageCondition?: string;
  conditions: AutomationConditions;
  conditionMode?: AutomationConditionMode;
  conditionRules?: AutomationConditionRule[];
  processing?: AutomationProcessing;
  actions: AutomationAction[];
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRulePreviewResult {
  previewId: string;
  ruleHash: string;
  capabilityFingerprint: string;
  sourceRuleId?: string;
  sourceRuleVersion?: string;
  normalizedRule: Omit<AutomationRule, "id" | "createdAt" | "updatedAt">;
  resolvedWindow?: { start: string; end: string };
  matchedCount: number;
  matchedReferences: Array<{ type: "email"; id: string; subject: string }>;
  truncated: boolean;
  plannedProcessors: AutomationProcessor[];
  plannedActions: AutomationAction[];
  warnings: string[];
  expiresAt: string;
}
