/**
 * Allowance / invoice ports (P2.6 — "queue stays, semantics move").
 *
 * The allowance invoice upload module moved to the private edition overlay
 * (`wemail-int/internal/src/allowance`). The open tree keeps:
 *
 *   - the *shapes* of everything the retained generic seams consume
 *     (agent tools, the confirmed-action executor, the automation action
 *     executor, the durable action-execution queue, the mail query
 *     repository and the HTTP layer),
 *   - the durable queue infrastructure itself (`ActionExecutionRepository`,
 *     schema v19, the `invoice_attachment_statuses` table and the
 *     `mailCoreProtocol` invoice fields) so both editions can open each
 *     other's data directories,
 *
 * and everything invoice-semantic is injected through this port. The open
 * edition registers nothing: every seam falls back to a structurally-typed
 * "not wired" behavior (`code = "allowance-not-wired"`), legacy
 * `upload_allowance_invoices` pending actions fail closed instead of
 * crashing, and the invoice read side collapses to null/empty.
 *
 * Error identity is a string `code`, not a class — the same rule as
 * `wecliPort` / `directoryRemoteClient`: an edition implementation is
 * compiled into a different package and must never hold a runtime
 * `instanceof` dependency on an open-tree class.
 */
import type { Hono } from "hono";
import type { MailAttachment, MailMessage } from "../../../shared/wemail/mail.js";
import type {
  ActionExecutionCommand,
  ActionExecutionSnapshot,
} from "../../../shared/wemail/actionExecution.js";
import type {
  InvoiceAttachmentStatus,
  InvoiceMailStatusSummary,
} from "../../../shared/wemail/invoice.js";
import type { WecliRunResult, WecliRunOptions } from "../../../shared/wemail/wecliTypes.js";
import type { WecliTokenizerPort } from "../skills/wecliPort.js";
import type { MailDatabase } from "../database/Database.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { FetchAttachmentResult } from "../mail/MailProvider.js";
import { resolveEditionModules } from "../bootstrap/editionModules.js";
import type { EditionModules } from "../bootstrap/editionModules.js";

// ── Structural error identity ──────────────────────────────────────────

export const ALLOWANCE_ERROR_CODES = Object.freeze({
  notWired: "allowance-not-wired",
});

export type AllowanceErrorCode =
  (typeof ALLOWANCE_ERROR_CODES)[keyof typeof ALLOWANCE_ERROR_CODES];

/** Read an edition error's stable `code` without importing its class. */
export function allowanceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

export function isAllowanceErrorCode(error: unknown, code: AllowanceErrorCode): boolean {
  return allowanceErrorCode(error) === code;
}

/** Thrown when a generic open seam is reached without an edition module. */
export class AllowanceNotWiredError extends Error {
  readonly code = ALLOWANCE_ERROR_CODES.notWired;
  constructor() {
    super("allowance module is not available in this edition");
    this.name = "AllowanceNotWiredError";
  }
}

// ── Wire shapes (moved here from the migrated service module) ───────────

export interface InvoiceAttachmentCandidate {
  emailId: string;
  subject: string;
  receivedAt: string;
  from: MailMessage["from"];
  attachment: MailAttachment;
}

export interface AllowanceUploadItem {
  emailId: string;
  attachmentId: string;
}

export interface AllowanceUploadResultItem {
  emailId: string;
  attachmentId: string;
  filename?: string;
  filePath?: string;
  sha256?: string;
  command?: string;
  binary?: string;
  resolvedBinary?: string;
  args?: string[];
  errorCode?: string;
  ok: boolean;
  exitCode?: number;
  auditId?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface AllowanceUploadResult {
  ok: boolean;
  results: AllowanceUploadResultItem[];
}

/** Result of staging one attachment for upload (before the mutation runs). */
export interface AllowancePreparedUpload {
  filename: string;
  filePath: string;
  sha256: string;
  command: string;
}

export interface AllowanceInvoiceSearchResult {
  ok: true;
  candidates: InvoiceAttachmentCandidate[];
  count: number;
  messages: Array<{
    emailId: string;
    subject: string;
    receivedAt: string;
    from: MailMessage["from"];
    attachmentCount: number;
  }>;
  mailCount: number;
  hasMore: boolean;
  nextPage?: number;
}

export interface AllowanceFindInvoiceInput {
  accountId?: string;
  emailId?: string;
  q?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  page?: number;
}

// ── Ports ──────────────────────────────────────────────────────────────

/**
 * The allowance invoice service surface consumed by open seams:
 * `MailAgentTools.find_invoice_attachments`, `MailActionExecutor`
 * (legacy direct upload), `AutomationActionExecutor` (structured
 * `wecli.allowance.upload` step) and the durable execution runner.
 */
export interface AllowanceInvoicePort {
  findInvoiceAttachments(input?: AllowanceFindInvoiceInput): Promise<AllowanceInvoiceSearchResult>;
  uploadFromMailAttachments(input: {
    accountId?: string;
    approvedBy: string;
    items: AllowanceUploadItem[];
  }): Promise<AllowanceUploadResult>;
  prepareUpload(
    item: AllowanceUploadItem & { filename?: string },
    accountId: string,
    signal: AbortSignal,
    allowNonPdf?: boolean,
  ): Promise<AllowancePreparedUpload>;
  submitPreparedUpload(
    command: string,
    approvedBy: string,
    signal: AbortSignal,
  ): Promise<WecliRunResult>;
  verifyUploadedInvoice(
    invoiceNumber: string,
    signal: AbortSignal,
  ): Promise<{ invoiceId: string; invoiceNumber: string } | null>;
}

/**
 * Receipt parsing for the durable queue's DB-lane recovery. The open
 * default recognizes nothing (recovery becomes a no-op), which is safe:
 * rows written by the internal edition keep their recorded phases.
 */
export interface AllowanceReceiptsPort {
  allowanceAuthenticationFailure(result: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }): string | null;
  rejectedAllowanceReceipt(
    parsed: unknown,
    exitCode: number,
  ): { error: string; invoiceNumber?: string } | null;
  selectAllowanceReceipt(
    parsed: unknown,
    knownTaskIds: Set<string>,
  ): { taskId: string; invoiceNumber?: string; invoiceStatus?: string } | null;
}

