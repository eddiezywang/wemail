import type { MailMessage } from "../../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import { BaseAutomationProvider } from "./BaseAutomationProvider.js";
import type { AutomationCapabilityDescriptor, AutomationProviderContext, AutomationStepPreview, AutomationStepResult, CompiledAutomationStep } from "./AutomationProvider.js";
import { completedAudit } from "./AutomationProvider.js";
import { descriptorFingerprint } from "./AutomationProviderRegistry.js";

export class MailAutomationProvider extends BaseAutomationProvider {
  readonly id = "mail";
  readonly version = "1";
  constructor(private readonly mail: CanonicalMailRepository) { super(); }

  protected capabilities(): AutomationCapabilityDescriptor[] {
    return [
      descriptor(this.id, "messages.collect", "收集邮件", "使用运行上下文中的有界邮件集合", "source", "read", ["read-mail"]),
      descriptor(this.id, "attachments.select", "筛选附件", "从邮件集合中按 MIME、扩展名和数量筛选附件引用", "source", "read", ["read-mail", "read-attachment"]),
      ...["star", "archive", "trash", "mark-read", "mark-unread", "mark-important", "mark-spam"].map((id) => descriptor(this.id, id, id, `修改邮件状态：${id}`, "action", id === "trash" || id === "mark-spam" ? "destructive" : "local-write", ["modify-mail"])),
    ];
  }

  override async validate(step: CompiledAutomationStep, input: Record<string, unknown>): Promise<string[]> {
    if (step.capability === "attachments.select") {
      const messages = normalizeMessages(input.messages);
      if (!messages.length) return ["messages must contain at least one mail reference"];
    }
    return [];
  }

  async preview(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepPreview> {
    if (step.capability === "messages.collect") {
      const messages = normalizeMessages(input.messages ?? context.collection?.messages ?? context.trigger.mail);
      return { plannedOperation: `收集 ${messages.length} 封邮件`, resolvedInputSummary: { count: messages.length }, output: { type: "mail-collection", messages }, warnings: [], sideEffects: ["read-mail"] };
    }
    if (step.capability === "attachments.select") {
      const output = selectAttachments(this.mail, context.run.accountId, normalizeMessages(input.messages), step.config);
      return { plannedOperation: `筛选 ${output.attachments.length} 个附件`, resolvedInputSummary: { messages: normalizeMessages(input.messages).length, attachments: output.attachments.length }, output, warnings: [], sideEffects: ["read-mail", "read-attachment"] };
    }
    return { plannedOperation: `计划对邮件执行 ${step.capability}`, resolvedInputSummary: summarize(input), warnings: [], sideEffects: ["modify-mail"] };
  }

  async execute(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    try {
      const preview = await this.preview(step, input, context);
      if (step.capability === "messages.collect" || step.capability === "attachments.select") {
        const completedAt = new Date().toISOString();
        return { status: "succeeded", output: preview.output as any, warnings: preview.warnings, sideEffects: preview.sideEffects.map((type) => ({ type, summary: preview.plannedOperation })), audit: completedAudit(step.descriptor, startedAt, completedAt) };
      }
      const messages = normalizeMessages(input.messages ?? input.message);
      for (const ref of messages) applyMutation(this.mail, ref.emailId, step.capability);
      const completedAt = new Date().toISOString();
      return { status: "succeeded", output: { type: "scalar", value: { affected: messages.length } }, warnings: [], sideEffects: [{ type: "modify-mail", summary: `${step.capability}: ${messages.length}` }], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    } catch (error) {
      const completedAt = new Date().toISOString();
      return { status: "failed", error: { code: "execution-failed", message: error instanceof Error ? error.message : String(error), retryable: false, retrySafe: false }, warnings: [], sideEffects: [], audit: completedAudit(step.descriptor, startedAt, completedAt) };
    }
  }
}

function descriptor(provider: string, id: string, label: string, description: string, kind: AutomationCapabilityDescriptor["kind"], risk: AutomationCapabilityDescriptor["risk"], sideEffects: AutomationCapabilityDescriptor["sideEffects"]): AutomationCapabilityDescriptor {
  const base = { provider, id, version: "1", kind, label, description, inputSchema: { type: "object" }, outputSchema: { type: "object" }, risk, sideEffects, previewSupport: "full" as const, idempotency: risk === "read" ? "native" as const : "keyed" as const, discoveryConfidence: "declared" as const };
  return { ...base, fingerprint: descriptorFingerprint(base) };
}

function normalizeMessages(value: unknown): Array<{ type: "mail-reference"; accountId: string; emailId: string; subject?: string }> {
  const rows: unknown[] = Array.isArray(value) ? value : value && typeof value === "object" && (value as any).type === "mail-collection" ? (value as any).messages : value ? [value] : [];
  return rows.filter((item: unknown): item is { accountId?: string; emailId: string; subject?: string } => !!item && typeof item === "object" && typeof (item as any).emailId === "string").map((item) => ({ type: "mail-reference", accountId: String(item.accountId ?? ""), emailId: item.emailId, subject: item.subject }));
}

function selectAttachments(mail: CanonicalMailRepository, accountId: string, refs: ReturnType<typeof normalizeMessages>, config?: Record<string, unknown>) {
  const mimeTypes = Array.isArray(config?.mimeTypes) ? config.mimeTypes.filter((item: unknown): item is string => typeof item === "string") : [];
  const patterns = Array.isArray(config?.filenamePatterns) ? config.filenamePatterns.filter((item: unknown): item is string => typeof item === "string") : [];
  const maxFiles = typeof config?.maxFiles === "number" ? Math.max(1, Math.min(500, Math.floor(config.maxFiles))) : 100;
  const attachments = [] as any[];
  for (const ref of refs) {
    const message = mail.getMessageById(ref.emailId, accountId) as MailMessage | null;
    if (!message) continue;
    for (const attachment of message.attachments) {
      const mimeType = attachment.mimetype ?? "application/octet-stream";
      if (mimeTypes.length && !mimeTypes.includes(mimeType)) continue;
      if (patterns.length && !patterns.some((pattern) => globMatch(attachment.filename, pattern))) continue;
      attachments.push({ type: "attachment-reference", accountId, emailId: message.id, attachmentId: attachment.id, filename: attachment.filename, mimeType, size: attachment.size ?? 0 });
      if (attachments.length >= maxFiles) return { type: "attachment-collection" as const, attachments };
    }
  }
  return { type: "attachment-collection" as const, attachments };
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function applyMutation(mail: CanonicalMailRepository, emailId: string, capability: string): void {
  if (capability === "star" || capability === "mark-important") mail.updateFlags(emailId, { flagged: true });
  else if (capability === "mark-read") mail.updateFlags(emailId, { seen: true });
  else if (capability === "mark-unread") mail.updateFlags(emailId, { seen: false });
  else if (capability === "archive") mail.moveMessage(emailId, "Archive");
  else if (capability === "trash") mail.trashMessage(emailId);
  else if (capability === "mark-spam") mail.moveMessage(emailId, "Spam");
  else throw new Error(`unsupported-mail-capability:${capability}`);
}

function summarize(input: Record<string, unknown>) { return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? { count: value.length } : typeof value])); }
