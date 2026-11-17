/**
 * RuleSuggester — AI-powered automation rule suggestion engine.
 *
 * Creates disabled draft rules based on email patterns, sender, category,
 * or natural-language intent. Suggestions are NEVER auto-enabled.
 *
 * When no LLM client is available, falls back to deterministic heuristics
 * that produce rule drafts from structured input (sender, category).
 */

import { randomUUID } from "node:crypto";
import type {
  AutomationAction,
  AutomationConditions,
} from "../../../shared/wemail/automation.js";
import type {
  AutomationSuggestInput,
  AutomationSuggestedRule,
} from "../../../shared/wemail/intelligence.js";
import { LlmRuntime } from "../ai/LlmRuntime.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";

/** Dangerous action types that require explicit confirmation when running. */
export const DANGEROUS_ACTION_TYPES: ReadonlySet<string> = new Set([
  "archive",
  "trash",
  "spam",
]);

export function isDangerousAction(action: AutomationAction): boolean {
  return DANGEROUS_ACTION_TYPES.has(action.type);
}

export function hasDangerousAction(actions: AutomationAction[]): boolean {
  return actions.some(isDangerousAction);
}

export interface RuleSuggesterDeps {
  mail: CanonicalMailRepository;
  llmRuntime?: LlmRuntime;
}

export class RuleSuggester {
  private readonly mail: CanonicalMailRepository;
  private readonly llmRuntime: LlmRuntime;

  constructor(deps: RuleSuggesterDeps) {
    this.mail = deps.mail;
    this.llmRuntime = deps.llmRuntime ?? new LlmRuntime({ initialSettings: null });
  }

  /**
   * Suggest an automation rule based on the input. Always returns a
   * disabled draft — never auto-enabled.
   */
  async suggest(input: AutomationSuggestInput): Promise<AutomationSuggestedRule> {
    // If we have an emailId, derive context from that email
    let contextEmail: MailMessage | null = null;
    if (input.emailId) {
      contextEmail = this.mail.getMessageById(input.emailId);
    }

    // Try LLM-based suggestion first
    const llm = this.llmRuntime.snapshot();
    const model = llm.modelFor("agent");
    if (llm.client && model) {
      try {
        return await this.suggestWithLlm(input, contextEmail, llm.client, model);
      } catch {
        // Fall through to heuristic
      }
    }

    // Deterministic heuristic fallback
    return this.suggestHeuristic(input, contextEmail);
  }

  private async suggestWithLlm(
    input: AutomationSuggestInput,
    contextEmail: MailMessage | null,
    llm: NonNullable<ReturnType<LlmRuntime["snapshot"]>["client"]>,
    model: string,
  ): Promise<AutomationSuggestedRule> {
    const prompt = this.buildLlmPrompt(input, contextEmail);
    const response = await llm.generate({
      model,
      system: RULE_SUGGESTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      jsonSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          conditions: {
            type: "object",
            properties: {
              sender: { type: "string" },
              recipient: { type: "string" },
              cc: { type: "string" },
              subjectKeyword: { type: "string" },
              bodyKeyword: { type: "string" },
              hasAttachment: { type: "boolean" },
              olderThanDays: { type: "number" },
              newerThanDays: { type: "number" },
              aiTag: { type: "string" },
            },
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                label: { type: "string" },
              },
            },
          },
          rationale: { type: "string" },
        },
        required: ["name", "conditions", "actions", "rationale"],
      },
    });

    const parsed = JSON.parse(response.text) as {
      name: string;
      conditions: AutomationConditions;
      actions: AutomationAction[];
      rationale: string;
    };

    return {
      id: `suggestion-${randomUUID()}`,
      accountId: input.accountId,
      name: parsed.name,
      enabled: false,
      conditions: parsed.conditions,
      actions: parsed.actions,
      rationale: parsed.rationale,
    };
  }

  private buildLlmPrompt(
    input: AutomationSuggestInput,
    contextEmail: MailMessage | null,
  ): string {
    const parts: string[] = [];
    if (contextEmail) {
      parts.push(
        `Based on an email from "${contextEmail.from.email}" with subject "${contextEmail.subject}":`,
      );
    }
    if (input.sender) {
      parts.push(`Target sender: ${input.sender}`);
    }
    if (input.category) {
      parts.push(`Target category: ${input.category}`);
    }
    if (input.naturalLanguageIntent) {
      parts.push(`User intent: ${input.naturalLanguageIntent}`);
    }
    parts.push("Suggest an automation rule with conditions, actions, and a rationale.");
    return parts.join("\n");
  }

  private suggestHeuristic(
    input: AutomationSuggestInput,
    contextEmail: MailMessage | null,
  ): AutomationSuggestedRule {
    const conditions: AutomationConditions = {};
    const actions: AutomationAction[] = [];
    let name = "Suggested rule";
    let rationale = "";

    if (input.sender) {
      conditions.sender = input.sender;
      actions.push({ type: "markRead" });
      name = `Auto-read from ${input.sender}`;
      rationale = `Rule to automatically mark emails from ${input.sender} as read.`;
    } else if (contextEmail) {
      conditions.sender = contextEmail.from.email;
      actions.push({ type: "markRead" });
      name = `Auto-read from ${contextEmail.from.email}`;
      rationale = `Rule based on email from ${contextEmail.from.email} with subject "${contextEmail.subject}".`;
    } else if (input.category) {
      conditions.aiTag = input.category;
      actions.push({ type: "markRead" });
      name = `Auto-read ${input.category} mail`;
      rationale = `Rule to automatically mark ${input.category} emails as read.`;
    } else if (input.naturalLanguageIntent) {
      // Best-effort: try to extract a sender-like pattern
      const senderMatch = input.naturalLanguageIntent.match(/from\s+([\w.@-]+)/i);
      if (senderMatch) {
        conditions.sender = senderMatch[1];
        actions.push({ type: "markRead" });
        name = `Auto-read from ${senderMatch[1]}`;
        rationale = `Derived from intent: "${input.naturalLanguageIntent}"`;
      } else {
        conditions.bodyKeyword = input.naturalLanguageIntent.slice(0, 50);
        actions.push({ type: "markRead" });
        name = `Rule for "${input.naturalLanguageIntent.slice(0, 30)}"`;
        rationale = `Derived from intent: "${input.naturalLanguageIntent}"`;
      }
    } else {
      // No input provided — return a generic draft
      actions.push({ type: "markRead" });
      name = "New suggested rule";
      rationale = "Generic rule suggestion with no specific input.";
    }

    return {
      id: `suggestion-${randomUUID()}`,
      accountId: input.accountId,
      name,
      enabled: false,
      conditions,
      actions,
      rationale,
    };
  }
}

const RULE_SUGGESTION_SYSTEM_PROMPT = `You are an email automation rule suggestion engine.
Given context about an email or a user's intent, suggest an automation rule.
Rules MUST be safe: prefer read-only actions (markRead, star, applyLabel) over destructive ones.
If the intent implies a dangerous action (archive, trash, spam), include it but note it requires confirmation.
Always provide a clear rationale for why the rule was suggested.
Respond with valid JSON matching the provided schema.`;
