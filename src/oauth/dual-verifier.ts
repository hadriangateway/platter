import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { safeStrEqual } from "../utils.js";
import type { PlatterOAuthProvider } from "./provider.js";

/**
 * Attempts OAuth token verification first, then falls back to checking
 * against the legacy static bearer token. This lets `requireBearerAuth`
 * handle both auth strategies in a single middleware.
 */
export class DualVerifier implements OAuthTokenVerifier {
  constructor(
    private provider: PlatterOAuthProvider,
    private getLegacyToken: () => string | null,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Try OAuth first.
    try {
      return await this.provider.verifyAccessToken(token);
    } catch {
      // Fall through to legacy check.
    }

    // Legacy static bearer token.
    const legacy = this.getLegacyToken();
    if (legacy && safeStrEqual(token, legacy)) {
      // No grant attached — per-session security falls back to the global
      // config unmodified (legacy bearer is an admin-level credential).
      return {
        token,
        clientId: "legacy-bearer",
        scopes: ["*"],
        extra: { grant: null },
      };
    }

    // InvalidTokenError → 401 with WWW-Authenticate, prompting the client
    // to re-authenticate. A generic Error would land in the bearer-auth
    // catch-all and become an opaque 500.
    throw new InvalidTokenError("Invalid access token");
  }
}
