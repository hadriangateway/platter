import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { ALL_TOOL_NAMES, type ToolName } from "../security.js";
import type { ClientGrant } from "./provider.js";

/**
 * Asymmetric signature algorithms we accept. Pinning this list defensively
 * rejects `alg: none` and any symmetric (HMAC) algorithm — even if a JWKS ever
 * served a symmetric key, an attacker can't downgrade to a key-confusion attack.
 * RS256 is the baseline used by Auth0, Keycloak, Okta, and Entra.
 */
const ALLOWED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"];

/** Default leeway (seconds) for `exp`/`nbf` to absorb clock skew between platter and the IdP. */
const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

const TOOL_SCOPE_PREFIX = "tools:";

export interface ExternalJwtVerifierConfig {
  /** JWKS endpoint to fetch signing keys from. Required unless `keyResolver` is supplied. */
  jwksUrl?: URL;
  /** Expected `iss` claim. When set, tokens from any other issuer are rejected. */
  issuer?: string;
  /** Expected `aud` claim. When unset, audience is NOT validated (any token from the issuer passes). */
  audience?: string;
  /** When true, map `tools:<name>` scopes in the token to a narrowing grant. */
  scopeGrants?: boolean;
  /** Clock skew tolerance in seconds (default 60). */
  clockToleranceSec?: number;
  /**
   * Injectable key resolver, used in place of a remote JWKS fetch. Primarily a
   * test seam (pass `createLocalJWKSet(jwks)`); production code supplies `jwksUrl`.
   */
  keyResolver?: JWTVerifyGetKey;
}

/**
 * Verifies JWT access tokens issued by an external OAuth/OIDC authorization
 * server (Auth0, Keycloak, Okta, Entra). Implements the same `OAuthTokenVerifier`
 * contract as {@link DualVerifier}, so it drops straight into `requireBearerAuth`.
 *
 * Signature keys are resolved from the issuer's JWKS via `createRemoteJWKSet`,
 * which caches keys, refetches on key rotation, and fetches lazily — so the
 * verifier never blocks construction on an unreachable IdP.
 */
export class ExternalJwtVerifier implements OAuthTokenVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer?: string;
  private readonly audience?: string;
  private readonly scopeGrants: boolean;
  private readonly clockTolerance: number;

  constructor(config: ExternalJwtVerifierConfig) {
    if (config.keyResolver) {
      this.jwks = config.keyResolver;
    } else if (config.jwksUrl) {
      this.jwks = createRemoteJWKSet(config.jwksUrl, {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
        cacheMaxAge: 600000,
      });
    } else {
      throw new Error("ExternalJwtVerifier requires either jwksUrl or keyResolver");
    }
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.scopeGrants = config.scopeGrants ?? false;
    this.clockTolerance = config.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        algorithms: ALLOWED_ALGS,
        clockTolerance: this.clockTolerance,
        ...(this.issuer ? { issuer: this.issuer } : {}),
        ...(this.audience ? { audience: this.audience } : {}),
      });
      payload = result.payload;
    } catch (err) {
      // A JWKS fetch/timeout failure is an operator-facing problem, not a bad
      // token — surface it to stderr so an unreachable IdP can be diagnosed,
      // while still returning a 401 to the client.
      const code = (err as { code?: string })?.code;
      if (
        code === "ERR_JWKS_TIMEOUT" ||
        code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS" ||
        code === "ERR_JWKS_NO_MATCHING_KEY"
      ) {
        console.error(`[jwks] token verification could not resolve a signing key (${code})`);
      }
      throw new InvalidTokenError("Invalid access token");
    }

    const scopes = parseScopes(payload);
    const grant = this.scopeGrants ? scopesToGrant(scopes) : null;

    return {
      token,
      clientId: clientIdFromPayload(payload),
      scopes,
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      extra: { grant },
    };
  }
}

/**
 * Parse OAuth scopes from a verified JWT. Handles the `scope` claim
 * (space-delimited string, RFC 8693) and the `scp` claim used by Entra/Azure AD
 * (space-delimited string in v2 tokens, array in some configurations).
 */
function parseScopes(payload: JWTPayload): string[] {
  const out = new Set<string>();
  const scope = payload.scope;
  if (typeof scope === "string") {
    for (const s of scope.split(/\s+/)) if (s) out.add(s);
  }
  const scp = (payload as Record<string, unknown>).scp;
  if (typeof scp === "string") {
    for (const s of scp.split(/\s+/)) if (s) out.add(s);
  } else if (Array.isArray(scp)) {
    for (const s of scp) if (typeof s === "string" && s) out.add(s);
  }
  return [...out];
}

/**
 * Build a tools-only grant from `tools:<name>` scopes. Returns `null` when no
 * recognized tool scopes are present, which `buildSessionSecurity` treats as
 * admin-level (the operator's global CLI restrictions still apply).
 */
function scopesToGrant(scopes: string[]): ClientGrant | null {
  const valid = new Set<string>(ALL_TOOL_NAMES);
  const tools: ToolName[] = [];
  for (const s of scopes) {
    if (!s.startsWith(TOOL_SCOPE_PREFIX)) continue;
    const name = s.slice(TOOL_SCOPE_PREFIX.length);
    if (valid.has(name)) tools.push(name as ToolName);
  }
  return tools.length > 0 ? { tools } : null;
}

function clientIdFromPayload(payload: JWTPayload): string {
  const azp = (payload as Record<string, unknown>).azp;
  const clientId = (payload as Record<string, unknown>).client_id;
  if (typeof azp === "string" && azp) return azp;
  if (typeof clientId === "string" && clientId) return clientId;
  if (typeof payload.sub === "string" && payload.sub) return payload.sub;
  return "external";
}
