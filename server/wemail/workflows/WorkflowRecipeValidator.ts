import type {
  AnalysisRecipe,
  AgentCapabilityDescriptor,
  ArtifactRecipe,
  DataSelectionSpec,
  DeliveryPlan,
  ExecutionPipelineDraft,
  PipelineValidationState,
} from "../../../shared/wemail/skillCenter.js";
import { compileDataSelectionFilters } from "./DataSelectionRuntime.js";

type Issue = PipelineValidationState["issues"][number];

/**
 * Validate the structured recipes that Skills ask the model to produce.
 * Capability validation alone only checks value kinds; these checks protect
 * the domain-specific contracts before a preview or external side effect.
 */
export function validateWorkflowRecipes(draft: ExecutionPipelineDraft): Issue[] {
  const issues: Issue[] = [];
  try {
    if (draft.dataSelection) validateDataSelection(draft.dataSelection, issues);
    if (draft.analysis) validateAnalysis(draft.analysis, issues);
    if (draft.artifact) validateArtifact(draft.artifact, issues);
    if (draft.delivery) validateDelivery(draft.delivery, issues);
  } catch (error) {
    issues.push(issue(
      "recipes",
      "recipe-contract-invalid",
      error instanceof Error ? `配方结构无效：${error.message}` : "配方结构无效。",
    ));
  }
  return issues;
}

export function validateAnalysisRecipe(recipe: AnalysisRecipe): Issue[] {
  const issues: Issue[] = [];
  validateAnalysis(recipe, issues);
  return issues;
}

/**
 * Recipes are durable user intent, while steps are what actually execute.
 * Reject drafts where those two views drift apart so a reviewed recipe can
 * never be committed as dead metadata.
 */
export function validateWorkflowRecipeCoverage(
  draft: ExecutionPipelineDraft,
  capabilities: Map<string, AgentCapabilityDescriptor>,
): Issue[] {
  const issues: Issue[] = [];
  const steps = draft.steps.map((step) => ({
    step,
    capability: capabilities.get(step.capabilityId),
  }));

  if (draft.analysis) {
    const analysisSteps = steps.filter(
      ({ capability }) => capability?.category === "analysis",
    );
    if (analysisSteps.length === 0) {
      issues.push(issue(
        "analysis",
        "analysis-step-required",
        "分析配方必须由至少一个可执行分析步骤实现。",
      ));
    }
    const requiresModel =
      draft.analysis.modelTasks.length > 0 ||
      draft.analysis.conclusions.length > 0;
    if (
      requiresModel &&
      !analysisSteps.some(
        ({ capability }) => capability?.metadata?.supportsModelTasks === true,
      )
    ) {
      issues.push(issue(
        "analysis.modelTasks",
        "model-task-step-required",
        "模型任务必须由明确支持分析配方的执行步骤实现。",
      ));
    }
    const declaredFields = new Set(
      analysisSteps.flatMap(({ capability }) => {
        const fields = capability?.outputSchema.fields;
        return Array.isArray(fields)
          ? fields.filter((field): field is string => typeof field === "string")
          : [];
      }),
    );
    if (declaredFields.size > 0) {
      const bindings = [
        ...draft.analysis.dimensions.map((dimension) => ({
          path: `analysis.dimensions.${dimension.id}`,
          field: dimension.field,
        })),
        ...draft.analysis.metrics.flatMap((metric) => [
          metric.field
            ? { path: `analysis.metrics.${metric.id}.field`, field: metric.field }
            : undefined,
          metric.numeratorField
            ? { path: `analysis.metrics.${metric.id}.numeratorField`, field: metric.numeratorField }
            : undefined,
          metric.denominatorField
            ? { path: `analysis.metrics.${metric.id}.denominatorField`, field: metric.denominatorField }
            : undefined,
        ]),
      ].filter((binding): binding is { path: string; field: string } => !!binding);
      for (const binding of bindings) {
        if (!declaredFields.has(binding.field)) {
          issues.push(issue(
            binding.path,
            "analysis-field-unavailable",
            `分析步骤不会生成字段：${binding.field}。`,
          ));
        }
      }
    }
  }

  if (draft.artifact) {
    const outputSteps = steps.filter(
      ({ capability }) => capability?.category === "output",
    );
    if (outputSteps.length === 0) {
      issues.push(issue(
        "artifact",
        "artifact-step-required",
        "产物配方必须由至少一个可执行产物步骤实现。",
      ));
    }
  }

  if (draft.delivery) {
    const enabled = draft.delivery.destinations.filter(
      (destination) => destination.enabled,
    );
    const deliverySteps = steps.filter(
      ({ capability }) => capability?.category === "delivery",
    );
    const capabilityIds = new Set(
      deliverySteps.map(({ step }) => step.capabilityId),
    );
    if (
      enabled.some((destination) => destination.type === "message_center") &&
      !capabilityIds.has("delivery.messageCenter.publish")
    ) {
      issues.push(issue(
        "delivery.destinations",
        "message-center-step-required",
        "启用消息中心投递时必须包含对应的可执行步骤。",
      ));
    }
    if (
      enabled.some((destination) =>
        destination.type === "connected_bot" ||
        destination.type === "feishu_bot" ||
        destination.type === "wecom_bot",
      ) &&
      !capabilityIds.has("delivery.bot.sendConnected")
    ) {
      issues.push(issue(
        "delivery.destinations",
        "bot-delivery-step-required",
        "启用 Bot 投递时必须包含对应的可执行步骤。",
      ));
    }
    if (
      enabled.some((destination) => destination.type === "conversation") &&
      !capabilityIds.has("delivery.conversation.publish")
    ) {
      issues.push(issue(
        "delivery.destinations",
        "conversation-delivery-unavailable",
        "当前流水线没有实现会话投递步骤。",
      ));
    }
    if (
      draft.delivery.fallbackPolicy.type === "all_available" &&
      deliverySteps.length > 1 &&
      deliverySteps.some(({ step }) => step.onError.policy !== "continue")
    ) {
      issues.push(issue(
        "delivery.fallbackPolicy",
        "all-available-must-continue",
        "全部可用目的地模式必须允许单个投递失败后继续其他目的地。",
      ));
    }
  }
  return issues;
}

