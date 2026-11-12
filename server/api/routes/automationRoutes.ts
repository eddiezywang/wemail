import { Hono } from "hono";
import type {
  AutomationAction,
  AutomationConditionMode,
  AutomationConditionRule,
  AutomationConditions,
  AutomationProcessing,
  AutomationRule,
  AutomationTrigger,
} from "../../../shared/wemail/automation.js";
import type {
  AutomationSuggestInput,
} from "../../../shared/wemail/intelligence.js";
import type { AutomationRuleRepository } from "../../wemail/automation/AutomationRuleRepository.js";
import type { AutomationRuleExecutionService } from "../../wemail/automation/AutomationRuleExecutionService.js";
import type { RuleDryRunner } from "../../wemail/automation/RuleDryRunner.js";
import type { RuleSuggester } from "../../wemail/automation/RuleSuggester.js";
import type { CanonicalMailRepository } from "../../wemail/mail/CanonicalMailRepository.js";
import { automationCapabilityDiscovery } from "../../wemail/automation/AutomationCapabilityRegistry.js";
import type { AutomationRuleService } from "../../wemail/automation/AutomationRuleService.js";
import type { AutomationProviderRegistry } from "../../wemail/automation/providers/AutomationProviderRegistry.js";
import type { PipelineAutomationRuleService, AutomationRuleV2Draft } from "../../wemail/automation/PipelineAutomationRuleService.js";
import {
  AutomationDeleteBlockedError,
  AutomationNotVisibleError,
  type UnifiedAutomationQueryService,
} from "../../wemail/automation/UnifiedAutomationQueryService.js";
import type { AutomationRunObservabilityService } from "../../wemail/automation/AutomationRunObservabilityService.js";
import type { CanonicalAutomationDraftService } from "../../wemail/automation/CanonicalAutomationDraftService.js";
import { PipelineDraftConflictError } from "../../wemail/workflows/ExecutionPipelineDraftRepository.js";
import type { AutomationDraftPatch } from "../../../shared/wemail/automationCenter.js";
import type { AutomationAuthoringAgentService } from "../../wemail/configuration/AutomationAuthoringAgentService.js";
import type { AutomationTemplateRegistryService } from "../../wemail/automation/AutomationTemplateRegistryService.js";

/** Dangerous action types that require explicit confirmation when running. */
const DANGEROUS_ACTION_TYPES = new Set(["archive", "trash", "spam"]);

export interface AutomationRoutesDeps {
  rules: AutomationRuleRepository;
  mail: CanonicalMailRepository;
  suggester: RuleSuggester;
  dryRunner: RuleDryRunner;
  executionService: AutomationRuleExecutionService;
  ruleService?: AutomationRuleService;
  providers?: AutomationProviderRegistry;
  pipelineRuleService?: PipelineAutomationRuleService;
  unified?: UnifiedAutomationQueryService;
  runObservability?: AutomationRunObservabilityService;
  canonicalDrafts?: CanonicalAutomationDraftService;
  automationAuthoring?: AutomationAuthoringAgentService;
  templates?: AutomationTemplateRegistryService;
  featureFlags?: {
    crossAccountAutomation: boolean;
    subscriptionInsight: boolean;
  };
  /**
   * Checks whether a message has a specific AI-generated tag.
   * When omitted, aiTag conditions match nothing (fail-closed).
   */
  messageHasTag?: (emailId: string, tagName: string) => boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRuleBody(body: unknown): {
  accountId: string;
  name: string;
  enabled?: boolean;
  trigger?: AutomationTrigger;
  naturalLanguageCondition?: string;
  conditions: AutomationConditions;
  conditionMode?: AutomationConditionMode;
  conditionRules?: AutomationConditionRule[];
  processing?: AutomationProcessing;
  actions: AutomationAction[];
} | { error: string; field: string } {
  if (!isObject(body)) return { error: "body must be an object", field: "body" };
  if (typeof body.accountId !== "string" || !body.accountId.trim()) {
    return { error: "accountId is required", field: "accountId" };
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return { error: "name is required", field: "name" };
  }
  if (!isObject(body.conditions)) {
    return { error: "conditions must be an object", field: "conditions" };
  }
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    return { error: "actions must be a non-empty array", field: "actions" };
  }
  const actions = parseActions(body.actions);
  if (actions.length !== body.actions.length) {
    return { error: "actions contain an unsupported or invalid action", field: "actions" };
  }
  const trigger = parseTrigger(body.trigger);
  if (body.trigger !== undefined && !trigger) {
    return { error: "trigger is invalid", field: "trigger" };
  }
  const naturalLanguageCondition =
    typeof body.naturalLanguageCondition === "string"
      ? body.naturalLanguageCondition.trim()
      : undefined;
  const conditions = body.conditions as AutomationConditions;
  const conditionRules = parseConditionRules(body.conditionRules);
  const conditionMode =
    conditionRules.length > 0 ? parseConditionMode(body.conditionMode) : undefined;
  const processing = parseProcessing(body.processing);
  if (
    isAutomaticTrigger(trigger) &&
    Object.keys(conditions).length === 0 &&
    conditionRules.length === 0 &&
    !naturalLanguageCondition && processing?.mode !== "collection"
  ) {
    return {
      error: "automatic rules require at least one condition",
      field: "conditions",
    };
  }
  return {
    accountId: body.accountId,
    name: body.name,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    trigger,
    naturalLanguageCondition,
    conditions,
    conditionMode,
    conditionRules,
    processing,
    actions,
  };
}