/**
 * The `invoice_attachment_statuses` store. The open edition has no
 * implementation: reads collapse to null and writes are skipped.
 */
export interface InvoiceStatusPort {
  get(
    emailId: string,
    attachmentId: string,
    accountId?: string,
  ): InvoiceAttachmentStatus | null;
  getMailStatus(emailId: string, accountId?: string): InvoiceMailStatusSummary;
  markUploaded(input: {
    accountId: string;
    emailId: string;
    attachmentId: string;
    filename?: string;
    invoiceId?: string;
    invoiceNumber?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
  }): void;
  markFromUploadFailure(input: {
    accountId: string;
    emailId: string;
    attachmentId: string;
    filename?: string;
    invoiceNumber?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    error?: string;
  }): void;
  markDeletedByInvoiceIds(input: {
    accountId: string;
    invoiceIds: string[];
    command?: string;
    stdout?: string;
    stderr?: string;
  }): number;
  reconcilePlatformOutput(input: {
    accountId: string;
    command: string;
    stdout?: string;
  }): number;
  /**
   * Seed `not_started` rows for a message's PDF attachments (refresh-route
   * bootstrap). Only the edition's route factory calls it.
   */
  ensureNotStartedForInvoiceMessage(
    message: MailMessage,
    options: { invoiceIntent: boolean },
  ): number;
}

/**
 * Durable upload executor (accept/get/subscribe/wake/stop). `agentRoutes`
 * already degrades to `action-execution-unavailable` when it is absent.
 */
export interface ActionExecutionPort {
  readonly available: boolean;
  accept(
    input: Omit<Extract<ActionExecutionCommand, { op: "accept" }>, "op">,
  ): Promise<ActionExecutionSnapshot>;
  get(
    accountId: string,
    actionId: string,
  ): Promise<ActionExecutionSnapshot | null>;
  subscribe(
    listener: (task: ActionExecutionSnapshot) => void,
  ): () => void;
  wake(): void;
  stop(): Promise<void>;
}

/**
 * Business conclusion projected onto the agent conversation after
 * `propose_allowance_invoice_upload` returns (moved here from the PI
 * runtime with the module).
 */
export interface AllowanceProposalConclusion {
  status: "succeeded" | "failed";
  summary: string;
  nextAction?: string;
}

/**
 * Invoice-attachment heuristic contributed by the edition. The open
 * default is `false`: no mail is an invoice candidate, so the built-in
 * `invoice.upload` scene action and the invoice home suggestion never
 * fire.
 */
export type IsInvoiceAttachmentCandidate = (
  attachment: MailAttachment,
  message: MailMessage,
) => boolean;

// ── Suggestion contribution (round 8: semantics leave the open tree) ──

/**
 * What the edition needs to decide whether the focused mail warrants the
 * invoice-upload suggestion. Structural projection of the suggestion
 * builder's context — the port must not import the builder (cycle).
 */
export interface AllowanceSuggestionInput {
  emailId: string;
  accountId?: string;
  /** Projection of the focused mail's summary result (if any). */
  summary?: {
    intent?: string;
    headline?: string;
    bullets?: readonly string[];
  } | null;
  /** Projection of the focused mail envelope (if available). */
  envelope?: {
    subject: string;
    snippet: string;
    from: string;
    attachments?: ReadonlyArray<{ filename?: string; mimetype?: string }>;
  } | null;
}