function validateDataSelection(spec: DataSelectionSpec, issues: Issue[]) {
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    issues.push(issue("dataSelection.version", "recipe-version-invalid", "数据选择配方版本必须是正整数。"));
  }
  if (!Number.isInteger(spec.limits.maxMessages) || spec.limits.maxMessages < 1) {
    issues.push(issue("dataSelection.limits.maxMessages", "max-messages-invalid", "最多读取邮件数必须是正整数。"));
  }
  if (spec.limits.maxMessages > 5000) {
    issues.push(issue("dataSelection.limits.maxMessages", "scope-limit-exceeded", "单次最多读取 5000 封邮件。"));
  }
  if (spec.scope.type === "calendar_day" && !spec.scope.timezone.trim()) {
    issues.push(issue("dataSelection.scope.timezone", "timezone-required", "日历日范围必须绑定账户时区。"));
  }
  if (
    spec.scope.type === "previous_schedule_window" &&
    spec.scope.maxLookback &&
    (!Number.isInteger(spec.scope.maxLookback.amount) ||
      spec.scope.maxLookback.amount < 1 ||
      spec.scope.maxLookback.amount > 365 ||
      !["hour", "day"].includes(spec.scope.maxLookback.unit))
  ) {
    issues.push(issue(
      "dataSelection.scope.maxLookback",
      "max-lookback-invalid",
      "最长回溯时间必须是 1 至 365 个小时或天。",
    ));
  }
  if (
    (spec.relation?.sameSender || spec.relation?.sameSystem) &&
    !spec.relation.currentEmailId &&
    spec.scope.type !== "current_mail"
  ) {
    issues.push(issue(
      "dataSelection.relation.currentEmailId",
      "relation-anchor-required",
      "同发件人或同系统关系必须绑定当前邮件。",
    ));
  }
  spec.filters.forEach((filter, index) => {
    if (!filter.field.trim() || !filter.operator.trim()) {
      issues.push(issue(`dataSelection.filters.${index}`, "filter-invalid", "过滤条件必须包含字段和操作符。"));
    }
  });
  try {
    compileDataSelectionFilters(spec);
  } catch (error) {
    issues.push(issue(
      "dataSelection.filters",
      "filter-unsupported",
      error instanceof Error ? `过滤条件无法执行：${error.message}` : "过滤条件无法执行。",
    ));
  }
}

