import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "../security/SecretStore.js";

export function isLoopbackLangBotUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1")
  );
}

export function validateLangBotEnablement(input: {
  baseUrl: string;
  trustMode: "loopback" | "remote";
  secrets: Pick<SecretStore, "isEncryptionAvailable">;
  developmentOverride?: boolean;
}): void {
  const url = new URL(input.baseUrl);
  if (input.trustMode === "loopback") {
    if (!isLoopbackLangBotUrl(url.toString())) {
      throw new Error("langbot-loopback-url-required");
    }
    return;
  }
  if (url.protocol !== "https:") throw new Error("langbot-remote-tls-required");
  if (
    !input.secrets.isEncryptionAvailable() &&
    input.developmentOverride !== true
  ) {
    throw new Error("langbot-encrypted-secret-store-required");
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function constantTimeSecretMatches(
  expected: string | undefined,
  received: string | undefined,
): boolean {
  const left = digest(expected ?? "");
  const right = digest(received ?? "");
  return timingSafeEqual(left, right) && !!expected && !!received;
}

export function generateWebhookSecret(): string {
  return `wh_${randomBytes(32).toString("base64url")}`;
}

export class ChannelSenderRateLimiter {
  private readonly buckets = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  consume(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }
}
