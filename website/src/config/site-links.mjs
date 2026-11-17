const INTERNAL_PATH_PATTERN = /^\/(?!\/)[^#\s]*$/;
const UNSAFE_EXTERNAL_URL_CHARACTER_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;

function isHttpsUrl(url) {
  if (UNSAFE_EXTERNAL_URL_CHARACTER_PATTERN.test(url)) return false;
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && Boolean(parsedUrl.hostname);
  } catch {
    return false;
  }
}

export function linkAttributes(url) {
  if (typeof url !== "string" || !url) {
    throw new TypeError("Link target must be a valid internal path or HTTPS URL");
  }
  if (INTERNAL_PATH_PATTERN.test(url)) {
    return Object.freeze({ href: url });
  }
  if (isHttpsUrl(url)) {
    return Object.freeze({
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    });
  }
  throw new TypeError("Link target must be a valid internal path or HTTPS URL");
}

// No vetted public release artifact exists yet. The tracked placeholder
// installer was zero bytes, so the website must not offer a download until
// an audited public release is available. To re-enable both download CTAs,
// set INSTALL_URL to a trusted HTTPS release URL and pass it through
// linkAttributes (which adds safe external-link attributes).
/** @type {string | null} */
export const INSTALL_URL = null;
/** @type {{ href: string, target?: string, rel?: string } | null} */
export const INSTALL_LINK_ATTRIBUTES = null;
