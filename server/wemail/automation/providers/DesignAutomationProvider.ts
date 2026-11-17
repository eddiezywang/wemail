import type { AutomationDataset } from "../../../../shared/wemail/automation.js";
import type { DesignRequest } from "../../../../shared/wemail/designArtifacts.js";
import type {
  ArtifactComponentSpec,
  ArtifactRecipe,
} from "../../../../shared/wemail/skillCenter.js";
import { DesignRecipeCompiler } from "../../design/DesignRecipeCompiler.js";
import { DesignRenderer } from "../../design/DesignRenderer.js";
import type { MessageArtifactRepository } from "../../design/MessageArtifactRepository.js";
import { BaseAutomationProvider } from "./BaseAutomationProvider.js";
import type { AutomationCapabilityDescriptor, AutomationProviderContext, AutomationStepPreview, AutomationStepResult, CompiledAutomationStep } from "./AutomationProvider.js";
import { completedAudit } from "./AutomationProvider.js";
import { descriptorFingerprint } from "./AutomationProviderRegistry.js";

export class DesignAutomationProvider extends BaseAutomationProvider {
  readonly id = "design";
  readonly version = "1";
  constructor(private readonly artifacts: MessageArtifactRepository, private readonly compiler = new DesignRecipeCompiler(), private readonly renderer = new DesignRenderer()) { super(); }

  protected capabilities(): AutomationCapabilityDescriptor[] {
    const base = { provider: this.id, id: "render", version: this.version, kind: "design" as const, label: "生成设计产物", description: "从 Dataset 和已评审 ArtifactRecipe 生成受信 DesignRecipe 与隔离 HTML Artifact", inputSchema: { type: "object", required: ["dataset"] }, outputSchema: { type: "object", automationValue: "artifact-reference" }, risk: "local-write" as const, sideEffects: ["write-local-artifact"] as const, previewSupport: "full" as const, idempotency: "keyed" as const, discoveryConfidence: "declared" as const, metadata: { supportsArtifactRecipe: true } };
    return [{ ...base, sideEffects: [...base.sideEffects], fingerprint: descriptorFingerprint({ ...base, sideEffects: [...base.sideEffects] }) }];
  }

  override async validate(_step: CompiledAutomationStep, input: Record<string, unknown>): Promise<string[]> {
    return isDataset(input.dataset) ? [] : ["dataset must be an AutomationDataset"];
  }

  async preview(step: CompiledAutomationStep, input: Record<string, unknown>): Promise<AutomationStepPreview> {
    const dataset = input.dataset as AutomationDataset;
    const recipe = this.compiler.compile(requestFrom(step, input, dataset));
    const rendered = this.renderer.render(recipe, dataset);
    return {
      plannedOperation: `生成 ${recipe.kind}：${recipe.title}`,
      resolvedInputSummary: { rows: dataset.rows.length, fields: dataset.schema.fields.length, recipe, preview: rendered.preview, keyMetrics: rendered.keyMetrics },
      output: {
        type: "artifact-reference",
        artifactId: `preview-${step.id}`,
        version: 1,
        contentHash: rendered.contentHash,
        kind: recipe.kind,
      },
      warnings: [],
      sideEffects: ["write-local-artifact"],
    };
  }

