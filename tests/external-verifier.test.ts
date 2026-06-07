import { beforeAll, describe, expect, it } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey, SignJWT } from "jose";
import { ExternalJwtVerifier } from "../src/oauth/external-verifier.js";

const ISS = "https://idp.example.com/";
const AUD = "https://platter.example.com/mcp";
const ALG = "RS256";
const KID = "test-key-1";

let signingKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;
// A second key that is NOT published in the JWKS — used to forge "bad signature".
let foreignKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair(ALG, { extractable: true });
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = KID;
  jwk.alg = ALG;
  jwk.use = "sig";
  keyResolver = createLocalJWKSet({ keys: [jwk as JWK] });

  const foreign = await generateKeyPair(ALG, { extractable: true });
  foreignKey = foreign.privateKey;
});

interface SignOpts {
  issuer?: string;
  audience?: string;
  expSecondsFromNow?: number;
  claims?: Record<string, unknown>;
  signWith?: CryptoKey;
  kid?: string;
}

async function sign(opts: SignOpts = {}): Promise<string> {
  let jwt = new SignJWT(opts.claims ?? {}).setProtectedHeader({ alg: ALG, kid: opts.kid ?? KID }).setIssuedAt();
  if (opts.issuer !== null) jwt = jwt.setIssuer(opts.issuer ?? ISS);
  if (opts.audience !== undefined) jwt = jwt.setAudience(opts.audience);
  const now = Math.floor(Date.now() / 1000);
  jwt = jwt.setExpirationTime(now + (opts.expSecondsFromNow ?? 300));
  return jwt.sign(opts.signWith ?? signingKey);
}

function makeVerifier(overrides: Partial<ConstructorParameters<typeof ExternalJwtVerifier>[0]> = {}) {
  return new ExternalJwtVerifier({ keyResolver, issuer: ISS, audience: AUD, ...overrides });
}

describe("ExternalJwtVerifier", () => {
  it("accepts a valid token and maps claims to AuthInfo", async () => {
    const token = await sign({ audience: AUD, claims: { azp: "client-123", scope: "openid tools:read" } });
    const info = await makeVerifier().verifyAccessToken(token);
    expect(info.token).toBe(token);
    expect(info.clientId).toBe("client-123");
    expect(info.scopes).toEqual(["openid", "tools:read"]);
    expect(typeof info.expiresAt).toBe("number");
    // No scope-grant mapping by default → admin-level (null grant).
    expect((info.extra as { grant: unknown }).grant).toBeNull();
  });

  it("rejects a token from the wrong issuer", async () => {
    const token = await sign({ issuer: "https://evil.example.com/", audience: AUD });
    await expect(makeVerifier().verifyAccessToken(token)).rejects.toThrow("Invalid access token");
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign({ audience: "https://other-api.example.com" });
    await expect(makeVerifier().verifyAccessToken(token)).rejects.toThrow("Invalid access token");
  });

  it("rejects a token with no audience when audience validation is on", async () => {
    const token = await sign(); // no aud claim
    await expect(makeVerifier().verifyAccessToken(token)).rejects.toThrow("Invalid access token");
  });

  it("rejects an expired token", async () => {
    const token = await sign({ audience: AUD, expSecondsFromNow: -600 });
    await expect(makeVerifier({ clockToleranceSec: 0 }).verifyAccessToken(token)).rejects.toThrow(
      "Invalid access token",
    );
  });

  it("rejects a token signed by a key not in the JWKS", async () => {
    const token = await sign({ audience: AUD, signWith: foreignKey, kid: "unknown-key" });
    await expect(makeVerifier().verifyAccessToken(token)).rejects.toThrow("Invalid access token");
  });

  it("rejects a token whose signature does not match the published key", async () => {
    // Same kid as the published key, but signed with a different private key.
    const token = await sign({ audience: AUD, signWith: foreignKey, kid: KID });
    await expect(makeVerifier().verifyAccessToken(token)).rejects.toThrow("Invalid access token");
  });

  it("accepts any audience when audience validation is disabled", async () => {
    const verifier = makeVerifier({ audience: undefined });
    const withAud = await sign({ audience: "anything-at-all" });
    const noAud = await sign();
    await expect(verifier.verifyAccessToken(withAud)).resolves.toBeDefined();
    await expect(verifier.verifyAccessToken(noAud)).resolves.toBeDefined();
  });

  describe("scope grants", () => {
    it("maps tools:<name> scopes (scope claim) to a narrowing grant", async () => {
      const token = await sign({ audience: AUD, claims: { scope: "openid tools:read tools:bash" } });
      const info = await makeVerifier({ scopeGrants: true }).verifyAccessToken(token);
      const grant = (info.extra as { grant: { tools: string[] } | null }).grant;
      expect(grant?.tools).toEqual(["read", "bash"]);
    });

    it("maps tools:<name> scopes from an scp array (Entra style)", async () => {
      const token = await sign({ audience: AUD, claims: { scp: ["tools:glob", "tools:grep"] } });
      const info = await makeVerifier({ scopeGrants: true }).verifyAccessToken(token);
      const grant = (info.extra as { grant: { tools: string[] } | null }).grant;
      expect(grant?.tools).toEqual(["glob", "grep"]);
    });

    it("ignores unknown tools:<name> scopes", async () => {
      const token = await sign({ audience: AUD, claims: { scope: "tools:read tools:nope" } });
      const info = await makeVerifier({ scopeGrants: true }).verifyAccessToken(token);
      const grant = (info.extra as { grant: { tools: string[] } | null }).grant;
      expect(grant?.tools).toEqual(["read"]);
    });

    it("falls back to admin (null grant) when no tools:<name> scopes are present", async () => {
      const token = await sign({ audience: AUD, claims: { scope: "openid profile" } });
      const info = await makeVerifier({ scopeGrants: true }).verifyAccessToken(token);
      expect((info.extra as { grant: unknown }).grant).toBeNull();
    });
  });

  describe("clientId resolution", () => {
    it("falls back to sub when azp/client_id are absent", async () => {
      const token = await sign({ audience: AUD, claims: { sub: "user-42" } });
      const info = await makeVerifier().verifyAccessToken(token);
      expect(info.clientId).toBe("user-42");
    });

    it("prefers client_id over sub", async () => {
      const token = await sign({ audience: AUD, claims: { client_id: "cid-9", sub: "user-42" } });
      const info = await makeVerifier().verifyAccessToken(token);
      expect(info.clientId).toBe("cid-9");
    });
  });
});
