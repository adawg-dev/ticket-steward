import type { TokenPair } from "../../store/tokens.js";

export interface TokenRepository {
  get(): TokenPair | null;
  set(p: TokenPair): void;
  setAuthBroken(v: boolean): void;
  withImmediateTransaction<T>(fn: () => T): T;
}

export const LINEAR_SCOPES = "read,write,comments:create,app:assignable,app:mentionable";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export const buildAuthorizeUrl = (p: { clientId: string; redirectUri: string; state: string }): string => {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: LINEAR_SCOPES,
    state: p.state,
    actor: "app",
    prompt: "consent",
  }).toString();
  return url.toString();
};

const postTokenRequest = async (form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> => {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!response.ok) throw new Error(`Linear token endpoint answered ${response.status}`);
  const { access_token, refresh_token, expires_in } = (await response.json()) as TokenResponse;
  return { access_token, refresh_token, expires_in };
};

const toTokenPair = (t: TokenResponse, appUserId: string | null): TokenPair => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  appUserId,
});

export const exchangeCode = async (p: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenPair> => {
  const token = await postTokenRequest(
    { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, client_secret: p.clientSecret },
    p.fetchImpl ?? fetch,
  );
  return toTokenPair(token, null);
};

const isFresh = (pair: TokenPair): boolean => new Date(pair.expiresAt).getTime() - Date.now() > REFRESH_WINDOW_MS;

export class LinearAuth {
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly repo: TokenRepository,
    private readonly creds: { clientId: string; clientSecret: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async accessToken(): Promise<string> {
    const stored = this.requirePair();
    if (isFresh(stored)) return stored.accessToken;
    return this.refreshSingleFlight(stored, isFresh);
  }

  handleUnauthorized(): Promise<string> {
    const stored = this.requirePair();
    return this.refreshSingleFlight(stored, (current) => current.refreshToken !== stored.refreshToken);
  }

  private requirePair(): TokenPair {
    const stored = this.repo.get();
    if (stored === null) throw new Error("No Linear token pair stored; run `steward auth linear`");
    return stored;
  }

  private refreshSingleFlight(seen: TokenPair, alreadyRotated: (current: TokenPair) => boolean): Promise<string> {
    if (this.inflight === null) {
      this.inflight = this.refresh(seen, alreadyRotated).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refresh(seen: TokenPair, alreadyRotated: (current: TokenPair) => boolean): Promise<string> {
    const current = this.repo.withImmediateTransaction(() => this.requirePair());
    if (alreadyRotated(current)) return current.accessToken;

    let token: TokenResponse;
    try {
      token = await postTokenRequest(
        { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: this.creds.clientId, client_secret: this.creds.clientSecret },
        this.fetchImpl,
      );
    } catch (error) {
      this.repo.setAuthBroken(true);
      throw error;
    }

    return this.repo.withImmediateTransaction(() => {
      const latest = this.requirePair();
      if (latest.refreshToken !== current.refreshToken) return latest.accessToken;
      const rotated = toTokenPair(token, latest.appUserId);
      this.repo.set(rotated);
      return rotated.accessToken;
    });
  }
}
