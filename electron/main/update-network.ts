import type { Session } from "electron";

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

function isAllowedProtocol(url: URL): boolean {
  return url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        isExtraAllowedHost(url.hostname) ||
        isPrivateIpv4(url.hostname)));
}

export function isAllowedUpdateRequest(
  url: string,
  allowedOrigins: string | readonly string[],
): boolean {
  let requestUrl: URL;

  try {
    requestUrl = new URL(url);
  } catch {
    return false;
  }

  return (
    isAllowedProtocol(requestUrl) &&
    !requestUrl.username &&
    !requestUrl.password &&
    (typeof allowedOrigins === "string" ? [allowedOrigins] : allowedOrigins)
      .includes(requestUrl.origin)
  );
}

export function secureUpdaterSession(
  session: Session,
  allowedOrigins: readonly string[],
): Session {
  session.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({
        cancel: !isAllowedUpdateRequest(details.url, allowedOrigins),
      });
    },
  );

  return session;
}