function parseTrigger(value: unknown): AutomationTrigger | undefined {
  if (!isObject(value) || typeof value.type !== "string") return undefined;
  if (value.type === "manual") return { type: "manual" };
  if (value.type === "mailReceived") {
    if (value.execution !== undefined && !parseMailReceivedExecution(value.execution)) {
      return undefined;
    }
    const execution = parseMailReceivedExecution(value.execution);
    return execution
      ? { type: "mailReceived", execution }
      : { type: "mailReceived", execution: { type: "immediate" } };
  }
  if (value.type === "scheduled") {
    if (isObject(value.schedule) && value.schedule.type === "daily") {
      return {
        type: "scheduled",
        schedule: {
          type: "daily",
          localTime: typeof value.schedule.localTime === "string" ? value.schedule.localTime : "",
          timezone: typeof value.schedule.timezone === "string" ? value.schedule.timezone : "",
        },
        nextRunAt: typeof value.nextRunAt === "string" ? value.nextRunAt : undefined,
      };
    }
    const intervalMinutes =
      typeof value.intervalMinutes === "number" && value.intervalMinutes > 0
        ? value.intervalMinutes
        : 60;
    return {
      type: "scheduled",
      intervalMinutes,
      schedule: { type: "interval", intervalMinutes },
      timezone: typeof value.timezone === "string" ? value.timezone : undefined,
      nextRunAt: typeof value.nextRunAt === "string" ? value.nextRunAt : undefined,
    };
  }
  return undefined;
}

function parseActions(value: unknown): AutomationAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).filter((action) => {
    if (action.type === "publishApplicationMessage") {
      return typeof action.title === "string" && action.title.trim().length > 0;
    }
    if (action.type !== "external") return true;
    if (action.adapter !== "wecli.allowance.upload" && action.adapter !== "wecli.operation") return false;
    if (!isObject(action.input)) return false;
    if (action.adapter === "wecli.operation") {
      return (
        typeof action.input.capability === "string" &&
        typeof action.input.operation === "string" &&
        (action.input.args === undefined ||
          (Array.isArray(action.input.args) && action.input.args.every((item) => typeof item === "string")))
      );
    }
    const policy = action.input.attachmentPolicy;
    return policy === undefined || policy === "pdf" || policy === "invoice" || policy === "all";
  }) as AutomationAction[];
}

function parseProcessing(value: unknown): AutomationProcessing | undefined {
  if (!isObject(value) || (value.mode !== "perMessage" && value.mode !== "collection")) return undefined;
  return value as unknown as AutomationProcessing;
}

function parseMailReceivedExecution(
  value: unknown,
): Extract<AutomationTrigger, { type: "mailReceived" }>["execution"] | undefined {
  if (!isObject(value) || typeof value.type !== "string") return undefined;
  if (value.type === "immediate") return { type: "immediate" };
  if (value.type === "delay") {
    const amount = typeof value.amount === "number" ? Math.floor(value.amount) : 0;
    const unit = value.unit;
    if (
      amount > 0 &&
      amount <= 365 &&
      (unit === "minute" || unit === "hour" || unit === "day")
    ) {
      return { type: "delay", amount, unit };
    }
    return undefined;
  }
  if (value.type === "nextDayAt") {
    const localTime = typeof value.localTime === "string" ? value.localTime : "";
    const timezone = typeof value.timezone === "string" ? value.timezone : "";
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime) && timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
        return { type: "nextDayAt", localTime, timezone };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function isAutomaticTrigger(trigger: AutomationTrigger | undefined): boolean {
  return trigger?.type === "mailReceived" || trigger?.type === "scheduled";
}

function parseConditionMode(value: unknown): AutomationConditionMode {
  return value === "any" ? "any" : "all";
}

function parseConditionRules(value: unknown): AutomationConditionRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isConditionRule);
}

function isConditionRule(value: unknown): value is AutomationConditionRule {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    isConditionField(value.field) &&
    isConditionOperator(value.operator) &&
    (value.value === undefined ||
      typeof value.value === "string" ||
      typeof value.value === "boolean")
  );
}

function isConditionField(value: unknown): value is AutomationConditionRule["field"] {
  return (
    value === "sender" ||
    value === "recipient" ||
    value === "cc" ||
    value === "subject" ||
    value === "body" ||
    value === "hasAttachment" ||
    value === "aiTag"
  );
}

