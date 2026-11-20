import type { EditionModules } from "../bootstrap/editionModules.js";
import { SENT_ARCHIVE_IMAP } from "./sentArchiveImap.js";

/**
 * Open-edition registration of the post-send archive seam: after SMTP send
 * the raw message is APPENDed back to the account's IMAP Sent folder
 * (folder auto-detected via RFC 6154 special-use, overridable with
 * `WEMAIL_SENT_FOLDER`, skipped when the server declares none).
 *
 * Internal builds may rebind `#edition-sent-archive` to their own module
 * for provider-specific folder conventions; the generic IMAP implementation
 * in `sentArchiveImap.ts` is the open default both shells otherwise share.
 */
export const SENT_ARCHIVE: EditionModules["sentArchive"] = SENT_ARCHIVE_IMAP;