/**
 * One suggestion candidate contributed by the edition. Shaped so the open
 * suggestion builder can rank it unchanged (`AgentSuggestionItem` plus the
 * builder's internal confidence field).
 */
export interface AllowanceSuggestionContribution {
  id: string;
  label: string;
  prompt: string;
  reason: string;
  priority: number;
  confidence: number;
}

/**
 * Invoice-upload home-suggestion rules contributed by the edition (the
 * invoice-text heuristics and the suggestion copy are edition semantics).
 * Return `undefined` when the mail does not warrant the suggestion. The
 * open edition does not register a contributor, so the open edition never
 * proposes the invoice-upload suggestion.
 */
export type AllowanceSuggestionContributor = (
  input: AllowanceSuggestionInput,
) => AllowanceSuggestionContribution | undefined;

// ── Platform command semantics (round 8: semantics leave the open tree) ──

/** Invoice fields parsed from one platform upload receipt. */
export interface AllowanceInvoiceReceiptFields {
  invoiceId?: string;
  invoiceNumber?: string;
  invoiceSeller?: string;
  invoiceTotal?: string;
  invoiceExpenseType?: string;
}

/**
 * The internal `allowance` platform-command semantics the retained open
 * seams consume: assembling and validating the platform delete command,
 * resolving which invoice ids a finished command deleted, recognizing the
 * platform list command, and parsing upload receipt fields. The open
 * edition registers nothing here, so:
 *
 *   - a confirmed legacy `delete_allowance_invoices` action fails closed
 *     with the typed `allowance-not-wired` error (same rule as upload),
 *   - receipt parsing recognizes nothing (no ids, no fields, no list
 *     commands), which is safe because the invoice status store itself is
 *     only constructed when the module is present.
 */
export interface AllowancePlatformCommandsPort {
  /** Assemble the platform delete command for confirmed invoice ids. */
  buildDeleteCommand(invoiceIds: readonly string[]): string;
  /**
   * Validate a user-supplied delete command against the confirmed ids
   * (guards a confirmed action from executing different parameters).
   */
  isEquivalentDeleteCommand(
    command: unknown,
    invoiceIds: readonly string[],
    tokenize: import("../skills/wecliPort.js").WecliTokenizerPort,
  ): boolean;
  /**
   * Resolve the invoice ids a finished platform command deleted. Empty
   * when the command is not a platform delete or reported nothing.
   */
  deletedInvoiceIds(
    input: {
      command: string;
      invoiceIds?: readonly string[];
      stdout?: string;
    },
    tokenize: import("../skills/wecliPort.js").WecliTokenizerPort,
  ): string[];
  /** Recognize the platform list command (output reconciliation trigger). */
  isListCommand(command: string): boolean;
  /** Parse the invoice fields one upload receipt item carried. */
  invoiceFieldsFromUploadItem(
    item: AllowanceUploadResultItem,
  ): AllowanceInvoiceReceiptFields;
}

// ── Factory inputs ─────────────────────────────────────────────────────

export interface AllowanceInvoiceFactoryInput {
  mailDatabase: MailDatabaseClient;
  wecli: { run(command: string, options?: WecliRunOptions): Promise<WecliRunResult> };
  rootDir: string;
  fetchAttachment: (
    emailId: string,
    attachmentId: string,
    accountId?: string,
  ) => Promise<FetchAttachmentResult | null>;
  now?: () => Date;
}

export interface ActionExecutionFactoryInput {
  mailDatabase: MailDatabaseClient;
  allowance: Pick<
    AllowanceInvoicePort,
    "prepareUpload" | "submitPreparedUpload" | "verifyUploadedInvoice"
  >;
  onError(error: unknown): void;
}

/** `POST /api/mail/messages/:id/invoice-status/refresh` (edition-mounted). */
export interface AllowanceInvoiceRoutesDeps {
  /** Hono instance created by the open HTTP layer and filled by the module. */
  app: Hono;
  mail: CanonicalMailRepository;
  statuses: InvoiceStatusPort;
  wecli: { run(command: string, options?: WecliRunOptions): Promise<WecliRunResult> };
  getActiveAccountId: () => string | undefined;
}

export type AllowanceInvoiceRoutesFactory = (deps: AllowanceInvoiceRoutesDeps) => Hono;

export interface InvoiceIssueDateFieldFactoryInput {
  repository: import("../intelligence/MailSemanticAttributeRepository.js").MailSemanticAttributeRepository;
}

