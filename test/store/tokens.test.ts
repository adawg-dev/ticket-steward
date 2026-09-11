import { openStores, type Stores } from "../../src/store/index.js";
import { freshDataDir } from "./helpers.js";

let stores: Stores;

const pair = {
  accessToken: "lin_oauth_access",
  refreshToken: "lin_oauth_refresh",
  expiresAt: "2026-09-12T00:00:00.000Z",
  appUserId: "user-1",
};

beforeEach(() => {
  vi.restoreAllMocks();
  stores = openStores(freshDataDir());
});

afterEach(() => {
  vi.useRealTimers();
  stores.db.close();
});

describe("TokenStore", () => {
  it("get is null until set, set replaces the pair, clear removes it", () => {
    expect(stores.tokens.get()).toBeNull();

    stores.tokens.set(pair);
    expect(stores.tokens.get()).toEqual(pair);

    stores.tokens.set({ ...pair, accessToken: "rotated", appUserId: null });
    expect(stores.tokens.get()).toEqual({ ...pair, accessToken: "rotated", appUserId: null });

    stores.tokens.clear();
    expect(stores.tokens.get()).toBeNull();
  });

  it("an oauth state can be consumed exactly once", () => {
    const state = stores.tokens.createOauthState(60_000);

    expect(state.length).toBe(32);
    expect(stores.tokens.consumeOauthState(state)).toBe(true);
    expect(stores.tokens.consumeOauthState(state)).toBe(false);
    expect(stores.tokens.consumeOauthState("unknown")).toBe(false);
  });

  it("an expired oauth state cannot be consumed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    const state = stores.tokens.createOauthState(60_000);
    vi.setSystemTime(new Date("2026-09-11T00:01:01Z"));

    expect(stores.tokens.consumeOauthState(state)).toBe(false);
  });

  it("auth broken flag round-trips and defaults to false", () => {
    expect(stores.tokens.isAuthBroken()).toBe(false);

    stores.tokens.setAuthBroken(true);
    expect(stores.tokens.isAuthBroken()).toBe(true);

    stores.tokens.setAuthBroken(false);
    expect(stores.tokens.isAuthBroken()).toBe(false);
  });

  it("withImmediateTransaction returns the callback value and rolls back on throw", () => {
    const value = stores.tokens.withImmediateTransaction(() => {
      stores.tokens.set(pair);
      return 42;
    });
    expect(value).toBe(42);
    expect(stores.tokens.get()).toEqual(pair);

    expect(() =>
      stores.tokens.withImmediateTransaction(() => {
        stores.tokens.clear();
        throw new Error("abort");
      }),
    ).toThrow();
    expect(stores.tokens.get()).toEqual(pair);
  });
});
