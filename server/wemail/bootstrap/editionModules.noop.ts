import type { EditionModules } from "./editionModules.js";

/**
 * Open-edition implementation of the `#edition-modules` registration entry:
 * no edition modules are registered, so every module-backed seam falls back
 * to its generic open behavior.
 *
 * Edition builds never edit this file. They compile their own registration
 * module (e.g. wemail-int `internal/src/register.ts`) and rebind
 * `#edition-modules` to it at build time via a generated
 * `dist-electron/package.json` imports map — see `editionModules.ts`.
 */
export const EDITION_MODULES: EditionModules = Object.freeze({
  // P2.4: no enterprise directory client factory and no pinyin port in the
  // open edition. DirectoryService keeps its P1 "directory-not-configured"
  // fallback and domain gate; DirectoryRepository uses the no-op pinyin port.
  directory: undefined,
  // P2.5: the open edition has no WeCLI runtime, installer, health checker,
  // catalog or agent tools. Every wecli-backed seam falls back to its generic
  // open behavior (404 endpoints, no tools, no install dialog).
  wecli: undefined,
  // P2.6: the open edition has no allowance/invoice module. The durable
  // queue stays, but no invoice service, routes, agent tools, receipts or
  // status store exist — every allowance seam falls back to its generic
  // "not wired" behavior.
  allowance: undefined,
});
