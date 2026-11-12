import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentPendingAction } from "../../../shared/wemail/intelligence.js";
import type {
  ChannelBinding,
  ChannelInboundEvent,
} from "../../../shared/wemail/channels.js";
import type {
  AgentActionExecutionResult,
  AgentActionExecutor,
} from "../agent/AgentActionExecutor.js";
import { rowToAction, type AgentPendingActionRepository } from "../agent/AgentPendingActionRepository.js";
import type { MailDatabase } from "../database/Database.js";

const COMMAND_PATTERN = /^\/(approve|deny)\s+([A-Za-z0-9_-]{8,64})\s*$/i;
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const CONFIRM_INTENT_RE = /(确认|确定|同意|执行|继续|可以|没问题|好的|yes|ok|confirm|approve)/;
const DENY_INTENT_RE = /(取消|不要|不行|拒绝|算了|否|别删|先不要|no|cancel|deny|reject|abort)/;
// Marks that look like a question / new request rather than a pure yes/no —
// e.g. "确认一下是不是这封", "好的，另外帮我查一下…". Such replies must NOT trigger
// execution even if they happen to contain a confirm word.
const AMBIGUOUS_REQUEST_RE = /(吗|？|\?|是不是|一下|另外|帮|查一|什么|哪)/;
const NATURAL_LANGUAGE_INTENT_MAX_LEN = 16;

/** Classify a short natural-language reply as confirm/deny for a pending
 *  action. Returns null when the text is too long, looks like a question/new
 *  request, or is not a confirmation phrase — the caller then falls back to
 *  the normal agent run. Exported for unit tests. */
export function classifyConfirmationIntent(text: string): "confirm" | "deny" | null {
  const normalized = (text ?? "").replace(/\s+/g, "").toLowerCase();
  if (!normalized || normalized.length > NATURAL_LANGUAGE_INTENT_MAX_LEN) return null;
  if (AMBIGUOUS_REQUEST_RE.test(normalized)) return null;
  if (DENY_INTENT_RE.test(normalized)) return "deny";
  if (CONFIRM_INTENT_RE.test(normalized)) return "confirm";
  return null;
}

interface ReferenceRow {
  id: string;
  connection_id: string;
  profile_id: string;
  bot_uuid: string;
  chat_kind: ChannelInboundEvent["chatKind"];
  chat_id: string;
  sender_id: string;
  account_id: string;
  pending_action_id: string;
  expires_at: string;
  resolved_at: string | null;
}

export class ChannelApprovalService {
  constructor(
    private readonly db: MailDatabase,
    private readonly pending: AgentPendingActionRepository,
    private readonly executor: AgentActionExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
    action: AgentPendingAction,
    ttlMs = 10 * 60_000,
  ): { reference: string; prompt: string } {
    const reference = randomBytes(9).toString("base64url");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO channel_approval_references (
          id, reference_hash, connection_id, profile_id, bot_uuid, chat_kind,
          chat_id, sender_id, account_id, pending_action_id, expires_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        hash(reference),
        event.connectionId,
        binding.profileId,
        event.botUuid,
        event.chatKind,
        event.chatId,
        event.senderId,
        binding.accountId,
        action.id,
        new Date(now.getTime() + ttlMs).toISOString(),
        now.toISOString(),
      );
    return {
      reference,
      prompt: [
        "此操作需要你明确确认。",
        `操作：${sanitize(action.description)}`,
        `风险：${sanitize(action.riskReason)}`,
        `批准：/approve ${reference}`,
        `拒绝：/deny ${reference}`,
        "该引用仅在当前会话和当前身份下短时有效。",
      ].join("\n"),
    };
  }

  async executePreauthorizedOwnerMailAction(
    binding: ChannelBinding,
    action: AgentPendingAction,
  ): Promise<{ ok: boolean; summary: string }> {
    const pending = this.pending.getById(action.id);
    const preauthorized =
      action.actionType === "send" || action.actionType === "schedule_send";
    if (
      !preauthorized ||
      !pending ||
      pending.action_type !== action.actionType ||
      pending.status !== "pending" ||
      this.pending.getAccountIdFor(pending.id) !== binding.accountId
    ) {
      return {
        ok: false,
        summary: "邮件操作未执行：预授权操作与当前邮箱不匹配，请重新发起。",
      };
    }

    try {
      const result = await this.executor.execute(pending, {
        accountId: binding.accountId,
      });
      this.pending.resolve(pending.id, result.ok ? "confirmed" : "rejected");
      return {
        ok: result.ok,
        summary:
          sanitize(result.summary) ||
          (result.ok ? "邮件操作已完成。" : "邮件操作失败，请检查邮箱配置后重试。"),
      };
    } catch {
      this.pending.resolve(pending.id, "rejected");
      return {
        ok: false,
        summary: "邮件操作失败，请检查邮箱配置后重新发起。",
      };
    }
  }

  rejectOwnerMailActionWithoutPreview(
    binding: ChannelBinding,
    action: AgentPendingAction,
  ): boolean {
    const pending = this.pending.getById(action.id);
    if (
      (action.actionType !== "send" &&
        action.actionType !== "schedule_send") ||
      !pending ||
      pending.action_type !== action.actionType ||
      pending.status !== "pending" ||
      this.pending.getAccountIdFor(pending.id) !== binding.accountId
    ) {
      return false;
    }
    this.pending.resolve(pending.id, "rejected");
    return true;
  }

