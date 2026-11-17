import type { AutomationFieldDefinition } from "../../../shared/wemail/automation.js";

/**
 * P2.6: the `invoice.issueDate` field (definition + resolver) is an edition
 * module contribution. This catalog contains only native fields; each
 * composition adds enabled edition fields to its own rule service.
 */
export const AUTOMATION_FIELD_DEFINITIONS: readonly AutomationFieldDefinition[] = [
  {
    path: "mail.receivedAt",
    label: "收到邮件的时间",
    description: "邮件进入邮箱的精确时间",
    valueType: "datetime",
    cardinality: "one",
    scope: "mail",
    availability: "immediate",
  },
];

export function getAutomationFieldDefinition(path: string): AutomationFieldDefinition | undefined {
  return AUTOMATION_FIELD_DEFINITIONS.find((definition) => definition.path === path);
}
