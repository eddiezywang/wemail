/**
 * Append the user's free-form custom instructions to a system prompt.
 *
 * upstream-parity F4: a single Markdown textbox in Settings whose contents
 * is forwarded verbatim to every AI feature's system prompt. This helper
 * is the single point that performs that append so every LLM call site
 * stays consistent.
 *
 * Privacy invariant: the prompt text returned MUST NOT be logged. Only
 * the boolean "was it applied" is safe to log.
 */
export function applyCustomInstructions(
  basePrompt: string,
  customInstructions: string | null | undefined,
): string {
  if (typeof customInstructions !== "string") return basePrompt;
  const trimmed = customInstructions.trim();
  if (trimmed.length === 0) return basePrompt;
  return (
    `${basePrompt}\n\n## User custom instructions\n` +
    `(The user supplied these free-form instructions in Settings. ` +
    `They apply to every AI feature. Follow them unless they conflict with safety rules.)\n\n` +
    trimmed
  );
}
