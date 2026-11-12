/**
 * Shared types for the agent runtime + tool surface.
 *
 * `JsonSchema` is intentionally loose — different LLM providers accept
 * slightly different JSON-Schema dialects. Tool authors supply a plain
 * object and the PI runtime forwards it verbatim to the provider.
 */

export type JsonSchema = Record<string, unknown>;

/**
 * Tool-call input is always an object (never a scalar or array at the
 * top level). Handlers narrow it further as needed.
 */
export type ToolInput = Record<string, unknown>;
