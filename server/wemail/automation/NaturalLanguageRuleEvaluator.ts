import type { MailMessage } from "../../../shared/wemail/mail.js";

export interface CompletionClient {
  complete(input: { model?: string; prompt: string }): Promise<{ text: string }>;
}

export interface NaturalLanguageRuleDecision {
  matched: boolean;
  confidence: number;
  reason: string;
}

export interface NaturalLanguageRuleEvaluatorOptions {
  getLlmClient: () => CompletionClient | undefined;
  getModel: () => string | undefined;
}

export interface EvaluateRuleInput {
  ruleId: string;
  accountId: string;
  triggerKind: string;
  condition: string;
  message: MailMessage;
}

const BODY_LIMIT = 4000;

export class NaturalLanguageRuleEvaluator {
  constructor(private readonly options: NaturalLanguageRuleEvaluatorOptions) {}

  async evaluate(input: EvaluateRuleInput): Promise<NaturalLanguageRuleDecision> {
    const client = this.options.getLlmClient();
    if (!client) return { matched: false, confidence: 0, reason: "llm-unavailable" };
    try {
      const result = await client.complete({
        model: this.options.getModel(),
        prompt: this.buildPrompt(input),
      });
      const parsed = JSON.parse(result.text) as Partial<NaturalLanguageRuleDecision>;
      return {
        matched: parsed.matched === true,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reason: typeof parsed.reason === "string" ? parsed.reason : "no-reason",
      };
    } catch {
      return { matched: false, confidence: 0, reason: "evaluation-failed" };
    }
  }

  private buildPrompt(input: EvaluateRuleInput): string {
    const body = (input.message.bodyText ?? "").slice(0, BODY_LIMIT);
    return [
      "Decide whether this email satisfies the automation rule.",
      "Return strict JSON only with keys matched, confidence, reason.",
      `RuleId: ${input.ruleId}`,
      `AccountId: ${input.accountId}`,
      `Rule: ${input.condition}`,
      `Trigger: ${input.triggerKind}`,
      `From: ${input.message.from.name ?? ""} <${input.message.from.email}>`,
      `Subject: ${input.message.subject}`,
      `Snippet: ${input.message.snippet}`,
      `BodyTextTruncated: ${body}`,
    ].join("\n");
  }
}
