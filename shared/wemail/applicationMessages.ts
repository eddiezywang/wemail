export type ApplicationMessageType =
  | "digest"
  | "analysis"
  | "execution-result"
  | "warning"
  | "smart-tag-suggestion"
  | "custom";

export type ApplicationMessageSeverity = "info" | "success" | "warning" | "error";

export type ApplicationMessageContentBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "callout"; tone: ApplicationMessageSeverity; title?: string; text: string }
  | { type: "status"; label: string; value: string; tone?: ApplicationMessageSeverity };

export type ApplicationMessageReference =
  | { type: "email"; id: string; accountId?: string; label?: string }
  | { type: "attachment"; id: string; emailId: string; accountId?: string; label?: string }
  | { type: "automationRule"; id: string; label?: string }
  | { type: "automationRun"; id: string; label?: string }
  | { type: "draft"; id: string; label?: string }
  | { type: "externalOperation"; id: string; label?: string };

export type ApplicationMessageInteraction =
  | { type: "openEmail"; emailId: string; accountId?: string; label: string }
  | { type: "openEmails"; emailIds: string[]; accountId?: string; references?: Array<{ accountId: string; emailId: string }>; label: string }
  | { type: "openAutomationRule"; ruleId: string; label: string }
  | { type: "proposeWecli"; command: string; label: string }
  | { type: "openArtifact"; artifactId: string; version: number; label: string }
  | { type: "previewSmartTagTopic"; topicId: string; emailIds: string[]; label: string }
  | { type: "createSmartTagFromTopic"; topicId: string; label: string }
  | { type: "editSmartTagFromTopic"; topicId: string; label: string }
  | { type: "deferSmartTagTopic"; topicId: string; label: string }
  | { type: "suppressSmartTagTopic"; topicId: string; label: string };

export interface ApplicationMessage {
  id: string;
  accountId: string;
  owner?: import("./automationCenter.js").AutomationOwner;
  sourceType: "automation" | "system" | "agent";
  sourceRuleId?: string;
  sourceRunId?: string;
  type: ApplicationMessageType;
  severity: ApplicationMessageSeverity;
  title: string;
  preview: string;
  content: ApplicationMessageContentBlock[];
  references: ApplicationMessageReference[];
  interactions: ApplicationMessageInteraction[];
  artifact?: {
    id: string;
    version: number;
    kind: "brief" | "report" | "dashboard" | "deck";
    contentHash: string;
  };
  keyMetrics?: Array<{ label: string; value: string; tone?: ApplicationMessageSeverity }>;
  delayed?: boolean;
  readAt?: string;
  archivedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ApplicationMessageListResult {
  messages: ApplicationMessage[];
  total: number;
  unread: number;
  nextOffset?: number;
}

export interface ApplicationMessageFilters {
  unread?: boolean;
  archived?: boolean;
  type?: ApplicationMessageType;
  sourceType?: ApplicationMessage["sourceType"];
  limit?: number;
  offset?: number;
}