function validateAnalysis(recipe: AnalysisRecipe, issues: Issue[]) {
  if (!Number.isInteger(recipe.version) || recipe.version < 1) {
    issues.push(issue("analysis.version", "recipe-version-invalid", "分析配方版本必须是正整数。"));
  }
  if (recipe.inputKinds.length === 0) {
    issues.push(issue("analysis.inputKinds", "analysis-input-required", "分析配方必须声明输入类型。"));
  }
  if (
    recipe.metrics.length === 0 &&
    recipe.modelTasks.length === 0 &&
    recipe.conclusions.length === 0
  ) {
    issues.push(issue("analysis", "analysis-operation-required", "分析配方至少需要指标、模型任务或结论规则之一。"));
  }
  assertUnique(recipe.dimensions.map((item) => item.id), "analysis.dimensions", issues);
  recipe.dimensions.forEach((dimension, index) => {
    if (!dimension.field.trim()) {
      issues.push(issue(`analysis.dimensions.${index}.field`, "dimension-field-required", "分析维度必须绑定字段。"));
    }
  });
  assertUnique(recipe.metrics.map((item) => item.id), "analysis.metrics", issues);
  recipe.metrics.forEach((metric, index) => {
    if (!metric.id.trim() || !metric.label.trim()) {
      issues.push(issue(`analysis.metrics.${index}`, "metric-invalid", "指标必须包含稳定 ID 和名称。"));
    }
    if (metric.aggregation === "ratio" &&
        (!metric.numeratorField?.trim() || !metric.denominatorField?.trim())) {
      issues.push(issue(`analysis.metrics.${index}`, "ratio-fields-required", "占比指标必须明确分子和分母字段。"));
    }
    if (metric.aggregation === "p95" && !metric.field?.trim()) {
      issues.push(issue(`analysis.metrics.${index}`, "p95-field-required", "p95 指标必须明确排序字段。"));
    }
    if (
      metric.aggregation !== "count" &&
      metric.aggregation !== "ratio" &&
      !metric.field?.trim()
    ) {
      issues.push(issue(`analysis.metrics.${index}.field`, "metric-field-required", "该聚合指标必须绑定数值字段。"));
    }
  });
  assertUnique(recipe.modelTasks.map((item) => item.id), "analysis.modelTasks", issues);
  recipe.modelTasks.forEach((task, index) => {
    if (!task.instruction.trim() || task.outputFields.length === 0) {
      issues.push(issue(`analysis.modelTasks.${index}`, "model-task-schema-invalid", "模型任务必须有指令和输出字段。"));
    }
    if (!Number.isInteger(task.maxInputItems) || task.maxInputItems < 1 || task.maxInputItems > 500) {
      issues.push(issue(`analysis.modelTasks.${index}.maxInputItems`, "model-input-limit-invalid", "模型任务输入条数必须在 1 到 500 之间。"));
    }
    if (task.instruction.length > 4000) {
      issues.push(issue(`analysis.modelTasks.${index}.instruction`, "model-instruction-too-long", "模型任务指令不能超过 4000 个字符。"));
    }
    assertUnique(task.outputFields, `analysis.modelTasks.${index}.outputFields`, issues);
  });
  assertUnique(recipe.conclusions.map((item) => item.id), "analysis.conclusions", issues);
  recipe.conclusions.forEach((conclusion, index) => {
    if (!conclusion.instruction.trim()) {
      issues.push(issue(`analysis.conclusions.${index}.instruction`, "conclusion-instruction-required", "结论规则不能为空。"));
    }
  });
  if (!isRecord(recipe.outputSchema)) {
    issues.push(issue("analysis.outputSchema", "analysis-output-schema-invalid", "分析输出结构必须是对象。"));
  }
}

