import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";

export type UpdatePolicy =
  | {
      enabled: false;
      feedUrls: null;
      allowedOrigins: null;
      platform: NodeJS.Platform;
      arch: string;
    }
  | {
      enabled: true;
      feedUrls: string[];
      allowedOrigins: string[];
      platform: NodeJS.Platform;
      arch: string;
    };

type ReadFile = (filePath: string, encoding: "utf8") => Promise<string>;

interface LoadUpdatePolicyOptions {
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  readFile?: ReadFile;
}

function disabledPolicy(
  platform: NodeJS.Platform,
  arch: string,
): UpdatePolicy {
  return {
    enabled: false,
    feedUrls: null,
    allowedOrigins: null,
    platform,
    arch,
  };
}

function normalizeFeedUrl(url: URL): string {
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${normalizedPath}${url.search}${url.hash}`;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

/** Additional HTTP update hosts are opt-in via WEMAIL_UPDATE_ALLOWED_HOSTS
 *  (comma-separated). The open-source default is an empty list. */
function isExtraAllowedHost(hostname: string): boolean {
  return (process.env.WEMAIL_UPDATE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(hostname.toLowerCase());
}

function isAllowedFeedUrl(url: URL): boolean {
  return url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        isExtraAllowedHost(url.hostname) ||
        isPrivateIpv4(url.hostname)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function parseUpdatePolicy(
  text: string,
  platform: NodeJS.Platform,
  arch: string,
): UpdatePolicy {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid update policy JSON");
  }

  const raw = asRecord(parsed);

  if (raw?.enabled !== true) {
    return disabledPolicy(platform, arch);
  }

  if (raw.platform !== platform || raw.arch !== arch) {
    throw new Error(`Update policy target must match ${platform}/${arch}`);
  }

  const rawFeedUrls = Array.isArray(raw.feedUrls)
    ? raw.feedUrls
    : typeof raw.feedUrl === "string"
      ? [raw.feedUrl]
      : null;
  if (!rawFeedUrls || rawFeedUrls.length === 0 ||
      rawFeedUrls.some((feedUrl) => typeof feedUrl !== "string")) {
    throw new Error("Enabled update policy requires at least one feed URL");
  }
  const feedUrls = [...new Set(rawFeedUrls.map((value) => {
    let feedUrl: URL;
    try {
      feedUrl = new URL(value as string);
    } catch {
      throw new Error("Update feed URL is invalid");
    }
    if (!isAllowedFeedUrl(feedUrl)) {
      throw new Error(
        "Update feed URL must use HTTPS unless it targets localhost or a private IPv4 address",
      );
    }
    if (feedUrl.username || feedUrl.password) {
      throw new Error("Update feed URL must not include credentials");
    }
    return normalizeFeedUrl(feedUrl);
  }))];

  return {
    enabled: true,
    feedUrls,
    allowedOrigins: [...new Set(feedUrls.map((feedUrl) => new URL(feedUrl).origin))],
    platform,
    arch,
  };
}

export async function loadUpdatePolicy({
  appPath,
  platform = process.platform,
  arch = process.arch,
  readFile = defaultReadFile,
}: LoadUpdatePolicyOptions): Promise<UpdatePolicy> {
  const policyPath = path.join(
    appPath,
    "dist-electron",
    "electron",
    "update-policy.json",
  );

  try {
    const text = await readFile(policyPath, "utf8");
    return parseUpdatePolicy(text, platform, arch);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return disabledPolicy(platform, arch);
    }

    throw error;
  }
}