  async intercept(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
  ): Promise<
    | { handled: false }
    | {
        handled: true;
        message: string;
        outcome: "approved" | "denied" | "invalid" | "expired" | "replayed";
      }
  > {
    const match = event.text.trim().match(COMMAND_PATTERN);
    if (!match) return { handled: false };
    const row = this.db
      .prepare(
        `SELECT id, connection_id, profile_id, bot_uuid, chat_kind, chat_id,
                sender_id, account_id, pending_action_id, expires_at, resolved_at
         FROM channel_approval_references WHERE reference_hash = ?`,
      )
      .get(hash(match[2])) as ReferenceRow | undefined;
    if (!row || !sameScope(row, event, binding)) {
      return {
        handled: true,
        outcome: "invalid",
        message: "确认引用无效，或不属于当前会话。",
      };
    }
    if (row.resolved_at) {
      return { handled: true, outcome: "replayed", message: "该确认引用已使用。" };
    }
    if (row.expires_at <= this.now().toISOString()) {
      this.resolveReference(row.id);
      this.pending.resolve(row.pending_action_id, "expired");
      return { handled: true, outcome: "expired", message: "该确认引用已过期。" };
    }
    const pending = this.pending.getById(row.pending_action_id);
    if (!pending || pending.status !== "pending") {
      this.resolveReference(row.id);
      return { handled: true, outcome: "replayed", message: "该操作已处理。" };
    }
    if (match[1].toLowerCase() === "deny") {
      this.pending.resolve(pending.id, "rejected");
      this.resolveReference(row.id);
      return { handled: true, outcome: "denied", message: "已拒绝该操作。" };
    }
    let result: AgentActionExecutionResult;
    try {
      result = await this.executor.execute(pending, {
        accountId: binding.accountId,
      });
    } catch {
      return {
        handled: true,
        outcome: "invalid",
        message: "操作执行失败，确认引用仍可在有效期内重试。",
      };
    }
    if (!result.ok) {
      return {
        handled: true,
        outcome: "invalid",
        message: "操作未成功，确认引用仍可在有效期内重试。",
      };
    }
    this.pending.resolve(pending.id, "confirmed");
    this.resolveReference(row.id);
    return {
      handled: true,
      outcome: "approved",
      message: sanitize(result.summary || "操作已完成。"),
    };
  }

  /**
   * Resolve a pending action from the owner's *natural-language* reply in chat
   * (e.g. "确认删除" / "取消") — the WeCom equivalent of clicking the desktop
   * confirmation card. Only short, explicit confirm/deny phrases trigger this;
   * everything else falls through to the agent run. Mirrors the desktop card's
   * atomic execution entry (reserveExecution + executor + completeExecution)
   * so the two surfaces are equivalent and mutually exclusive (no double run).
   * send/schedule_send stay on the 【邮件预览】 preauthorization flow and are
   * excluded here.
   */
  async resolveByNaturalLanguage(
    event: ChannelInboundEvent,
    binding: ChannelBinding,
  ): Promise<
    | { handled: false }
    | {
        handled: true;
        message: string;
        outcome: "approved" | "denied" | "invalid" | "expired" | "replayed";
      }
  > {
    const intent = classifyConfirmationIntent(event.text);
    if (!intent) return { handled: false };
    const pending = this.pending
      .getPending(binding.conversationId)
      .filter(
        (row) => row.action_type !== "send" && row.action_type !== "schedule_send",
      )
      .find((row) => this.pending.getAccountIdFor(row.id) === binding.accountId);
    if (!pending) return { handled: false };

    if (intent === "deny") {
      this.pending.resolve(pending.id, "rejected");
      return { handled: true, outcome: "denied", message: "已取消该操作。" };
    }

    const reservation = this.pending.reserveExecution({
      id: pending.id,
      idempotencyKey: pending.idempotency_key ?? `legacy:${pending.id}`,
      parameters: rowToAction(pending).parameters ?? {},
    });
    if (reservation.kind === "duplicate") {
      return { handled: true, outcome: "replayed", message: "该操作已处理。" };
    }
    if (reservation.kind === "expired") {
      return { handled: true, outcome: "expired", message: "该操作已过期，请重新发起。" };
    }
    if (reservation.kind !== "reserved") {
      return { handled: true, outcome: "invalid", message: "该操作无法执行，请重新发起。" };
    }
    try {
      const result = await this.executor.execute(pending, {
        accountId: binding.accountId,
      });
      this.pending.completeExecution(
        pending.id,
        result.ok ? "succeeded" : "failed",
        { ok: result.ok, summary: result.summary },
      );
      return {
        handled: true,
        outcome: result.ok ? "approved" : "invalid",
        message:
          sanitize(result.summary) ||
          (result.ok ? "操作已完成。" : "操作未成功，请稍后重试。"),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.pending.completeExecution(pending.id, "failed", { ok: false, error: detail });
      return { handled: true, outcome: "invalid", message: "操作执行失败，请稍后重试。" };
    }
  }

  private resolveReference(id: string): void {
    this.db
      .prepare(
        `UPDATE channel_approval_references
         SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?`,
      )
      .run(this.now().toISOString(), id);
  }
}

function sameScope(
  row: ReferenceRow,
  event: ChannelInboundEvent,
  binding: ChannelBinding,
) {
  return (
    row.connection_id === event.connectionId &&
    row.profile_id === binding.profileId &&
    row.bot_uuid === event.botUuid &&
    row.chat_kind === event.chatKind &&
    row.chat_id === event.chatId &&
    row.sender_id === event.senderId &&
    row.account_id === binding.accountId
  );
}

function sanitize(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}
