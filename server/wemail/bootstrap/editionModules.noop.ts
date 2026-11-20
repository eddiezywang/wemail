import type { EditionModules } from "./editionModules.js";
import { SENT_ARCHIVE_IMAP } from "../mail-core/sentArchiveImap.js";

/**
 * Open-edition implementation of the `#edition-modules` registration entry:
 * generic open behavior for every module-backed seam.
 *
 * Sent-archive is a native open capability: after SMTP send the message is
 * APPENDed back to the account's IMAP Sent folder (folder auto-detected via
 * RFC 6154 special-use, overridable with WEMAIL_SENT_FOLDER, skipped when
 * the server has none). Internal editions may rebind `#edition-modules` to
 * override it (e.g. provider-specific folder conventions) — see
 * `editionModules.ts`. Edition builds never edit this file directly.
 */
export const EDITION_MODULES: EditionModules = Object.freeze({
  // Generic IMAP write-back of sent mail (see sentArchiveImap.ts). Internal
  // editions can override with their own registration module.
  sentArchive: SENT_ARCHIVE_IMAP,
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
