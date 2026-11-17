import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AutomationAccountScope,
  AutomationTemplateDefinition,
  AutomationTemplateSummary,
} from "../../../shared/wemail/automationCenter.js";
import type {
  AutomationProcessing,
  AutomationRuleV2,
  AutomationTrigger,
} from "../../../shared/wemail/automation.js";
import type {
  DeliveryPlan,
  ExecutionPipelineDraft,
} from "../../../shared/wemail/skillCenter.js";
import type { MailDatabase } from "../database/Database.js";
import type { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import type { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import type { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import { PipelineReviewService } from "../workflows/PipelineReviewService.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import type { PipelineAutomationRuleService } from "./PipelineAutomationRuleService.js";

const TEMPLATE_PREVIEW_TTL_MS = 15 * 60_000;
const BOT_DELIVERY_CAPABILITY = "delivery.bot.sendConnected";
const MESSAGE_CENTER_CAPABILITY = "delivery.messageCenter.publish";
const PROHIBITED_UI_KEYS =
  /script|rawhtml|network|process|filesystem|shell|command|executable/i;

export interface AutomationTemplateRegistryPaths {
  builtinRoot: string;
  personalRoot: string;
}

export function resolveAutomationTemplateRegistryPaths(input: {
  repositoryRoot: string;
  userDataDir: string;
  resourcesPath?: string;
  packaged?: boolean;
}): AutomationTemplateRegistryPaths {
  const packagedRoot = input.resourcesPath
    ? path.join(input.resourcesPath, "automation-templates", "builtin")
    : undefined;
  return {
    builtinRoot:
      input.packaged && packagedRoot && fs.existsSync(packagedRoot)
        ? packagedRoot
        : path.join(input.repositoryRoot, "automation-templates", "builtin"),
    personalRoot: path.join(
      input.userDataDir,
      "automation-templates",
      "personal",
    ),
  };
}

export class AutomationTemplateRegistryService {
  private readonly reviews: PipelineReviewService;

  constructor(
    private readonly deps: {
      db: MailDatabase;
      paths: AutomationTemplateRegistryPaths;
      drafts: ExecutionPipelineDraftRepository;
      rules: AutomationRuleRepository;
      catalog: AgentCapabilityCatalogService;
      pipeline: ExecutionPipelineService;
      now?: () => string;
    },
  ) {
    this.reviews = new PipelineReviewService(() => this.now());
  }

  async synchronize(): Promise<void> {
    fs.mkdirSync(this.deps.paths.personalRoot, { recursive: true });
    for (const source of ["builtin", "personal"] as const) {
      const root =
        source === "builtin"
          ? this.deps.paths.builtinRoot
          : this.deps.paths.personalRoot;
      if (!fs.existsSync(root)) continue;
      for (const file of findTemplateFiles(root)) {
        const definition = this.readDefinition(file, source);
        this.installVersion(definition, source);
      }
    }
  }

  async list(
    locale = "zh-CN",
    accountId?: string,
  ): Promise<AutomationTemplateSummary[]> {
    const capabilities = new Map(
      (await this.deps.catalog.list()).map((item) => [item.id, item]),
    );
    const rows = this.deps.db
      .prepare(`
        SELECT v.manifest_json
          FROM automation_template_versions v
          JOIN automation_template_packages p ON p.id = v.template_id
         WHERE v.version = p.active_version
         ORDER BY v.template_id
      `)
      .all() as Array<{ manifest_json: string }>;
    return rows.map((row) => {
      const definition = JSON.parse(
        row.manifest_json,
      ) as AutomationTemplateDefinition;
      const metadata =
        definition.metadata.locales[locale] ??
        definition.metadata.locales[definition.metadata.fallbackLocale] ??
        Object.values(definition.metadata.locales)[0]!;
      const unavailable = definition.pipelineBlueprint.steps
        .map((step) => capabilities.get(step.capabilityId))
        .find((capability) => capability?.availability.state !== "ready");
      const canFallbackToMessageCenter =
        unavailable?.id === BOT_DELIVERY_CAPABILITY &&
        definition.pipelineBlueprint.steps.some(
          (step) => step.capabilityId === BOT_DELIVERY_CAPABILITY,
        ) &&
        capabilities.get(MESSAGE_CENTER_CAPABILITY)?.availability.state ===
          "ready";
      const installed = accountId
        ? !!this.deps.db
            .prepare(
              `SELECT id FROM automation_rules
                WHERE template_id = ? AND archived_at IS NULL
                  AND (account_id = ? OR owner_type = 'local_profile')
                LIMIT 1`,
            )
            .get(definition.id, accountId)
        : false;
      return {
        id: definition.id,
        version: definition.version,
        name: metadata.name,
        description: metadata.description,
        icon: metadata.icon,
        category: metadata.category,
        defaultTiming: summarizeDefaultTiming(
          definition.defaultTrigger,
          definition.id,
        ),
        readiness:
          unavailable && !canFallbackToMessageCenter ? "needs_setup" : "ready",
        readinessMessage: unavailable?.availability.reason,
        installed,
      };
    });
  }

  inspect(id: string, version?: string): AutomationTemplateDefinition | null {
    const row = version
      ? this.deps.db
          .prepare(
            `SELECT manifest_json FROM automation_template_versions
              WHERE template_id = ? AND version = ?`,
          )
          .get(id, version)
      : this.deps.db
          .prepare(
            `SELECT v.manifest_json
               FROM automation_template_versions v
               JOIN automation_template_packages p ON p.id = v.template_id
                AND p.active_version = v.version
              WHERE v.template_id = ?`,
          )
          .get(id);
    return row
      ? (JSON.parse((row as { manifest_json: string }).manifest_json) as
          AutomationTemplateDefinition)
      : null;
  }

  validateConfiguration(
    definition: AutomationTemplateDefinition,
    configuration: Record<string, unknown>,
  ): Array<{ path: string; code: string; message: string }> {
    const schema = definition.configurationSchema;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    const issues: Array<{ path: string; code: string; message: string }> = [];
    for (const key of required) {
      if (configuration[key] === undefined) {
        issues.push({
          path: key,
          code: "required",
          message: `${key} 为必填项。`,
        });
      }
    }
    for (const [key, value] of Object.entries(configuration)) {
      const property = properties[key];
      if (!property) {
        if (schema.additionalProperties === false) {
          issues.push({
            path: key,
            code: "unknown-property",
            message: `${key} 不是可配置项。`,
          });
        }
        continue;
      }
      if (!matchesType(value, property.type)) {
        issues.push({
          path: key,
          code: "invalid-type",
          message: `${key} 的数据类型不正确。`,
        });
      }
      if (
        typeof value === "number" &&
        typeof property.minimum === "number" &&
        value < property.minimum
      ) {
        issues.push({
          path: key,
          code: "below-minimum",
          message: `${key} 不能小于 ${property.minimum}。`,
        });
      }
      if (
        typeof value === "number" &&
        typeof property.maximum === "number" &&
        value > property.maximum
      ) {
        issues.push({
          path: key,
          code: "above-maximum",
          message: `${key} 不能大于 ${property.maximum}。`,
        });
      }
    }
    return issues.slice(0, 20);
  }

  async previewInstantiation(input: {
    templateId: string;
    version?: string;
    accountId: string;
    configuration: Record<string, unknown>;
  }): Promise<{
    previewId: string;
    previewHash: string;
    draft: ExecutionPipelineDraft;
    expiresAt: string;
  }> {
    const definition = this.inspect(input.templateId, input.version);
    if (!definition) throw new Error("automation-template-not-found");
    const configuration = {
      ...definition.defaultConfiguration,
      ...input.configuration,
    };
    const issues = this.validateConfiguration(definition, configuration);
    if (issues.length > 0) {
      throw new Error(
        `automation-template-configuration-invalid:${issues
          .map((issue) => `${issue.path}:${issue.code}`)
          .join(",")}`,
      );
    }
    const draft = await this.compileDraft(
      definition,
      input.accountId,
      configuration,
    );
    return this.persistPreview(definition, input.accountId, configuration, draft);
  }

  async previewUpgrade(input: {
    ruleId: string;
    accountId: string;
  }): Promise<{
    previewId: string;
    previewHash: string;
    draft: ExecutionPipelineDraft;
    expiresAt: string;
    upgrade: ReturnType<AutomationTemplateRegistryService["upgradeFor"]>;
  }> {
    const rule = this.deps.rules.getV2(input.ruleId);
    if (!rule) throw new Error("automation-rule-not-found");
    const upgrade = this.upgradeFor(rule);
    if (!upgrade.available || !upgrade.targetVersion || !rule.templateBinding) {
      throw new Error("automation-template-upgrade-not-available");
    }
    const definition = this.inspect(
      rule.templateBinding.templateId,
      upgrade.targetVersion,
    );
    if (!definition) throw new Error("automation-template-not-found");
    const configuration = {
      ...definition.defaultConfiguration,
      ...rule.templateBinding.configuration,
    };
    const issues = this.validateConfiguration(definition, configuration);
    if (issues.length > 0) {
      throw new Error(
        `automation-template-configuration-invalid:${issues
          .map((issue) => `${issue.path}:${issue.code}`)
          .join(",")}`,
      );
    }
    const draft = await this.compileDraft(
      definition,
      input.accountId,
      configuration,
    );
    draft.sourceRuleId = rule.id;
    draft.sourceRuleVersion = rule.version;
    draft.owner = rule.owner;
    draft.accountScope = rule.accountScope;
    const preview = this.persistPreview(
      definition,
      input.accountId,
      configuration,
      draft,
    );
    return { ...preview, upgrade };
  }

  listRuleVersions(ruleId: string): Array<{
    version: number;
    templateVersion?: string;
    createdAt: string;
    current: boolean;
  }> {
    const current = this.deps.rules.getV2(ruleId);
    if (!current) throw new Error("automation-rule-not-found");
    return (
      this.deps.db
        .prepare(
          `SELECT version, template_version, created_at
             FROM automation_rule_versions
            WHERE rule_id = ?
            ORDER BY version DESC
            LIMIT 30`,
        )
        .all(ruleId) as Array<{
        version: number;
        template_version: string | null;
        created_at: string;
      }>
    ).map((row) => ({
      version: row.version,
      templateVersion: row.template_version ?? undefined,
      createdAt: row.created_at,
      current: row.version === current.version,
    }));
  }

  private persistPreview(
    definition: AutomationTemplateDefinition,
    accountId: string,
    configuration: Record<string, unknown>,
    draft: ExecutionPipelineDraft,
  ): {
    previewId: string;
    previewHash: string;
    draft: ExecutionPipelineDraft;
    expiresAt: string;
  } {
    const previewId = `automation-template-preview-${randomUUID()}`;
    const previewHash = contentHash({
      definition: definition.contentHash,
      configuration,
      draft,
    });
    const createdAt = this.now();
    const expiresAt = new Date(
      Date.parse(createdAt) + TEMPLATE_PREVIEW_TTL_MS,
    ).toISOString();
    this.deps.db.prepare(`
      INSERT INTO automation_template_previews (
        id, account_id, template_id, template_version, template_hash,
        configuration_json, draft_json, preview_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      previewId,
      accountId,
      definition.id,
      definition.version,
      definition.contentHash,
      JSON.stringify(configuration),
      JSON.stringify(draft),
      previewHash,
      createdAt,
      expiresAt,
    );
    return { previewId, previewHash, draft, expiresAt };
  }

  confirmInstantiation(input: {
    previewId: string;
    previewHash: string;
    accountId: string;
  }): ExecutionPipelineDraft {
    const row = this.deps.db
      .prepare(
        `SELECT * FROM automation_template_previews
          WHERE id = ? AND account_id = ?`,
      )
      .get(input.previewId, input.accountId) as
      | {
          preview_hash: string;
          draft_json: string;
          expires_at: string;
        }
      | undefined;
    if (!row || row.expires_at <= this.now()) {
      throw new Error("automation-template-preview-not-found-or-expired");
    }
    if (row.preview_hash !== input.previewHash) {
      throw new Error("automation-template-preview-hash-mismatch");
    }
    const draft = JSON.parse(row.draft_json) as ExecutionPipelineDraft;
    return this.deps.drafts.create(draft);
  }

  async instantiate(input: {
    previewId: string;
    previewHash: string;
    accountId: string;
    locale?: string;
    ruleService: PipelineAutomationRuleService;
  }): Promise<AutomationRuleV2> {
    const draft = this.confirmedPreviewDraft(input);
    const binding = draft.templateBinding;
    if (!binding) throw new Error("automation-template-binding-missing");
    const existing = this.deps.db
      .prepare(
        `SELECT id FROM automation_rules
          WHERE template_id = ? AND archived_at IS NULL
            AND (account_id = ? OR owner_type = 'local_profile')
          LIMIT 1`,
      )
      .get(binding.templateId, input.accountId) as { id: string } | undefined;
    if (existing) throw new Error("automation-template-already-added");

    const definition = this.inspect(
      binding.templateId,
      binding.templateVersion,
    );
    if (!definition) throw new Error("automation-template-not-found");
    const metadata =
      definition.metadata.locales[input.locale ?? "zh-CN"] ??
      definition.metadata.locales[definition.metadata.fallbackLocale] ??
      Object.values(definition.metadata.locales)[0]!;
    const compiled = await this.deps.pipeline.compile(draft);
    if (!compiled.trigger) throw new Error("automation-trigger-required");
    const preview = await input.ruleService.preview({
      schemaVersion: 2,
      accountId: draft.accountId,
      name: metadata.name,
      description: metadata.description,
      enabled: true,
      owner: draft.owner,
      accountScope: draft.accountScope,
      templateBinding: binding,
      trigger: compiled.trigger,
      conditions: {},
      collection: collectionFrom(draft),
      pipeline: compiled.pipeline,
      skillSnapshots: draft.skillSnapshots,
      dataSelectionRecipe: draft.dataSelection,
      analysisRecipe: draft.analysis,
      artifactRecipe: draft.artifact,
      deliveryPlan: draft.delivery,
      acceptedReviews: [],
      compiledPipelineHash: compiled.hash,
    });
    return input.ruleService.commit({
      accountId: draft.accountId,
      previewId: preview.previewId,
      ruleHash: preview.ruleHash,
    });
  }

  private confirmedPreviewDraft(input: {
    previewId: string;
    previewHash: string;
    accountId: string;
  }): ExecutionPipelineDraft {
    const row = this.deps.db
      .prepare(
        `SELECT preview_hash, draft_json, expires_at
           FROM automation_template_previews
          WHERE id = ? AND account_id = ?`,
      )
      .get(input.previewId, input.accountId) as
      | {
          preview_hash: string;
          draft_json: string;
          expires_at: string;
        }
      | undefined;
    if (!row || row.expires_at <= this.now()) {
      throw new Error("automation-template-preview-not-found-or-expired");
    }
    if (row.preview_hash !== input.previewHash) {
      throw new Error("automation-template-preview-hash-mismatch");
    }
    return JSON.parse(row.draft_json) as ExecutionPipelineDraft;
  }

  installPersonal(
    definition: AutomationTemplateDefinition,
  ): AutomationTemplateDefinition {
    validateDefinition(definition, "personal");
    const protectedBuiltin = this.deps.db
      .prepare(
        `SELECT manifest_json FROM automation_template_versions
          WHERE template_id = ? AND source = 'builtin' LIMIT 1`,
      )
      .get(definition.id) as { manifest_json: string } | undefined;
    if (protectedBuiltin) {
      const builtin = JSON.parse(
        protectedBuiltin.manifest_json,
      ) as AutomationTemplateDefinition;
      if (builtin.protected !== false) {
        throw new Error("automation-template-protected-id");
      }
    }
    const computed = definitionHash(definition);
    if (computed !== definition.contentHash) {
      throw new Error("automation-template-content-hash-mismatch");
    }
    const directory = path.join(
      this.deps.paths.personalRoot,
      safeSegment(definition.id),
      safeSegment(definition.version),
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "template.json"),
      `${JSON.stringify(definition, null, 2)}\n`,
      "utf8",
    );
    this.installVersion(definition, "personal");
    return definition;
  }

  async saveWorkflowAsTemplate(input: {
    draft: ExecutionPipelineDraft;
    id: string;
    version: string;
    name: string;
    description: string;
  }): Promise<AutomationTemplateDefinition> {
    const base: AutomationTemplateDefinition = {
      schemaVersion: 1,
      id: input.id,
      version: input.version,
      scope: "personal",
      metadata: {
        fallbackLocale: "zh-CN",
        locales: {
          "zh-CN": {
            name: input.name,
            description: input.description,
          },
        },
      },
      configurationSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      uiSchema: { version: 1, fields: [] },
      pipelineBlueprint: {
        version: 1,
        steps: input.draft.steps.map((step) => ({
          ...step,
          input: sanitizeObject(step.input),
        })),
        bindings: {},
        analysis: input.draft.analysis,
        artifact: input.draft.artifact,
        delivery: input.draft.delivery,
      },
      resultSchemaId:
        input.draft.templateBinding?.resultSchemaId ?? "wemail.generic",
      resultSchemaVersion:
        input.draft.templateBinding?.resultSchemaVersion ?? 1,
      rendererId:
        input.draft.templateBinding?.rendererId ?? "wemail.generic",
      rendererVersion:
        input.draft.templateBinding?.rendererVersion ?? "1.0.0",
      defaultConfiguration: {},
      contentHash: "",
    };
    base.contentHash = definitionHash(base);
    return this.installPersonal(base);
  }

  upgradeFor(rule: AutomationRuleV2) {
    if (!rule.templateBinding) return { available: false, requiresPreview: true };
    const active = this.inspect(rule.templateBinding.templateId);
    if (!active || active.version === rule.templateBinding.templateVersion) {
      return {
        available: false,
        currentVersion: rule.templateBinding.templateVersion,
        requiresPreview: true,
      };
    }
    return {
      available: true,
      currentVersion: rule.templateBinding.templateVersion,
      targetVersion: active.version,
      targetHash: active.contentHash,
      summary: semanticTemplateDiff(
        this.inspect(
          rule.templateBinding.templateId,
          rule.templateBinding.templateVersion,
        ),
        active,
      ),
      requiresPreview: true,
    };
  }

  rollbackRule(ruleId: string, targetVersion: number): AutomationRuleV2 {
    const current = this.deps.rules.getV2(ruleId);
    if (!current) throw new Error("automation-rule-not-found");
    const row = this.deps.db
      .prepare(
        `SELECT rule_json FROM automation_rule_versions
          WHERE rule_id = ? AND version = ?`,
      )
      .get(ruleId, targetVersion) as { rule_json: string } | undefined;
    if (!row) throw new Error("automation-rule-version-not-found");
    const historical = JSON.parse(row.rule_json) as AutomationRuleV2;
    return this.deps.rules.replaceV2(
      ruleId,
      historical,
      current.version,
    );
  }

  private readDefinition(
    file: string,
    source: "builtin" | "personal",
  ): AutomationTemplateDefinition {
    const definition = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as AutomationTemplateDefinition;
    validateDefinition(definition, source);
    const computed = definitionHash(definition);
    if (computed !== definition.contentHash) {
      throw new Error(
        `automation-template-content-hash-mismatch:${definition.id}@${definition.version}`,
      );
    }
    return definition;
  }

  private installVersion(
    definition: AutomationTemplateDefinition,
    source: "builtin" | "personal",
  ): void {
    const existing = this.deps.db
      .prepare(
        `SELECT content_hash FROM automation_template_versions
          WHERE template_id = ? AND version = ?`,
      )
      .get(definition.id, definition.version) as
      | { content_hash: string }
      | undefined;
    if (existing && existing.content_hash !== definition.contentHash) {
      throw new Error(
        `automation-template-version-tampered:${definition.id}@${definition.version}`,
      );
    }
    const now = this.now();
    this.deps.db.transaction(() => {
      this.deps.db.prepare(`
        INSERT INTO automation_template_packages (
          id, source, active_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at
      `).run(definition.id, source, definition.version, now, now);
      this.deps.db.prepare(`
        INSERT INTO automation_template_versions (
          template_id, version, source, manifest_json, content_hash,
          compatibility_json, active, created_at
        ) VALUES (?, ?, ?, ?, ?, '{}', 0, ?)
        ON CONFLICT(template_id, version) DO NOTHING
      `).run(
        definition.id,
        definition.version,
        source,
        JSON.stringify(definition),
        definition.contentHash,
        now,
      );
      const versions = (
        this.deps.db
          .prepare(
            `SELECT version FROM automation_template_versions
              WHERE template_id = ?`,
          )
          .all(definition.id) as Array<{ version: string }>
      ).map((row) => row.version);
      const activeVersion = versions.sort(compareSemver).at(-1)!;
      this.deps.db
        .prepare(
          `UPDATE automation_template_packages
              SET active_version = ?, updated_at = ? WHERE id = ?`,
        )
        .run(activeVersion, now, definition.id);
      this.deps.db.prepare(`
        UPDATE automation_template_versions
           SET active = CASE
             WHEN version = (
               SELECT active_version FROM automation_template_packages
                WHERE id = ?
             ) THEN 1 ELSE 0 END
         WHERE template_id = ?
      `).run(definition.id, definition.id);
    })();
  }

  private async compileDraft(
    definition: AutomationTemplateDefinition,
    accountId: string,
    configuration: Record<string, unknown>,
  ): Promise<ExecutionPipelineDraft> {
    const timestamp = this.now();
    const trigger = resolveTrigger(definition, configuration);
    const accountScope = resolveAccountScope(configuration.accountScope, accountId);
    const resolvedDelivery = resolveDelivery(
      configuration.delivery,
      definition.pipelineBlueprint.delivery ?? definition.defaultDelivery,
    );
    const capabilities = await this.deps.catalog.list();
    const connectedBotReady = capabilities.some(
      (capability) =>
        capability.id === BOT_DELIVERY_CAPABILITY &&
        capability.availability.state === "ready",
    );
    const hasBotStep = definition.pipelineBlueprint.steps.some(
      (step) => step.capabilityId === BOT_DELIVERY_CAPABILITY,
    );
    const messageCenterReady =
      capabilities.find((capability) => capability.id === MESSAGE_CENTER_CAPABILITY)
        ?.availability.state === "ready";
    const fallbackToMessageCenter =
      !connectedBotReady && hasBotStep && messageCenterReady;
    // A Bot-only template can still be installed before channel setup. Keep the
    // rule executable by replacing the unavailable Bot step with local delivery.
    const delivery = resolvedDelivery
      ? resolveDeliveryForCapabilities(
          resolvedDelivery,
          !connectedBotReady,
          fallbackToMessageCenter,
        )
      : resolvedDelivery;
    const effectiveConfiguration = delivery
      ? { ...configuration, delivery }
      : configuration;
    const templateSteps = definition.pipelineBlueprint.steps.map((step) => ({
      ...step,
      input: { ...step.input },
      onError: { ...step.onError },
    }));
    const steps = fallbackToMessageCenter
      ? withMessageCenterFallback(
          templateSteps.filter(
            (step) => step.capabilityId !== BOT_DELIVERY_CAPABILITY,
          ),
        )
      : templateSteps;
    let draft: ExecutionPipelineDraft = {
      id: `pipeline-${randomUUID()}`,
      accountId,
      owner:
        accountScope.type === "currentAccount"
          ? { type: "account", accountId }
          : { type: "localProfile", profileId: "default" },
      accountScope,
      templateBinding: {
        templateId: definition.id,
        templateVersion: definition.version,
        templateHash: definition.contentHash,
        resultSchemaId: definition.resultSchemaId,
        resultSchemaVersion: definition.resultSchemaVersion,
        rendererId: definition.rendererId,
        rendererVersion: definition.rendererVersion,
        configuration: effectiveConfiguration,
      },
      templateConfiguration: effectiveConfiguration,
      revision: 1,
      mode: "automation",
      trigger,
      dataSelection: {
        version: 1,
        source: "mail",
        scope: templateDataSelectionScope(definition.id, configuration),
        filters: [],
        limits: {
          maxMessages:
            typeof configuration.maxMessages === "number"
              ? Math.floor(configuration.maxMessages)
              : 200,
        },
      },
      analysis: definition.pipelineBlueprint.analysis,
      artifact: definition.pipelineBlueprint.artifact,
      delivery,
      steps,
      skillSnapshots: [],
      capabilitySnapshots: [],
      reviews: [],
      validation: { status: "not_validated", issues: [] },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (
      definition.id === "subscription-daily-insight" &&
      connectedBotReady &&
      delivery?.destinations.some(
        (destination) =>
          destination.type === "connected_bot" && destination.enabled,
      ) &&
      !draft.steps.some(
        (step) => step.capabilityId === BOT_DELIVERY_CAPABILITY,
      )
    ) {
      draft.steps.push({
        id: "subscription-insight-bot",
        capabilityId: BOT_DELIVERY_CAPABILITY,
        name: "仅在有风险或可处理建议时通知已连接 Bot",
        input: {
          value: {
            type: "path",
            from: "step",
            stepId: "subscription-insight",
            path: "",
          },
          notificationPolicy: {
            type: "literal",
            value: "risk_or_actionable",
          },
          policy: { type: "literal", value: "all_available" },
        },
        outputKind: "delivery-receipt",
        onError: { policy: "continue", retries: 1 },
      });
    }
    const selected = new Set(draft.steps.map((step) => step.capabilityId));
    draft.capabilitySnapshots = capabilities
      .filter((capability) => selected.has(capability.id))
      .map((capability) => ({
        capabilityId: capability.id,
        version: capability.version,
        fingerprint: capability.fingerprint,
        availabilityAtPreview: capability.availability.state,
        risk: capability.risk,
      }));
    draft.validation = await this.deps.pipeline.validate(draft);
    draft = this.reviews.synchronizeCheckpoints(draft);
    return JSON.parse(JSON.stringify(draft)) as ExecutionPipelineDraft;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}

export function definitionHash(
  definition: AutomationTemplateDefinition,
): string {
  const copy = { ...definition, contentHash: undefined };
  return contentHash(copy);
}

function validateDefinition(
  definition: AutomationTemplateDefinition,
  source: "builtin" | "personal",
): void {
  if (
    definition.schemaVersion !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(definition.id) ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(definition.version)
  ) {
    throw new Error("automation-template-manifest-invalid");
  }
  if (definition.scope !== source) {
    throw new Error("automation-template-source-mismatch");
  }
  if (
    !definition.metadata.locales[definition.metadata.fallbackLocale] ||
    !Array.isArray(definition.uiSchema.fields) ||
    !Array.isArray(definition.pipelineBlueprint.steps)
  ) {
    throw new Error("automation-template-manifest-invalid");
  }
  const properties =
    definition.configurationSchema.properties &&
    typeof definition.configurationSchema.properties === "object"
      ? (definition.configurationSchema.properties as Record<string, unknown>)
      : {};
  for (const field of definition.uiSchema.fields) {
    if (
      PROHIBITED_UI_KEYS.test(field.path) ||
      PROHIBITED_UI_KEYS.test(field.control) ||
      !Object.prototype.hasOwnProperty.call(properties, field.path)
    ) {
      throw new Error(`automation-template-ui-schema-invalid:${field.path}`);
    }
  }
  for (const step of definition.pipelineBlueprint.steps) {
    const value = step as unknown as Record<string, unknown>;
    if (
      typeof step.capabilityId !== "string" ||
      "provider" in value ||
      "executor" in value ||
      "script" in value
    ) {
      throw new Error(`automation-template-blueprint-invalid:${step.id}`);
    }
  }
  if (
    !definition.resultSchemaId ||
    !definition.rendererId ||
    !definition.rendererVersion
  ) {
    throw new Error("automation-template-result-binding-invalid");
  }
}

function collectionFrom(
  draft: ExecutionPipelineDraft,
): AutomationProcessing | undefined {
  const selection = draft.dataSelection;
  if (!selection) return undefined;
  if (
    selection.scope.type === "current_mail" ||
    selection.scope.type === "current_thread"
  ) {
    return { mode: "perMessage" };
  }
  const scope =
    selection.scope.type === "calendar_day"
      ? {
          type: "calendarDay" as const,
          timezone: selection.scope.timezone,
          limit: selection.limits.maxMessages,
        }
      : selection.scope.type === "rolling_window"
        ? {
            type: "rollingWindow" as const,
            amount: selection.scope.amount,
            unit: selection.scope.unit,
            limit: selection.limits.maxMessages,
          }
        : selection.scope.type === "previous_schedule_window"
          ? {
              type: "previousScheduleWindow" as const,
              ...(selection.scope.maxLookback
                ? { maxLookback: selection.scope.maxLookback }
                : {}),
              limit: selection.limits.maxMessages,
            }
          : undefined;
  return { mode: "collection", ...(scope ? { scope } : {}) };
}

function templateDataSelectionScope(
  templateId: string,
  configuration: Record<string, unknown>,
): NonNullable<ExecutionPipelineDraft["dataSelection"]>["scope"] {
  if (templateId !== "subscription-daily-insight") {
    return { type: "rolling_window", amount: 1, unit: "day" };
  }
  const windowHours =
    typeof configuration.windowHours === "number"
      ? Math.max(1, Math.min(168, Math.floor(configuration.windowHours)))
      : 24;
  switch (configuration.dataWindowMode) {
    case "rollingWindow":
      return { type: "rolling_window", amount: windowHours, unit: "hour" };
    case "previousRun":
      return { type: "previous_schedule_window" };
    case "calendarDay":
      return {
        type: "calendar_day",
        timezone:
          typeof configuration.timezone === "string"
            ? configuration.timezone
            : "Asia/Shanghai",
      };
    default:
      return {
        type: "previous_schedule_window",
        maxLookback: { amount: windowHours, unit: "hour" },
      };
  }
}

function findTemplateFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "template.json") files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

function resolveTrigger(
  definition: AutomationTemplateDefinition,
  configuration: Record<string, unknown>,
): ExecutionPipelineDraft["trigger"] {
  const trigger = definition.defaultTrigger;
  if (trigger?.type === "scheduled") {
    return {
      event: "schedule",
      timing: {
        type: "daily",
        localTime:
          typeof configuration.localTime === "string"
            ? configuration.localTime
            : trigger.schedule?.type === "daily"
              ? trigger.schedule.localTime
              : "08:30",
        timezone:
          typeof configuration.timezone === "string"
            ? configuration.timezone
            : trigger.schedule?.type === "daily"
              ? trigger.schedule.timezone
              : "Asia/Shanghai",
      },
    };
  }
  if (trigger?.type === "mailReceived") {
    return {
      event: "mail.received",
      timing: { ...(trigger.execution ?? { type: "immediate" }) },
    };
  }
  return { event: "manual", timing: { type: "immediate" } };
}

function resolveAccountScope(
  value: unknown,
  accountId: string,
): AutomationAccountScope {
  if (value && typeof value === "object") {
    const scope = value as Record<string, unknown>;
    if (
      (scope.type === "selectedAccounts" ||
        scope.type === "selected_accounts") &&
      Array.isArray(scope.accountIds)
    ) {
      const accountIds = scope.accountIds.filter(
        (item): item is string => typeof item === "string" && !!item,
      );
      if (accountIds.length > 0) {
        return { type: "selectedAccounts", accountIds };
      }
    }
    if (
      scope.type === "allConnectedAccounts" ||
      scope.type === "all_connected_accounts"
    ) {
      return { type: "allConnectedAccounts" };
    }
  }
  return { type: "currentAccount", accountId };
}

function resolveDelivery(
  value: unknown,
  fallback: DeliveryPlan | undefined,
): DeliveryPlan | undefined {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.destinations)) {
      return {
        version: 1,
        destinations: record.destinations
          .filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === "object" && !Array.isArray(item),
          )
          .map((item) => ({
            type: normalizeDestination(item.type),
            destinationId:
              typeof item.destinationId === "string"
                ? item.destinationId
                : undefined,
            enabled: item.enabled !== false,
          })),
        content: {
          includeSummary: true,
          includeImage: true,
          includeArtifactLink: true,
        },
        fallbackPolicy: {
          type: "first_available",
          priority: ["feishu_bot", "wecom_bot"],
          messageCenterRequired: true,
        },
      };
    }
  }
  return fallback;
}

function resolveDeliveryForCapabilities(
  delivery: DeliveryPlan,
  disableBotDestinations: boolean,
  fallbackToMessageCenter: boolean,
): DeliveryPlan {
  let hasEnabledMessageCenter = false;
  const destinations = delivery.destinations.map((destination) => {
    if (fallbackToMessageCenter && destination.type === "message_center") {
      hasEnabledMessageCenter = true;
      return { ...destination, enabled: true };
    }
    if (disableBotDestinations && isBotDestination(destination.type)) {
      return { ...destination, enabled: false };
    }
    return { ...destination };
  });
  if (fallbackToMessageCenter && !hasEnabledMessageCenter) {
    destinations.push({ type: "message_center", enabled: true });
  }
  return {
    ...delivery,
    destinations,
    ...(fallbackToMessageCenter
      ? {
          fallbackPolicy: {
            ...delivery.fallbackPolicy,
            type: "continue" as const,
            messageCenterRequired: true,
          },
        }
      : {}),
  };
}

function isBotDestination(
  type: DeliveryPlan["destinations"][number]["type"],
): boolean {
  return type === "connected_bot" || type === "feishu_bot" || type === "wecom_bot";
}

function withMessageCenterFallback(
  steps: ExecutionPipelineDraft["steps"],
): ExecutionPipelineDraft["steps"] {
  if (steps.some((step) => step.capabilityId === MESSAGE_CENTER_CAPABILITY)) {
    return steps;
  }
  return [
    ...steps,
    {
      id: "message-center",
      capabilityId: MESSAGE_CENTER_CAPABILITY,
      name: "发布到消息中心",
      input: {
        title: {
          type: "path",
          from: "trigger",
          path: "notificationTitle",
        },
        preview: {
          type: "path",
          from: "trigger",
          path: "notificationBody",
        },
      },
      outputKind: "delivery-receipt",
      onError: { policy: "continue", retries: 1 },
    },
  ];
}

function normalizeDestination(
  value: unknown,
): DeliveryPlan["destinations"][number]["type"] {
  return value === "conversation" ||
    value === "message_center" ||
    value === "feishu_bot" ||
    value === "wecom_bot" ||
    value === "connected_bot"
    ? value
    : "message_center";
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  return true;
}

function summarizeDefaultTiming(
  trigger: AutomationTrigger | undefined,
  templateId?: string,
): string | undefined {
  if (!trigger || trigger.type === "manual") return "手动运行";
  if (trigger.type === "mailReceived") {
    return templateId === "wemail.received-mail-summary-notification"
      ? "每收到一封邮件 · 摘要完成后"
      : "每收到一封邮件";
  }
  return trigger.schedule?.type === "daily"
    ? `每天 ${trigger.schedule.localTime}`
    : trigger.schedule?.type === "interval"
      ? `每 ${trigger.schedule.intervalMinutes} 分钟`
      : trigger.intervalMinutes
        ? `每 ${trigger.intervalMinutes} 分钟`
        : "定时运行";
}

function semanticTemplateDiff(
  current: AutomationTemplateDefinition | null,
  target: AutomationTemplateDefinition,
): string[] {
  if (!current) return [`升级到 ${target.version}`];
  const changes: string[] = [];
  if (
    stable(current.configurationSchema) !== stable(target.configurationSchema)
  ) {
    changes.push("可配置项发生变化");
  }
  if (
    stable(current.pipelineBlueprint.steps) !==
    stable(target.pipelineBlueprint.steps)
  ) {
    changes.push("处理流程发生变化");
  }
  if (
    current.rendererId !== target.rendererId ||
    current.rendererVersion !== target.rendererVersion
  ) {
    changes.push("结果展示方式发生变化");
  }
  return changes.length > 0 ? changes : ["模板实现更新"];
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/body|html|token|secret|password|credential|path/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]),
  );
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[bounded]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>);
  }
  return typeof value === "string" ? value.slice(0, 2_000) : value;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split("-", 1)[0]!
      .split(".")
      .map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}
