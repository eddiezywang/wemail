import type {
  McpAccessTokenMetadata,
  McpAccessTokenService,
} from "./McpAccessTokenService.js";

export type McpAuthenticationResult =
  | { ok: true; token: McpAccessTokenMetadata }
  | { ok: false; status: 401; code: "authentication_required" };

export class McpAuthenticator {
  constructor(private readonly tokens: Pick<McpAccessTokenService, "verify">) {}

  authenticate(authorizationHeader: string | undefined): McpAuthenticationResult {
    if (!authorizationHeader) {
      return { ok: false, status: 401, code: "authentication_required" };
    }
    const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader.trim());
    if (!match?.[1]) {
      return { ok: false, status: 401, code: "authentication_required" };
    }
    const token = this.tokens.verify(match[1]);
    return token
      ? { ok: true, token }
      : { ok: false, status: 401, code: "authentication_required" };
  }
}