function validateArtifact(recipe: ArtifactRecipe, issues: Issue[]) {
  if (!Number.isInteger(recipe.version) || recipe.version < 1) {
    issues.push(issue("artifact.version", "recipe-version-invalid", "产物配方版本必须是正整数。"));
  }
  if (!recipe.title.trim()) {
    issues.push(issue("artifact.title", "artifact-title-required", "产物必须有标题。"));
  }
  assertUnique(recipe.components.map((item) => item.id), "artifact.components", issues);
  recipe.components.forEach((component, index) => {
    if (!component.id.trim()) {
      issues.push(issue(`artifact.components.${index}.id`, "component-id-invalid", "产物组件必须有稳定 ID。"));
    }
    const chart = component.type.endsWith("_chart");
    if (chart && !isRecord(component.binding)) {
      issues.push(issue(`artifact.components.${index}.binding`, "chart-binding-required", "图表必须提供完整的数据绑定。"));
    }
    if (component.type === "line_chart" && isRecord(component.binding)) {
      const binding = component.binding as Record<string, unknown>;
      const valueFields = Array.isArray(binding.valueFields)
        ? binding.valueFields.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (
        typeof binding.xField !== "string" ||
        !binding.xField.trim() ||
        (typeof binding.valueField !== "string" && valueFields.length === 0)
      ) {
        issues.push(issue(`artifact.components.${index}.binding`, "line-chart-fields-required", "折线图必须明确横轴和至少一个数值字段。"));
      }
    }
  });
  if (typeof recipe.accessibility.includeTextSummary !== "boolean" ||
      typeof recipe.accessibility.chartDescriptions !== "boolean") {
    issues.push(issue("artifact.accessibility", "accessibility-invalid", "产物必须明确可访问性选项。"));
  }
  if (!recipe.emptyState.trim() || !recipe.errorState.trim()) {
    issues.push(issue("artifact.state", "artifact-state-required", "产物必须定义空状态和错误状态。"));
  }
  if (!isRecord(recipe.outputSchema)) {
    issues.push(issue("artifact.outputSchema", "artifact-output-schema-invalid", "产物输出结构必须是对象。"));
  }
}

function validateDelivery(plan: DeliveryPlan, issues: Issue[]) {
  if (!Number.isInteger(plan.version) || plan.version < 1) {
    issues.push(issue("delivery.version", "recipe-version-invalid", "投递计划版本必须是正整数。"));
  }
  const enabled = plan.destinations.filter((destination) => destination.enabled);
  if (enabled.length === 0) {
    issues.push(issue("delivery.destinations", "delivery-destination-required", "投递计划至少需要一个启用的目的地。"));
  }
  const keys = plan.destinations.map((destination) =>
    `${destination.type}:${destination.destinationId ?? ""}`,
  );
  assertUnique(keys, "delivery.destinations", issues);
  if (plan.fallbackPolicy.messageCenterRequired &&
      !enabled.some((destination) => destination.type === "message_center")) {
    issues.push(issue("delivery.destinations", "message-center-required", "要求消息中心兜底时必须启用消息中心目的地。"));
  }
  if (!plan.content.includeSummary &&
      !plan.content.includeImage &&
      !plan.content.includeArtifactLink &&
      !plan.content.includeFullArtifact) {
    issues.push(issue("delivery.content", "delivery-content-empty", "投递内容不能全部为空。"));
  }
  if (plan.fallbackPolicy.type === "first_available" &&
      (!plan.fallbackPolicy.priority || plan.fallbackPolicy.priority.length === 0)) {
    issues.push(issue("delivery.fallbackPolicy.priority", "delivery-priority-required", "first_available 必须明确 Bot 优先级。"));
  }
  if (plan.fallbackPolicy.priority) {
    assertUnique(plan.fallbackPolicy.priority, "delivery.fallbackPolicy.priority", issues);
  }
}

function assertUnique(values: string[], path: string, issues: Issue[]) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!value.trim() || seen.has(value)) {
      issues.push(issue(`${path}.${index}`, "duplicate-id", "集合中的 ID 必须存在且唯一。"));
    }
    seen.add(value);
  });
}

function issue(path: string, code: string, message: string): Issue {
  return { path, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
