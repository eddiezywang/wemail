/**
 * Edition module bundle — the P2 "port + modules" injection seam.
 *
 * Everything an edition may contribute to the server composition lives in
 * one optional bundle. The open-source edition registers nothing: services
 * receive `undefined` for each slot and fall back to their generic behavior
 * (no office suggestions, no office-mail prefiltering, no extra agent prompt
 * sections, no contributed scene actions).
 *
 * Two injection paths, in precedence order:
 *
 * 1. `ComposeAppOverrides.modules` — per-call override (tests, harnesses).
 * 2. `EDITION_MODULES` — the thin registration entry `#edition-modules`.
 *    The open build binds `#edition-modules` to the committed NO_OP stub
 *    (`editionModules.noop.ts`) through two indirections that must stay in
 *    sync:
 *      - tsconfig `paths` maps the specifier to the stub's `.ts` source so
 *        `typecheck`/`tsc` builds and `tsx`-run tests resolve it in-tree;
 *      - package.json `"imports"` maps it to the stub's compiled
 *        `dist-electron` output for packaged runtime.
 *    An edition build (see wemail-int `internal/src/register.ts`) compiles
 *    its own registration module next to the open output and rebinds the
 *    specifier with a generated `dist-electron/package.json` imports map
 *    (Node resolves `#` specifiers through the *nearest* package scope).
 *
 *    Why not plain tsconfig `paths` substitution? `tsc` does not rewrite
 *    import specifiers in emitted JavaScript, so a `paths` mapping alone can
 *    only change *types*, never which module executes. The package-scope
 *    imports binding is what performs the compile-time-selected, runtime-
 *    static swap without editing any open source file.
 *
 * Later P2 modules (WeCLI runtime = P2.5, allowance/invoice = final)
 * add their own optional typed slots below; `composeApp` threads each one
 * to its service.
 */
import { EDITION_MODULES as REGISTERED_MODULES } from "#edition-modules";
import type { OfficeScenePort } from "../intelligence/officeScenePort.js";
import type { SceneActionContributor } from "../intelligence/MailSceneActionResolver.js";
import type { PromptSections } from "../agent/PiAgentRuntime.js";
import type {
  DirectoryPinyinPort,
  DirectoryRemoteClientFactory,
} from "../directory/DirectoryRemoteClient.js";
import type { EditionWecliModules } from "../skills/wecliPort.js";
import type { EditionAllowanceModules } from "../agent/allowancePort.js";

/**
 * Enterprise-directory contributions (P2.4). The open edition registers
 * neither: DirectoryService falls back to `directory-not-configured` (P1
 * domain gate still rejects non-matching accounts before credentials are
 * read) and DirectoryRepository uses the no-op pinyin port.
 */
export interface EditionDirectoryModules {
  /** Edition-supplied remote client factory; `baseUrl` comes from edition config. */
  clientFactory?: DirectoryRemoteClientFactory;
  /** Edition-supplied pinyin search-index builder (and its index version). */
  pinyin?: DirectoryPinyinPort;
}

/**
 * Remote-image proxy tuning for enterprise-internal image hosts (P3).
 * The open edition registers nothing: `RemoteImageProxy` runs with its
 * default policy (system trust store, private-address blocklist active).
 */
export interface EditionRemoteImageModules {
  /**
   * Skip TLS certificate verification for proxied image fetches — for
   * internal hosts whose certificates are issued by a corporate CA absent
   * from the process trust store. Scope is limited to the outbound
   * image-proxy connection; IMAP/SMTP and every other TLS usage are
   * unaffected. Pair with `trustedHostSuffixes` so only sanctioned internal
   * hosts can be fetched.
   */
  allowInsecureTLS?: boolean;
  /** Enterprise host suffixes exempt from the private-address blocklist. */
  trustedHostSuffixes?: string[];
  /**
   * Edition-supplied transport for proxied image fetches. Defaults to the
   * open build's Node pinned-socket fetch (address-pinned after DNS
   * validation). Editions may supply an alternative — e.g. Electron's
   * `net.fetch`, whose socket I/O runs in the Chromium network-service
   * utility process instead of the main process — where endpoint-security
   * policies gate the main process's sockets. The transport still goes
   * through `RemoteImageProxy`'s SSRF validation, size/format limits and
   * caching; only the socket differs. Invoked with an absolute URL string.
   */
  fetcher?: typeof fetch;
}

