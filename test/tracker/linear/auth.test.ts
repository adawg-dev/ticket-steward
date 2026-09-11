import { LINEAR_SCOPES, LinearAuth, buildAuthorizeUrl, exchangeCode, type TokenRepository } from "../../../src/tracker/linear/auth.js";
import type { TokenPair } from "../../../src/store/tokens.js";

class MemoryTokenRepository implements TokenRepository {
  pair: TokenPair | null = null;
  authBroken = false;
  get(): TokenPair | null {
    return this.pair;
  }
  set(p: TokenPair): void {
    this.pair = p;
  }
  setAuthBroken(v: boolean): void {
    this.authBroken = v;
  }
  withImmediateTransaction<T>(fn: () => T): T {
    return fn();
  }
}

const creds = { clientId: "client-id", clientSecret: "client-secret" };
const minutes = (n: number) => n * 60 * 1000;
const pair = (expiresInMs: number): TokenPair => ({
  accessToken: "access-old",
  refreshToken: "refresh-old",
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  appUserId: "app-user-1",
});

const tokenResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const rotated = { access_token: "access-new", token_type: "Bearer", expires_in: 86399, scope: "read", refresh_token: "refresh-new" };

describe("buildAuthorizeUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an actor=app authorize URL with scopes, state and consent", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "client-id", redirectUri: "https://steward.example.com/oauth/linear/callback", state: "abc" }));
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://steward.example.com/oauth/linear/callback");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(LINEAR_SCOPES);
    expect(LINEAR_SCOPES).toBe("read,write,comments:create,app:assignable,app:mentionable");
  });
});

describe("exchangeCode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a form-encoded authorization_code grant and maps expires_in to expiresAt", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-11T12:00:00.000Z") });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse(rotated));
    const result = await exchangeCode({ ...creds, redirectUri: "https://steward.example.com/cb", code: "the-code", fetchImpl: fetchMock });
    expect(result).toEqual({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: new Date(Date.now() + 86399 * 1000).toISOString(),
      appUserId: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/oauth/token");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: "https://steward.example.com/cb",
        client_id: "client-id",
        client_secret: "client-secret",
      }),
    );
    vi.useRealTimers();
  });

  it("rejects when the token endpoint answers non-2xx", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));
    await expect(exchangeCode({ ...creds, redirectUri: "https://steward.example.com/cb", code: "bad", fetchImpl: fetchMock })).rejects.toThrow();
  });
});

describe("LinearAuth.accessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the stored token without a network call when it is fresh", async () => {
    const repo = new MemoryTokenRepository();
    repo.set(pair(minutes(60)));
    const fetchMock = vi.fn<typeof fetch>();
    const auth = new LinearAuth(repo, creds, fetchMock);
    expect(await auth.accessToken()).toBe("access-old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when within five minutes of expiry and persists the rotated pair", async () => {
    const repo = new MemoryTokenRepository();
    repo.set(pair(minutes(4)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse(rotated));
    const auth = new LinearAuth(repo, creds, fetchMock);
    const before = Date.now();
    expect(await auth.accessToken()).toBe("access-new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/oauth/token");
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "refresh-old", client_id: "client-id", client_secret: "client-secret" }),
    );
    const stored = repo.get()!;
    expect(stored.accessToken).toBe("access-new");
    expect(stored.refreshToken).toBe("refresh-new");
    expect(stored.appUserId).toBe("app-user-1");
    expect(new Date(stored.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 86399 * 1000);
    expect(repo.authBroken).toBe(false);
  });

  it("makes a single refresh for two concurrent calls", async () => {
    const repo = new MemoryTokenRepository();
    repo.set(pair(minutes(1)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse(rotated));
    const auth = new LinearAuth(repo, creds, fetchMock);
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(["access-new", "access-new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the network call when another process already rotated the pair", async () => {
    const repo = new MemoryTokenRepository();
    repo.set(pair(minutes(1)));
    const fetchMock = vi.fn<typeof fetch>();
    const auth = new LinearAuth(repo, creds, fetchMock);
    repo.withImmediateTransaction = <T>(fn: () => T): T => {
      repo.pair = { ...pair(minutes(60)), accessToken: "access-elsewhere", refreshToken: "refresh-elsewhere" };
      return fn();
    };
    expect(await auth.accessToken()).toBe("access-elsewhere");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets auth broken and rejects when the refresh fails", async () => {
    const repo = new MemoryTokenRepository();
    repo.set(pair(minutes(1)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse({ error: "invalid_grant" }, 400));
    const auth = new LinearAuth(repo, creds, fetchMock);
    await expect(auth.accessToken()).rejects.toThrow();
    expect(repo.authBroken).toBe(true);
    expect(repo.get()!.accessToken).toBe("access-old");
  });

  it("rejects when no token pair is stored", async () => {
    const repo = new MemoryTokenRepository();
    const fetchMock = vi.fn<typeof fetch>();
    const auth = new LinearAuth(repo, creds, fetchMock);
    await expect(auth.accessToken()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LinearAuth.handleUnauthorized", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forces a refresh even when the stored token looks fresh", async () => {
    const repo = new MemoryTokenRepository();
    repo.set(pair(minutes(60)));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse(rotated));
    const auth = new LinearAuth(repo, creds, fetchMock);
    expect(await auth.handleUnauthorized()).toBe("access-new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repo.get()!.accessToken).toBe("access-new");
  });
});
