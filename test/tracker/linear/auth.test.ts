import {
  createClientCredentialsToken,
  LINEAR_APP_SCOPES,
  LinearCredentialsRejectedError,
  type LinearToken,
} from "../../../src/tracker/linear/auth.js";

const CLIENT_ID = "client-id-1";
const CLIENT_SECRET = "client-secret-1";
const DAY_MS = 24 * 60 * 60 * 1000;

const tokenResponse = (accessToken: string, expiresIn = 30 * 24 * 60 * 60): Response =>
  new Response(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, scope: "read write" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Answers each mint with the next numbered token; revokes answer 200. */
const fakeLinear = () => {
  let minted = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
    minted += 1;
    return tokenResponse(`token-${minted}`);
  });
  return { fetchImpl, mints: () => fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/oauth/token")).length };
};

const makeToken = (fetchImpl: typeof fetch, clock: { now: number }, maxAgeMs?: number): LinearToken =>
  createClientCredentialsToken({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: LINEAR_APP_SCOPES,
    fetchImpl,
    now: () => clock.now,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  });

describe("createClientCredentialsToken", () => {
  it("mints once with the client-credentials form and HTTP Basic client auth, then serves the cached token", async () => {
    const linear = fakeLinear();
    const token = makeToken(linear.fetchImpl, { now: 0 });

    expect(await token.get()).toBe("token-1");
    expect(await token.get()).toBe("token-1");

    expect(linear.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = linear.fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.linear.app/oauth/token");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable");
    expect(init?.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    });
  });

  it("shares one mint between concurrent callers", async () => {
    const linear = fakeLinear();
    const token = makeToken(linear.fetchImpl, { now: 0 });

    expect(await Promise.all([token.get(), token.get()])).toEqual(["token-1", "token-1"]);
    expect(linear.mints()).toBe(1);
  });

  it("re-mints after the current token is invalidated", async () => {
    const linear = fakeLinear();
    const token = makeToken(linear.fetchImpl, { now: 0 });

    token.invalidate(await token.get());

    expect(await token.get()).toBe("token-2");
    expect(linear.mints()).toBe(2);
  });

  it("keeps the current token when a stale one is invalidated", async () => {
    const linear = fakeLinear();
    const token = makeToken(linear.fetchImpl, { now: 0 });
    const first = await token.get();
    token.invalidate(first);
    await token.get();

    token.invalidate(first);

    expect(await token.get()).toBe("token-2");
    expect(linear.mints()).toBe(2);
  });

  it("re-mints a token older than a day", async () => {
    const linear = fakeLinear();
    const clock = { now: 1_000 };
    const token = makeToken(linear.fetchImpl, clock);
    await token.get();

    clock.now += DAY_MS - 1;
    expect(await token.get()).toBe("token-1");
    clock.now += 1;
    expect(await token.get()).toBe("token-2");
  });

  it("honours a shorter maxAgeMs", async () => {
    const linear = fakeLinear();
    const clock = { now: 0 };
    const token = makeToken(linear.fetchImpl, clock, 60_000);
    await token.get();
    clock.now = 60_000;
    expect(await token.get()).toBe("token-2");
  });

  it("re-mints before Linear's own expiry when that comes first", async () => {
    let minted = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => tokenResponse(`token-${++minted}`, 3600));
    const clock = { now: 0 };
    const token = makeToken(fetchImpl, clock);
    await token.get();

    clock.now = 3600 * 1000 - 60_000;
    expect(await token.get()).toBe("token-2");
  });

  it("rejects bad client credentials with an error naming the secrets and no value", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    const token = makeToken(fetchImpl, { now: 0 });

    const minting = token.get();

    await expect(minting).rejects.toBeInstanceOf(LinearCredentialsRejectedError);
    await expect(minting).rejects.toThrow("LINEAR_CLIENT_ID");
    await expect(minting).rejects.not.toThrow(CLIENT_SECRET);
  });

  it("fails other mint errors without latching, so the next get tries again", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(tokenResponse("token-1"));
    const token = makeToken(fetchImpl, { now: 0 });

    await expect(token.get()).rejects.toThrow("Linear token mint answered 503");
    expect(await token.get()).toBe("token-1");
  });

  it("revokes the held token with client auth and forgets it", async () => {
    const linear = fakeLinear();
    const token = makeToken(linear.fetchImpl, { now: 0 });
    await token.get();

    await token.revoke();

    const [url, init] = linear.fetchImpl.mock.calls[1] ?? [];
    expect(url).toBe("https://api.linear.app/oauth/revoke");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("token=token-1&token_type_hint=access_token");
    expect(init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}` });
    expect(await token.get()).toBe("token-2");
  });

  it("revokes nothing when no token was minted", async () => {
    const linear = fakeLinear();
    await makeToken(linear.fetchImpl, { now: 0 }).revoke();
    expect(linear.fetchImpl).not.toHaveBeenCalled();
  });
});
