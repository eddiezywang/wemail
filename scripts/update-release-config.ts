export interface ReleaseConfigInput {
  release: boolean;
  baseUrl?: string;
  fallbackBaseUrl?: string;
  platform: NodeJS.Platform;
  arch: string;
  windowsPublisherName?: string;
  appleTeamId?: string;
}

export type ReleaseUpdatePolicy =
  | {
      enabled: false;
      platform: NodeJS.Platform;
      arch: string;
    }
  | {
      enabled: true;
      feedUrls: string[];
      platform: NodeJS.Platform;
      arch: string;
    };

export interface ReleaseConfig {
  feedUrl: string | null;
  feedUrls: string[];
  policy: ReleaseUpdatePolicy;
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

function isAllowedUpdateBaseUrl(url: URL): boolean {
  return url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        isExtraAllowedHost(url.hostname) ||
        isPrivateIpv4(url.hostname)));
}

export function createReleaseConfig(input: ReleaseConfigInput): ReleaseConfig {
  if (!input.release) {
    return {
      feedUrl: null,
      feedUrls: [],
      policy: {
        enabled: false,
        platform: input.platform,
        arch: input.arch,
      },
    };
  }

  const supported = input.platform === "win32"
    ? input.arch === "x64"
    : input.platform === "darwin" && ["x64", "arm64"].includes(input.arch);
  if (!supported) {
    throw new Error(`Unsupported release target: ${input.platform}/${input.arch}`);
  }
  if (!input.baseUrl) {
    throw new Error("WEMAIL_UPDATE_BASE_URL is required");
  }

  const parseBaseUrl = (value: string, name: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} is invalid`);
    }
    if (!isAllowedUpdateBaseUrl(url)) {
      throw new Error(
        `${name} must use HTTPS unless it targets localhost or a private IPv4 address`,
      );
    }
    if (url.username || url.password) {
      throw new Error(`${name} must not include credentials`);
    }
    return url;
  };
  const baseUrls = [
    parseBaseUrl(input.baseUrl, "WEMAIL_UPDATE_BASE_URL"),
    ...(input.fallbackBaseUrl
      ? [parseBaseUrl(input.fallbackBaseUrl, "WEMAIL_UPDATE_FALLBACK_BASE_URL")]
      : []),
  ];
  if (input.platform === "win32" && !input.windowsPublisherName?.trim()) {
    throw new Error("WEMAIL_WINDOWS_PUBLISHER is required");
  }
  if (input.platform === "darwin" && !input.appleTeamId?.trim()) {
    throw new Error("APPLE_TEAM_ID is required");
  }

  const platformDirectory = input.platform === "win32" ? "windows" : "mac";
  const feedUrls = [...new Set(baseUrls.map((baseUrl) => {
    const base = `${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, "")}`;
    return `${base}/${platformDirectory}/${input.arch}`;
  }))];
  return {
    feedUrl: feedUrls[0]!,
    feedUrls,
    policy: {
      enabled: true,
      feedUrls,
      platform: input.platform,
      arch: input.arch,
    },
  };
}
