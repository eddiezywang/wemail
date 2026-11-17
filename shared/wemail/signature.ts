export const SIGNATURE_BRAND = "Wemail";
export const SIGNATURE_BRAND_COLOR = "#d96f4a";
const CHINESE_NAME_RE = /[\u3400-\u9fff]/u;
const CHINESE_NAME_SEQUENCE_RE = /[\u3400-\u9fff]+/gu;
const PARENTHESIZED_NAME_RE = /[（(]\s*([^（）()]*)\s*[）)]\s*$/u;

export function extractChineseDirectoryName(value?: string): string {
  const normalized = value?.trim();
  if (!normalized) return "";

  const parenthesized = normalized.match(PARENTHESIZED_NAME_RE)?.[1]?.trim();
  if (parenthesized && CHINESE_NAME_RE.test(parenthesized)) {
    return parenthesized;
  }

  return normalized.match(CHINESE_NAME_SEQUENCE_RE)?.join("") ?? "";
}

export function isOriginalEmailDisplayName(
  displayName: string | undefined,
  emailAddress: string,
): boolean {
  const normalizedDisplayName = displayName?.trim().toLocaleLowerCase();
  const normalizedEmail = emailAddress.trim().toLocaleLowerCase();
  const localPart = normalizedEmail.split("@", 1)[0] ?? "";
  return !normalizedDisplayName ||
    normalizedDisplayName === normalizedEmail ||
    normalizedDisplayName === localPart;
}

export function resolveSignatureIdentity(input: {
  displayName?: string;
  emailAddress?: string;
  directoryName?: string;
}): string {
  const directoryName = extractChineseDirectoryName(input.directoryName);
  if (directoryName) return directoryName;
  const displayName = input.displayName?.trim();
  if (displayName) return displayName;
  const emailAddress = input.emailAddress?.trim();
  if (!emailAddress) return "";
  const atIndex = emailAddress.indexOf("@");
  return atIndex > 0 ? emailAddress.slice(0, atIndex) : emailAddress;
}

export function buildSignatureText(identity?: string): string {
  const normalizedIdentity = identity?.trim();
  return [
    "--",
    "",
    ...(normalizedIdentity ? [normalizedIdentity, ""] : []),
    `Sent with ${SIGNATURE_BRAND}`,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** brandUrl: edition-injected outbound link; empty = plain-text brand. */
export function buildSignatureHtml(identity?: string, brandUrl?: string): string {
  const normalizedIdentity = identity?.trim() ?? "";
  const safeUrl = brandUrl?.trim() ?? "";
  const brand = safeUrl
    ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color: ${SIGNATURE_BRAND_COLOR}; text-decoration: none;"><strong><span style="color: ${SIGNATURE_BRAND_COLOR};">${SIGNATURE_BRAND}</span></strong></a>`
    : `<strong><span style="color: ${SIGNATURE_BRAND_COLOR};">${SIGNATURE_BRAND}</span></strong>`;
  return `<div data-wemail-signature="true" style="margin-top: 18px; text-align: left; color: #44403c; font-size: 14px; font-weight: 400; line-height: 1.45;"><div style="font-weight: 400;">--<br><br>${escapeHtml(normalizedIdentity)}<br></div><p data-wemail-signature-brand="true" style="margin: 5px 0 0; color: #a8a29e; font-size: 11px; font-weight: 400;">Sent with ${brand}</p></div>`;
}

function hasSignatureFooter(value: string): boolean {
  const text = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return new RegExp(`Sent with (?:${SIGNATURE_BRAND}|WeMail)\\s*$`, "i").test(
    text,
  );
}

export function ensureSignatureText(body: string | undefined, identity?: string): string {
  const source = body ?? "";
  if (hasSignatureFooter(source)) return source;
  const base = source.trimEnd();
  const signature = buildSignatureText(identity);
  return base ? `${base}\n\n${signature}` : signature;
}

export function ensureSignatureHtml(
  body: string | undefined,
  identity?: string,
  brandUrl?: string,
): string {
  const source = body ?? "";
  if (hasSignatureFooter(source)) {
    return source;
  }
  const base = source.trimEnd();
  const signature = buildSignatureHtml(identity, brandUrl);
  return base ? `${base}<br>${signature}` : signature;
}
