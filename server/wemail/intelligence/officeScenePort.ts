/**
 * Port for deterministic office-scene detection (P2 module seam).
 *
 * The open-source edition ships only {@link NO_OP_OFFICE_SCENES}: no scene is
 * ever detected, nothing is filtered, and every consumer degrades to its
 * generic behavior. An edition build registers a real implementation through
 * the composition root's `modules.officeScenes` bundle (see
 * `server/wemail/bootstrap/editionModules.ts`), which detects enterprise
 * system-generated mail subjects with zero LLM cost and supplies the
 * actionable scene metadata used by the agent home panel.
 *
 * Method shapes mirror the original in-tree detector exports so an edition
 * implementation can stay a drop-in port implementation.
 */
export interface OfficeScenePort {
  /**
   * Scene id for the first matching pattern, or undefined for non-office
   * mail. Scene ids are opaque strings owned by the implementation; the
   * open tree never interprets them.
   */
  detect(subject: string, sender?: string): string | undefined;
  /**
   * True for any mail matching an office pattern. Consumers use it to skip
   * work that cannot apply to system-generated mail (e.g. LLM subscription
   * classification). The NO_OP port is always false, i.e. nothing is ever
   * filtered out.
   */
  isSystemMail(subject: string, sender?: string): boolean;
  /** Actionable scene ids in the implementation's priority order. */
  actionableScenes(): readonly string[];
  /**
   * Label + agent prompt for an actionable scene, or undefined for noise
   * scenes and unknown ids. Prompts carry no send permission: the agent's
   * confirmation gates still apply.
   */
  actionMeta(scene: string): { label: string; prompt: string } | undefined;
}

/**
 * The open-edition implementation: never detects, never filters, exposes no
 * actionable scenes. Frozen so tests can share one instance.
 */
export const NO_OP_OFFICE_SCENES: OfficeScenePort = Object.freeze({
  detect: () => undefined,
  isSystemMail: () => false,
  actionableScenes: () => [],
  actionMeta: () => undefined,
});
