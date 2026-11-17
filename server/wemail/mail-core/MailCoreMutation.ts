import type { MailFlagsPatch } from "../../../shared/wemail/mail.js";
import type {
  MailCoreMutation,
  MailCoreMutationResult,
} from "../../../shared/wemail/mailCoreProtocol.js";

export type { MailCoreMutation, MailCoreMutationResult };

export interface MailCoreMutationInput {
  accountId: string;
  emailId: string;
  mutation: MailCoreMutation;
  idempotencyKey: string;
}

export interface MailCoreRemoteLocatorSnapshot {
  folder: string;
  uid: number;
  uidValidity: number;
  internalDate: string;
  state: "ready" | "unknown";
}

export interface MailCoreRemoteOperation {
  accountId: string;
  emailId: string;
  remoteEmailId: string;
  messageId: string;
  locator: MailCoreRemoteLocatorSnapshot;
  mutation: MailCoreMutation;
}

export interface MailCoreRemoteRelocation {
  folder: string;
  uid?: number;
  uidValidity?: number;
  state: "ready" | "unknown";
}

export function parseMailCoreMutation(value: unknown): MailCoreMutation | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type === "flags") {
    if (!input.patch || typeof input.patch !== "object") return null;
    const patch = input.patch as Record<string, unknown>;
    const allowed = ["seen", "flagged", "answered", "draft"] as const;
    const parsed: MailFlagsPatch = {};
    for (const key of allowed) {
      if (key in patch) {
        if (typeof patch[key] !== "boolean") return null;
        parsed[key] = patch[key];
      }
    }
    return Object.keys(parsed).length > 0 ? { type: "flags", patch: parsed } : null;
  }
  if (input.type === "move") {
    return typeof input.folder === "string" && input.folder.trim()
      ? { type: "move", folder: input.folder.trim() }
      : null;
  }
  if (input.type === "trash" || input.type === "delete") {
    return { type: input.type };
  }
  return null;
}
