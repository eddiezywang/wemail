import type { AutomationRule } from "../../../shared/wemail/automation.js";

// The commit path cannot yet replace a V1 rule atomically with its V2 rule.
export const LEGACY_UPGRADE_COMMIT_SUPPORTED: boolean = false;

/** Whether the data-selection model can represent this legacy rule. */
export function supportsLegacyDataSelection(source: AutomationRule): boolean {
  const scope = source.processing?.scope;
  const supportedFields = new Set(["sender", "recipient", "cc", "subjectKeyword", "bodyKeyword", "hasAttachment"]);
  return !source.naturalLanguageCondition && !source.conditionRules?.length &&
    Object.keys(source.conditions).every((field) => supportedFields.has(field)) &&
    !scope?.folder && !(scope?.type === "previousScheduleWindow" && scope.maxLookback);
}

/** These legacy options cannot be represented by the current workflow sinks. */
export function supportsLegacyActions(source: AutomationRule): boolean {
  return source.actions.length === 1 && source.actions.every((action) =>
    action.type === "publishApplicationMessage" &&
    action.desktopNotification !== true &&
    (action.messageType === undefined || action.messageType === "analysis"),
  ) && (source.processing?.processors ?? []).every((processor) => !processor.instructions);
}
