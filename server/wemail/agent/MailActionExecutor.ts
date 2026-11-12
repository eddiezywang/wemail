/**
 * Default {@link AgentActionExecutor} for the local desktop runtime.
 *
 * Translates a confirmed {@link AgentPendingActionRow} into the
 * underlying mail, configuration, automation, scheduled-send, or wecli
 * primitive. Every operation reaches this class only after the user has
 * confirmed its pending action.
 *
 * Each successful action writes one row to the intelligence audit log
 * (action `agent.action.executed`) so retention/forensics can trace
 * which user-confirmed actions actually ran.
 */
import type {
  AgentActionExecutionContext,
  AgentActionExecutionResult,
  AgentActionExecutor,
} from "./AgentActionExecutor.js";
import type { AgentPendingActionRow } from "./AgentPendingActionRepository.js";
import type { MailProvider } from "../mail/MailProvider.js";
import { randomUUID } from "node:crypto";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { AuditLogService } from "../telemetry/AuditLogService.js";
import type {
  AllowanceInvoicePort,
  AllowancePlatformCommandsPort,
  AllowanceUploadResult,
} from "./allowancePort.js";
import { AllowanceNotWiredError } from "./allowancePort.js";
import type {
  WecliInstallerPort,
  WecliInstallRequest,
  WecliRuntimePort,
  WecliTokenizerPort,
} from "../skills/wecliPort.js";
import { OPEN_WECLI_TOKENIZER } from "../skills/wecliPort.js";
import type { InvoiceStatusPort } from "./allowancePort.js";
import type { AutomationRuleRepository } from "../automation/AutomationRuleRepository.js";
import type { AutomationRuleService } from "../automation/AutomationRuleService.js";
import type { PipelineAutomationRuleService } from "../automation/PipelineAutomationRuleService.js";
import type { AutomationDeferredExecutionRepository } from "../automation/AutomationDeferredExecutionRepository.js";
import type { UserTagRepository } from "../intelligence/UserTagRepository.js";
import type { SmartTagPromptCompiler } from "../intelligence/SmartTagPromptCompiler.js";
import type { IntelligenceResultRepository } from "../intelligence/IntelligenceResultRepository.js";
import type { EmailSmartTagRepository } from "../intelligence/EmailSmartTagRepository.js";
import type { AutomationRule } from "../../../shared/wemail/automation.js";
import type { WemailDraftInput } from "../../../shared/wemail/mail.js";
import type { MailDatabaseAccountRecord } from "../../../shared/wemail/mailDatabaseProtocol.js";
import {
  ensureSignatureHtml,
  ensureSignatureText,
  resolveSignatureIdentity,
} from "../../../shared/wemail/signature.js";
import type { MailCoreMutationParams } from "../../../shared/wemail/mailCoreProtocol.js";
import type { ScheduledSendService } from "../mail/ScheduledSendService.js";
import type { DirectoryService } from "../directory/DirectoryService.js";
import type { AiProfileSettingsService } from "../settings/AiProfileSettingsService.js";
import type { BusinessPreferenceService } from "../settings/BusinessPreferenceService.js";
import { assertValidAutomationRuleDraft } from "../automation/AutomationRuleValidation.js";
import type { ConfigurationWorkflowService } from "../configuration/ConfigurationWorkflowService.js";
import { ConfigurationFailureAdapter } from "../configuration/ConfigurationFailureAdapter.js";
import { isConfirmationRequiredAction } from "./AgentOperationPolicy.js";

export interface MailActionExecutorOptions {
  mailProvider: MailProvider;
  mailDatabase: MailDatabaseClient;
  directoryService?: Pick<DirectoryService, "getContact">;
  audit: AuditLogService;
  /** Defaults to "Archive". Override for non-Gmail providers / tests. */
  archiveFolder?: string;
  /** Defaults to "Trash". */
  trashFolder?: string;
  /** Defaults to "Spam". */
  spamFolder?: string;
  /** Edition allowance service; absent in the open edition (P2.6). */
  allowance?: Pick<AllowanceInvoicePort, "uploadFromMailAttachments">;
  /**
   * Edition platform-command semantics (delete-command assembly +
   * receipt-field parsing); absent in the open edition (P2.6 round 8).
   * Without it a confirmed legacy `delete_allowance_invoices` action
   * fails closed with the typed `allowance-not-wired` error.
   */
  allowancePlatformCommands?: AllowancePlatformCommandsPort;
  wecli?: WecliRuntimePort;
  /** Edition-supplied installer; absent in the open edition. */
  wecliInstaller?: WecliInstallerPort;
  /** Edition-supplied install descriptor used to validate confirmed actions. */
  wecliInstallRequest?: WecliInstallRequest;
  /** Edition-supplied tokenizer (falls back to the neutral open tokenizer). */
  tokenize?: WecliTokenizerPort;
  invoiceStatuses?: InvoiceStatusPort;
  automationRules?: AutomationRuleRepository;
  automationRuleService?: AutomationRuleService;
  pipelineAutomationRuleService?: PipelineAutomationRuleService;
  configurationWorkflow?: ConfigurationWorkflowService;
  deferredExecutions?: AutomationDeferredExecutionRepository;
  userTags?: UserTagRepository;
  smartTagPromptCompiler?: SmartTagPromptCompiler;
  intelligenceResults?: Pick<IntelligenceResultRepository, "removeTagFromAccount">;
  emailSmartTags?: Pick<EmailSmartTagRepository, "removeByTag">;
  scheduledSend?: ScheduledSendService;
  aiProfile?: AiProfileSettingsService;
  businessPreferences?: BusinessPreferenceService;
  onSmartTagConfigurationChanged?: (accountId: string) => void | Promise<void>;
  getUnsubscribeUrl?: (emailId: string) => Promise<string | null>;
  runAutomationRule?: (ruleId: string) => Promise<AgentActionExecutionResult>;
  /**
   * Edition-injected outbound brand link for the appended signature.
   * Empty/undefined = plain-text brand footer (open-source default).
   */
  signatureBrandUrl?: string;
}

