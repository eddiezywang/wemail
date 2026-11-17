export interface WemailFeatureFlags {
  dynamicSkills: boolean;
  agentCapabilityCatalog: boolean;
  pipelineAuthoringSessions: boolean;
  unifiedAutomationCenter: boolean;
  structuredAutomationEditing: boolean;
  automationTemplateCatalog: boolean;
  crossAccountAutomation: boolean;
  subscriptionInsight: boolean;
}

export function readWemailFeatureFlags(
  environment: NodeJS.ProcessEnv = process.env,
): WemailFeatureFlags {
  return {
    dynamicSkills: environment.WEMAIL_DYNAMIC_SKILLS !== "0",
    agentCapabilityCatalog:
      environment.WEMAIL_AGENT_CAPABILITY_CATALOG !== "0",
    pipelineAuthoringSessions:
      environment.WEMAIL_PIPELINE_AUTHORING !== "0",
    unifiedAutomationCenter:
      environment.WEMAIL_UNIFIED_AUTOMATION_CENTER !== "0",
    structuredAutomationEditing:
      environment.WEMAIL_STRUCTURED_AUTOMATION_EDITING !== "0",
    automationTemplateCatalog:
      environment.WEMAIL_AUTOMATION_TEMPLATE_CATALOG !== "0",
    crossAccountAutomation:
      environment.WEMAIL_CROSS_ACCOUNT_AUTOMATION !== "0",
    subscriptionInsight:
      environment.WEMAIL_SUBSCRIPTION_INSIGHT !== "0",
  };
}
