import type {
  IntelligenceJobType,
  LearningSummary,
  PersonalizedPromptResult,
} from "../../../shared/wemail/intelligence.js";
import type { AiProfileSettings } from "../../../shared/wemail/settings.js";

/**
 * Prompt builder that consumes profile + learning summary.
 *
 * CRITICAL PRIVACY INVARIANT:
 * Logs include only ids, feature, version, and outcome metadata.
 * The promptText is NEVER logged. Raw private feedback text is NEVER
 * included in logs or metadata.
 */

const PROMPT_VERSION = 1;

/**
 * Sensitive keys that MUST NOT appear in log output or metadata.
 * These keys might exist in learning summary signals but must never
 * be exposed outside the prompt text itself.
 */
const LOG_FORBIDDEN_KEYS = new Set<string>([
  "bodyText",
  "bodyHtml",
  "prompt",
  "rawResponse",
  "rawLlmResponse",
  "llmResponse",
  "password",
  "token",
  "apiKey",
  "secret",
  "feedbackText",
  "originalText",
  "editedText",
]);

/**
 * Strip sensitive keys from an object for safe logging.
 * Returns a new object with forbidden keys removed.
 */
function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (LOG_FORBIDDEN_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeForLog(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface PromptBuilderDeps {
  /** Logger function that receives safe-to-log metadata. */
  logger?: (event: string, meta: Record<string, unknown>) => void;
}

/**
 * Builds personalized prompts by combining profile settings and
 * learning summaries. The prompt text is for LLM consumption only
 * and MUST NEVER be logged. Only ids, feature, version, and outcome
 * metadata are safe to log.
 */
export class PromptBuilder {
  private readonly logger?: (event: string, meta: Record<string, unknown>) => void;

  constructor(deps: PromptBuilderDeps = {}) {
    this.logger = deps.logger;
  }

  /**
   * Build a personalized prompt for a given feature.
   *
   * @param feature - The intelligence feature to build a prompt for.
   * @param profile - The user's AI profile settings.
   * @param learningSummary - Optional per-feature learning summary from feedback.
   * @param basePrompt - The base prompt template for the feature.
   * @returns A PersonalizedPromptResult with promptText (not for logging)
   *          and safe-to-log metadata.
   */
  build(input: {
    feature: IntelligenceJobType;
    profile: AiProfileSettings | null;
    learningSummary: LearningSummary | null;
    basePrompt: string;
  }): PersonalizedPromptResult {
    const { feature, profile, learningSummary, basePrompt } = input;

    const profileSections: string[] = [];
    const profileFieldsUsed: string[] = [];

    // Add profile-based personalization
    if (profile) {
      if (profile.userDisplayName) {
        profileSections.push(`User name: ${profile.userDisplayName}`);
        profileFieldsUsed.push("userDisplayName");
      }
      if (profile.assistantPreference) {
        profileSections.push(`Assistant style: ${profile.assistantPreference}`);
        profileFieldsUsed.push("assistantPreference");
      }
      if (profile.defaultSummaryLanguage) {
        profileSections.push(`Summary language: ${profile.defaultSummaryLanguage}`);
        profileFieldsUsed.push("defaultSummaryLanguage");
      }
      if (profile.defaultReplyTone) {
        profileSections.push(`Reply tone: ${profile.defaultReplyTone}`);
        profileFieldsUsed.push("defaultReplyTone");
      }
      if (profile.signaturePreference) {
        profileSections.push(`Signature preference: ${profile.signaturePreference}`);
        profileFieldsUsed.push("signaturePreference");
      }
      if (profile.importantContacts && profile.importantContacts.length > 0) {
        profileSections.push(`Important contacts: ${profile.importantContacts.join(", ")}`);
        profileFieldsUsed.push("importantContacts");
      }
      if (profile.composeLanguage) {
        profileSections.push(`Compose language: ${profile.composeLanguage}`);
        profileFieldsUsed.push("composeLanguage");
      }
      if (profile.translationLanguage) {
        profileSections.push(`Translation language: ${profile.translationLanguage}`);
        profileFieldsUsed.push("translationLanguage");
      }
    }

    // Add learning-summary-based personalization
    let learningSummaryUsed = false;
    const learningSections: string[] = [];
    if (learningSummary && learningSummary.signals) {
      const signals = learningSummary.signals;

      // Tags: add suppression signals
      if (feature === "tags" && signals.suppressedTags) {
        const tags = signals.suppressedTags as string[];
        if (tags.length > 0) {
          learningSections.push(
            `Avoid suggesting these tags (user has rejected them): ${tags.join(", ")}`,
          );
          learningSummaryUsed = true;
        }
      }

      // Reply draft: add writing feedback signals
      if (feature === "replyDraft" && signals.writingFeedback) {
        const wf = signals.writingFeedback as { editRatio: number; editCount: number; acceptCount: number };
        learningSections.push(
          `Writing feedback: ${wf.editCount} edits, ${wf.acceptCount} accepts. ` +
          `Edit ratio: ${Math.round(wf.editRatio * 100)}%.`,
        );
        learningSummaryUsed = true;
      }

      // Summary: add rating signals
      if (feature === "summary" && signals.averageRating !== undefined) {
        learningSections.push(
          `Average summary rating: ${signals.averageRating}/5.`,
        );
        learningSummaryUsed = true;
      }
    }

    // Assemble the prompt
    const parts: string[] = [basePrompt];
    if (profileSections.length > 0) {
      parts.push("\n## User Preferences\n" + profileSections.join("\n"));
    }
    if (learningSections.length > 0) {
      parts.push("\n## Learned Preferences\n" + learningSections.join("\n"));
    }

    // Custom instructions (upstream-parity F4): a single free-form Markdown
    // textbox the user fills in once that affects ALL features. Appended
    // last so it can override anything earlier in the prompt. The text is
    // forwarded verbatim — Markdown is NOT parsed server-side.
    let customInstructionsUsed = false;
    const customInstructionsRaw = profile?.customInstructions;
    if (typeof customInstructionsRaw === "string" && customInstructionsRaw.trim().length > 0) {
      parts.push(
        "\n## User custom instructions\n" +
          "(The user supplied these free-form instructions in Settings. " +
          "They apply to every AI feature. Follow them unless they conflict with safety rules.)\n\n" +
          customInstructionsRaw.trim(),
      );
      customInstructionsUsed = true;
    }

    const promptText = parts.join("\n");

    // Build safe-to-log metadata (NO prompt text, NO raw feedback,
    // NO custom-instructions text — only the boolean "was it used").
    const meta: PersonalizedPromptResult["meta"] = {
      feature,
      version: PROMPT_VERSION,
      profileFieldsUsed,
      learningSummaryUsed,
      customInstructionsUsed,
    };

    // Log only safe metadata
    this.logger?.("prompt.build", sanitizeForLog({
      feature,
      version: PROMPT_VERSION,
      profileFieldsUsed,
      learningSummaryUsed,
      customInstructionsUsed,
    }));

    return { promptText, meta };
  }
}

/**
 * Export the sanitizer for testing. The function ensures that
 * any object logged from the prompt builder has sensitive keys removed.
 */
export { sanitizeForLog, LOG_FORBIDDEN_KEYS };
