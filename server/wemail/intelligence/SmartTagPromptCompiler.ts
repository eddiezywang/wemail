import type { LlmRuntime } from "../ai/LlmRuntime.js";

const COMPILER_VERSION = "wemail-smart-tag-rule-v1";

const COMPILER_SYSTEM_PROMPT = [
  "You convert a user's informal smart-tag description into a strict mail-classification rule.",
  "Infer intent without requiring the user to use formal syntax.",
  "Separate mandatory signals, supporting signals, and exclusions.",
  "Words joined as cumulative facts (including comma-separated Chinese phrases) are mandatory together unless the user explicitly says any/either/or.",
  "Words such as usually/often/may indicate supporting evidence, not a mandatory condition.",
  "Do not invent private addresses, domains, people, or business facts that the user did not provide.",
  "When the description is ambiguous, prefer precision and non-match.",
  "Return only JSON matching the schema.",
].join(" ");

const COMPILER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["intent", "matchMode", "requiredSignals", "supportingSignals", "exclusionSignals"],
  properties: {
    intent: { type: "string", minLength: 1, maxLength: 500 },
    matchMode: { type: "string", enum: ["all", "any"] },
    requiredSignals: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
    supportingSignals: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
    exclusionSignals: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
  },
}) as Record<string, unknown>;

interface CompiledRule {
  intent: string;
  matchMode: "all" | "any";
  requiredSignals: string[];
  supportingSignals: string[];
  exclusionSignals: string[];
}

export class SmartTagPromptCompiler {
  constructor(private readonly llmRuntime: LlmRuntime) {}

  async compile(input: {
    name: string;
    description: string;
  }): Promise<string> {
    const name = input.name.trim();
    const description = input.description.trim();
    const snapshot = this.llmRuntime.snapshot();
    const client = snapshot.client;
    const model = snapshot.modelFor("default");
    if (!client || !model) return fallbackPrompt(name, description);

    try {
      const response = await client.generate({
        model,
        system: COMPILER_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            `Tag name: ${name}`,
            `User description: ${description || name}`,
            "Convert this description into stable classification criteria.",
          ].join("\n"),
        }],
        jsonSchema: COMPILER_SCHEMA,
        temperature: 0,
        maxTokens: 800,
        timeoutMs: 25_000,
      });
      const parsed = parseCompiledRule(response.text);
      return parsed ? renderPrompt(name, description, parsed) : fallbackPrompt(name, description);
    } catch {
      return fallbackPrompt(name, description);
    }
  }
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length === value.length ? items : null;
}

function parseCompiledRule(text: string): CompiledRule | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const requiredSignals = parseStringArray(value.requiredSignals);
    const supportingSignals = parseStringArray(value.supportingSignals);
    const exclusionSignals = parseStringArray(value.exclusionSignals);
    if (
      typeof value.intent !== "string"
      || !value.intent.trim()
      || (value.matchMode !== "all" && value.matchMode !== "any")
      || !requiredSignals?.length
      || !supportingSignals
      || !exclusionSignals
    ) return null;
    return {
      intent: value.intent.trim(),
      matchMode: value.matchMode,
      requiredSignals,
      supportingSignals,
      exclusionSignals,
    };
  } catch {
    return null;
  }
}

function renderPrompt(name: string, description: string, rule: CompiledRule): string {
  return [
    `[${COMPILER_VERSION}]`,
    `智能标签：${name}`,
    `用户原始描述：${description || name}`,
    `分类意图：${rule.intent}`,
    `必要条件（${rule.matchMode === "all" ? "必须全部满足" : "满足任意一项"}）：`,
    ...rule.requiredSignals.slice(0, 6).map((signal) => `- ${signal.slice(0, 200)}`),
    "辅助证据（不能单独构成命中）：",
    ...(rule.supportingSignals.length > 0
      ? rule.supportingSignals.slice(0, 4).map((signal) => `- ${signal.slice(0, 200)}`)
      : ["- 无"]),
    "排除条件（命中任意一项即不归类）：",
    ...(rule.exclusionSignals.length > 0
      ? rule.exclusionSignals.slice(0, 4).map((signal) => `- ${signal.slice(0, 200)}`)
      : ["- 无额外排除条件"]),
    "判定要求：仅在必要条件成立且不存在排除条件时返回此标签；辅助证据只能增强判断；信息缺失、冲突或不确定时不要返回此标签。",
  ].join("\n");
}

function fallbackPrompt(name: string, description: string): string {
  const source = description || name;
  return [
    `[${COMPILER_VERSION}]`,
    `智能标签：${name}`,
    `用户原始描述：${source}`,
    "必要条件（必须全部满足）：",
    `- 邮件内容必须明确符合以下完整描述，不能只命中其中一个孤立词语：${source}`,
    "排除条件（命中任意一项即不归类）：",
    "- 仅出现相似关键词，但发件来源、主题语义或业务上下文不符合完整描述",
    "- 信息缺失、条件冲突或无法确定",
    "判定要求：逗号分隔的事实默认视为累计条件；只有用户明确表达“任一、或者、其中之一”时才按任选条件处理。不得因为附件、单个关键词或宽泛主题相似而归类。",
  ].join("\n");
}