/** Optional module bundle injected into the composition root. */
export interface EditionModules {
  /** Optional edition-specific post-send archival, executed outside SMTP. */
  sentArchive?: {
    supports(credential: import("../../../shared/wemail/mailCoreProtocol.js").MailboxCredentialEnvelope): boolean;
    save(input: {
      credential: import("../../../shared/wemail/mailCoreProtocol.js").MailboxCredentialEnvelope;
      draft: import("../../../shared/wemail/mail.js").WemailDraftInput;
      messageId: string;
    }): Promise<void>;
  };
  automationFormContributions?: ReadonlyArray<{
    requires: ReadonlyArray<keyof import("../../../shared/wemail/edition.js").EditionFeatures>;
    contributions: import("../../../shared/wemail/automation.js").AutomationFormContributions;
  }>;
  featurePromptSections?: ReadonlyArray<{
    requires: ReadonlyArray<keyof import("../../../shared/wemail/edition.js").EditionFeatures>;
    sections: PromptSections;
  }>;
  featureSceneActionContributors?: ReadonlyArray<{
    requires: ReadonlyArray<keyof import("../../../shared/wemail/edition.js").EditionFeatures>;
    contributors: readonly SceneActionContributor[];
  }>;
  /** Additional legacy automation capabilities contributed by an edition. */
  automationCapabilities?: Partial<Pick<import("../automation/AutomationCapabilityRegistry.js").AutomationCapabilityCatalog, "processors" | "actions">>;
  /** Legacy collection processor type to workflow capability ID. */
  legacyProcessorCapabilities?: Readonly<Record<string, string>>;
  automationRuleValidation?: {
    validateAction?: (action: unknown, features?: import("../../../shared/wemail/edition.js").EditionFeatures) => boolean;
    validateProcessor?: (processor: unknown) => boolean;
  };
  /**
   * Deterministic office-scene detection. Injected into
   * `AgentHomeSuggestionService` (zero-LLM office suggestions) and
   * `SubscriptionInsightService` (skip LLM classification for clearly
   * non-subscription system mail).
   */
  officeScenes?: OfficeScenePort;
  /**
   * Sections appended to the end of the PI agent system prompt. Edition-only
   * guidance lives here instead of `PI_DEFAULT_SYSTEM_PROMPT`, so the open
   * default prompt stays free of edition-specific behavior text.
   */
  extraPromptSections?: PromptSections;
  /**
   * Additional mail scene actions resolved onto the email detail panel
   * (e.g. edition-specific workflow actions). Contributors run after the
   * built-in summary/report actions; see `MailSceneActionResolver`.
   */
  sceneActionContributors?: readonly SceneActionContributor[];
  /**
   * Enterprise directory client + pinyin implementation. Registering this
   * slot also enables the six directory agent tools when
   * `edition.features.enterpriseDirectory` is on (see composeAgent).
   */
  directory?: EditionDirectoryModules;
  /**
   * Remote-image proxy tuning (P3). Registering this slot replaces the
   * default `RemoteImageProxy` options for the `/api/mail/remote-images`
   * route; absent registration keeps the stock policy.
   */
  remoteImage?: EditionRemoteImageModules;
  /**
   * WeCLI runtime pieces (P2.5). The open edition registers nothing here:
   * no `/api/system/wecli/*` or `/api/skills/wecli/*` routes, no wecli_*
   * agent tools, no installer. An edition build assembles all of them in
   * `wemail-int/internal/src/wecli/index.ts` and registers the bundle from
   * `internal/src/register.ts`.
   */
  wecli?: EditionWecliModules;
  /**
   * Allowance / invoice module (P2.6, the final P2 extraction). The durable
   * action-execution storage schema, the invoice_attachment_statuses
   * table and the mailCoreProtocol invoice fields stay in the open tree for
   * DB compatibility; everything invoice-semantic (attachment discovery,
   * upload, receipts, status store, routes, automation field) re-enters
   * through this slot. The open edition registers nothing: legacy
   * upload_allowance_invoices pending actions confirm to an
   * `allowance-not-wired` typed error, the invoice read side collapses to
   * null and no invoice agent tools / routes / nav are produced.
   */
  allowance?: EditionAllowanceModules;
}

/** Immutable empty bundle: the open edition's registration. */
export const EMPTY_EDITION_MODULES: EditionModules = Object.freeze({});

/**
 * The build-time registration entry. Re-exported (not inlined) so there is
 * exactly one binding site for `#edition-modules` in the tree.
 */
export const EDITION_MODULES: EditionModules =
  REGISTERED_MODULES ?? EMPTY_EDITION_MODULES;

/** Resolve the active bundle: an explicit override wins over the build entry. */
export function resolveEditionModules(override?: EditionModules): EditionModules {
  return override ?? EDITION_MODULES;
}

export function resolveEditionPromptSections(
  modules: EditionModules,
  features: import("../../../shared/wemail/edition.js").EditionFeatures | undefined,
): PromptSections | undefined {
  const enabled: PromptSections[] = [
    ...(modules.extraPromptSections ? [modules.extraPromptSections] : []),
    ...(modules.featurePromptSections ?? [])
      .filter((contribution) => contribution.requires.every((feature) => features?.[feature] === true))
      .map((contribution) => contribution.sections),
  ];
  if (enabled.length === 0) return undefined;
  return (context) => enabled.flatMap((sections) => typeof sections === "function" ? sections(context) : sections);
}

export function resolveAutomationFormContributions(
  modules: EditionModules,
  features: import("../../../shared/wemail/edition.js").EditionFeatures | undefined,
): import("../../../shared/wemail/automation.js").AutomationFormContributions {
  const enabled = (modules.automationFormContributions ?? []).filter((entry) =>
    entry.requires.every((feature) => features?.[feature] === true),
  );
  return {
    processors: enabled.flatMap((entry) => entry.contributions.processors),
    externalActions: enabled.flatMap((entry) => entry.contributions.externalActions),
  };
}