/** Aggregate of everything an edition contributes for the allowance module. */
export interface EditionAllowanceModules {
  createInvoiceService(input: AllowanceInvoiceFactoryInput): AllowanceInvoicePort;
  createActionExecutions(input: ActionExecutionFactoryInput): ActionExecutionPort;
  /** Receipt parsing used inside the DB writer lane's recovery sweep. */
  receipts: AllowanceReceiptsPort;
  /** Per-database invoice store for the composition and the query lanes. */
  createInvoiceStatusStore(db: MailDatabase): InvoiceStatusPort;
  /** `POST /api/mail/messages/:id/invoice-status/refresh` route builder. */
  buildInvoiceRoutes: AllowanceInvoiceRoutesFactory;
  /** Registers the `invoice.issueDate` automation field resolver. */
  createIssueDateFieldProvider(
    input: InvoiceIssueDateFieldFactoryInput,
  ): import("../automation/AutomationFieldRegistry.js").AutomationFieldProvider;
  /**
   * Automation field definitions contributed by the module (appended to the
   * open catalog; the open edition lists only the native `mail.receivedAt`).
   */
  automationFieldDefinitions?: readonly import("../../../shared/wemail/automation.js").AutomationFieldDefinition[];
  /** Invoice-attachment heuristic for the scene-action resolver. */
  isInvoiceAttachmentCandidate: IsInvoiceAttachmentCandidate;
  /** Post-proposal business conclusion for the agent conversation. */
  concludeProposal?(
    toolName: string,
    output: unknown,
  ): AllowanceProposalConclusion | undefined;
  /**
   * Invoice-upload home-suggestion rules (detection heuristics + copy).
   * Absent in the open edition: the open suggestion builder proposes no
   * invoice-upload suggestion.
   */
  buildUploadSuggestion?: AllowanceSuggestionContributor;
  /**
   * Platform command semantics (delete-command assembly/validation and
   * receipt-field parsing). Absent in the open edition: legacy
   * `delete_allowance_invoices` confirms fail closed with
   * `allowance-not-wired` and receipt parsing recognizes nothing.
   */
  platformCommands?: AllowancePlatformCommandsPort;
}

// ── Open defaults (no allowance module, no internal dependency) ─────────

export const OPEN_ALLOWANCE_RECEIPTS: AllowanceReceiptsPort = Object.freeze({
  allowanceAuthenticationFailure: () => null,
  rejectedAllowanceReceipt: () => null,
  selectAllowanceReceipt: () => null,
});

/** Throwing service used when a generic seam runs without the module. */
export const OPEN_ALLOWANCE_SERVICE: AllowanceInvoicePort = Object.freeze({
  async findInvoiceAttachments(): Promise<AllowanceInvoiceSearchResult> {
    throw new AllowanceNotWiredError();
  },
  async uploadFromMailAttachments(): Promise<AllowanceUploadResult> {
    throw new AllowanceNotWiredError();
  },
  async prepareUpload(): Promise<AllowancePreparedUpload> {
    throw new AllowanceNotWiredError();
  },
  async submitPreparedUpload(): Promise<WecliRunResult> {
    throw new AllowanceNotWiredError();
  },
  async verifyUploadedInvoice(): Promise<{ invoiceId: string; invoiceNumber: string } | null> {
    throw new AllowanceNotWiredError();
  },
});

/** The open edition never classifies an attachment as an invoice candidate. */
export const OPEN_IS_INVOICE_ATTACHMENT_CANDIDATE: IsInvoiceAttachmentCandidate =
  () => false;

// ── Resolution helpers (build-time registration + explicit injection) ──

export function resolveAllowanceModules(
  override?: EditionModules,
): EditionAllowanceModules | undefined {
  return (override ?? resolveEditionModules()).allowance;
}

export function resolveIsInvoiceAttachmentCandidate(
  override?: EditionModules,
): IsInvoiceAttachmentCandidate {
  return resolveAllowanceModules(override)?.isInvoiceAttachmentCandidate
    ?? OPEN_IS_INVOICE_ATTACHMENT_CANDIDATE;
}

/**
 * Ports for the durable queue's DB lanes (writer recovery + reader
 * projections). Defaults to the build-time registration; the open build
 * resolves to the no-op receipts and no invoice store.
 */
export interface ActionExecutionLanePorts {
  receipts: AllowanceReceiptsPort;
  invoiceStatuses: InvoiceStatusPort | undefined;
}

export function resolveActionExecutionLanePorts(
  db: MailDatabase,
  override?: EditionModules,
): ActionExecutionLanePorts {
  const modules = resolveAllowanceModules(override);
  return {
    receipts: modules?.receipts ?? OPEN_ALLOWANCE_RECEIPTS,
    invoiceStatuses: modules ? modules.createInvoiceStatusStore(db) : undefined,
  };
}

export function resolveInvoiceStatusStore(
  db: MailDatabase,
  override?: EditionModules,
): InvoiceStatusPort | undefined {
  const modules = resolveAllowanceModules(override);
  return modules ? modules.createInvoiceStatusStore(db) : undefined;
}
