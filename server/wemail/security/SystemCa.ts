import tls from "node:tls";

type CaType = "default" | "system" | "bundled" | "extra";

export interface SystemCaTlsApi {
  getCACertificates?: (type?: CaType) => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

export interface SystemCaResult {
  enabled: boolean;
  added: number;
  total: number;
  error?: string;
}

let applied = false;

/**
 * Make Node's TLS verifier trust OS-installed root CAs in addition to
 * the bundled Mozilla CA set. On Windows this handles enterprise or
 * provider chains that validate in the OS certificate store but fail
 * with "unable to verify the first certificate" in Node's default mode.
 */
export function enableSystemCertificateAuthorities(
  tlsApi: SystemCaTlsApi = tls as unknown as SystemCaTlsApi,
): SystemCaResult {
  if (applied) return { enabled: true, added: 0, total: 0 };
  if (!tlsApi.getCACertificates || !tlsApi.setDefaultCACertificates) {
    return {
      enabled: false,
      added: 0,
      total: 0,
      error: "system-ca-api-unavailable",
    };
  }

  try {
    const defaults = tlsApi.getCACertificates("default");
    const system = tlsApi.getCACertificates("system");
    const merged = Array.from(new Set([...defaults, ...system]));
    tlsApi.setDefaultCACertificates(merged);
    applied = true;
    return {
      enabled: true,
      added: merged.length - defaults.length,
      total: merged.length,
    };
  } catch (error) {
    return {
      enabled: false,
      added: 0,
      total: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