const DEFAULT_ARCHIVE_FOLDER = "Archive";
const DEFAULT_TRASH_FOLDER = "Trash";
const DEFAULT_SPAM_FOLDER = "Spam";

function mapAllowanceError(error?: string): string | undefined {
  if (!error) return undefined;
  if (error === "wecli-nonzero-exit") return "上传命令返回失败";
  if (error === "attachment-not-found") return "未找到附件";
  if (
    error === "attachment fetch not supported" ||
    error === "attachment-fetch-failed" ||
    error === "ATTACHMENT_SERVICE_UNAVAILABLE" ||
    error === "Mail Core is unavailable" ||
    error === "account-runtime-unavailable"
  ) return "WeMail 暂时无法读取邮件附件";
  return error;
}

function allowanceExecutionResult(
  result: AllowanceUploadResult,
  requestedCount: number,
): AgentActionExecutionResult {
  const items = result.results.map((item) => ({
    ...(item.filename ? { filename: item.filename } : {}),
    ok: item.ok,
    ...(item.command ? { command: item.command } : {}),
    ...(item.binary ? { binary: item.binary } : {}),
    ...(item.resolvedBinary ? { resolvedBinary: item.resolvedBinary } : {}),
    ...(item.args ? { args: item.args } : {}),
    ...(item.errorCode ? { errorCode: item.errorCode } : {}),
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(item.auditId ? { auditId: item.auditId } : {}),
    ...(item.stdout !== undefined ? { stdout: item.stdout } : {}),
    ...(item.stderr !== undefined ? { stderr: item.stderr } : {}),
    ...(mapAllowanceError(item.error) ? { error: mapAllowanceError(item.error) } : {}),
  }));
  const successCount = items.length > 0
    ? items.filter((item) => item.ok).length
    : result.ok
      ? requestedCount
      : 0;
  const failureCount = items.length > 0 ? items.length - successCount : 0;
  return {
    ok: result.ok,
    summary: result.ok
      ? `上传完成：${successCount} 个附件已上传到发票平台。`
      : `上传未完成：成功 ${successCount} 个，失败 ${failureCount} 个。`,
    successCount,
    failureCount,
    items,
  };
}

function genericSuccess(description: string): AgentActionExecutionResult {
  return {
    ok: true,
    summary: `已完成：${description}`,
  };
}

export class MailActionExecutor implements AgentActionExecutor {
  private readonly mailProvider: MailProvider;
  private readonly mailDatabase: MailDatabaseClient;
  private readonly directoryService?: Pick<DirectoryService, "getContact">;
  private readonly audit: AuditLogService;
  private readonly archiveFolder: string;
  private readonly trashFolder: string;
  private readonly spamFolder: string;
  private readonly allowance?: Pick<AllowanceInvoicePort, "uploadFromMailAttachments">;
  private readonly allowancePlatformCommands?: AllowancePlatformCommandsPort;
  private readonly wecli?: WecliRuntimePort;
  private readonly wecliInstaller?: WecliInstallerPort;
  private readonly wecliInstallRequest?: WecliInstallRequest;
  private readonly tokenize: WecliTokenizerPort;
  private readonly invoiceStatuses?: InvoiceStatusPort;
  private readonly automationRules?: AutomationRuleRepository;
  private readonly automationRuleService?: AutomationRuleService;
  private readonly pipelineAutomationRuleService?: PipelineAutomationRuleService;
  private readonly configurationWorkflow?: ConfigurationWorkflowService;
  private readonly deferredExecutions?: AutomationDeferredExecutionRepository;
  private readonly userTags?: UserTagRepository;
  private readonly smartTagPromptCompiler?: SmartTagPromptCompiler;
  private readonly intelligenceResults?: Pick<IntelligenceResultRepository, "removeTagFromAccount">;
  private readonly emailSmartTags?: Pick<EmailSmartTagRepository, "removeByTag">;
  private readonly scheduledSend?: ScheduledSendService;
  private readonly aiProfile?: AiProfileSettingsService;
  private readonly businessPreferences?: BusinessPreferenceService;
  private readonly onSmartTagConfigurationChanged?: (accountId: string) => void | Promise<void>;
  private readonly getUnsubscribeUrl?: (emailId: string) => Promise<string | null>;
  private readonly runAutomationRule?: (ruleId: string) => Promise<AgentActionExecutionResult>;
  private readonly signatureBrandUrl?: string;
  private readonly configurationFailures = new ConfigurationFailureAdapter();

