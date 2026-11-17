/**
 * Enterprise-directory ports (P2.4 — "engine stays, client moves").
 *
 * The open tree keeps the snapshot engine (DirectoryService,
 * DirectoryRepository, DB lanes, HTTP routes) but no longer ships an
 * enterprise directory implementation. Everything that used to be imported
 * from `CoremailWebClient.ts` / `DirectoryPinyin.ts` is now a small typed
 * port, injected through `EditionModules.directory` (see
 * `bootstrap/editionModules.ts`). The internal edition registers the real
 * implementations in `wemail-int/internal/src/directory/index.ts`.
 *
 * The remote client is deliberately the *minimal public surface* of the
 * former Coremail client — no protocol, session or encryption details leak
 * back into the open tree. Errors are matched structurally by `code`, so an
 * internal implementation never needs a runtime import of an open-tree class
 * (its compiled code is relocated to `dist-electron/edition-modules/**`).
 */
import { resolveEditionModules } from "../bootstrap/editionModules.js";

export interface DirectoryRemoteDirectoryNode {
  dn?: string;
  id?: string;
  name?: string;
  email?: string;
  childCount?: number;
  ou?: DirectoryRemoteDirectoryNode[];
}

export type DirectoryRemoteContact = Record<string, unknown>;

export interface DirectoryRemoteContactPage {
  contacts: DirectoryRemoteContact[];
  total?: number;
}

/** Minimal remote directory client surface used by DirectoryService. */
export interface DirectoryRemoteClient {
  warmup(): Promise<void>;
  getDirectories(dn?: string): Promise<DirectoryRemoteDirectoryNode[]>;
  listContacts(input: {
    dn: string;
    start: number;
    limit: number;
  }): Promise<DirectoryRemoteContactPage>;
  autoMatch(keyword: string, limit?: number): Promise<DirectoryRemoteContact[]>;
  getContacts(emails: string[]): Promise<DirectoryRemoteContact[]>;
}

export interface DirectoryRemoteClientFactoryInput {
  username: string;
  password: string;
  /**
   * Edition-configured endpoint. AppComposition supplies it from
   * `edition.enterpriseDirectory.coremailBaseUrl`; the open build has no
   * endpoint and no factory at all.
   */
  baseUrl?: string;
}

export type DirectoryRemoteClientFactory = (
  input: DirectoryRemoteClientFactoryInput,
) => DirectoryRemoteClient;

/** Error thrown by the open engine for directory failures (code is the API). */
export class DirectoryRemoteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryRemoteError";
  }
}

/**
 * Extract a directory error code from either the open error class or an
 * edition implementation's own error class (structural match). Internal
 * modules must not extend an open class: their compiled files are relocated
 * by the edition build and cannot resolve a runtime import into `open/`.
 */
export function directoryRemoteErrorCode(error: unknown): string | undefined {
  if (error instanceof DirectoryRemoteError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/** Search-index contribution computed from a contact display name. */
export interface DirectoryPinyinIndex {
  fullPinyin: string;
  pinyinInitials: string;
  searchTerms: string[];
}

/**
 * Pinyin port. `version` is stamped on every indexed contact; raising it
 * re-indexes older rows. The open default is a no-op at version 0, so an
 * internal edition (version 1) reindexes contacts written by an open build
 * without any schema/migration change.
 */
export interface DirectoryPinyinPort {
  readonly version: number;
  buildIndex(displayName: string): DirectoryPinyinIndex;
}

export const OPEN_DIRECTORY_PINYIN: DirectoryPinyinPort = Object.freeze({
  version: 0,
  buildIndex: () => ({ fullPinyin: "", pinyinInitials: "", searchTerms: [] }),
});

/**
 * Resolve the active pinyin port. Called at DirectoryRepository construction
 * time in every process (including DB reader/writer worker lanes), so the
 * build-time `#edition-modules` registration reaches them without threading
 * a function through worker-thread boundaries. A per-call
 * `ComposeAppOverrides.modules.directory?.pinyin` can still be passed
 * explicitly by the composition root.
 */
export function resolveDirectoryPinyin(): DirectoryPinyinPort {
  return resolveEditionModules().directory?.pinyin ?? OPEN_DIRECTORY_PINYIN;
}
