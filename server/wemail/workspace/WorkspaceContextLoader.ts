/**
 * Compiles a capability's `workspaceInputs` into a bounded
 * {@link WorkspaceContext} that can be injected into prompts at
 * runtime.
 *
 * Design (Route C / WP J.2):
 *   - Each capability declares the workspace files it consumes via
 *     `CapabilityDescriptor.workspaceInputs`.
 *   - At handle() time, the orchestrator asks this loader for the
 *     compiled context for the capability + account.
 *   - Files are loaded through {@link WorkspaceFileSystem} (so the
 *     sandbox path policy applies). Missing files become empty
 *     sections; processors decide whether to emit anything special
 *     when sections are empty.
 *   - A per-account, per-path cache keyed on mtime keeps repeat reads
 *     cheap. Cache invalidates whenever the underlying file is
 *     re-written (mtime advances).
 *   - A token budget (default 800) clamps the total content. When
 *     exceeded, the LAST section's content is tail-truncated until
 *     the total fits, and the result's `truncated` flag is set.
 */

import type { CapabilityDescriptor } from "../intelligence/CapabilityDescriptor.js";
import { estimateTokens } from "../ai/context/ContextBuilder.js";
import type { WorkspaceFileSystem } from "./WorkspaceFileSystem.js";

const DEFAULT_TOKEN_BUDGET = 800;

export interface WorkspaceContextSection {
  /** Source path inside workspace, e.g. "style/voice.md". */
  path: string;
  /** Compiled / preprocessed content. Empty string when source missing. */
  content: string;
}

export interface WorkspaceContext {
  /** Sections in declaration order matching capability.workspaceInputs. */
  sections: WorkspaceContextSection[];
  /** Total tokens (rough char/4 estimate). */
  totalTokenEstimate: number;
  /** True when content was truncated to stay within token budget. */
  truncated: boolean;
}

export interface WorkspaceContextLoaderOptions {
  fs: WorkspaceFileSystem;
  /** Max tokens injected per call. Default 800. */
  maxTokenBudget?: number;
}

interface CacheEntry {
  content: string;
  mtime: string;
  /** Rough token estimate of `content`. */
  tokenEstimate: number;
}

export class WorkspaceContextLoader {
  private readonly fs: WorkspaceFileSystem;
  private readonly maxTokenBudget: number;
  /** Cache key: `${accountId}::${path}`. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: WorkspaceContextLoaderOptions) {
    this.fs = options.fs;
    this.maxTokenBudget = options.maxTokenBudget ?? DEFAULT_TOKEN_BUDGET;
  }

  /**
   * Load all `descriptor.workspaceInputs` for this account. Compiled
   * results are cached by (accountId, path) and invalidated when the
   * underlying file's mtime changes. Empty input list returns a
   * context with no sections and totalTokenEstimate=0.
   */
  async loadFor(opts: {
    descriptor: Pick<CapabilityDescriptor, "workspaceInputs">;
    accountId: string;
  }): Promise<WorkspaceContext> {
    const inputs = opts.descriptor.workspaceInputs ?? [];
    if (inputs.length === 0) {
      return { sections: [], totalTokenEstimate: 0, truncated: false };
    }

    const sections: WorkspaceContextSection[] = [];
    for (const inputPath of inputs) {
      const content = await this.loadOne(opts.accountId, inputPath);
      sections.push({ path: inputPath, content });
    }

    // Compute total token estimate; truncate the LAST non-empty
    // section's tail until it fits.
    let total = sections.reduce((sum, s) => sum + estimateTokens(s.content), 0);
    let truncated = false;
    if (total > this.maxTokenBudget) {
      truncated = true;
      // Walk sections in declaration order keeping running total.
      // When budget would be exceeded by section i, truncate section i's
      // content to fit the remainder, then drop content from later
      // sections.
      let remaining = this.maxTokenBudget;
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]!;
        const sectionTokens = estimateTokens(section.content);
        if (sectionTokens <= remaining) {
          remaining -= sectionTokens;
          continue;
        }
        // Tail-truncate this section to `remaining` tokens (~ chars * 4).
        if (remaining <= 0) {
          section.content = "";
        } else {
          const charBudget = remaining * 4;
          section.content =
            charBudget >= section.content.length
              ? section.content
              : section.content.slice(0, charBudget);
        }
        remaining = 0;
        // Empty out later sections.
        for (let j = i + 1; j < sections.length; j++) {
          sections[j]!.content = "";
        }
        break;
      }
      total = sections.reduce((sum, s) => sum + estimateTokens(s.content), 0);
    }

    return {
      sections,
      totalTokenEstimate: total,
      truncated,
    };
  }

  /** Drop cache for one account (invoked on logout from later batches). */
  invalidate(accountId: string): void {
    const prefix = `${accountId}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Drop the entire cache. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private async loadOne(accountId: string, relPath: string): Promise<string> {
    const key = `${accountId}::${relPath}`;
    const stat = await this.fs.stat(relPath);
    if (!stat || stat.type !== "file") {
      // File missing — drop any stale cache entry and return empty.
      this.cache.delete(key);
      return "";
    }
    const cached = this.cache.get(key);
    if (cached && cached.mtime === stat.mtime) {
      return cached.content;
    }
    const content = (await this.fs.readFile(relPath)) ?? "";
    this.cache.set(key, {
      content,
      mtime: stat.mtime,
      tokenEstimate: estimateTokens(content),
    });
    return content;
  }
}