  constructor(options: MailActionExecutorOptions) {
    this.mailProvider = options.mailProvider;
    this.mailDatabase = options.mailDatabase;
    this.directoryService = options.directoryService;
    this.audit = options.audit;
    this.archiveFolder = options.archiveFolder ?? DEFAULT_ARCHIVE_FOLDER;
    this.trashFolder = options.trashFolder ?? DEFAULT_TRASH_FOLDER;
    this.spamFolder = options.spamFolder ?? DEFAULT_SPAM_FOLDER;
    this.allowance = options.allowance;
    this.allowancePlatformCommands = options.allowancePlatformCommands;
    this.wecli = options.wecli;
    // P2.5: no implicit internal installer. The open edition has none, so a
    // stale install_wecli action fails with wecli-not-wired instead of
    // reaching a private registry.
    this.wecliInstaller = options.wecliInstaller;
    this.wecliInstallRequest = options.wecliInstallRequest;
    this.tokenize = options.tokenize ?? OPEN_WECLI_TOKENIZER;
    this.invoiceStatuses = options.invoiceStatuses;
    this.automationRules = options.automationRules;
    this.automationRuleService = options.automationRuleService;
    this.pipelineAutomationRuleService = options.pipelineAutomationRuleService;
    this.configurationWorkflow = options.configurationWorkflow;
    this.deferredExecutions = options.deferredExecutions;
    this.userTags = options.userTags;
    this.smartTagPromptCompiler = options.smartTagPromptCompiler;
    this.intelligenceResults = options.intelligenceResults;
    this.emailSmartTags = options.emailSmartTags;
    this.scheduledSend = options.scheduledSend;
    this.aiProfile = options.aiProfile;
    this.businessPreferences = options.businessPreferences;
    this.onSmartTagConfigurationChanged = options.onSmartTagConfigurationChanged;
    this.getUnsubscribeUrl = options.getUnsubscribeUrl;
    this.runAutomationRule = options.runAutomationRule;
    this.signatureBrandUrl = options.signatureBrandUrl?.trim() || undefined;
  }

  private async mutate(
    accountId: string | undefined,
    emailId: string,
    mutation: MailCoreMutationParams["mutation"],
  ): Promise<boolean> {
    if (!accountId) throw new Error("missing-accountId");
    const result = await this.mailDatabase.mutateMail(
      { accountId, emailId, mutation },
      `agent:${accountId}:${emailId}:${randomUUID()}`,
    );
    return result.value.status === "applied";
  }

  private async addDefaultSignature(
    draft: WemailDraftInput,
  ): Promise<WemailDraftInput> {
    let account: MailDatabaseAccountRecord["account"] | undefined;
    try {
      account = (await this.mailDatabase.listAccounts()).find(
        (record) => record.account.id === draft.accountId,
      )?.account;
    } catch {
      // Signature metadata must not turn a confirmed send into a failed send.
    }
    let directoryName: string | undefined;
    try {
      if (account?.emailAddress) directoryName = (await this.directoryService?.getContact(draft.accountId, account.emailAddress))?.name;
    } catch {
      // Optional directory metadata must not fail a confirmed send.
    }
    const identity = resolveSignatureIdentity({
      directoryName,
      displayName: account?.displayName,
      emailAddress: account?.emailAddress,
    });
    const bodyHtml =
      typeof draft.bodyHtml === "string" && draft.bodyHtml.trim()
        ? draft.bodyHtml
        : draft.bodyText;
    return {
      ...draft,
      bodyText: ensureSignatureText(draft.bodyText, identity),
      bodyHtml: ensureSignatureHtml(bodyHtml, identity, this.signatureBrandUrl),
    };
  }