function isConditionOperator(value: unknown): value is AutomationConditionRule["operator"] {
  return (
    value === "contains" ||
    value === "notContains" ||
    value === "equals" ||
    value === "notEquals" ||
    value === "exists" ||
    value === "notExists"
  );
}

function hasDangerousAction(actions: AutomationAction[]): boolean {
  return actions.some((a) => DANGEROUS_ACTION_TYPES.has(a.type) || a.type === "external");
}

export function buildAutomationRoutes(deps: AutomationRoutesDeps): Hono {
  const app = new Hono();
  const subscriptionTemplateAvailable = (templateId: string) =>
    templateId !== "subscription-daily-insight" ||
    deps.featureFlags?.subscriptionInsight !== false;
  const crossAccountScopeAvailable = (configuration: unknown) => {
    if (deps.featureFlags?.crossAccountAutomation !== false) return true;
    if (!isObject(configuration) || !isObject(configuration.accountScope)) {
      return true;
    }
    return configuration.accountScope.type === "currentAccount";
  };

  app.get("/templates", async (c) => {
    if (!deps.templates) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    return c.json({
      ok: true,
      templates: (
        await deps.templates.list(
          c.req.query("locale")?.trim() || "zh-CN",
          c.req.query("accountId")?.trim(),
        )
      ).filter((template) => subscriptionTemplateAvailable(template.id)),
    });
  });

  app.get("/templates/:id", (c) => {
    if (!deps.templates) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    if (!subscriptionTemplateAvailable(c.req.param("id"))) {
      return c.json({ ok: false, error: "automation-template-not-found" }, 404);
    }
    const template = deps.templates.inspect(
      c.req.param("id"),
      c.req.query("version")?.trim(),
    );
    return template
      ? c.json({ ok: true, template })
      : c.json({ ok: false, error: "automation-template-not-found" }, 404);
  });

  app.post("/templates/:id/validate", async (c) => {
    if (!deps.templates) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!subscriptionTemplateAvailable(c.req.param("id"))) {
      return c.json({ ok: false, error: "automation-template-not-found" }, 404);
    }
    const template = deps.templates.inspect(
      c.req.param("id"),
      isObject(body) && typeof body.version === "string"
        ? body.version
        : undefined,
    );
    if (!template) {
      return c.json({ ok: false, error: "automation-template-not-found" }, 404);
    }
    const configuration =
      isObject(body) && isObject(body.configuration)
        ? body.configuration
        : {};
    if (!crossAccountScopeAvailable(configuration)) {
      return c.json({ ok: false, error: "cross-account-automation-disabled" }, 409);
    }
    const issues = deps.templates.validateConfiguration(
      template,
      configuration,
    );
    return c.json({ ok: issues.length === 0, issues });
  });

  app.post("/templates/:id/preview", async (c) => {
    if (!deps.templates) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!subscriptionTemplateAvailable(c.req.param("id"))) {
      return c.json({ ok: false, error: "automation-template-not-found" }, 404);
    }
    if (
      !isObject(body) ||
      typeof body.accountId !== "string" ||
      !isObject(body.configuration)
    ) {
      return c.json(
        { ok: false, error: "accountId and configuration are required" },
        400,
      );
    }
    if (!crossAccountScopeAvailable(body.configuration)) {
      return c.json({ ok: false, error: "cross-account-automation-disabled" }, 409);
    }
    try {
      const preview = await deps.templates.previewInstantiation({
        templateId: c.req.param("id"),
        version: typeof body.version === "string" ? body.version : undefined,
        accountId: body.accountId,
        configuration: body.configuration,
      });
      return c.json({ ok: true, preview });
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

  app.post("/templates/:id/confirm", async (c) => {
    if (!deps.templates || !deps.pipelineRuleService) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    if (
      !isObject(body) ||
      typeof body.accountId !== "string" ||
      typeof body.previewId !== "string" ||
      typeof body.previewHash !== "string"
    ) {
      return c.json({ ok: false, error: "invalid-template-confirmation" }, 400);
    }
    try {
      const automation = await deps.templates.instantiate({
        accountId: body.accountId,
        previewId: body.previewId,
        previewHash: body.previewHash,
        locale: typeof body.locale === "string" ? body.locale : "zh-CN",
        ruleService: deps.pipelineRuleService,
      });
      return c.json({
        ok: true,
        automation,
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: automationTemplateConfirmationCode(error),
        },
        409,
      );
    }
  });

  app.get("/center", async (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const profileId = c.req.query("profileId")?.trim();
    if (profileId && profileId !== "default") {
      return c.json({ ok: false, error: "profile-not-visible" }, 403);
    }
    const projected = deps.unified.list({
      accountId,
      profileId: "default",
    });
    const automations = deps.templates
      ? projected.automations.map((automation) => {
          if (automation.schemaVersion !== 2) return automation;
          const rule = deps.rules.getV2(automation.id);
          return rule?.templateBinding
            ? { ...automation, upgrade: deps.templates!.upgradeFor(rule) }
            : automation;
        })
      : projected.automations;
    return c.json({
      ok: true,
      ...projected,
      automations,
      recommendedTemplates: deps.templates
        ? (
            await deps.templates.list(
              c.req.query("locale")?.trim() || "zh-CN",
              accountId,
            )
          ).filter((template) => template.id !== "wemail.mail-digest")
        : projected.recommendedTemplates,
    });
  });

  app.post("/center/:id/edit-draft", async (c) => {
    if (!deps.canonicalDrafts) {
      return c.json({ ok: false, error: "canonical-draft-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const result = deps.automationAuthoring
        ? await deps.automationAuthoring.resumeRule({
            ruleId: c.req.param("id"),
            accountId,
          })
        : await deps.canonicalDrafts.resumeFromRule({
            ruleId: c.req.param("id"),
            accountId,
          });
      return c.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 404);
    }
  });

  app.get("/center/drafts/:draftId", (c) => {
    if (!deps.canonicalDrafts) {
      return c.json({ ok: false, error: "canonical-draft-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const draft = deps.canonicalDrafts.get(
      c.req.param("draftId"),
      accountId,
    );
    return draft
      ? c.json({ ok: true, draft })
      : c.json({ ok: false, error: "pipeline-draft-not-found" }, 404);
  });

  app.get("/center/:id/template-version", (c) => {
    if (!deps.templates || !deps.unified) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      if (automation.schemaVersion !== 2) {
        return c.json({ ok: false, error: "template-versioning-requires-v2" }, 409);
      }
      const rule = deps.rules.getV2(automation.id);
      if (!rule) return c.json({ ok: false, error: "rule-not-found" }, 404);
      return c.json({
        ok: true,
        upgrade: deps.templates.upgradeFor(rule),
        versions: deps.templates.listRuleVersions(rule.id),
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  app.post("/center/:id/template-upgrade/preview", async (c) => {
    if (!deps.templates || !deps.unified) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const accountId =
      isObject(body) && typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      if (automation.schemaVersion !== 2) {
        return c.json({ ok: false, error: "template-versioning-requires-v2" }, 409);
      }
      const preview = await deps.templates.previewUpgrade({
        ruleId: automation.id,
        accountId,
      });
      return c.json({ ok: true, preview });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  app.post("/center/:id/template-upgrade/confirm", async (c) => {
    if (!deps.templates || !deps.unified) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    if (
      !isObject(body) ||
      typeof body.accountId !== "string" ||
      typeof body.previewId !== "string" ||
      typeof body.previewHash !== "string"
    ) {
      return c.json({ ok: false, error: "invalid-template-upgrade-confirmation" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId: body.accountId,
        profileId: "default",
      });
      const draft = deps.templates.confirmInstantiation({
        accountId: body.accountId,
        previewId: body.previewId,
        previewHash: body.previewHash,
      });
      if (draft.sourceRuleId !== automation.id) {
        return c.json({ ok: false, error: "template-upgrade-source-mismatch" }, 409);
      }
      return c.json({
        ok: true,
        draft,
        next: {
          type: "review_and_confirm",
          message: "升级草稿已创建；旧版本仍在运行，请完成预览评审和最终确认。",
        },
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  app.post("/center/:id/template-rollback", async (c) => {
    if (!deps.templates || !deps.unified) {
      return c.json({ ok: false, error: "automation-templates-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const accountId =
      isObject(body) && typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";
    const targetVersion =
      isObject(body) && typeof body.targetVersion === "number"
        ? Math.floor(body.targetVersion)
        : 0;
    const expectedCurrentVersion =
      isObject(body) && typeof body.expectedCurrentVersion === "number"
        ? Math.floor(body.expectedCurrentVersion)
        : 0;
    if (
      !accountId ||
      targetVersion < 1 ||
      expectedCurrentVersion < 1 ||
      !isObject(body) ||
      body.confirmation !== `回退到版本 ${targetVersion}`
    ) {
      return c.json({ ok: false, error: "exact-rollback-confirmation-required" }, 409);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      if (
        automation.schemaVersion !== 2 ||
        automation.version !== expectedCurrentVersion
      ) {
        return c.json({ ok: false, error: "automation-rule-version-conflict" }, 409);
      }
      return c.json({
        ok: true,
        automation: deps.templates.rollbackRule(automation.id, targetVersion),
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  app.patch("/center/:id/state", async (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const accountId =
      isObject(body) && typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";
    if (!accountId || !isObject(body) || typeof body.enabled !== "boolean") {
      return c.json({ ok: false, error: "accountId and enabled are required" }, 400);
    }
    try {
      return c.json({
        ok: true,
        automation: deps.unified.setEnabled(
          c.req.param("id"),
          { accountId, profileId: "default" },
          body.enabled,
        ),
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/center/:id/run", async (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const accountId =
      isObject(body) && typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      if (!automation.enabled) {
        return c.json({ ok: false, error: "automation-disabled" }, 409);
      }
      if (automation.schemaVersion === 2) {
        if (!deps.pipelineRuleService) {
          return c.json({ ok: false, error: "pipeline-runtime-unavailable" }, 503);
        }
        const rule = deps.rules.getV2(automation.id);
        if (!rule) return c.json({ ok: false, error: "rule-not-found" }, 404);
        return c.json({
          ok: true,
          result: await deps.pipelineRuleService.runManually(rule),
        });
      }
      const legacy = deps.rules.get(automation.id);
      if (!legacy) return c.json({ ok: false, error: "rule-not-found" }, 404);
      if (
        hasDangerousAction(legacy.actions) &&
        (!isObject(body) || body.confirmDangerous !== true)
      ) {
        return c.json({ ok: false, error: "dangerous-action-confirmation-required" }, 409);
      }
      return c.json({
        ok: true,
        result: await deps.executionService.runRuleManually(legacy.id),
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/center/:id/test", async (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const accountId =
      isObject(body) && typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      if (automation.schemaVersion === 1) {
        return c.json({
          ok: true,
          preview: deps.dryRunner.dryRun(automation.id, accountId),
        });
      }
      if (!deps.pipelineRuleService) {
        return c.json({ ok: false, error: "pipeline-runtime-unavailable" }, 503);
      }
      const rule = deps.rules.getV2(automation.id);
      if (!rule) return c.json({ ok: false, error: "rule-not-found" }, 404);
      const {
        id: _id,
        version: _version,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...draft
      } = rule;
      return c.json({
        ok: true,
        preview: await deps.pipelineRuleService.preview(draft),
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        409,
      );
    }
  });

  app.patch("/center/drafts/:draftId", async (c) => {
    if (!deps.canonicalDrafts) {
      return c.json({ ok: false, error: "canonical-draft-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isObject(body) || !Number.isInteger(body.expectedRevision)) {
      return c.json({ ok: false, error: "expectedRevision is required" }, 400);
    }
    if (
      deps.featureFlags?.crossAccountAutomation === false &&
      isObject(body.accountScope) &&
      body.accountScope.type !== "currentAccount"
    ) {
      return c.json(
        { ok: false, error: "cross-account-automation-disabled" },
        409,
      );
    }
    try {
      const result = deps.automationAuthoring
        ? await deps.automationAuthoring.patchDraft({
            draftId: c.req.param("draftId"),
            accountId,
            patch: body as unknown as AutomationDraftPatch,
            previewRows: Array.isArray(body.previewRows)
              ? (body.previewRows as Array<Record<string, unknown>>).slice(0, 50)
              : [],
          })
        : {
            draft: await deps.canonicalDrafts.patch({
              draftId: c.req.param("draftId"),
              accountId,
              patch: body as unknown as AutomationDraftPatch,
            }),
          };
      return c.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof PipelineDraftConflictError) {
        return c.json(
          {
            ok: false,
            error: error.message,
            conflict: error.summary,
          },
          409,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { ok: false, error: message },
        message === "pipeline-draft-not-found" ? 404 : 409,
      );
    }
  });

  app.get("/center/:id", (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      const rule =
        automation.schemaVersion === 2
          ? deps.rules.getV2(automation.id)
          : null;
      return c.json({
        ok: true,
        automation:
          deps.templates && rule?.templateBinding
            ? { ...automation, upgrade: deps.templates.upgradeFor(rule) }
            : automation,
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/center/:id/runs/:runId", (c) => {
    if (!deps.unified || !deps.runObservability) {
      return c.json({ ok: false, error: "run-observability-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      const run = deps.runObservability.detail(c.req.param("runId"), {
        accountId,
        profileId: "default",
      });
      if (!run || run.ruleId !== c.req.param("id")) {
        return c.json({ ok: false, error: "automation-run-not-found" }, 404);
      }
      return c.json({ ok: true, run });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/center/:id/runs/:runId/progress", (c) => {
    if (!deps.unified || !deps.runObservability) {
      return c.json({ ok: false, error: "run-observability-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const afterRevision = Number(c.req.query("afterRevision") ?? 0);
    try {
      deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      const progress = deps.runObservability.progress(
        c.req.param("runId"),
        { accountId, profileId: "default" },
        Number.isFinite(afterRevision) ? afterRevision : 0,
      );
      if (!progress || progress.detail?.ruleId && progress.detail.ruleId !== c.req.param("id")) {
        return c.json({ ok: false, error: "automation-run-not-found" }, 404);
      }
      return c.json({ ok: true, ...progress });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/center/:id/runs/:runId/steps/:stepId/retry", async (c) => {
    if (
      !deps.unified ||
      !deps.runObservability ||
      !deps.pipelineRuleService
    ) {
      return c.json({ ok: false, error: "run-recovery-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      const automation = deps.unified.detail(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      if (automation.schemaVersion !== 2) {
        return c.json({ ok: false, error: "legacy-step-retry-unsupported" }, 409);
      }
      const run = deps.runObservability.detail(c.req.param("runId"), {
        accountId,
        profileId: "default",
      });
      const step = run?.steps.find(
        (item) => item.stepId === c.req.param("stepId"),
      );
      if (!run || run.ruleId !== automation.id || !step) {
        return c.json({ ok: false, error: "automation-step-not-found" }, 404);
      }
      if (step.stage === "delivery") {
        const body = await c.req.json().catch(() => ({}));
        if (!isObject(body) || body.confirmDelivery !== true) {
          return c.json(
            {
              ok: false,
              error: "delivery-retry-confirmation-required",
              message: "重试投递可能再次向外部发送消息，请先确认。",
            },
            409,
          );
        }
      }
      const rule = deps.rules.getV2(automation.id);
      if (!rule) {
        return c.json({ ok: false, error: "pipeline-rule-not-found" }, 404);
      }
      const result = await deps.pipelineRuleService.retryFailedStep({
        rule,
        runId: run.id,
        stepId: step.stepId,
      });
      return result.ok
        ? c.json({ ok: true, result })
        : c.json({ ok: false, error: result.code, message: result.message }, 409);
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/center/:id/archive", (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      return c.json({
        ok: true,
        automation: deps.unified.archive(c.req.param("id"), {
          accountId,
          profileId: "default",
        }),
      });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      throw error;
    }
  });

  app.delete("/center/:id/permanent", (c) => {
    if (!deps.unified) {
      return c.json({ ok: false, error: "unified-automation-unavailable" }, 503);
    }
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    try {
      deps.unified.deletePermanently(c.req.param("id"), {
        accountId,
        profileId: "default",
      });
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof AutomationNotVisibleError) {
        return c.json({ ok: false, error: error.message }, 404);
      }
      if (error instanceof AutomationDeleteBlockedError) {
        return c.json(
          { ok: false, error: error.message, references: error.references },
          409,
        );
      }
      throw error;
    }
  });

  app.get("/capabilities", async (c) => {
    if (!deps.providers) return c.json({ ok: true, capabilities: automationCapabilityDiscovery() });
    const capabilities = await deps.providers.discover({ query: c.req.query("query"), provider: c.req.query("provider"), capability: c.req.query("capability") });
    return c.json({ ok: true, capabilities, registryFingerprint: await deps.providers.fingerprint() });
  });
  app.get("/v2/rules", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) return c.json({ ok: false, error: "accountId is required" }, 400);
    return c.json({ ok: true, rules: deps.rules.listV2(accountId) });
  });
  app.post("/v2/rules/preview", async (c) => {
    if (!deps.pipelineRuleService) return c.json({ ok: false, error: "pipeline-runtime-unavailable" }, 503);
    try { return c.json({ ok: true, preview: await deps.pipelineRuleService.preview(await c.req.json() as AutomationRuleV2Draft) }); }
    catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/v2/rules/commit", async (c) => {
    if (!deps.pipelineRuleService) return c.json({ ok: false, error: "pipeline-runtime-unavailable" }, 503);
    try { const body = await c.req.json() as { accountId: string; previewId: string; ruleHash: string }; return c.json({ ok: true, rule: await deps.pipelineRuleService.commit(body) }); }
    catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/v2/rules/:id/run", async (c) => {
    if (!deps.pipelineRuleService) return c.json({ ok: false, error: "pipeline-runtime-unavailable" }, 503);
    const rule = deps.rules.getV2(c.req.param("id"));
    if (!rule) return c.json({ ok: false, error: "rule-not-found" }, 404);
    try { return c.json({ ok: true, result: await deps.pipelineRuleService.run(rule, await c.req.json().catch(() => ({}))) }); }
    catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
  });

  app.post("/rules/preview", async (c) => {
    if (!deps.ruleService) return c.json({ ok: false, error: "automation-preview-unavailable" }, 501);
    const body = await c.req.json().catch(() => ({}));
    const parsed = parseRuleBody(body);
    if ("error" in parsed) return c.json({ ok: false, error: parsed.error, field: parsed.field }, 400);
    try {
      const normalized = {
        ...parsed,
        enabled: parsed.enabled ?? false,
        trigger: parsed.trigger ?? { type: "manual" as const },
      };
      return c.json({ ok: true, preview: deps.ruleService.preview(normalized, isObject(body) && typeof body.sourceRuleId === "string" ? body.sourceRuleId : undefined) });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/rules/commit", async (c) => {
    if (!deps.ruleService) return c.json({ ok: false, error: "automation-preview-unavailable" }, 501);
    const body = await c.req.json().catch(() => ({}));
    if (!isObject(body) || typeof body.accountId !== "string" || typeof body.previewId !== "string" || typeof body.ruleHash !== "string") {
      return c.json({ ok: false, error: "accountId, previewId and ruleHash are required" }, 400);
    }
    try { return c.json({ ok: true, rule: deps.ruleService.commit({ accountId: body.accountId, previewId: body.previewId, ruleHash: body.ruleHash }) }); }
    catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409); }
  });

  app.get("/rules", (c) => {
    const accountId = c.req.query("accountId") ?? undefined;
    return c.json({ ok: true, rules: deps.rules.list(accountId) });
  });

  app.get("/runs", (c) => {
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    const requestedLimit = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    return c.json({ ok: true, runs: deps.rules.listRuns(accountId, limit) });
  });

  app.post("/rules", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = parseRuleBody(body);
    if ("error" in parsed) return c.json({ ok: false, error: parsed.error, field: parsed.field }, 400);
    try {
      const draft = { ...parsed, enabled: parsed.enabled ?? true, trigger: parsed.trigger ?? { type: "manual" as const } };
      return c.json({ ok: true, rule: deps.ruleService ? deps.ruleService.createLegacy(draft) : deps.rules.create(parsed) });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.patch("/rules/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const existing = deps.rules.get(c.req.param("id"));
    if (!existing) return c.json({ ok: false, error: "rule-not-found" }, 404);

    const trigger = parseTrigger(body.trigger);
    if (body.trigger !== undefined && !trigger) {
      return c.json({ ok: false, error: "trigger is invalid", field: "trigger" }, 400);
    }
    const hasNaturalLanguageCondition =
      typeof body.naturalLanguageCondition === "string";
    const naturalLanguageCondition = hasNaturalLanguageCondition
      ? (body.naturalLanguageCondition as string).trim()
      : undefined;
    const conditions = isObject(body.conditions)
      ? (body.conditions as AutomationConditions)
      : undefined;
    const hasConditionRules = Array.isArray(body.conditionRules);
    const conditionRules = hasConditionRules
      ? parseConditionRules(body.conditionRules)
      : undefined;
    const conditionMode = hasConditionRules
      ? parseConditionMode(body.conditionMode)
      : undefined;
    const actions = Array.isArray(body.actions) ? parseActions(body.actions) : undefined;
    const processing = body.processing === undefined ? undefined : parseProcessing(body.processing);
    if (body.processing !== undefined && !processing) return c.json({ ok: false, error: "processing is invalid", field: "processing" }, 400);
    if (Array.isArray(body.actions) && actions?.length !== body.actions.length) {
      return c.json({ ok: false, error: "actions contain an unsupported or invalid action", field: "actions" }, 400);
    }
    const nextTrigger = trigger ?? existing.trigger;
    const nextConditions = conditions ?? existing.conditions;
    const nextConditionRules = conditionRules ?? existing.conditionRules ?? [];
    const nextNaturalLanguageCondition = hasNaturalLanguageCondition
      ? naturalLanguageCondition
      : existing.naturalLanguageCondition;
    if (
      isAutomaticTrigger(nextTrigger) &&
      Object.keys(nextConditions).length === 0 &&
      nextConditionRules.length === 0 &&
      !nextNaturalLanguageCondition
    ) {
      return c.json(
        {
          ok: false,
          error: "automatic rules require at least one condition",
          field: "conditions",
        },
        400,
      );
    }

    deps.executionService.cancelPendingForRule(existing.id);
    const patch = {
      name: typeof body.name === "string" ? body.name : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      trigger,
      naturalLanguageCondition: hasNaturalLanguageCondition
        ? (body.naturalLanguageCondition as string)
        : undefined,
      conditions,
      conditionMode,
      conditionRules,
      processing,
      actions,
    };
    try {
      const rule = deps.ruleService
        ? deps.ruleService.updateLegacy(existing.id, {
            accountId: existing.accountId,
            name: patch.name ?? existing.name,
            enabled: patch.enabled ?? existing.enabled,
            trigger: patch.trigger ?? existing.trigger,
            naturalLanguageCondition: hasNaturalLanguageCondition ? patch.naturalLanguageCondition : existing.naturalLanguageCondition,
            conditions: patch.conditions ?? existing.conditions,
            conditionMode: patch.conditionMode ?? existing.conditionMode,
            conditionRules: patch.conditionRules ?? existing.conditionRules,
            processing: patch.processing ?? existing.processing,
            actions: patch.actions ?? existing.actions,
          })
        : deps.rules.update(existing.id, patch);
      return c.json({ ok: true, rule });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.delete("/rules/:id", (c) => {
    const id = c.req.param("id");
    deps.executionService.cancelPendingForRule(id);
    const deleted = deps.rules.delete(id);
    if (!deleted) return c.json({ ok: false, error: "rule-not-found" }, 404);
    return c.json({ ok: true });
  });

  // ── AI Suggestion ─────────────────────────────────────────────

  app.post("/rules/suggest", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!isObject(body)) {
      return c.json({ ok: false, error: "body must be an object" }, 400);
    }
    if (typeof body.accountId !== "string" || !body.accountId.trim()) {
      return c.json({ ok: false, error: "accountId is required", field: "accountId" }, 400);
    }

    const input: AutomationSuggestInput = {
      accountId: body.accountId,
      emailId: typeof body.emailId === "string" ? body.emailId : undefined,
      sender: typeof body.sender === "string" ? body.sender : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      naturalLanguageIntent:
        typeof body.naturalLanguageIntent === "string" ? body.naturalLanguageIntent : undefined,
    };

    // Must have at least one suggestion trigger
    if (!input.emailId && !input.sender && !input.category && !input.naturalLanguageIntent) {
      return c.json(
        { ok: false, error: "At least one of emailId, sender, category, or naturalLanguageIntent is required" },
        400,
      );
    }

    const suggestion = await deps.suggester.suggest(input);

    // Safety: suggestion MUST always be disabled
    if (suggestion.enabled !== false) {
      return c.json(
        { ok: false, error: "Internal safety violation: suggestion was not disabled" },
        500,
      );
    }

    return c.json({ ok: true, suggestion });
  });

  // ── Dry Run Draft (suggestion preview) ────────────────────────
  // NOTE: must be registered before /rules/:id/dry-run to avoid
  // Hono matching "suggest" as the :id parameter.

  app.post("/rules/suggest/dry-run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!isObject(body)) {
      return c.json({ ok: false, error: "body must be an object" }, 400);
    }
    if (typeof body.accountId !== "string" || !body.accountId.trim()) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    if (!isObject(body.conditions)) {
      return c.json({ ok: false, error: "conditions must be an object" }, 400);
    }
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return c.json({ ok: false, error: "actions must be a non-empty array" }, 400);
    }

    const draft = {
      id: typeof body.ruleId === "string" ? body.ruleId : `draft-${Date.now()}`,
      accountId: body.accountId as string,
      conditions: body.conditions as AutomationConditions,
      actions: body.actions.filter(isObject) as AutomationAction[],
    };

    const result = deps.dryRunner.dryRunDraft(draft, body.accountId as string);
    return c.json(result);
  });

  // ── Dry Run ───────────────────────────────────────────────────

  app.post("/rules/:id/dry-run", (c) => {
    const rule = deps.rules.get(c.req.param("id"));
    if (!rule) return c.json({ ok: false, error: "rule-not-found" }, 404);

    const accountId = c.req.query("accountId") ?? rule.accountId;
    const result = deps.dryRunner.dryRun(rule.id, accountId);

    return c.json(result);
  });

  // ── Run ───────────────────────────────────────────────────────

  app.post("/rules/:id/run", async (c) => {
    const rule = deps.rules.get(c.req.param("id"));
    if (!rule) return c.json({ ok: false, error: "rule-not-found" }, 404);

    // Disabled rules do not execute
    if (!rule.enabled) {
      deps.rules.logRun({
        ruleId: rule.id,
        accountId: rule.accountId,
        dryRun: false,
        matchedCount: 0,
        appliedCount: 0,
      });
      return c.json({ ok: true, matchedCount: 0, appliedCount: 0, disabled: true });
    }

    // Dangerous action confirmation check
    if (hasDangerousAction(rule.actions)) {
      const body = await c.req.json().catch(() => ({}));
      const confirmDangerous =
        isObject(body) && body.confirmDangerous === true;
      if (!confirmDangerous) {
        return c.json(
          {
            ok: false,
            error: "Dangerous action confirmation required",
            detail: `Rule contains dangerous actions (${rule.actions
              .filter((a) => DANGEROUS_ACTION_TYPES.has(a.type) || a.type === "external")
              .map((a) => a.type)
              .join(", ")}). Pass { confirmDangerous: true } to execute.`,
          },
          400,
        );
      }
    }

    const result = await deps.executionService.runRuleManually(rule.id);
    return c.json(result);
  });

  return app;
}

function automationTemplateConfirmationCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "automation-template-preview-not-found-or-expired") {
    return "AUTOMATION_TEMPLATE_PREVIEW_EXPIRED";
  }
  if (message === "automation-template-preview-hash-mismatch") {
    return "AUTOMATION_TEMPLATE_PREVIEW_HASH_MISMATCH";
  }
  if (message === "automation-template-already-added") {
    return "AUTOMATION_TEMPLATE_ALREADY_ADDED";
  }
  if (message === "automation-capabilities-changed") {
    return "AUTOMATION_CAPABILITIES_CHANGED";
  }
  if (message === "automation-preview-not-found-or-expired") {
    return "AUTOMATION_RULE_PREVIEW_EXPIRED";
  }
  if (message === "automation-preview-hash-mismatch") {
    return "AUTOMATION_RULE_PREVIEW_HASH_MISMATCH";
  }
  return "AUTOMATION_TEMPLATE_CONFIRMATION_FAILED";
}
