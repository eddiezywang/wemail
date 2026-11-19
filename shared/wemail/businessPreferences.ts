import { z } from "zod";
import type { NotificationContentMode } from "./notifications.js";

export interface BusinessPreferences {
  inboxDensity: "comfortable" | "compact";
  threading: boolean;
  readingPane: "side" | "off";
  sendShortcut: "cmd-enter" | "ctrl-enter" | "off";
  actionRequiredNotifications: boolean;
  newMailNotifications: boolean;
  notificationSound: boolean;
  notificationContentMode: NotificationContentMode;
  dailyDigest: boolean;
  interfaceLanguage: "auto" | "zh-CN" | "en";
  accountSignatures: Record<string, { enabled: boolean; customText: string }> | null;
}

export const DEFAULT_BUSINESS_PREFERENCES: BusinessPreferences = {
  inboxDensity: "comfortable",
  threading: true,
  readingPane: "side",
  sendShortcut: "cmd-enter",
  actionRequiredNotifications: true,
  newMailNotifications: true,
  notificationSound: false,
  notificationContentMode: "full",
  dailyDigest: false,
  interfaceLanguage: "auto",
  accountSignatures: null,
};

export function validateBusinessPreferences(value: unknown): BusinessPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T =>
    typeof input[key] === "string" && allowed.includes(input[key] as T)
      ? input[key] as T
      : fallback;
  const bool = (key: string, fallback: boolean) =>
    typeof input[key] === "boolean" ? input[key] as boolean : fallback;
  return {
    inboxDensity: pick("inboxDensity", ["comfortable", "compact"], "comfortable"),
    threading: bool("threading", true),
    readingPane: pick("readingPane", ["side", "off"], "side"),
    sendShortcut: pick("sendShortcut", ["cmd-enter", "ctrl-enter", "off"], "cmd-enter"),
    actionRequiredNotifications: bool("actionRequiredNotifications", true),
    newMailNotifications: bool(
      "newMailNotifications",
      DEFAULT_BUSINESS_PREFERENCES.newMailNotifications,
    ),
    notificationSound: bool("notificationSound", false),
    notificationContentMode: pick(
      "notificationContentMode",
      ["full", "sender-only", "count-only"],
      "full",
    ),
    dailyDigest: bool("dailyDigest", false),
    interfaceLanguage: pick("interfaceLanguage", ["auto", "zh-CN", "en"], "auto"),
    accountSignatures: z.record(z.string(), z.object({ enabled: z.boolean(), customText: z.string().max(10000) })).nullable().catch(null).parse(input.accountSignatures),
  };
}

export const BusinessPreferencesPatchSchema = z.object({
  inboxDensity: z.enum(["comfortable", "compact"]),
  threading: z.boolean(),
  readingPane: z.enum(["side", "off"]),
  sendShortcut: z.enum(["cmd-enter", "ctrl-enter", "off"]),
  actionRequiredNotifications: z.boolean(),
  newMailNotifications: z.boolean(),
  notificationSound: z.boolean(),
  notificationContentMode: z.enum(["full", "sender-only", "count-only"]),
  dailyDigest: z.boolean(),
  interfaceLanguage: z.enum(["auto", "zh-CN", "en"]),
  accountSignatures: z.record(z.string(), z.object({ enabled: z.boolean(), customText: z.string().max(10000) })).nullable(),
}).partial().strict();

export interface BusinessPreferencesSnapshot {
  stored: boolean;
  preferences: BusinessPreferences;
}