  async execute(
    action: AgentPendingActionRow,
    context?: AgentActionExecutionContext,
  ): Promise<AgentActionExecutionResult> {
    if (!isConfirmationRequiredAction(action.action_type)) {
      throw new Error("operation-policy-rejected-action");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(action.input_json);
    } catch {
      throw new Error("invalid-input-json");
    }
    const inputJson = (
      parsed && typeof parsed === "object" ? parsed : {}
    ) as Record<string, unknown>;

    const emailId = action.email_id;
    if (
      !emailId &&
      action.action_type !== "upload_allowance_invoices" &&
      action.action_type !== "delete_allowance_invoices" &&
      action.action_type !== "run_wecli_command" &&
      action.action_type !== "install_wecli" &&
      action.action_type !== "run_automation" &&
      action.action_type !== "send" &&
      action.action_type !== "configure_smart_tag" &&
      action.action_type !== "configure_automation_rule" &&
      action.action_type !== "configure_writing_style" &&
      action.action_type !== "schedule_send" &&
      action.action_type !== "cancel_scheduled_send" &&
      action.action_type !== "configure_business_preferences" &&
      action.action_type !== "delete_draft"
    ) {
      throw new Error("missing-emailId");
    }
    const targetEmailId = emailId ?? "";
    if (targetEmailId && context?.accountId) {
      const message = await this.mailDatabase.getMailSnapshot(targetEmailId);
      if (!message.message || message.message.accountId !== context.accountId) {
        throw new Error("email-account-mismatch");
      }
    }

    let targetFolder: string | undefined;
    let execution: AgentActionExecutionResult | undefined;
    switch (action.action_type) {
      case "archive": {
        targetFolder = this.archiveFolder;
        const moved = await this.mutate(context?.accountId, targetEmailId, { type: "move", folder: targetFolder });
        if (!moved) throw new Error("move-target-not-found");
        execution = genericSuccess(action.description);
        break;
      }
      case "move": {
        // `propose_action` nests args under `details`; older callers
        // (and direct API users) put them at the top level. Accept both.
        const details =
          inputJson.details && typeof inputJson.details === "object"
            ? (inputJson.details as Record<string, unknown>)
            : undefined;
        const requested = details?.targetFolder ?? inputJson.targetFolder;
        if (typeof requested !== "string" || requested.length === 0) {
          throw new Error("move-requires-targetFolder");
        }
        targetFolder = requested;
        const moved = await this.mutate(context?.accountId, targetEmailId, { type: "move", folder: targetFolder });
        if (!moved) throw new Error("move-target-not-found");
        execution = genericSuccess(action.description);
        break;
      }
      case "delete": {
        targetFolder = this.trashFolder;
        const moved = await this.mutate(context?.accountId, targetEmailId, { type: "trash" });
        if (!moved) throw new Error("move-target-not-found");
        execution = genericSuccess(action.description);
        break;
      }
      case "mark_spam": {
        targetFolder = this.spamFolder;
        const moved = await this.mutate(context?.accountId, targetEmailId, { type: "move", folder: targetFolder });
        if (!moved) throw new Error("move-target-not-found");
        execution = genericSuccess(action.description);
        break;
      }
      case "upload_allowance_invoices": {
        // P2.6: legacy confirmed actions fail closed with the typed
        // "allowance-not-wired" error when the edition module is absent.
        if (!this.allowance) throw new AllowanceNotWiredError();
        const rawItems = Array.isArray(inputJson.items) ? inputJson.items : [];
        const items = rawItems
          .map((item) =>
            item && typeof item === "object"
              ? (item as Record<string, unknown>)
              : undefined,
          )
          .filter(
            (item): item is { emailId: string; attachmentId: string } =>
              typeof item?.emailId === "string" &&
              typeof item.attachmentId === "string",
          );
        if (items.length === 0) throw new Error("allowance-requires-items");
        const accountId = context?.accountId;
        if (!accountId) throw new Error("missing-accountId");
        const uploadResult = await this.allowance.uploadFromMailAttachments({
          accountId,
          approvedBy: `user:${accountId}`,
          items,
        });
        this.recordAllowanceUploadStatuses(accountId, uploadResult);
        execution = allowanceExecutionResult(uploadResult, items.length);
        break;
      }
      case "run_wecli_command": {
        if (!this.wecli) throw new Error("wecli-not-wired");
        const command =
          typeof inputJson.command === "string" ? inputJson.command.trim() : "";
        if (!command) throw new Error("wecli-command-required");
        const accountId = context?.accountId;
        if (!accountId) throw new Error("missing-accountId");
        const wecliResult = await this.wecli.run(command, { approvedBy: `user:${accountId}` });
        if (wecliResult.exitCode === 0) {
          this.recordAllowanceDeleteStatuses({
            accountId,
            command,
            stdout: wecliResult.stdout,
            stderr: wecliResult.stderr,
          });
          this.recordAllowancePlatformSnapshot({ accountId, command, stdout: wecliResult.stdout });
        }
        execution = {
          ok: wecliResult.exitCode === 0,
          summary:
            wecliResult.exitCode === 0
              ? `已完成：${action.description}`
              : "执行未完成：命令返回失败。",
          successCount: wecliResult.exitCode === 0 ? 1 : 0,
          failureCount: wecliResult.exitCode === 0 ? 0 : 1,
          items: [
            {
              ok: wecliResult.exitCode === 0,
              command,
              exitCode: wecliResult.exitCode,
              auditId: wecliResult.auditId,
              stdout: wecliResult.stdout,
              stderr: wecliResult.stderr,
              error: wecliResult.exitCode === 0 ? undefined : "命令返回失败",
            },
          ],
        };
        break;
      }
      case "install_wecli": {
        const command =
          typeof inputJson.command === "string" ? inputJson.command : "";
        const packageName =
          typeof inputJson.package === "string" ? inputJson.package : "";
        const registry =
          typeof inputJson.registry === "string" ? inputJson.registry : "";
        const request = this.wecliInstallRequest;
        if (
          !request ||
          command !== request.command ||
          packageName !== request.packageName ||
          registry !== request.registry
        ) {
          throw new Error(request ? "invalid-wecli-install-request" : "wecli-not-wired");
        }
        if (!this.wecliInstaller) throw new Error("wecli-not-wired");
        const installResult = await this.wecliInstaller.install();
        const ok = installResult.exitCode === 0 && !installResult.timedOut;
        execution = {
          ok,
          summary: ok
            ? "WeCLI 安装完成。请重新执行刚才需要 WeCLI 的操作。"
            : "WeCLI 安装未完成。请确认当前处于企业内网环境，并检查 npm 全局安装权限。",
          successCount: ok ? 1 : 0,
          failureCount: ok ? 0 : 1,
          items: [
            {
              filename: "WeCLI",
              ok,
              command: installResult.command,
              exitCode: installResult.exitCode,
              stdout: installResult.stdout,
              stderr: installResult.stderr,
              error: ok
                ? undefined
                : installResult.timedOut
                  ? "安装命令执行超时"
                  : "安装命令返回失败",
            },
          ],
        };
        break;
      }
      case "delete_allowance_invoices": {
        // P2.6 round 8: the platform delete command is edition semantics
        // (assembled and validated by the module's contribution). Without
        // the module a confirmed legacy action must not execute — it raises
        // the typed "allowance-not-wired" error, exactly like upload.
        if (!this.allowancePlatformCommands) throw new AllowanceNotWiredError();
        if (!this.wecli) throw new Error("wecli-not-wired");
        const rawInvoiceIds = Array.isArray(inputJson.invoiceIds)
          ? inputJson.invoiceIds
          : [];
        const invoiceIds = rawInvoiceIds
          .map((value) => stringField(value))
          .filter((id): id is string => !!id);
        if (invoiceIds.length === 0) throw new Error("allowance-delete-invoiceIds-required");
        const command = this.allowancePlatformCommands.buildDeleteCommand(invoiceIds);
        if (typeof inputJson.command === "string" && inputJson.command.trim()) {
          if (!this.allowancePlatformCommands.isEquivalentDeleteCommand(inputJson.command, invoiceIds, this.tokenize)) {
            throw new Error("invalid-allowance-delete-command");
          }
        }
        const accountId = context?.accountId;
        if (!accountId) throw new Error("missing-accountId");
        const wecliResult = await this.wecli.run(command, { approvedBy: `user:${accountId}` });
        if (wecliResult.exitCode === 0) {
          this.recordAllowanceDeleteStatuses({
            accountId,
            invoiceIds,
            command,
            stdout: wecliResult.stdout,
            stderr: wecliResult.stderr,
          });
        }
        execution = {
          ok: wecliResult.exitCode === 0,
          summary:
            wecliResult.exitCode === 0
              ? `已完成：${action.description}`
              : "删除未完成：命令返回失败。",
          successCount: wecliResult.exitCode === 0 ? 1 : 0,
          failureCount: wecliResult.exitCode === 0 ? 0 : 1,
          items: [
            {
              ok: wecliResult.exitCode === 0,
              command,
              exitCode: wecliResult.exitCode,
              auditId: wecliResult.auditId,
              stdout: wecliResult.stdout,
              stderr: wecliResult.stderr,
              error: wecliResult.exitCode === 0 ? undefined : "命令返回失败",
            },
          ],
        };
        break;
      }
      case "send": {
        const accountId = context?.accountId;
        if (!accountId) throw new Error("missing-accountId");
        if (inputJson.accountId !== accountId) throw new Error("email-account-mismatch");
        const draftInput = inputJson as unknown as WemailDraftInput;
        if (!Array.isArray(draftInput.to) || draftInput.to.length === 0) {
          throw new Error("recipient-required");
        }
        if (typeof draftInput.subject !== "string" || typeof draftInput.bodyText !== "string") {
          throw new Error("invalid-send-draft");
        }
        const draft = await this.addDefaultSignature(draftInput);
        const sentDraftId = stringField(inputJson.draftId);
        const result = await this.mailDatabase.enqueueSend({
          ...draft,
          attachments: [],
          ...(sentDraftId ? { draftId: sentDraftId } : {}),
          idempotencyKey: `agent-send:${accountId}:${action.id}`,
        });
        execution = {
          ok: true,
          summary: `邮件已进入规范发件队列：${draft.subject}`,
          successCount: 1,
          failureCount: 0,
          items: [{
            ok: true,
            auditId: result.value.outboxId,
            messageId: result.value.messageIdHeader,
          }],
        };
        break;
      }
      case "configure_smart_tag": {
        if (!this.userTags) throw new Error("smart-tag-service-not-wired");
        const accountId = context?.accountId;
        if (!accountId || inputJson.accountId !== accountId) throw new Error("cross-account-action");
        const operation = stringField(inputJson.operation);
        const tagId = stringField(inputJson.tagId);
        if (operation === "create") {
          const name = stringField(inputJson.name);
          if (!name) throw new Error("smart-tag-name-required");
          assertSmartTagFields(name, inputJson.description, inputJson.prompt);
          const description = typeof inputJson.description === "string"
            ? inputJson.description
            : typeof inputJson.prompt === "string" ? inputJson.prompt : "";
          const prompt = this.smartTagPromptCompiler
            ? await this.smartTagPromptCompiler.compile({ name, description })
            : typeof inputJson.prompt === "string" ? inputJson.prompt : undefined;
          this.userTags.upsert({
            accountId,
            name,
            description,
            prompt,
          });
        } else if (operation === "update") {
          if (!tagId) throw new Error("tagId-required");
          const existing = this.userTags.getById(tagId);
          if (!existing || existing.accountId !== accountId) throw new Error("smart-tag-not-found");
          assertSmartTagFields(
            typeof inputJson.name === "string" ? inputJson.name : existing.name,
            inputJson.description,
            inputJson.prompt,
          );
          const name = typeof inputJson.name === "string" ? inputJson.name : existing.name;
          const description = typeof inputJson.description === "string"
            ? inputJson.description
            : typeof inputJson.prompt === "string" ? inputJson.prompt : existing.description;
          const prompt = this.smartTagPromptCompiler
            ? await this.smartTagPromptCompiler.compile({ name, description })
            : typeof inputJson.prompt === "string" ? inputJson.prompt : existing.prompt;
          this.userTags.updateById({
            id: tagId,
            name,
            description,
            prompt,
          });
        } else if (operation === "delete") {
          if (!tagId) throw new Error("tagId-required");
          const existing = this.userTags.getById(tagId);
          if (!existing || existing.accountId !== accountId) throw new Error("smart-tag-not-found");
          this.intelligenceResults?.removeTagFromAccount(accountId, existing.name);
          this.emailSmartTags?.removeByTag(tagId);
          this.userTags.deleteById(tagId);
        } else {
          throw new Error("invalid-smart-tag-operation");
        }
        if (operation === "create" || operation === "update") {
          await this.onSmartTagConfigurationChanged?.(accountId);
        }
        execution = genericSuccess(action.description);
        break;
      }
      case "configure_automation_rule": {
        if (!this.automationRules) throw new Error("automation-service-not-wired");
        const accountId = context?.accountId;
        if (!accountId || inputJson.accountId !== accountId) throw new Error("cross-account-action");
        const operation = stringField(inputJson.operation);
        const ruleId = stringField(inputJson.ruleId);
        const rule = inputJson.rule && typeof inputJson.rule === "object"
          ? inputJson.rule as Omit<AutomationRule, "id" | "createdAt" | "updatedAt">
          : undefined;
        const previewId = typeof inputJson.previewId === "string" ? inputJson.previewId : undefined;
        const ruleHash = typeof inputJson.ruleHash === "string" ? inputJson.ruleHash : undefined;
        const pipelineVersion = inputJson.pipelineVersion === 2 ? 2 : 1;
        const configurationTaskId = typeof inputJson.configurationTaskId === "string"
          ? inputJson.configurationTaskId
          : undefined;
        if (operation === "create") {
          if (pipelineVersion === 2 && previewId && ruleHash && this.pipelineAutomationRuleService) {
            let committed;
            try {
              committed = await this.pipelineAutomationRuleService.commit({ accountId, previewId, ruleHash });
            } catch (error) {
              if (configurationTaskId && this.configurationWorkflow) {
                const task = this.configurationWorkflow.get(configurationTaskId, accountId);
                if (task) {
                  const failed = this.configurationFailures.failed({
                    error,
                    phase: "commit_configuration",
                    provider: "automation-pipeline",
                    effectState: "none",
                  });
                  this.configurationWorkflow.block({
                    taskId: task.id,
                    accountId,
                    expectedRevision: task.revision,
                    issue: failed.issue,
                  });
                }
              }
              throw error;
            }
            if (configurationTaskId && this.configurationWorkflow) {
              const task = this.configurationWorkflow.get(configurationTaskId, accountId);
              if (!task) throw new Error("configuration-task-not-found");
              const verifying = this.configurationWorkflow.recordCommittedReference({
                taskId: task.id,
                accountId,
                expectedRevision: task.revision,
                resourceId: committed.id,
                version: committed.version,
                hash: ruleHash,
                effectType: "automation-rule-created",
                summary: `自动化规则“${committed.name}”已创建`,
              });
              const persisted = this.automationRules.getV2(committed.id);
              if (!persisted || persisted.accountId !== accountId || persisted.version !== committed.version) {
                throw new Error("automation-rule-verification-failed");
              }
              this.configurationWorkflow.completeVerified({
                taskId: verifying.id,
                accountId,
                expectedRevision: verifying.revision,
              });
            }
            execution = genericSuccess(action.description);
            break;
          }
          if (previewId && ruleHash && this.automationRuleService) {
            this.automationRuleService.commit({ accountId, previewId, ruleHash });
            execution = genericSuccess(action.description);
            break;
          }
          if (!rule || rule.accountId !== accountId) throw new Error("invalid-automation-rule");
          assertValidAutomationRuleDraft(rule);
          this.automationRules.create(rule);
        } else {
          if (!ruleId) throw new Error("ruleId-required");
          const existing = this.automationRules.get(ruleId);
          if (!existing || existing.accountId !== accountId) throw new Error("automation-rule-not-found");
          if (operation === "update") {
            if (previewId && ruleHash && this.automationRuleService) {
              this.deferredExecutions?.cancelForRule(ruleId);
              this.automationRuleService.commit({ accountId, previewId, ruleHash });
              execution = genericSuccess(action.description);
              break;
            }
            if (!rule || rule.accountId !== accountId) throw new Error("invalid-automation-rule");
            assertValidAutomationRuleDraft(rule);
            this.deferredExecutions?.cancelForRule(ruleId);
            this.automationRules.update(ruleId, rule);
          } else if (operation === "enable" || operation === "disable") {
            if (operation === "disable") this.deferredExecutions?.cancelForRule(ruleId);
            this.automationRules.update(ruleId, { enabled: operation === "enable" });
          } else if (operation === "delete") {
            this.deferredExecutions?.cancelForRule(ruleId);
            this.automationRules.delete(ruleId);
          } else {
            throw new Error("invalid-automation-operation");
          }
        }
        execution = genericSuccess(action.description);
        break;
      }
      case "configure_writing_style": {
        if (!this.aiProfile) throw new Error("writing-style-service-not-wired");
        const operation = stringField(inputJson.operation);
        const styleId = stringField(inputJson.styleId);
        if (operation === "create") {
          const name = stringField(inputJson.name);
          const instructions = stringField(inputJson.instructions);
          if (!name || !instructions) throw new Error("style-name-instructions-required");
          this.aiProfile.createStyle({
            name,
            instructions,
            description: typeof inputJson.description === "string" ? inputJson.description : undefined,
          });
        } else if (operation === "update") {
          if (!styleId) throw new Error("styleId-required");
          const updated = this.aiProfile.updateStyle(styleId, {
            name: typeof inputJson.name === "string" ? inputJson.name : undefined,
            description: typeof inputJson.description === "string" ? inputJson.description : undefined,
            instructions: typeof inputJson.instructions === "string" ? inputJson.instructions : undefined,
          });
          if (!updated) throw new Error("writing-style-not-found");
        } else if (operation === "delete") {
          if (!styleId || !this.aiProfile.deleteStyle(styleId)) throw new Error("writing-style-not-found");
        } else {
          throw new Error("invalid-style-operation");
        }
        execution = genericSuccess(action.description);
        break;
      }
      case "schedule_send": {
        if (!this.scheduledSend) throw new Error("scheduled-send-service-not-wired");
        const accountId = context?.accountId;
        const draftInput = inputJson.draft as WemailDraftInput | undefined;
        const sendAt = stringField(inputJson.sendAt);
        if (!accountId || !draftInput || draftInput.accountId !== accountId || !sendAt) {
          throw new Error("invalid-scheduled-send");
        }
        if (
          typeof draftInput.subject !== "string" ||
          typeof draftInput.bodyText !== "string"
        ) {
          throw new Error("invalid-scheduled-send");
        }
        const draft = await this.addDefaultSignature(draftInput);
        const scheduled = await this.scheduledSend.schedule(draft, sendAt);
        execution = {
          ok: true,
          summary: `邮件已安排在 ${scheduled.sendAt} 发送`,
          successCount: 1,
          failureCount: 0,
          items: [{ ok: true, auditId: scheduled.id }],
        };
        break;
      }
      case "cancel_scheduled_send": {
        if (!this.scheduledSend) throw new Error("scheduled-send-service-not-wired");
        const accountId = context?.accountId;
        const scheduledId = stringField(inputJson.scheduledId);
        const owned = accountId && scheduledId
          ? (await this.scheduledSend.listScheduled(accountId)).some((item) => item.id === scheduledId)
          : false;
        if (!owned || !scheduledId || !accountId || !await this.scheduledSend.cancel(scheduledId, accountId)) {
          throw new Error("scheduled-mail-not-found-or-not-pending");
        }
        execution = genericSuccess(action.description);
        break;
      }
      case "permanent_delete": {
        if (!await this.mutate(context?.accountId, targetEmailId, { type: "delete" })) {
          throw new Error("mail-not-found");
        }
        execution = genericSuccess(action.description);
        break;
      }
      case "delete_draft": {
        const accountId = context?.accountId;
        const draftId = stringField(inputJson.draftId);
        if (!accountId || inputJson.accountId !== accountId || !draftId) {
          throw new Error("draft-not-found");
        }
        const deleted = await this.mailDatabase.deleteDraft({ accountId, id: draftId });
        if (!deleted.value) throw new Error("draft-delete-failed");
        execution = genericSuccess(action.description);
        break;
      }
      case "bulk_mail_operation": {
        const accountId = context?.accountId;
        const operation = stringField(inputJson.operation);
        const emailIds = Array.isArray(inputJson.emailIds)
          ? inputJson.emailIds.map(stringField).filter((item): item is string => !!item).slice(0, 100)
          : [];
        if (!accountId || !operation || emailIds.length === 0) throw new Error("invalid-bulk-mail-operation");
        if (!["move", "archive", "trash", "spam", "restore", "permanent_delete"].includes(operation)) {
          throw new Error("invalid-bulk-mail-operation");
        }
        const items = await Promise.all(emailIds.map(async (id) => {
          const snapshot = await this.mailDatabase.getMailSnapshot(id);
          if (!snapshot.message || snapshot.message.accountId !== accountId) {
            return { ok: false, error: "mail-not-found" };
          }
          const target = operation === "archive"
            ? this.archiveFolder
            : operation === "trash"
              ? this.trashFolder
              : operation === "spam"
                ? this.spamFolder
                : operation === "restore"
                  ? "INBOX"
                  : stringField(inputJson.targetFolder);
          const ok = operation === "permanent_delete"
            ? await this.mutate(accountId, id, { type: "delete" })
            : operation === "trash"
              ? await this.mutate(accountId, id, { type: "trash" })
              : !!target && await this.mutate(accountId, id, { type: "move", folder: target });
          return { ok, error: ok ? undefined : "mail-operation-failed" };
        }));
        const successCount = items.filter((item) => item.ok).length;
        execution = {
          ok: successCount === items.length,
          summary: `批量邮件操作完成：成功 ${successCount}，失败 ${items.length - successCount}`,
          successCount,
          failureCount: items.length - successCount,
          items,
        };
        break;
      }
      case "configure_business_preferences": {
        if (!this.businessPreferences) throw new Error("business-preferences-not-wired");
        if (!inputJson.patch || typeof inputJson.patch !== "object" || Array.isArray(inputJson.patch)) {
          throw new Error("preference-change-required");
        }
        this.businessPreferences.save(inputJson.patch as Parameters<BusinessPreferenceService["save"]>[0]);
        execution = genericSuccess(action.description);
        break;
      }
      case "unsubscribe": {
        const details = inputJson.details && typeof inputJson.details === "object"
          ? inputJson.details as Record<string, unknown>
          : {};
        const url = stringField(details.url ?? inputJson.url) ??
          await this.getUnsubscribeUrl?.(targetEmailId) ??
          undefined;
        if (!url) throw new Error("unsubscribe-url-not-found");
        if (/^mailto:/i.test(url)) {
          const accountId = context?.accountId;
          if (!accountId) throw new Error("missing-accountId");
          const parsed = new URL(url);
          const recipient = decodeURIComponent(parsed.pathname);
          if (!recipient) throw new Error("invalid-unsubscribe-mailto");
          const subject = parsed.searchParams.get("subject") ?? "unsubscribe";
          const bodyText = parsed.searchParams.get("body") ?? "unsubscribe";
          await this.mailProvider.sendDraft({
            accountId,
            to: [{ email: recipient }],
            subject,
            bodyText,
            bodyHtml: bodyText,
          });
        } else {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new Error("unsupported-unsubscribe-url");
          }
          const response = await fetch(parsed, {
            method: "GET",
            redirect: "follow",
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error(`unsubscribe-http-${response.status}`);
        }
        execution = genericSuccess(action.description);
        break;
      }
      case "run_automation": {
        if (!this.runAutomationRule) throw new Error("automation-runner-not-wired");
        const details = inputJson.details && typeof inputJson.details === "object"
          ? inputJson.details as Record<string, unknown>
          : {};
        const ruleId = stringField(details.ruleId ?? inputJson.ruleId);
        if (!ruleId) throw new Error("ruleId-required");
        const rule = this.automationRules?.get(ruleId);
        if (!rule || !context?.accountId || rule.accountId !== context.accountId) {
          throw new Error("automation-rule-not-found");
        }
        execution = await this.runAutomationRule(ruleId);
        break;
      }
      default:
        throw new Error(`unknown-actionType: ${action.action_type}`);
    }

    const auditEmailId =
      targetEmailId ||
      (Array.isArray(inputJson.items) &&
      inputJson.items[0] &&
      typeof inputJson.items[0] === "object" &&
      typeof (inputJson.items[0] as Record<string, unknown>).emailId === "string"
        ? ((inputJson.items[0] as Record<string, unknown>).emailId as string)
        : "agent-action");
    this.audit.log({
      emailId: auditEmailId,
      action: "agent.action.executed",
      caller: { source: "agent" },
      result: {
        actionId: action.id,
        actionType: action.action_type,
        targetFolder,
        conversationId: action.conversation_id,
        execution,
        ...(action.action_type === "upload_allowance_invoices"
          ? { itemCount: Array.isArray(inputJson.items) ? inputJson.items.length : 0 }
          : {}),
        ...(action.action_type === "run_wecli_command"
          ? { command: inputJson.command }
          : {}),
        ...(action.action_type === "install_wecli" && this.wecliInstallRequest
          ? {
              command: this.wecliInstallRequest.command,
              registry: this.wecliInstallRequest.registry,
            }
          : {}),
        ...(action.action_type === "delete_allowance_invoices"
          ? { command: inputJson.command, invoiceIds: inputJson.invoiceIds }
          : {}),
      },
    });
    // The mailProvider field is wired today purely so future provider
    // mutations (IMAP MOVE, JMAP move, etc.) can short-circuit through
    // the same executor without rewriting the deps bag. Reference it so
    // strict-mode type-checking doesn't strip it.
    void this.mailProvider;
    return execution ?? genericSuccess(action.description);
  }

  private recordAllowanceUploadStatuses(
    accountId: string,
    result: AllowanceUploadResult,
  ): void {
    if (!this.invoiceStatuses) return;
    for (const item of result.results) {
      if (item.ok) {
        this.invoiceStatuses.markUploaded({
          accountId,
          emailId: item.emailId,
          attachmentId: item.attachmentId,
          filename: item.filename,
          command: item.command,
          stdout: item.stdout,
          stderr: item.stderr,
          // Receipt-field parsing is edition semantics (P2.6 round 8); the
          // open edition (no module) contributes no fields.
          ...this.allowancePlatformCommands?.invoiceFieldsFromUploadItem(item),
        });
      } else {
        this.invoiceStatuses.markFromUploadFailure({
          accountId,
          emailId: item.emailId,
          attachmentId: item.attachmentId,
          filename: item.filename,
          command: item.command,
          stdout: item.stdout,
          stderr: item.stderr,
          error: item.error,
          ...this.allowancePlatformCommands?.invoiceFieldsFromUploadItem(item),
        });
      }
    }
  }

  private recordAllowanceDeleteStatuses(input: {
    accountId: string;
    command: string;
    invoiceIds?: string[];
    stdout?: string;
    stderr?: string;
  }): void {
    if (!this.invoiceStatuses) return;
    const invoiceIds = this.allowancePlatformCommands?.deletedInvoiceIds(
      {
        command: input.command,
        invoiceIds: input.invoiceIds,
        stdout: input.stdout,
      },
      this.tokenize,
    ) ?? [];
    if (invoiceIds.length === 0) return;
    this.invoiceStatuses.markDeletedByInvoiceIds({
      accountId: input.accountId,
      invoiceIds,
      command: input.command,
      stdout: input.stdout,
      stderr: input.stderr,
    });
  }

  private recordAllowancePlatformSnapshot(input: {
    accountId: string;
    command: string;
    stdout?: string;
  }): void {
    // Recognizing the platform list command is edition semantics
    // (P2.6 round 8); the open edition reconciles nothing.
    if (!this.invoiceStatuses || this.allowancePlatformCommands?.isListCommand(input.command) !== true) return;
    this.invoiceStatuses.reconcilePlatformOutput(input);
  }
}


function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function assertSmartTagFields(name: string, description: unknown, prompt: unknown): void {
  if (!name.trim() || name.trim().length > 30) throw new Error("invalid-smart-tag-name");
  if (typeof description === "string" && description.length > 1000) {
    throw new Error("smart-tag-description-too-long");
  }
  if (typeof prompt === "string" && prompt.length > 4000) {
    throw new Error("smart-tag-prompt-too-long");
  }
}
