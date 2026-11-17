import type { UsageBucketStats } from "../../../../shared/wemail/intelligence";

export type UsageModelRow = UsageBucketStats["models"][number];

export interface MergedModelRow {
  model: string;
  /**
	 * The provider label to surface for this model. Collapsed to `"unknown"`
	 * (no label shown) when the model was reached via more than one provider
	 * protocol, since the UI does not split the model dimension by protocol.
	 */
  provider: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/**
 * Merge the per-bucket model rows produced by the backend into a single
 * model dimension for display.
 *
 * The backend groups usage by `(category, provider, model)`, so the same
 * model reached via different provider protocols (e.g. openai-compatible vs
 * anthropic-compatible) arrives as several rows. Users want one entry per
 * model name — protocol is not a display dimension — so every provider row
 * for a model is summed together. `provider` is retained only when all rows
 * for that model carried the same known provider (it drives the optional
 * "OpenAI ·" / "Anthropic ·" label); otherwise it collapses to `"unknown"`
 * and no protocol label is rendered.
 */
export function mergeModelRows(rows: readonly UsageModelRow[]): MergedModelRow[] {
  const knownProvidersByModel = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.provider === "unknown") continue;
    const providers = knownProvidersByModel.get(row.model) ?? new Set<string>();
    providers.add(row.provider);
    knownProvidersByModel.set(row.model, providers);
  }

  const byModel = new Map<string, MergedModelRow>();
  for (const row of rows) {
    const existing = byModel.get(row.model);
    if (existing) {
      existing.tokens += row.tokens;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.calls += row.calls;
    } else {
      const known = knownProvidersByModel.get(row.model);
      const provider = known && known.size === 1 ? [...known][0]! : "unknown";
      byModel.set(row.model, {
        model: row.model,
        provider,
        tokens: row.tokens,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        calls: row.calls,
      });
    }
  }
  return Array.from(byModel.values()).sort((a, b) => b.tokens - a.tokens);
}