  async execute(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    try {
      const dataset = input.dataset as AutomationDataset;
      const recipe = this.compiler.compile(requestFrom(step, input, dataset));
      const rendered = this.renderer.render(recipe, dataset);
      const artifact = this.artifacts.create({ accountId: context.run.accountId, owner: context.owner, recipe, html: rendered.html, preview: rendered.preview, sourceRuleId: context.run.ruleId, sourceRuleVersion: context.run.ruleVersion, sourceRunId: context.run.id });
      const completedAt = new Date().toISOString();
      return { status: "succeeded", output: { type: "artifact-reference", artifactId: artifact.artifactId, version: artifact.version, contentHash: artifact.contentHash, kind: artifact.kind }, warnings: [], sideEffects: [{ type: "write-local-artifact", summary: artifact.title }], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    } catch (error) {
      const completedAt = new Date().toISOString();
      return { status: "failed", error: { code: "execution-failed", message: error instanceof Error ? error.message : String(error), retryable: false, retrySafe: false }, warnings: [], sideEffects: [], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    }
  }
}

function requestFrom(step: CompiledAutomationStep, input: Record<string, unknown>, dataset: AutomationDataset): DesignRequest {
  const artifact = asArtifactRecipe(input.artifactRecipe);
  const charts = artifact ? chartsFromArtifact(artifact) : undefined;
  return {
    dataset,
    mode: artifact ? modeFromArtifact(artifact) : asMode(input.mode ?? step.config?.mode),
    objective: asString(input.objective ?? step.config?.objective),
    audience: asString(input.audience ?? step.config?.audience),
    title: artifact?.title ?? asString(input.title ?? step.config?.title),
    instructions: artifact
      ? `空状态：${artifact.emptyState}；错误状态：${artifact.errorState}`
      : asString(input.instructions ?? step.config?.instructions),
    designSystem: artifact?.theme.name,
    templateId: asTemplate(input.templateId ?? step.config?.templateId),
    purpose: asPurpose(input.purpose ?? step.config?.purpose),
    ...(charts?.length ? {
      charts,
      constraints: { maxCharts: charts.length },
    } : {}),
  };
}
function asString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function asMode(value: unknown): DesignRequest["mode"] { return value === "brief" || value === "report" || value === "dashboard" || value === "deck" ? value : "auto"; }
function asTemplate(value: unknown): DesignRequest["templateId"] {
  return value === "email-visual-summary" || value === "quick-chart" || value === "timeline-view" || value === "executive-insight" || value === "trend-analysis" || value === "comparison-breakdown" || value === "operational-health" ? value : undefined;
}
function asPurpose(value: unknown): DesignRequest["purpose"] {
  return value === "visualize" || value === "analyze" ? value : "auto";
}
function isDataset(value: unknown): value is AutomationDataset { return !!value && typeof value === "object" && (value as AutomationDataset).type === "dataset" && Array.isArray((value as AutomationDataset).rows); }

function asArtifactRecipe(value: unknown): ArtifactRecipe | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ArtifactRecipe>;
  return typeof candidate.title === "string" && Array.isArray(candidate.components)
    ? candidate as ArtifactRecipe
    : undefined;
}

function modeFromArtifact(recipe: ArtifactRecipe): DesignRequest["mode"] {
  if (/dashboard|仪表盘/i.test(recipe.layout.structure)) return "dashboard";
  if (/deck|slide|演示/i.test(recipe.layout.structure)) return "deck";
  return "report";
}

function chartsFromArtifact(recipe: ArtifactRecipe): NonNullable<DesignRequest["charts"]> {
  return recipe.components.flatMap((component) => {
    const family = chartFamily(component.type);
    const binding = recordValue(component.binding);
    const x = stringValue(binding.xField) ?? stringValue(binding.x);
    const values = [
      ...(Array.isArray(binding.valueFields) ? binding.valueFields : []),
      binding.valueField,
      binding.y,
    ].filter((value): value is string => typeof value === "string" && !!value.trim());
    if (!family || !x || values.length === 0) return [];
    return [...new Set(values)].map((y) => ({
      family,
      x,
      y,
      ...(typeof binding.seriesField === "string"
        ? { splitBy: binding.seriesField }
        : {}),
      ...(component.title
        ? { title: values.length === 1 ? component.title : `${component.title} · ${y}` }
        : {}),
      ...(values.length > 1 ? { switchGroup: component.id, span: "full" as const } : {}),
    }));
  });
}

function chartFamily(type: ArtifactComponentSpec["type"]): "line" | "bar" | "donut" | undefined {
  if (type === "line_chart") return "line";
  if (type === "bar_chart") return "bar";
  if (type === "pie_chart") return "donut";
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
