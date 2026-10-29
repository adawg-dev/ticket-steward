import { z } from "zod";

export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
/** What the steward's Linear app asks for: read and write, plus being assigned (delegated) and mentioned. */
export const LINEAR_APP_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Re-mint this long before Linear's own expiry, so a call never goes out with a token about to lapse. */
const EXPIRY_MARGIN_MS = 60_000;
const SCOPE = /^[a-z][a-z:]*$/;

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().optional() });
const ErrorResponse = z.object({ error: z.string() });

/** The Linear app's access token, held in dispatcher memory only: minted on first use, re-minted daily and after a 401. */
export interface LinearToken {
  get(): Promise<string>;
  /** Drops `rejected` if it is still the current token, so the next `get` mints; a stale token changes nothing. */
  invalidate(rejected: string): void;
  /** Revokes the current token (on shutdown) and forgets it. */
  revoke(): Promise<void>;
}

/** Linear refused the app's client credentials, or kept refusing a freshly minted token. Retrying cannot help. */
export class LinearCredentialsRejectedError extends Error {
  constructor() {
    super(
      "Linear rejected the steward's app credentials: check LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (Secrets Manager DEV_STEWARD_LINEAR_CLIENT_ID and DEV_STEWARD_LINEAR_CLIENT_SECRET) and restart the steward.",
    );
    this.name = "LinearCredentialsRejectedError";
  }
}

/** RFC 6749 §2.3.1 client authentication. */
const basicAuth = (clientId: string, clientSecret: string): string => `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

/** An OAuth error code from the body, never the body itself. */
const oauthError = async (response: Response): Promise<string | null> => {
  const body: unknown = await response.json().catch(() => undefined);
  return ErrorResponse.safeParse(body).data?.error ?? null;
};

/**
 * A client-credentials token for the steward's Linear app (`POST /oauth/token`, `grant_type=client_credentials`).
 * Concurrent `get` calls share one mint; nothing is written to disk.
 */
export const createClientCredentialsToken = (p: {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  fetchImpl: typeof fetch;
  now: () => number;
  /** Re-mint a token this old; default a day. */
  maxAgeMs?: number;
}): LinearToken => {
  const bad = p.scopes.find((scope) => !SCOPE.test(scope));
  if (bad !== undefined) throw new Error(`invalid Linear OAuth scope "${bad}"`);
  const authorization = basicAuth(p.clientId, p.clientSecret);
  const maxAgeMs = p.maxAgeMs ?? DAY_MS;
  let held: { token: string; expiresAt: number } | null = null;
  let minting: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    const response = await p.fetchImpl(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization },
      body: `grant_type=client_credentials&scope=${p.scopes.join(",")}`,
    });
    if (!response.ok) {
      const error = await oauthError(response);
      if (response.status === 401 || error === "invalid_client" || error === "unauthorized_client") throw new LinearCredentialsRejectedError();
      throw new Error(`Linear token mint answered ${response.status}${error === null ? "" : ` (${error})`}`);
    }
    const parsed = TokenResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new Error("Linear token mint returned no access_token");
    const mintedAt = p.now();
    const lifetime = parsed.data.expires_in === undefined ? maxAgeMs : Math.min(maxAgeMs, parsed.data.expires_in * 1000 - EXPIRY_MARGIN_MS);
    held = { token: parsed.data.access_token, expiresAt: mintedAt + lifetime };
    return parsed.data.access_token;
  };

  return {
    get: () => {
      if (held !== null && p.now() < held.expiresAt) return Promise.resolve(held.token);
      held = null;
      minting ??= mint().finally(() => {
        minting = null;
      });
      return minting;
    },
    invalidate: (rejected) => {
      if (held?.token === rejected) held = null;
    },
    revoke: async () => {
      const current = held?.token;
      held = null;
      if (current === undefined) return;
      const response = await p.fetchImpl(LINEAR_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization },
        body: `token=${encodeURIComponent(current)}&token_type_hint=access_token`,
      });
      if (!response.ok) throw new Error(`Linear token revoke answered ${response.status}`);
    },
  };
};
