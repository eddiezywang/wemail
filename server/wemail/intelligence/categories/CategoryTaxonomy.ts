/**
 * Canonical system category taxonomy for inbox classification tabs.
 *
 * Category ids are language-independent (never translated). Display labels
 * are the concern of the renderer; the API and database only ever store or
 * transmit canonical ids.
 *
 * The system taxonomy is ordered: required categories always appear first
 * in the API response, and dynamic (non-system) tags appear after.
 * Dynamic tags cannot replace or shadow a system category.
 */

/**
 * The three user-visible independent system classification ids.
 * Order determines tab display order in the UI.
 */
export const SYSTEM_CATEGORY_IDS = Object.freeze([
  "important",
  "action_required",
  "invoice",
] as const) as readonly string[];

export type SystemCategoryId = (typeof SYSTEM_CATEGORY_IDS)[number];

/** Set for O(1) membership checks. */
export const SYSTEM_CATEGORY_SET: ReadonlySet<string> = new Set(SYSTEM_CATEGORY_IDS);

/**
 * Default display labels for system categories.
 * These are English defaults; the renderer may override with
 * localized strings. The API never uses these as identifiers.
 */
export const SYSTEM_CATEGORY_LABELS: Readonly<Record<SystemCategoryId, string>> = {
  important: "重要",
  action_required: "待处理",
  invoice: "发票",
};

/**
 * Check whether a category id is a canonical system category.
 */
export function isSystemCategory(id: string): boolean {
  return SYSTEM_CATEGORY_SET.has(id);
}
