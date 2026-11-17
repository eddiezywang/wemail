import type { HandlerDetails } from "electron";

export interface ExternalLinkOpenResult {
  ok: boolean;
  reason?: "invalid-url" | "open-failed";
}

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function sanitizeExternalUrl(rawUrl: string | null | undefined): string | null {
  const value = rawUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createExternalLinkOpener(
  openExternal: (url: string) => Promise<void>,
) {
  return async (rawUrl: string): Promise<ExternalLinkOpenResult> => {
    const url = sanitizeExternalUrl(rawUrl);
    if (!url) return { ok: false, reason: "invalid-url" };
    try {
      await openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false, reason: "open-failed" };
    }
  };
}

export function getExternalLinkWindowAction(
  details: Pick<HandlerDetails, "url">,
  openExternal: (url: string) => Promise<void>,
) {
  const url = sanitizeExternalUrl(details.url);
  if (url) {
    void openExternal(url);
  }
  return { action: "deny" as const };
}

export function getMainWindowNavigationDecision(
  nextUrl: string,
  currentUrl: string,
): { prevent: boolean; openExternalUrl?: string } {
  if (nextUrl === currentUrl) return { prevent: false };

  try {
    const next = new URL(nextUrl);
    const current = new URL(currentUrl);
    if (next.origin === current.origin) return { prevent: false };
  } catch {
    return { prevent: true };
  }

  const externalUrl = sanitizeExternalUrl(nextUrl);
  return externalUrl
    ? { prevent: true, openExternalUrl: externalUrl }
    : { prevent: true };
}
