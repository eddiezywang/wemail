import type { AutomationFieldDefinition } from "../../../shared/wemail/automation.js";
import { resolveAllowanceModules } from "../agent/allowancePort.js";

/**
 * P2.6: the `invoice.issueDate` field (definition + resolver) is an edition
 * module contribution. The open catalog lists only the native fields, so
 * rule authoring and validation never offer or accept the invoice field;
 * an internal build appends the module's definitions at registration.
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
  ...(resolveAllowanceModules()?.automationFieldDefinitions ?? []),
];

export function getAutomationFieldDefinition(path: string): AutomationFieldDefinition | undefined {
  return AUTOMATION_FIELD_DEFINITIONS.find((definition) => definition.path === path);
}
