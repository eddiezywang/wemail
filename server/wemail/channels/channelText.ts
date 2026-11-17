/**
 * Shared presentation sanitization for channel-bound agent text. Hides API
 * keys/tokens/secrets and Windows local paths, and caps length. Used by both
 * the one-shot delivery path (`ChannelWorker`) and the WeCom streaming session
 * (`WecomStreamSession`) so the two rules never drift.
 */
export function sanitizePresentation(text: string): string {
  return text
    .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[已隐藏]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g, "[本地路径已隐藏]")
    .slice(0, 32_000);
}

/**
 * Longest prefix of `text` whose UTF-8 byte length is ≤ `maxBytes`, cut on a
 * code-point boundary (surrogate pairs / emoji are never split). Used to enforce
 * hard per-frame / per-element budgets — a single large delta can otherwise jump
 * past a pre-check that only measured the length before the append.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let len = 0;
  for (const chunk of text) {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (len + chunkBytes > maxBytes) break;
    out += chunk;
    len += chunkBytes;
  }
  return out;
}

/**
 * Longest prefix of `text` with ≤ `maxChars` code points (surrogate pairs count
 * as one). Code-point-safe — never splits an emoji.
 */
export function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  let out = "";
  let count = 0;
  for (const chunk of text) {
    if (count >= maxChars) break;
    out += chunk;
    count += 1;
  }
  return out;
}

/** UTF-8 byte length of a JS string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Drop unpaired surrogates so the content encodes to valid UTF-8. */
export function sanitizeUtf8(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
      out += text[i] + text[i + 1];
      i += 1;
    } else if (isHigh || isLow) {
      out += "�";
    } else {
      out += text[i];
    }
  }
  return out;
}
